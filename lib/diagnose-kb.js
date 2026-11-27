/**
 * The diagnosis knowledge base: for each failure type, which places to check
 * and in what order. A diagnosis draft (lib/diagnose-report.js) points the
 * model at the section of its failure's type, so it checks a few known
 * places instead of reading through the plugin's source.
 *
 * Two ways it reaches the model:
 * - the skill `dsh-mem0-kb`, which the plugin offers through DSH's skill
 *   registry (`ctx.skills.registerProvider`, the way dsh-skill-office ships
 *   its skills), listed only for sessions whose working directory is the
 *   diagnosis folder, so no other session's catalog grows by a line;
 * - the one section of its type written into the prompt (`checklistFor`):
 *   for copied text, which may be pasted where the skill is not offered,
 *   and on DSH versions without the skill registry.
 *
 * Every step is read-only: mem0_status, the plugin's own redacted failure
 * record (`../failures.json` from the diagnosis folder), one GET without a
 * key against an endpoint, a listening-port check. Never a key, a
 * credential file, memory text or the store itself.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DIAGNOSE_SKILL = 'dsh-mem0-kb'
export const DIAGNOSE_SKILL_PROVIDER = 'dsh-mem0'
// After DSH's own bundled skills and the user's: a same-name skill of theirs wins.
const SKILL_RANK = 1000

/** What a Mem0 user may see when the record cannot say (the draft adds "not sure"). */
export const DIAGNOSE_SYMPTOMS = Object.freeze({
  zh: ['新内容没记住', '想不起以前的记忆', '设置页或底部栏报错', '对话明显变慢'],
  en: ['New things are not remembered', 'Earlier memories are not recalled', 'An error on the settings page or status bar', 'Replies got slow'],
})
export const DIAGNOSE_FEATURE = Object.freeze({ zh: '记忆', en: 'Memory' })

const TITLES = {
  timeout: { zh: '超时', en: 'timeout' },
  connection: { zh: '连接失败', en: 'connection failed' },
  auth: { zh: '认证或额度', en: 'auth or quota' },
  circuit: { zh: '熔断', en: 'circuit breaker' },
  extraction: { zh: 'LLM 抽取失败', en: 'LLM extraction failed' },
  startup: { zh: '本地后端启动失败', en: 'local backend failed to start' },
  config: { zh: '配置错误', en: 'configuration error' },
  other: { zh: '其他错误', en: 'other error' },
}

const STATUS = {
  zh: '调用一次 mem0_status（只读，不显示 key）',
  en: 'Call mem0_status once (read-only, never shows keys)',
}
const PROBE = {
  zh: '对诊断信息里的 endpoint 做一次不带 key 的 GET（web_fetch，或 `curl -sS -m 10 -o /dev/null -w "%{http_code} %{time_total}"`，路径用 /v1/models 或 /），不发真实内容。',
  en: 'Make one GET without a key to the endpoint in the facts (web_fetch, or `curl -sS -m 10 -o /dev/null -w "%{http_code} %{time_total}"`, path /v1/models or /), never with a key or real content.',
}
const RECORD = {
  zh: '读一次诊断文件夹上一级的 failures.json（即 ../failures.json，插件自己的失败记录，已脱敏，最多 20 条）',
  en: 'Read failures.json one level above the diagnosis folder once (../failures.json, the plugin\'s own failure record, redacted, at most 20 entries)',
}

/**
 * The checklists, one per failure type (lib/failure-history.js
 * FAILURE_CAUSES). A line with `reason` applies to that extraction reason
 * only.
 */
const CHECKLISTS = {
  timeout: [
    { zh: `${STATUS.zh}：看 status 行和 last recall 的分步耗时，确认慢在哪一步（对照诊断信息的 step 和 component）。`, en: `${STATUS.en}: read the status line and the step timings of the last recall to see which step is slow (match step and component in the facts).` },
    { zh: '对照 duration_ms、step_elapsed_ms 和超时设置：召回 recallTimeoutMs（默认 5000）、保存 addTimeoutMs（默认 120000）、其他 timeoutMs（默认 30000）。耗时贴着上限是服务慢；远低于上限说明是别的原因中断。', en: 'Compare duration_ms and step_elapsed_ms with the timeouts: recallTimeoutMs for recall (default 5000), addTimeoutMs for saving (default 120000), timeoutMs otherwise (default 30000). Close to the limit means a slow service; far below it, something else cut the call.' },
    { zh: `${PROBE.zh}看能不能连上、用了多久。`, en: `${PROBE.en} Note whether it answers and how long it takes.` },
    { zh: '本地模型（Ollama 等）第一次调用要加载模型：embedderKeepAlive（默认 30m）太短会反复冷启动。', en: 'A local model (Ollama and the like) loads on its first call: an embedderKeepAlive (default 30m) that is too short means repeated cold starts.' },
    { zh: '结论：服务本身慢就调高对应的超时；连不上按「connection」处理；只发生一两次可以先观察。', en: 'Conclude: a slow service needs the matching timeout raised; no answer at all is a "connection" problem; a one-off can be watched first.' },
  ],
  connection: [
    { zh: `${STATUS.zh}：看 endpoint、embedder、extraction LLM 行，确认是哪个组件、哪个地址连不上。`, en: `${STATUS.en}: read the endpoint, embedder and extraction LLM lines to see which component and which address fail.` },
    { zh: `${PROBE.zh}区分拒绝连接（服务没开或端口不对）、DNS 失败（地址写错）、超时（网络或代理）。`, en: `${PROBE.en} Tell apart refused (service down or wrong port), DNS failure (wrong address) and timeout (network or proxy).` },
    { zh: '地址是 127.0.0.1 或 localhost 时，用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 看有没有服务在监听。', en: 'For 127.0.0.1 or localhost, check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` that something listens.' },
    { zh: '用户说改过网络或代理：只看 HTTP_PROXY、HTTPS_PROXY、NO_PROXY 有没有设置、本机地址是否在 NO_PROXY 里，不要打印带密码的值。', en: 'If the user changed the network or proxy: check only whether HTTP_PROXY, HTTPS_PROXY and NO_PROXY are set and whether local addresses are in NO_PROXY; never print a value with a password.' },
    { zh: '结论：说清楚要启动哪个服务，或在设置页（本地后端在配置向导）把地址改成什么。', en: 'Conclude: name the service to start, or the address to set in the settings (the setup wizard on the local backend).' },
  ],
  auth: [
    { zh: '先看 http_status：401 或 403 是 key 被拒；429，或报错里有 quota、rate limit、余额，是额度或限流。', en: 'Start from http_status: 401 or 403 means the key was refused; 429, or quota, rate limit or balance in the message, means quota or rate limiting.' },
    { zh: `${STATUS.zh}：看 key source（只有来源，没有 key）、backend 和 endpoint，确认 key 从哪来、发给了哪个服务。`, en: `${STATUS.en}: read key source (where the key comes from, not the key), backend and endpoint to see which service the key goes to.` },
    { zh: '401/403：确认这个 key 属于当前的服务商和地址；换过服务商或地址但没换 key 是最常见的原因。不要读取、打印 key，也不要让用户贴出来。', en: '401/403: check that the key belongs to the current provider and address; a changed provider or address with the old key is the usual cause. Never read or print the key, and do not ask the user to paste it.' },
    { zh: '429/额度：请用户到服务商控制台看余额和限额；看 count、first_at、last_at 是不是集中在一段时间。', en: '429/quota: ask the user to check balance and limits in the provider\'s console; see whether count, first_at and last_at cluster in one stretch of time.' },
    { zh: '结论：告诉用户在哪里换 key（设置页，本地后端在配置向导），或者等额度恢复。', en: 'Conclude: say where to replace the key (the settings, the setup wizard on the local backend), or to wait for the quota.' },
  ],
  circuit: [
    { zh: '熔断本身不是原因：同一后端连续失败 5 次后，插件暂停调用 2 分钟。', en: 'The breaker is not the cause: after 5 failures in a row the plugin pauses calls to that backend for 2 minutes.' },
    { zh: `${RECORD.zh}，找出熔断之前那条不是 circuit 的失败，按它的类型的一节排查。`, en: `${RECORD.en} and find the failure before the breaker that is not "circuit"; follow the section of its type.` },
    { zh: `${STATUS.zh}：status 是 ready 就说明已经恢复。`, en: `${STATUS.en}: status ready means it has recovered.` },
    { zh: '结论：指出真正原因的那条失败；已经恢复就说明不用处理。', en: 'Conclude: name the failure that caused it; if it has recovered, say nothing needs doing.' },
  ],
  extraction: [
    { zh: `${STATUS.zh}：看 extraction LLM 行（跟随 DSH 当前模型还是单独配置、模型名、llmMaxTokens）和 last extraction 行。`, en: `${STATUS.en}: read the extraction LLM line (follows DSH's model or its own, model name, llmMaxTokens) and the last extraction line.` },
    { reason: 'not_json', zh: 'not_json：模型没按 JSON 回答。推理模型和小模型常这样；建议换一个能稳定输出 JSON 的模型，或把 llmReasoningEffort 设成 low。', en: 'not_json: the model did not answer in JSON. Reasoning and small models often do; suggest a model that reliably answers in JSON, or llmReasoningEffort low.' },
    { reason: 'truncated', zh: 'truncated：回答到了输出上限。调高 llmMaxTokens（默认 8000），或把 llmReasoningEffort 设成 low。', en: 'truncated: the answer hit its output limit. Raise llmMaxTokens (default 8000), or set llmReasoningEffort low.' },
    { reason: 'empty', zh: 'empty：模型返回空内容。多半是模型或网关的问题，换一个模型试试。', en: 'empty: the model returned nothing. Usually the model or the gateway; try another model.' },
    { reason: 'refusal', zh: 'refusal：模型拒绝回答。可能被服务商的内容过滤拦了，换一个模型试试。', en: 'refusal: the model refused. Possibly the provider\'s content filter; try another model.' },
    { zh: '用户说换过模型：最近一次换模型很可能就是原因，说明换回去或换哪类模型。', en: 'If the user changed the model: the latest change is the likely cause; say whether to switch back or which kind of model to use.' },
    { zh: '结论：说清楚在设置页（本地后端在配置向导）改哪一项。', en: 'Conclude: name the setting to change (the settings, the setup wizard on the local backend).' },
  ],
  startup: [
    { zh: `${STATUS.zh}：看 store 行和 last store failure 行（时间、组件、错误码）。`, en: `${STATUS.en}: read the store line and the last store failure line (time, component, error code).` },
    { zh: '按错误码判断：路径不存在或没权限，用 `ls -ld` 看 storePath 所在目录；数据库被锁，看是不是另一个 DSH 在用同一个存储；schema_newer 是更新的版本写过这个库。', en: 'By error code: a missing path or no permission, check the folder of storePath with `ls -ld`; a locked database, see whether another DSH uses the same store; schema_newer means a newer version wrote this store.' },
    { zh: '不要打开、复制或修改数据库文件，不要读记忆内容。', en: 'Do not open, copy or change the database file, and do not read memory text.' },
    { zh: '用户说升级过 DSH 或插件：对照 last store failure 的时间和升级时间。', en: 'If the user upgraded DSH or the plugin: compare the time of the last store failure with the upgrade.' },
    { zh: '结论：在配置向导里改存储路径，或者关掉占用的进程。', en: 'Conclude: change the store path in the setup wizard, or close the process holding it.' },
  ],
  config: [
    { zh: `${STATUS.zh}：看 configuration (…)、warning 和 ignored settings 行，它们直接写着哪项设置不能用。`, en: `${STATUS.en}: read the configuration (…), warning and ignored settings lines; they name the setting that cannot be used.` },
    { zh: '嵌入模型和存储不匹配（维度不同）：换回原来的嵌入模型，或在配置向导里迁移；缺设置就补上。', en: 'Embedder and store do not match (different dimensions): switch back to the earlier embedder, or migrate in the setup wizard; a missing setting needs filling in.' },
    { zh: '用户说升级过 DSH 或设置丢了：看 warning 行有没有提到 cordis.patch.yml 被移走、有没有备份。', en: 'If the user upgraded DSH or settings went missing: see whether the warning line says cordis.patch.yml was moved aside and whether a backup exists.' },
    { zh: '结论：指明在设置页或配置向导里把哪一项改成什么；改好之前重试没用。', en: 'Conclude: name the setting and the value, in the settings or the setup wizard; retrying does not help until then.' },
  ],
  other: [
    { zh: '先按用户说的现象定方向：没记住看保存（capture），想不起来看召回（recall），变慢看耗时。', en: 'Let the user\'s answer set the direction: not remembered is capture, not recalled is recall, slow is timing.' },
    { zh: `${STATUS.zh}。`, en: `${STATUS.en}.` },
    { zh: `http_status 是 5xx：服务端出错。${PROBE.zh}看现在是否还在报错；本地网关就看网关本身是否正常。`, en: `http_status 5xx: the server failed. ${PROBE.en} See whether it still fails; for a local gateway, check the gateway itself.` },
    { zh: `${RECORD.zh}，看同类失败从什么时候开始、是否和别的失败一起出现。`, en: `${RECORD.en}: when did this kind of failure start, and does it come with others?` },
    { zh: '还是定位不了：如实说，列出已经排除的和还需要用户提供的信息（比如网关日志里对应时间的一行）。', en: 'Still unclear: say so, with what you ruled out and what the user could add (say, the gateway\'s log line at that time).' },
  ],
}

export const DIAGNOSE_SECTIONS = Object.freeze(Object.keys(CHECKLISTS))

function language(lang) {
  return lang === 'zh' ? 'zh' : 'en'
}

/** The section of a failure entry: its cause, or `other` for anything unknown. */
export function sectionFor(entry) {
  return Object.hasOwn(CHECKLISTS, entry?.cause) ? entry.cause : 'other'
}

/**
 * The checklist lines of one failure, in order. An extraction failure gets
 * the lines of its own reason only; without a known reason, all of them.
 */
export function checklistFor(entry, { lang = 'en' } = {}) {
  const section = sectionFor(entry)
  const lines = CHECKLISTS[section]
  const known = lines.some((line) => line.reason && line.reason === entry?.reason)
  return lines.filter((line) => !line.reason || !known || line.reason === entry.reason).map((line) => line[language(lang)])
}

const SKILL_TEXT = {
  zh: {
    description: 'Mem0 记忆插件的诊断清单：每种失败类型按什么顺序查哪几处。只在 Mem0 诊断会话里用。',
    intro: [
      `# ${DIAGNOSE_SKILL}：Mem0 诊断清单`,
      '',
      '在 Mem0 诊断会话里，问完用户之后用。只照草稿点名的那一节查，按顺序，查到原因就停。',
      '',
      '## 通用规则',
      '- 每一步只做一件事；拿到能下结论的信息就停，不要把整节跑完。',
      '- 整次诊断的工具调用尽量控制在 10 次以内；超过还没结论，就停下来如实说明。',
      '- 不要通读插件源码，不要遍历目录或在整个磁盘里搜索。',
      '- 不要读取、打印或索要 API key 和凭据文件，不要读取或引用记忆正文。',
      '- 这是只读会话：把修法一步步告诉用户，由用户自己改。',
      '- 回答格式：一句结论；一到三条依据；修法（编号步骤）。定位不了：已经排除了什么、还缺什么信息。',
    ],
  },
  en: {
    description: 'Checklists for diagnosing the Mem0 memory plugin: which places to check, in what order, for each failure type. For Mem0 diagnosis sessions only.',
    intro: [
      `# ${DIAGNOSE_SKILL}: Mem0 diagnosis checklists`,
      '',
      'Use in a Mem0 diagnosis session, after asking the user. Follow only the section the draft names, in order, and stop once you find the cause.',
      '',
      '## General rules',
      '- One thing per step; stop as soon as you can conclude, without running the whole section.',
      '- Keep the whole diagnosis to about 10 tool calls; past that without a cause, stop and say so.',
      '- Do not read through the plugin source, walk directories or search the whole disk.',
      '- Do not read, print or ask for API keys or credential files, and do not read or quote memory text.',
      '- This is a read-only session: give the user the fix as steps for them to carry out.',
      '- Answer: the cause in one sentence; one to three facts; the fix as numbered steps. Unclear: what you ruled out and what is missing.',
    ],
  },
}

/** The skill's catalog description (both languages: the catalog is built once). */
export function diagnoseSkillDescription() {
  return `${SKILL_TEXT.en.description} ${SKILL_TEXT.zh.description}`
}

/** The whole skill body: the general rules, then every section in order. */
export function diagnoseSkillContent({ lang = 'en' } = {}) {
  const key = language(lang)
  const lines = [...SKILL_TEXT[key].intro]
  for (const section of DIAGNOSE_SECTIONS) {
    const title = TITLES[section][key]
    lines.push('', key === 'zh' ? `## ${section}（${title}）` : `## ${section} (${title})`)
    CHECKLISTS[section].forEach((line, index) => lines.push(`${index + 1}. ${line[key]}`))
  }
  return lines.join('\n')
}

function realpath(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** Whether `cwd` is the diagnosis folder or inside it (symlinks resolved, e.g. /tmp → /private/tmp). */
export function inDiagnoseDirectory(cwd, directory) {
  if (typeof cwd !== 'string' || !cwd || typeof directory !== 'string' || !directory) return false
  const base = realpath(directory)
  const here = realpath(cwd)
  return here === base || here.startsWith(`${base}${path.sep}`)
}

/**
 * Offer the skill to sessions in the diagnosis folder. `directory()` is that
 * folder (null when there is none), `lang()` the language of the latest
 * draft. Calls `onReady(true)` once the provider is registered; DSH without
 * the skill registry never calls it, and the draft then carries the
 * checklist itself.
 */
export function registerDiagnoseSkill(ctx, { directory, lang = () => 'en', onReady = () => {}, logger } = {}) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['skills'], (sub) => {
    const skills = sub.skills ?? sub.get?.('skills')
    if (typeof skills?.registerProvider !== 'function') return
    const summary = () => ({
      name: DIAGNOSE_SKILL,
      description: diagnoseSkillDescription(),
      invocation: { modelInvocable: true, userInvocable: false },
      provider: DIAGNOSE_SKILL_PROVIDER,
      source: 'bundled',
    })
    try {
      skills.registerProvider(() => ({
        name: DIAGNOSE_SKILL_PROVIDER,
        async list(options) {
          let dir = null
          try {
            dir = directory?.() ?? null
          } catch {
            dir = null
          }
          if (!inDiagnoseDirectory(options?.cwd, dir)) return []
          return [{ ...summary(), rank: SKILL_RANK, locator: DIAGNOSE_SKILL }]
        },
        async get(candidate) {
          if (candidate?.name !== DIAGNOSE_SKILL) return undefined
          return { ...summary(), content: diagnoseSkillContent({ lang: lang() }) }
        },
      }))
      onReady(true)
    } catch (error) {
      logger?.warn?.(`dsh-mem0: could not offer the diagnosis skill: ${error.message}`)
    }
  })
}

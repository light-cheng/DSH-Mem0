/**
 * The prompt of the settings page's "AI troubleshoot" entry: for a user who
 * cannot point at one failure. The plugin hands over its current state
 * (redacted: no key, no memory text, endpoints as host:port only), the
 * model asks what the user sees, then follows the matching section of the
 * skill dsh-mem0-kb (lib/diagnose-kb.js), and fixes what it can once the
 * user agrees (lib/diagnose-report.js diagnosisFixRules).
 *
 * The wording of the Chinese prompt is the one agreed with the user; the
 * English one says the same.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DIAGNOSE_SKILL } from './diagnose-kb.js'
import { diagnosisFixRules, hostPort } from './diagnose-report.js'
import { DEFAULT_PLATFORM_BASE_URL } from './config.js'

/** Fingerprint the record keeps for the general entry's latest session. */
export const GENERAL_FINGERPRINT = 'dsh-mem0:general'

const CAUSES = ['timeout', 'connection', 'auth', 'circuit', 'extraction', 'startup', 'config', 'other']
const CAUSE_NAME = {
  zh: { timeout: '超时', connection: '连接失败', auth: '认证或额度', circuit: '熔断', extraction: 'LLM 抽取失败', startup: '本地后端启动失败', config: '配置错误', other: '其他错误' },
  en: { timeout: 'timeout', connection: 'connection failed', auth: 'auth or quota', circuit: 'circuit breaker', extraction: 'LLM extraction failed', startup: 'local backend failed to start', config: 'configuration error', other: 'other error' },
}

/** DSH's version, read from the host package next to the running CLI; null when not found. */
export function hostVersion({ argv = process.argv } = {}) {
  const entry = typeof argv?.[1] === 'string' ? argv[1] : ''
  if (!entry) return null
  try {
    return createRequire(entry)('@deepseek-ai/dsh/package.json').version ?? null
  } catch {
    // An asar or unusual layout: look for the scope folder above the entry.
  }
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.basename(dir) === '@deepseek-ai') {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'dsh', 'package.json'), 'utf8')).version ?? null
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function localTime(iso) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '?'
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Open (not recovered) failures by type: `[{ cause, count, lastAt }]`,
 * the type with the newest failure first. Only the type, a count and a
 * time leave the plugin: no message, endpoint or detail.
 */
export function openFailureSummary(failures) {
  const groups = new Map()
  for (const entry of Array.isArray(failures) ? failures : []) {
    if (!entry || entry.recovered === true) continue
    const cause = CAUSES.includes(entry.cause) ? entry.cause : 'other'
    const count = Number.isFinite(Number(entry.count)) && Number(entry.count) > 0 ? Math.round(Number(entry.count)) : 1
    const at = Number.isFinite(Date.parse(entry.at)) ? new Date(Date.parse(entry.at)).toISOString() : null
    const group = groups.get(cause) ?? { cause, count: 0, lastAt: null }
    group.count += count
    if (at && (!group.lastAt || at > group.lastAt)) group.lastAt = at
    groups.set(cause, group)
  }
  return [...groups.values()].sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
}

/**
 * The plugin's state as the prompt shows it. Pure apart from `runtime`
 * reads; `dshVersion` and `pluginVersion` are passed in.
 */
export function generalState(runtime, { pluginVersion, dshVersion } = {}) {
  const config = runtime?.config ?? {}
  const backend = ['platform', 'server', 'oss'].includes(config.backend) ? config.backend : 'unknown'
  const endpoints = []
  if (backend === 'oss') {
    // The local client's resolved settings (profile merged with oss.json);
    // the plugin config alone may not name them.
    let settings = null
    try {
      settings = typeof runtime?.client?.settings === 'function' ? runtime.client.settings() : null
    } catch {
      settings = null
    }
    const label = (value) => (value ? `${String(value).replace(/[^\w.-]/g, '')} ` : '')
    const embedder = hostPort(settings?.embedder?.baseUrl || config.embedderBaseUrl)
    const llmProvider = settings?.llm?.provider
    const llm = llmProvider === 'dsh' ? null : hostPort(settings?.llm?.baseUrl || config.llmBaseUrl)
    if (embedder) endpoints.push(`embedder ${label(settings?.embedder?.provider || config.embedderProvider)}${embedder}`)
    if (llmProvider === 'dsh') endpoints.push('LLM follows DSH')
    else if (llm) endpoints.push(`LLM ${llm}`)
  } else if (backend !== 'unknown') {
    const host = hostPort(config.baseUrl || (backend === 'platform' ? DEFAULT_PLATFORM_BASE_URL : ''))
    if (host) endpoints.push(host)
  }
  const breaker = runtime?.breaker
  return {
    pluginVersion: pluginVersion ?? null,
    dshVersion: dshVersion ?? null,
    backend,
    endpoints,
    autoRecall: config.autoRecall !== false,
    autoCapture: config.autoCapture !== false,
    partitions: backend === 'oss' && config.projectPartitions !== false,
    breakerOpen: typeof breaker?.isOpen === 'function' ? breaker.isOpen() === true : null,
    failures: openFailureSummary(typeof runtime?.failures?.list === 'function' ? runtime.failures.list() : []),
  }
}

const TEXT = {
  zh: {
    intro: `这是 DSH-Mem0（记忆插件）的问题排查。用户从设置页「AI 排查」发起，没有指定哪条失败，你要先问清楚现象，再动手查。`,
    stateTitle: '【插件已带上的状态，不用再问】',
    versions: (s) => `插件版本 ${s.pluginVersion ?? '未知'}，DSH 版本 ${s.dshVersion ?? '未知'}`,
    backend: (s) => `后端：${s.backend === 'oss' ? 'oss（本地）' : s.backend === 'unknown' ? '未知' : `${s.backend}（云端）`}，服务商 ${s.endpoints.length ? s.endpoints.join('，') : '未知'}`,
    switches: (s) => `自动召回 ${s.autoRecall ? '开' : '关'}，自动保存 ${s.autoCapture ? '开' : '关'}，按项目分区 ${s.partitions ? '开' : '关'}`,
    breaker: (s) => `熔断状态：${s.breakerOpen === null ? '未知' : s.breakerOpen ? '已熔断（暂停调用中）' : '正常'}`,
    failures: (s) =>
      `最近未恢复的失败：${s.failures.length ? s.failures.map((f) => `${CAUSE_NAME.zh[f.cause]} ${f.count} 次（最后一次 ${localTime(f.lastAt)}）`).join('；') : '无'}`,
    record: (file) => `插件的失败记录（已脱敏）：${file}`,
    step1: '第一步，先问清楚。用 ask_user_question 提问，一次只问一两题，每题都给选项，并留「说不清」。要覆盖这些情况：',
    symptoms: [
      '记不住：说过的事，下次会话里不记得',
      '想不起来：明明存过，但新会话没用上，或者召回的内容不相关',
      '记错了：记忆过时、重复、互相矛盾',
      '串了：A 项目的记忆出现在 B 项目里',
      '报错：状态栏或设置页显示失败、熔断',
      '维护出问题：定期整理失败、记忆概要不更新',
      '变慢：回复明显被拖慢',
      '第一次配置就用不了：key、服务商或本地后端连不上',
    ],
    changes: '第二题问最近改过什么：换了 key、换了服务商或模型、改了网络或代理、升级了 DSH 或插件、什么都没改。',
    match: '上面状态里有未恢复的失败、而用户的描述和它对得上时，直接按那一类查，不要从头猜。',
    step2: (skill) =>
      `第二步，按分类排查。调用 ${skill} 技能，照对应分类的顺序查（记不住 not_saved、想不起来 not_recalled、记错了 stale、串了 cross_project、维护 maintenance、变慢 slow、第一次配置 first_setup；报错按失败类型那一节）。先用 mem0_check（target status），再按清单用 mem0_check 看连接和最近的失败（target failures）。不要自己读文件、发请求或查端口，不要遍历整个目录或扫整盘。`,
    step2b: '先做一轮简短排查，把发现告诉用户，再问要不要继续深入。',
    step3: '第三步，能修就修：先说原因和打算怎么改，用户同意了再改，改完用 mem0_check 验证。问题分三类：配置类（服务商地址、模型名、超时、开关）用 mem0_setting_set 改，它每次都弹确认、改完自己再测；key、后端、存储路径它改不了，告诉用户去设置页哪里改。数据类（记错、重复、串项目）改记忆，删除和重建概要总会弹确认。外部类（服务宕机、额度用完、网络）修不了，只告诉用户原因和该怎么办。',
    step4: '第四步，如果看起来是插件本身的问题，或者你拿不准，替用户起草一份问题报告：写清现象、你查过什么、还差什么。报告要脱敏，不含 key、不含记忆正文。只给用户看，不要提交到任何地方。',
    rulesTitle: '修改的规则：',
    closing: '话要短，像人说话。全程用用户当前的语言。',
  },
  en: {
    intro: 'This is troubleshooting for DSH-Mem0 (the memory plugin). The user started it from "AI troubleshoot" on the settings page without naming a failure: find out what they see first, then check.',
    stateTitle: '[State the plugin attached; do not ask for it again]',
    versions: (s) => `Plugin version ${s.pluginVersion ?? 'unknown'}, DSH version ${s.dshVersion ?? 'unknown'}`,
    backend: (s) => `Backend: ${s.backend === 'oss' ? 'oss (local)' : s.backend === 'unknown' ? 'unknown' : `${s.backend} (cloud)`}, provider ${s.endpoints.length ? s.endpoints.join(', ') : 'unknown'}`,
    switches: (s) => `Auto recall ${s.autoRecall ? 'on' : 'off'}, auto save ${s.autoCapture ? 'on' : 'off'}, project partitions ${s.partitions ? 'on' : 'off'}`,
    breaker: (s) => `Circuit breaker: ${s.breakerOpen === null ? 'unknown' : s.breakerOpen ? 'open (calls paused)' : 'closed'}`,
    failures: (s) =>
      `Recent failures not recovered: ${s.failures.length ? s.failures.map((f) => `${CAUSE_NAME.en[f.cause]} ×${f.count} (last ${localTime(f.lastAt)})`).join('; ') : 'none'}`,
    record: (file) => `The plugin's failure record (redacted): ${file}`,
    step1: 'Step 1, find out first. Ask with ask_user_question, one or two questions at a time, each with choices and a "Can\'t tell" choice. Cover these:',
    symptoms: [
      'Not remembered: something said earlier is not known in a later session',
      'Not recalled: it was stored, but a new session did not use it, or what was recalled is unrelated',
      'Wrong: memories are outdated, duplicated or contradict each other',
      'Mixed up: memories of project A show up in project B',
      'Errors: the status bar or settings page shows failures or the circuit breaker',
      'Maintenance: the periodic check fails, the memory summary does not update',
      'Slow: replies are clearly slower',
      'First setup does not work: the key, the provider or the local backend cannot be reached',
    ],
    changes: 'The second question asks what changed recently: the key, the provider or model, the network or proxy, an upgrade of DSH or the plugin, nothing.',
    match: 'When the state above has failures not recovered and the user\'s description matches one, check that type directly instead of guessing from scratch.',
    step2: (skill) =>
      `Step 2, check by category. Load the skill ${skill} and follow the matching section in order (not remembered not_saved, not recalled not_recalled, wrong stale, mixed up cross_project, maintenance maintenance, slow slow, first setup first_setup; errors by their failure type). Start with mem0_check (target status), then check the connection and recent failures (target failures) with mem0_check as the checklist says. Do not read files, send requests or check ports yourself; never walk a whole folder or scan the disk.`,
    step2b: 'Do one short round of checks first, tell the user what you found, then ask whether to dig deeper.',
    step3: 'Step 3, fix what you can: say the cause and the planned change, change it once the user agrees, then check with mem0_check. Problems come in three kinds: configuration (provider address, model name, timeouts, switches) is changed with mem0_setting_set, which always asks and checks again afterwards; keys, the backend and the store path it cannot change: tell the user where on the settings page. Data (wrong, duplicated or mixed-up memories) means changing memories; deleting and rebuilding the summary always ask. External (a service down, quota used up, the network) cannot be fixed here: tell the user the cause and what to do.',
    step4: 'Step 4, if it looks like a problem in the plugin itself, or you are not sure, draft an issue report for them: what happens, what you checked, what is still missing. Keep it redacted: no key, no memory text. Show it to the user only; never submit it anywhere.',
    rulesTitle: 'Rules for changes:',
    closing: 'Keep it short and plain. Use the user\'s current language throughout.',
  },
}

/**
 * The whole general prompt. `state` from generalState; `confirm` 'each' or
 * 'skip' (diagnosisFixRules); `tools` `{ write, alwaysConfirm, status }`;
 * `recordFile` the path of failures.json, or null.
 */
export function buildGeneralPrompt(state, { lang = 'en', confirm = 'each', tools = {}, settingsFile = 'cordis.patch.yml', recordFile } = {}) {
  const copy = TEXT[lang === 'zh' ? 'zh' : 'en']
  const rules = diagnosisFixRules({ lang, confirm, tools, settingsFile })
  return [
    copy.intro,
    '',
    copy.stateTitle,
    copy.versions(state),
    copy.backend(state),
    copy.switches(state),
    copy.breaker(state),
    copy.failures(state),
    ...(recordFile ? [copy.record(recordFile)] : []),
    '',
    copy.step1,
    ...copy.symptoms.map((line) => `- ${line}`),
    copy.changes,
    copy.match,
    '',
    copy.step2(DIAGNOSE_SKILL),
    copy.step2b,
    '',
    copy.step3,
    copy.step4,
    '',
    copy.rulesTitle,
    ...rules.map((rule) => `- ${rule}`),
    '',
    copy.closing,
  ].join('\n')
}

/**
 * The diagnosis knowledge base: which places to check and in what order,
 * one section per failure type (lib/failure-history.js FAILURE_CAUSES) and
 * one per symptom a user may describe without a failure to point at
 * (DIAGNOSE_SYMPTOM_SECTIONS: not remembered, not recalled, wrong memories,
 * memories of another project, maintenance, slow replies, first setup). A
 * diagnosis prompt points the model at one section, so it checks a few
 * known places instead of reading through the plugin's source.
 *
 * Two ways it reaches the model:
 * - the skill `dsh-mem0-kb`, which the plugin offers through DSH's skill
 *   registry (`ctx.skills.registerProvider`, the way dsh-skill-office ships
 *   its skills), listed only for the diagnosis sessions the plugin opened
 *   (by session id, whatever workspace they run in), so no other session's
 *   catalog grows by a line;
 * - the one section of its type written into the prompt (`checklistFor`):
 *   for copied text, which may be pasted where the skill is not offered,
 *   and on DSH versions without the skill registry.
 *
 * In a diagnosis session (the skill, and the prompt's own section) the
 * checks go through mem0_check and setting changes through
 * mem0_setting_set (lib/diagnose-tools.js): the same checks and saves as
 * the settings page, redacted, so the model neither reads files nor sends
 * requests itself. Copied text (`checklistFor(…, { tools: false })`), pasted
 * where those tools do not exist, keeps the plain checks: mem0_status, the
 * redacted failure record (`<profile>/dsh-mem0/failures.json`), one GET
 * without a key, a listening-port check. Never a key or a credential file.
 * Changes come after the user agrees (lib/diagnose-report.js
 * diagnosisFixRules).
 */
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
  not_saved: { zh: '记不住', en: 'not remembered' },
  not_recalled: { zh: '想不起来', en: 'not recalled' },
  stale: { zh: '记错了', en: 'wrong memories' },
  cross_project: { zh: '串了', en: 'another project\'s memories' },
  maintenance: { zh: '维护出问题', en: 'maintenance' },
  slow: { zh: '变慢', en: 'slow replies' },
  first_setup: { zh: '第一次配置就用不了', en: 'first setup does not work' },
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
  zh: '读一次插件自己的失败记录 failures.json（路径写在提示词里；已脱敏，最多 20 条）',
  en: 'Read the plugin\'s own failure record failures.json once (its path is in the prompt; redacted, at most 20 entries)',
}
// Reading proxy variables needs a wider sandbox in DSH (a live run asked to
// escalate for it): the user knows how their proxy is set.
const PROXY = {
  zh: '用户说改过网络或代理：直接问用户代理是怎么设的（系统代理、环境变量还是代理软件，本机地址有没有绕过代理），不要自己去读环境变量。',
  en: 'If the user changed the network or proxy: ask them how the proxy is set (system proxy, environment variables or a proxy app, and whether local addresses bypass it); do not read environment variables yourself.',
}
// The same steps through the diagnosis tools (lib/diagnose-tools.js).
const CHECK_STATUS = {
  zh: '调用一次 mem0_check（target status：当前生效的设置，只读，不联网，不显示 key）',
  en: 'Call mem0_check once (target status: the settings in effect; read-only, no network, never shows keys)',
}
const CHECK_PROBE = {
  zh: '用 mem0_check 测一次连接：本地后端用 target embedder 或 llm（用已保存的设置和 key 真发一次测试请求），云端后端用 target connection；不要自己用 web_fetch 或 curl 发请求。',
  en: 'Test the connection with mem0_check: target embedder or llm on the local backend (one real test call with the saved settings and key), target connection on a cloud backend; do not send requests yourself with web_fetch or curl.',
}
const CHECK_RECORD = {
  zh: '调用一次 mem0_check（target failures：未恢复的失败，已脱敏）',
  en: 'Call mem0_check once (target failures: the open failures, redacted)',
}
const TOOL_SUBSTITUTIONS = [
  [STATUS, CHECK_STATUS],
  [PROBE, CHECK_PROBE],
  [RECORD, CHECK_RECORD],
]

const SEARCH = {
  zh: '用 mem0_search 按用户说的那件事搜一次（只看相关的几条和它们的分区，不要整库翻）',
  en: 'Run mem0_search once for the thing the user names (look at the few hits and their partition only; never page through the store)',
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
    { zh: PROXY.zh, en: PROXY.en },
    { zh: '结论：服务本身慢就调高对应的超时；连不上按「connection」处理；只发生一两次可以先观察。', en: 'Conclude: a slow service needs the matching timeout raised; no answer at all is a "connection" problem; a one-off can be watched first.' },
  ],
  connection: [
    { zh: `${STATUS.zh}：看 endpoint、embedder、extraction LLM 行，确认是哪个组件、哪个地址连不上。`, en: `${STATUS.en}: read the endpoint, embedder and extraction LLM lines to see which component and which address fail.` },
    { zh: `${PROBE.zh}区分拒绝连接（服务没开或端口不对）、DNS 失败（地址写错）、超时（网络或代理）。`, en: `${PROBE.en} Tell apart refused (service down or wrong port), DNS failure (wrong address) and timeout (network or proxy).` },
    { mode: 'plain', zh: '地址是 127.0.0.1 或 localhost 时，用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 看有没有服务在监听。', en: 'For 127.0.0.1 or localhost, check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` that something listens.' },
    { mode: 'tools', zh: '地址是 127.0.0.1 或 localhost 时，用 mem0_check target probe 看本机常见的模型服务（Ollama、LM Studio、oMLX）有没有在跑、在哪个端口。', en: 'For 127.0.0.1 or localhost, run mem0_check target probe to see whether the usual local model servers (Ollama, LM Studio, oMLX) run, and on which port.' },
    { zh: PROXY.zh, en: PROXY.en },
    { mode: 'plain', zh: '结论：说清楚要启动哪个服务，或在设置页（本地后端在配置向导）把地址改成什么。', en: 'Conclude: name the service to start, or the address to set in the settings (the setup wizard on the local backend).' },
    { mode: 'tools', zh: '结论：服务没开就说清楚要启动哪个（这个修不了，告诉用户）；地址写错，用户同意后用 mem0_setting_set 改（本地后端 embedderBaseUrl 或 llmBaseUrl，云端 server 后端 baseUrl），它会先测再存。', en: 'Conclude: a service that is down needs starting (you cannot fix that; tell the user); a wrong address is changed with mem0_setting_set once the user agrees (embedderBaseUrl or llmBaseUrl on the local backend, baseUrl on a server backend); it tests before it saves.' },
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
    { mode: 'tools', zh: '模型名可能写错（报错里有 model not found、404、unknown model）：用 mem0_check target models（component embedder 或 llm）列出服务上的模型名，和设置里的对比。', en: 'A model name may be wrong (model not found, 404 or unknown model in the message): list the server\'s model names with mem0_check target models (component embedder or llm) and compare with the setting.' },
    { zh: '用户说升级过 DSH 或设置丢了：看 warning 行有没有提到 cordis.patch.yml 被移走、有没有备份。', en: 'If the user upgraded DSH or settings went missing: see whether the warning line says cordis.patch.yml was moved aside and whether a backup exists.' },
    { mode: 'plain', zh: '结论：指明在设置页或配置向导里把哪一项改成什么；改好之前重试没用。', en: 'Conclude: name the setting and the value, in the settings or the setup wizard; retrying does not help until then.' },
    { mode: 'tools', zh: '结论：说清楚哪一项改成什么；在 mem0_setting_set 的白名单里，用户同意后用它改，改完它会自己再测一次；不在白名单里（key、后端、存储路径、嵌入换代要重算向量）就告诉用户去设置页或配置向导哪里改。', en: 'Conclude: name the setting and the value; if mem0_setting_set allows it, change it with that once the user agrees (it checks again afterwards); otherwise (keys, backend, store path, an embedder change that recomputes vectors) tell the user where to change it in the settings or the setup wizard.' },
  ],
  other: [
    { zh: '先按用户说的现象定方向：没记住看保存（capture），想不起来看召回（recall），变慢看耗时。', en: 'Let the user\'s answer set the direction: not remembered is capture, not recalled is recall, slow is timing.' },
    { zh: `${STATUS.zh}。`, en: `${STATUS.en}.` },
    { zh: `http_status 是 5xx：服务端出错。${PROBE.zh}看现在是否还在报错；本地网关就看网关本身是否正常。`, en: `http_status 5xx: the server failed. ${PROBE.en} See whether it still fails; for a local gateway, check the gateway itself.` },
    { zh: `${RECORD.zh}，看同类失败从什么时候开始、是否和别的失败一起出现。`, en: `${RECORD.en}: when did this kind of failure start, and does it come with others?` },
    { zh: '还是定位不了：如实说，列出已经排除的和还需要用户提供的信息（比如网关日志里对应时间的一行）。', en: 'Still unclear: say so, with what you ruled out and what the user could add (say, the gateway\'s log line at that time).' },
  ],
}

/**
 * Symptom sections, for a user who cannot point at one failure (the
 * general "AI troubleshoot" entry). Keys are the symptom ids the general
 * prompt asks about (lib/diagnose-general.js); an error a user sees goes to
 * the section of its failure type instead.
 */
const SYMPTOM_CHECKLISTS = {
  not_saved: [
    { zh: `${STATUS.zh}：看 autoCapture 开没开，和 last capture 行（时间、结果、跳过的原因）。`, en: `${STATUS.en}: is autoCapture on, and what does the last capture line say (time, result, why it was skipped)?` },
    { zh: `${SEARCH.zh}：搜得到就是存了没用上，转「not_recalled」；搜不到才是没存。`, en: `${SEARCH.en}: a hit means it was saved but not used (go to "not_recalled"); no hit means it was not saved.` },
    { zh: 'last capture 是 skipped：captureFilter（heuristic 会跳过寒暄和太短的话）或重复判定（captureTurnDedupThreshold）把它挡了；是 failed：按那条失败的类型查。', en: 'Last capture skipped: captureFilter (heuristic skips small talk and very short turns) or the duplicate check (captureTurnDedupThreshold) held it back; failed: follow the section of that failure type.' },
    { zh: '结论：autoCapture 关着就在设置页打开；过滤太严可以把 captureFilter 改成 off，或者这一条用 mem0_add 直接记（会按确认规则弹确认）。', en: 'Conclude: autoCapture off means turning it on in the settings; a filter that is too strict means captureFilter off, or storing this one with mem0_add (it asks as the confirmation rules say).' },
  ],
  not_recalled: [
    { zh: `${STATUS.zh}：看 autoRecall 开没开，和 last recall 行（命中几条、耗时、有没有超时）。`, en: `${STATUS.en}: is autoRecall on, and what does the last recall line say (hits, time, timeout)?` },
    { zh: `${SEARCH.zh}，用用户这次的问题当查询：搜不到转「not_saved」；搜得到但没召回，看它是不是在别的项目分区（projectPartitions）、recallTopK 和 memoryBudgetTokens 是不是太小。`, en: `${SEARCH.en}, with the user's question as the query: no hit goes to "not_saved"; a hit that was not recalled: is it in another project's partition (projectPartitions), are recallTopK and memoryBudgetTokens too small?` },
    { zh: '召回的内容不相关：看命中的分数，recallTopK 调小；不相关的旧记忆可以改正或删掉（转「stale」）。', en: 'Unrelated recalls: look at the hit scores and lower recallTopK; unrelated old memories can be corrected or removed (go to "stale").' },
    { zh: 'last recall 超时：按「timeout」一节查。', en: 'Last recall timed out: follow the "timeout" section.' },
    { zh: '结论：说清楚改哪一项设置，或者要修正哪几条记忆。', en: 'Conclude: name the setting to change, or the memories to correct.' },
  ],
  stale: [
    { zh: `${SEARCH.zh}，确认哪几条过时、重复或互相矛盾；只把这几条的大意告诉用户。`, en: `${SEARCH.en} and find which memories are outdated, duplicated or contradict each other; tell the user only the gist of those.` },
    { zh: `${STATUS.zh}：看 hygiene 行（定期整理开没开、上次什么时候、结果）。整理关着或很久没跑，重复就会越积越多。`, en: `${STATUS.en}: read the hygiene line (on or off, last run, result). With hygiene off or stale, duplicates pile up.` },
    { zh: '要改：过时的用 mem0_update 改正，重复的用 mem0_delete 删掉（删除总会弹确认），重要的用 mem0_pin 置顶。', en: 'To fix: correct outdated ones with mem0_update, remove duplicates with mem0_delete (deleting always asks), pin important ones with mem0_pin.' },
    { zh: '错在记忆概要里：用 mem0_profile_get 看，mem0_profile_update 改那几行；重建概要 mem0_profile_reset 总会弹确认，只在概要整体不对时用。', en: 'Wrong in the memory summary: read it with mem0_profile_get and fix the lines with mem0_profile_update; rebuilding with mem0_profile_reset always asks and is only for a summary that is wrong throughout.' },
  ],
  cross_project: [
    { zh: `${STATUS.zh}：看 backend 和 projectPartitions，以及当前项目是怎么认出来的（scope 行）。`, en: `${STATUS.en}: read backend and projectPartitions, and how the current project was recognised (the scope line).` },
    { zh: '后端是 platform 或 server：所有记忆都是全局的，没有项目分区，如实告诉用户这是限制。', en: 'Backend platform or server: every memory is global and there are no project partitions; tell the user it is a limitation.' },
    { zh: `本地后端：${SEARCH.zh}，看串过来的那条是 global 还是别的项目；projectPartitions 关着就在设置页打开。`, en: `Local backend: ${SEARCH.en}; is the stray memory global or from another project? projectPartitions off means turning it on in the settings.` },
    { zh: '要改：只属于那个项目的事被存成全局，在设置页「记忆」标签把它移到对应项目，或者删掉后在那个项目里重新记。', en: 'To fix: a project-only fact stored as global can be moved to its project on the settings page\'s Memories tab, or removed and stored again in that project.' },
  ],
  maintenance: [
    { zh: `${STATUS.zh}：看 hygiene 行（上次时间、结果、下次）和 summary 行（概要上次更新）。`, en: `${STATUS.en}: read the hygiene line (last run, result, next run) and the summary line (last update).` },
    { zh: `${RECORD.zh}，找 maintenance 或 summary 的失败，按它的类型那一节查。`, en: `${RECORD.en} and find maintenance or summary failures; follow the section of their type.` },
    { zh: '整理没跑：hygieneEnabled 关着，或者 modelHygiene 开着但 DSH 当前没有可用模型；概要不更新：profileEnabled 关着。', en: 'Hygiene did not run: hygieneEnabled is off, or modelHygiene is on but DSH has no usable model; the summary does not update: profileEnabled is off.' },
    { zh: '结论：在设置页「维护」标签手动跑一次巡检，或者打开对应设置；概要整体不对才用 mem0_profile_reset（总会弹确认）。', en: 'Conclude: run a check by hand on the settings page\'s Maintenance tab, or turn the setting on; use mem0_profile_reset (always asks) only for a summary that is wrong throughout.' },
  ],
  slow: [
    { zh: `${STATUS.zh}：看 last recall 的分步耗时和 recallTimeoutMs。`, en: `${STATUS.en}: read the step timings of the last recall and recallTimeoutMs.` },
    { zh: '召回在每轮回复之前跑，保存在后台跑、不拖慢回复：慢多半是召回（嵌入或检索）或注入的记忆太多（memoryBudgetTokens、profileBudgetTokens）。', en: 'Recall runs before each reply and saving runs in the background without delaying it: slowness is usually recall (embedding or search) or too much injected memory (memoryBudgetTokens, profileBudgetTokens).' },
    { zh: '本地嵌入模型反复冷启动：embedderKeepAlive 调长；远端服务慢：按「timeout」一节查。', en: 'A local embedder that keeps cold-starting: lengthen embedderKeepAlive; a slow remote service: follow the "timeout" section.' },
    { zh: '结论：说清楚改哪一项、改成多少。', en: 'Conclude: name the setting and the value.' },
  ],
  first_setup: [
    { zh: `${STATUS.zh}：看 backend、key source（只有来源，没有 key）、endpoint、store 和 warning 行。`, en: `${STATUS.en}: read backend, key source (where the key comes from, not the key), endpoint, store and the warning lines.` },
    { zh: 'platform 或 server：key source 是空的，请用户在设置页填 key（不要让用户把 key 贴进对话）；endpoint 不对，在设置页改地址。', en: 'Platform or server: an empty key source means the user enters the key on the settings page (never ask them to paste it into the chat); a wrong endpoint is changed in the settings.' },
    { zh: `本地后端：配置向导里的嵌入模型、抽取模型和存储路径；${PROBE.zh}`, en: `Local backend: the embedder, extraction model and store path in the setup wizard; ${PROBE.en}` },
    { mode: 'tools', zh: '本地后端想整体验一遍：mem0_check target selftest（用单独的测试用户写入、搜索、删除一条测试记忆，不碰用户的记忆）。', en: 'To check the local backend end to end: mem0_check target selftest (writes, searches and deletes one test memory under a separate test user; the user\'s memories are not touched).' },
    { zh: '有报错就按报错的类型转「auth」「connection」或「config」一节。', en: 'With an error, follow the "auth", "connection" or "config" section by its type.' },
  ],
}

/** Ids of the symptom sections, in the order the general prompt asks. */
export const DIAGNOSE_SYMPTOM_SECTIONS = Object.freeze(Object.keys(SYMPTOM_CHECKLISTS))

/** Every section of the skill: failure types first, then symptoms. */
export const DIAGNOSE_SECTIONS = Object.freeze([...Object.keys(CHECKLISTS), ...DIAGNOSE_SYMPTOM_SECTIONS])
const ALL_CHECKLISTS = { ...CHECKLISTS, ...SYMPTOM_CHECKLISTS }

function language(lang) {
  return lang === 'zh' ? 'zh' : 'en'
}

/** The section of a failure entry: its cause, or `other` for anything unknown. */
export function sectionFor(entry) {
  return Object.hasOwn(CHECKLISTS, entry?.cause) ? entry.cause : 'other'
}

/**
 * One line's text: `tools` true for a diagnosis session (mem0_check and
 * mem0_setting_set exist), false for copied text.
 */
function lineText(line, key, tools) {
  let text = line[key]
  if (!tools) return text
  for (const [plain, checked] of TOOL_SUBSTITUTIONS) text = text.split(plain[key]).join(checked[key])
  return text
}

function forMode(line, tools) {
  return !line.mode || line.mode === (tools ? 'tools' : 'plain')
}

/**
 * The checklist lines of one failure, in order. An extraction failure gets
 * the lines of its own reason only; without a known reason, all of them.
 * `tools`: whether the diagnosis tools exist where the text goes (a
 * diagnosis session: true; copied text: false).
 */
export function checklistFor(entry, { lang = 'en', tools = false } = {}) {
  const section = sectionFor(entry)
  const lines = CHECKLISTS[section].filter((line) => forMode(line, tools))
  const known = lines.some((line) => line.reason && line.reason === entry?.reason)
  return lines.filter((line) => !line.reason || !known || line.reason === entry.reason).map((line) => lineText(line, language(lang), tools))
}

const SKILL_TEXT = {
  zh: {
    description: 'Mem0 记忆插件的排查清单：每种失败类型和每种现象按什么顺序查哪几处。只在 Mem0 排查会话里用。',
    intro: [
      `# ${DIAGNOSE_SKILL}：Mem0 排查清单`,
      '',
      '在 Mem0 排查会话里，问完用户之后用。只照提示词点名的那一节（或用户描述对应的那一节）查，按顺序，查到原因就停。',
      '',
      '## 通用规则',
      '- 每一步只做一件事；拿到能下结论的信息就停，不要把整节跑完。',
      '- 先做一轮简短排查（工具调用尽量控制在 10 次以内），把发现告诉用户，再问要不要继续深入。',
      '- 不要通读插件源码，不要遍历目录或在整个磁盘里搜索。',
      '- 不要读取、打印或索要 API key 和凭据文件。只有现象和记忆内容有关时才看相关的几条记忆，问题报告里不写记忆正文。',
      '- 查用 mem0_check（和设置页同一套检测，已脱敏），不要自己读 failures.json、用 web_fetch 或 curl 发请求、查端口，也不要申请提权去读环境变量。',
      '- 问题分三类：',
      '  - 配置类（服务商地址、模型名、超时、开关）：能测也能改。用户同意后用 mem0_setting_set 改，它每次都弹确认，改完自己再测一次。key、后端、存储路径不在它的白名单里，告诉用户去设置页哪里改。',
      '  - 数据类（记错、重复、串项目）：改的是记忆，用 mem0_update、mem0_delete、mem0_pin；删除和重建概要（mem0_profile_reset）总会弹确认。',
      '  - 外部类（服务宕机、额度用完、网络）：修不了，只告诉用户原因和该找谁、怎么做。',
      '- 能修就修：先说原因和打算怎么改，用户同意了再改。mem0_setting_set 改完自己会再测，不用另外验证；改记忆后用 mem0_check 看一次。mem0_delete、mem0_profile_reset 和 mem0_setting_set 总会弹确认。',
      '- 不要直接改 cordis.patch.yml 或 oss.json（DSH 和插件会改写它们）：插件设置用 mem0_setting_set，它改不了的告诉用户去设置页哪一项改成什么。',
      '- 回答格式：一句结论；一到三条依据；打算怎么改。定位不了：已经排除了什么、还缺什么信息。',
    ],
  },
  en: {
    description: 'Checklists for troubleshooting the Mem0 memory plugin: which places to check, in what order, for each failure type and each symptom. For Mem0 troubleshooting sessions only.',
    intro: [
      `# ${DIAGNOSE_SKILL}: Mem0 troubleshooting checklists`,
      '',
      'Use in a Mem0 troubleshooting session, after asking the user. Follow only the section the prompt names (or the one that matches what the user describes), in order, and stop once you find the cause.',
      '',
      '## General rules',
      '- One thing per step; stop as soon as you can conclude, without running the whole section.',
      '- Do one short round of checks first (about 10 tool calls), tell the user what you found, then ask whether to dig deeper.',
      '- Do not read through the plugin source, walk directories or search the whole disk.',
      '- Do not read, print or ask for API keys or credential files. Look at a few memories only when the symptom is about their content, and never put memory text in an issue report.',
      '- Check with mem0_check (the settings page\'s own checks, redacted); do not read failures.json, send requests with web_fetch or curl, check ports or ask for wider permissions to read environment variables yourself.',
      '- Problems come in three kinds:',
      '  - Configuration (provider address, model name, timeouts, switches): can be tested and changed. Once the user agrees, change it with mem0_setting_set; it always asks and checks again afterwards. Keys, the backend and the store path are not on its list: tell the user where to change them on the settings page.',
      '  - Data (wrong, duplicated or mixed-up memories): the memories change, with mem0_update, mem0_delete, mem0_pin; deleting and rebuilding the summary (mem0_profile_reset) always ask.',
      '  - External (a service down, quota used up, the network): cannot be fixed here; tell the user the cause and who or what can fix it.',
      '- Fix what you can: say the cause and the planned change, and change it once the user agrees. mem0_setting_set checks again by itself, so no further check is needed; after changing memories, check once with mem0_check. mem0_delete, mem0_profile_reset and mem0_setting_set always ask.',
      '- Do not edit cordis.patch.yml or oss.json directly (DSH and the plugin rewrite them): change plugin settings with mem0_setting_set, and for what it cannot change tell the user which setting on the settings page to change and to what.',
      '- Answer: the cause in one sentence; one to three facts; the planned change. Unclear: what you ruled out and what is missing.',
    ],
  },
}

/**
 * The prompt rules of a diagnosis session about the tools and the three
 * kinds of problem (configuration, data, external). The skill's general
 * rules say the same.
 */
export function diagnoseToolRules({ lang = 'en' } = {}) {
  return language(lang) === 'zh'
    ? [
        '查用 mem0_check（和设置页同一套检测，已脱敏），不要自己读 failures.json、用 web_fetch 或 curl 发请求、查端口，也不要申请提权去读环境变量。',
        '配置类问题（服务商地址、模型名、超时、开关）能测也能改：用户同意后用 mem0_setting_set 改，改完它自己再测一次，不用另外验证；key、后端、存储路径它改不了，告诉用户去设置页哪里改。',
        '数据类问题（记错、重复、串项目）改的是记忆：删除和重建概要总会弹确认。',
        '外部类问题（服务宕机、额度用完、网络）修不了：只告诉用户原因和该怎么办。',
      ]
    : [
        'Check with mem0_check (the settings page\'s own checks, redacted); do not read failures.json, send requests with web_fetch or curl, check ports or ask for wider permissions to read environment variables yourself.',
        'Configuration problems (provider address, model name, timeouts, switches) can be tested and changed: once the user agrees, change them with mem0_setting_set, which checks again afterwards, so no further check is needed; keys, the backend and the store path it cannot change: tell the user where on the settings page.',
        'Data problems (wrong, duplicated or mixed-up memories) change memories: deleting and rebuilding the summary always ask.',
        'External problems (a service down, quota used up, the network) cannot be fixed here: tell the user the cause and what to do.',
      ]
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
    ALL_CHECKLISTS[section].filter((line) => forMode(line, true)).forEach((line, index) => lines.push(`${index + 1}. ${lineText(line, key, true)}`))
  }
  return lines.join('\n')
}

/**
 * Offer the skill to the diagnosis sessions the plugin opened, in whatever
 * workspace they run. DSH's skill lookups pass the viewing agent as
 * `options.scope` (dsh-tool-skill: `{ cwd, signal, scope: exec.agent }`);
 * `inDiagnosis(session)` says whether its session is one of ours. Lookups
 * without an agent (the user's own skill picker) and every other session
 * get nothing. `onChange(listener)` reports record changes, so a session
 * registered after a catalog was cached sees the skill on its first turn.
 * `lang()` is the language of the latest prompt. Calls `onReady(true)`
 * once the provider is registered; DSH without the skill registry never
 * calls it, and the prompt then carries the checklist itself.
 */
export function registerDiagnoseSkill(ctx, { inDiagnosis = () => false, onChange, lang = () => 'en', onReady = () => {}, logger } = {}) {
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
    const offered = (options) => {
      try {
        return inDiagnosis(options?.scope?.session) === true
      } catch {
        return false
      }
    }
    try {
      skills.registerProvider((control) => {
        const stop = typeof onChange === 'function' ? onChange(() => control?.invalidate?.()) : undefined
        control?.signal?.addEventListener?.('abort', () => stop?.(), { once: true })
        return {
          name: DIAGNOSE_SKILL_PROVIDER,
          async list(options) {
            return offered(options) ? [{ ...summary(), rank: SKILL_RANK, locator: DIAGNOSE_SKILL }] : []
          },
          async get(candidate, options) {
            if (candidate?.name !== DIAGNOSE_SKILL || !offered(options)) return undefined
            return { ...summary(), content: diagnoseSkillContent({ lang: lang() }) }
          },
        }
      })
      onReady(true)
    } catch (error) {
      logger?.warn?.(`dsh-mem0: could not offer the diagnosis skill: ${error.message}`)
    }
  })
}

# Release notes

English is the default; the Chinese version follows below.

## English

### Unreleased

- **Localized plugin page in DSH.** DSH's plugin page now shows a page written for it instead of the GitHub README: `meta.detail` in `locale/en.json` and `locale/zh.json` points to `docs/plugin-page.en.md` and `docs/plugin-page.zh-CN.md`. Chinese users see Chinese, other languages fall back to English. The pages drop the GitHub-only language switch and HTML, use absolute links, and show screenshots from the package. Only these two files are added to the package. Needs a DSH version that reads `meta.detail` (0.2.2-rc.1 does); older versions keep showing the README.
- **Failure history and a status bar that explains itself.** The last 20 memory failures (capture, recall, summary, maintenance) are kept in `<DSH profile>/dsh-mem0/failures.json`, so a later success or a restart no longer hides why memory failed. Each entry has the time, kind, backend, duration and a cause: timeout, connection (refused, DNS, reset), auth or quota (HTTP 401/403/429, quota and rate-limit messages), circuit-breaker skip, or other. Repeated identical failures fold into one entry with a count. Messages are redacted before they are stored (no keys, tokens, memory text or home-directory paths) and capped at 240 characters; the file is written atomically, and a corrupt file is ignored and replaced. The Memory activity card lists them under **Recent failures**. The composer status now tells two cases apart: **Memory failed** when a capture or recall failed, and **Status unavailable** when the page could not read the plugin's status. Hover shows the cause, and a click opens it in place: kind, cause, message and time. The mock server (`scripts/mock-mem0-server.mjs`) can now inject delays, HTTP errors (401, 429, …) and dropped connections through `POST /__fault`.

### v0.3.1 — first-turn recall and dsh-strata interop

**Upgrade recommended for everyone**: in 0.3.0 and earlier, automatic recall never ran on a session's first turn, and on later turns it searched with the previous turn's question.

Fixes:

- **Recall now runs on the first turn and searches with the current question** (#13). DSH claims the user's message and builds the system prompt before the message reaches the session history, so the plugin read the wrong question. It now listens to `agent/inbox/claimed` and searches with the claimed user text; later steps of the same turn reuse that turn's recall block without a second search. The cache layout is unchanged.

dsh-strata interop (#11, #12):

- **Shared recall budget.** When the dsh-strata plugin is installed, recall asks its `strataBudget` service (`ctx.get('strataBudget')`) how much of `memoryBudgetTokens` it may use under the current context pressure, and fits the `mem0:recall` block to that allowance. Errors or bad values fall back to the configured budget. Without dsh-strata nothing changes. The memory summary section is never resized. `mem0_status` and the settings page's Memory activity card show the budget, e.g. `recall budget 1100 / 2200 (strata: tight)`.
- **Optional fold capture.** New `captureStrataFolds` setting (default **off**). With it and `autoCapture` on, dsh-strata's tier-1 `strata/fold-landed` summaries of main-agent sessions are redacted and saved as memories (metadata `source: "dsh"`, `via: "dsh-strata"`). This captures the same turns a second time as a cleaner summary; Mem0's own inference dedupes facts.
- **Documented interop contract.** The READMEs describe how context plugins can recognise and trim DSH-Mem0's injected blocks; the block names and tags are exported as constants and covered by a contract test.

Verification: 150 Node tests and 17 Python tests pass; `npm run check` passes.

### v0.3.0 — safer hygiene, privacy and cache-friendly injection

This release fixes the issues found in a full code review. **Upgrade recommended**: earlier versions' memory hygiene could delete memories this plugin did not write. v0.2.3 was released on GitHub only and never published to npm; this is the first npm release.

Behavior changes to know about:

- **Memory hygiene only deletes memories written by this plugin** (`metadata.source: "dsh"`). Automatic passes only preview until you confirm a manual run once in the settings page. Ranking now uses pinned/importance, then freshness (about 90-day decay); text length only breaks ties.
- **Memory translation is now opt-in** (`translateMemories`, default off), because it sends memory text to the DSH default model. Turn it on in the settings page if you used it before.
- **The OSS sidecar gets an allowlisted environment.** System, proxy, Python, model-cache and common LLM provider variables are passed through; anything else your Mem0 OSS config relies on must be listed in the new `sidecarEnv` setting.
- **The memory summary is a stable system-prompt section** (`plugin:dsh-mem0:profile`), and recall is a separate `mem0:recall` context appended last, so recall changing every turn no longer breaks the cached prompt prefix.

Fixes:

- Recall state resets every turn even with `autoCapture` off; long tool-heavy turns are captured again (user messages plus the final reply).
- A cold or crashed OSS sidecar no longer stalls recall for up to 15 s: recall skips while it starts in the background, and a failed start is not retried for 30 s.
- `memoryBudgetTokens` is now the real recall limit (the old 3000-character cap is gone). New `recallTimeoutMs` (3 s) and `addTimeoutMs` (120 s) apply on every backend.
- A user message sent mid-turn no longer drops memories already recalled that turn.
- Summary headings follow the memories' language (English by default).
- `mem0_get` checks ownership by ID like update and delete.
- The sidecar closes the connection when an error reply leaves the request body unread.

Privacy and security:

- The working directory is no longer sent as memory metadata.
- The translation cache is owner-only (0600) and drops entries for deleted memories; stored hygiene reports keep only ids and reasons.
- `mem0_status` and the settings page say why a backend was chosen, including when an inherited `MEM0_API_KEY` selected the cloud Platform.
- Redaction now covers Tavily and Google API keys, JWTs, bare Bearer tokens, credentials in URLs and 密码/口令 phrasing.
- The sidecar token is passed on stdin instead of the command line.
- The API key can come from DSH credentials (order: config, DSH credentials, environment).
- The README has a Privacy section describing what leaves the machine for each backend.

Internals: shared `lib/http.js`, legacy config paths in `lib/legacy-paths.js`, the settings page reads the DSH locale, `npm run check` covers every file and runs in CI, the summary state file is cached in memory, and new wiring, client, credentials and Python handler tests.

Verification: 124 Node tests and 17 Python tests pass; `npm run check` and `npm pack` pass.

### v0.2.3 — faster settings page and complete translation

- The settings page now renders from a fast, untranslated status snapshot first; profile and memory translation refreshes in the background instead of blocking the first paint. A cold page open no longer waits for several sequential model calls.
- Memory-summary lines that mix English with embedded Chinese terms are now translated. Previously any Chinese character in a line suppressed translation, which left those lines in English forever.
- Translation batches run concurrently, and the translation cache is persisted under `<profile>/dsh-mem0/translation-cache.json`, so restarts and repeated page opens stay fast.
- The backend selector now shows a top-of-page **Save** button and an **unsaved changes** badge while a backend choice is pending. Selecting Local OSS is saved instead of silently reverting to Auto after re-entering the page.
- The activity dock no longer triggers translation work on every poll.

Verification: 64 Node tests and 4 Python tests pass; `npm run check` and `npm pack` pass.

### v0.2.2 — detailed hygiene report

- The Memory maintenance card now expands into a detailed hygiene report: start/end time, duration, memory and token counts before and after, summary item/token counts, and itemized duplicate, budget-pruned, deleted and failed entries.
- Reports produced by older versions remain readable with a legacy fallback note.
- The new report labels are localized in English and Chinese.

Verification: 59 Node tests and 4 Python tests pass; `npm run check` and `npm pack` pass.

### v0.2.1 — first public release

DSH-Mem0 is a universal long-term memory plugin for DeepSeek Harness. It supports Mem0 Platform, a self-hosted Mem0 REST server, and a local Mem0 OSS Python sidecar behind one configuration surface.

Highlights:

- Automatic recall with `<mem0-relevant-memories>` injection and non-blocking failure handling.
- Automatic capture for completed turns, with heuristic filtering of greetings, short acknowledgements and command-only turns.
- Editable memory summary generated from stored facts, grouped into sections and injected before relevant memories with its own token budget; manual edits persist and agent tools can read/update/reset it. Legacy flat generated summaries are rebuilt automatically on startup without deleting memories.
- Memory and long-term-memory token budgets, store limits, and weekly memory hygiene with duplicate removal, value-based pruning and a manual **Run hygiene now** action.
- Memory text is translated into the page language with the current DSH model, cached, with original-text fallback.
- Searchable **Memory library** and **Last recalled memories** preview in the settings page.
- Rolling dot-matrix status globe: idle is static, active/success roll along a tilted axis, failure is red; the silhouette stays circular and respects reduced motion.
- English and Chinese UI following DSH's language setting.
- The Memory maintenance card shows the latest hygiene report, including scanned, duplicate, pruned, deleted and failed counts, run time and trigger.
- Local-only `link:` installs show the checkout path as DSH install metadata; npm packages contain no local paths.

Verification: 59 Node tests and 4 Python tests pass; `npm run check` and `npm pack` pass.

## 简体中文

### 未发布

- **DSH 插件页本地化。** DSH 的插件页现在显示专门为它写的介绍，而不是 GitHub README：`locale/en.json` 和 `locale/zh.json` 的 `meta.detail` 分别指向 `docs/plugin-page.en.md` 和 `docs/plugin-page.zh-CN.md`。中文用户看到中文，其他语言回退到英文。页面去掉了只在 GitHub 上有用的语言切换行和 HTML，链接改为绝对地址，截图直接取自插件包。包里只新增这两个文件。需要支持 `meta.detail` 的 DSH 版本（0.2.2-rc.1 已支持）；更早的版本仍显示 README。
- **失败记录，状态栏说明失败原因。** 最近 20 次记忆失败（自动保存、自动召回、记忆摘要、记忆整理）保存在 `<DSH profile>/dsh-mem0/failures.json`，之后的成功或重启都不会再让失败原因消失。每条记录包括时间、类型、后端、耗时和原因分类：超时、连接失败（拒绝连接、DNS、连接重置）、认证或额度（HTTP 401/403/429、额度和限流提示）、熔断跳过、其他。连续相同的失败合并成一条并计数。消息在保存前脱敏（不含密钥、token、记忆正文和用户主目录路径），最长 240 字符；文件原子写入，损坏时忽略并在下次写入时替换。「记忆活动」卡片在「最近失败」里列出这些记录。输入框下的状态现在区分两种情况：记忆操作失败显示「记忆失败」，读不到插件状态显示「状态读取失败」。悬停即可看到原因，点击会就地展开：类型、原因、消息和时间。模拟服务器（`scripts/mock-mem0-server.mjs`）新增 `POST /__fault`，可以注入延迟、HTTP 错误（401、429 等）和断开连接。

### v0.3.1 — 首轮召回修复与 dsh-strata 协同

**建议所有用户升级**：0.3.0 及更早版本中，自动召回在会话第一轮从不触发，之后每轮都用上一轮的问题去检索。

修复：

- **召回在第一轮也会运行，并用当前问题检索**（#13）。DSH 先认领用户消息、组装系统提示，之后才把消息写入会话历史，所以插件读到的是错误的问题。现在插件监听 `agent/inbox/claimed`，用认领到的用户文本检索；同一轮后续步骤复用本轮的召回块，不再重复检索。缓存布局不变。

与 dsh-strata 协同（#11、#12）：

- **共享召回预算。** 安装了 dsh-strata 插件时，召回会向它的 `strataBudget` 服务（`ctx.get('strataBudget')`）询问在当前上下文压力下能用多少 `memoryBudgetTokens`，并把 `mem0:recall` 块裁到这个额度。出错或返回值无效时回退到配置的预算；没有 dsh-strata 时行为不变。记忆摘要段永远不会被按轮缩放。`mem0_status` 和设置页的“记忆活动”卡片会显示预算，例如 `recall budget 1100 / 2200 (strata: tight)`。
- **可选的折叠摘要保存。** 新设置 `captureStrataFolds`（默认**关闭**）。它和 `autoCapture` 都打开时，dsh-strata 对主代理会话发出的一级 `strata/fold-landed` 摘要会经过脱敏后存为记忆（元数据 `source: "dsh"`、`via: "dsh-strata"`）。这相当于把同样的对话再以更干净的摘要形式保存一次，Mem0 自身的推理会对事实去重。
- **写明协同约定。** README 说明了上下文插件如何识别和裁剪 DSH-Mem0 注入的块；块名和标签以常量导出，并有约定测试覆盖。

验证：150 个 Node 测试和 17 个 Python 测试通过；`npm run check` 通过。

### v0.3.0 — 更安全的巡检、隐私收紧与缓存友好的注入

本版修复了一次完整代码审阅发现的问题。**建议升级**：旧版的记忆巡检可能删除不是本插件写入的记忆。v0.2.3 只在 GitHub 发布、没有发到 npm；本版是第一个 npm 版本。

需要注意的行为变化：

- **记忆巡检只删除本插件写入的记忆**（`metadata.source: "dsh"`）；在你于设置页确认一次手动巡检之前，自动巡检只出预览。排序改为按置顶/重要度、再按新鲜度（约 90 天衰减），文本长度只用于平局判定。
- **记忆翻译改为手动开启**（`translateMemories`，默认关闭），因为它会把记忆文本发给 DSH 默认模型。之前在用的话，请在设置页重新打开。
- **OSS sidecar 只继承白名单内的环境变量**：系统、代理、Python、模型缓存和常见 LLM 服务商的变量会传入；你的 Mem0 OSS 配置依赖的其他变量，需要写进新的 `sidecarEnv` 设置。
- **记忆摘要改为稳定的系统提示段**（`plugin:dsh-mem0:profile`），召回结果是单独的、放在最后的 `mem0:recall` 上下文，每轮召回变化不再破坏提示词前缀缓存。

修复：

- 关闭 `autoCapture` 时召回状态也会每轮重置；工具调用很多的长回合重新可以保存（用户消息加最终回复）。
- OSS sidecar 冷启动或崩溃后，召回不再卡最多 15 秒：启动期间直接跳过召回、在后台启动；启动失败后 30 秒内不重试。
- `memoryBudgetTokens` 成为召回的真实上限（去掉了原来 3000 字符的限制）；新增 `recallTimeoutMs`（3 秒）和 `addTimeoutMs`（120 秒），对所有后端生效。
- 回合中途插入的用户消息不再让本轮已召回的记忆消失。
- 摘要分节标题跟随记忆语言（默认英文）。
- `mem0_get` 按 ID 读取时和 update/delete 一样检查归属。
- 错误回复留下未读请求体时，sidecar 会关闭连接。

隐私与安全：

- 不再把工作目录作为记忆元数据上传。
- 翻译缓存只允许本人读写（0600），删除记忆时同步清理；保存的巡检报告只保留 ID 和原因。
- `mem0_status` 和设置页会说明为什么选了某个后端，包括因为环境变量里有 `MEM0_API_KEY` 而选了云端 Platform 的情况。
- 脱敏新增 Tavily 和 Google API key、JWT、裸 Bearer token、URL 中的账号密码，以及「密码/口令」写法。
- sidecar token 改为通过 stdin 传递，不再出现在命令行参数里。
- API key 可以来自 DSH credentials（顺序：配置、DSH credentials、环境变量）。
- README 新增隐私一节，按后端说明哪些数据会离开本机。

内部改进：共享的 `lib/http.js`；旧配置路径集中到 `lib/legacy-paths.js`；设置页读取 DSH 语言设置；`npm run check` 覆盖所有文件并在 CI 中运行；摘要状态文件在内存中缓存；新增装配、客户端、credentials 和 Python 请求处理测试。

验证：124 个 Node 测试和 17 个 Python 测试通过；`npm run check` 与 `npm pack` 通过。

### v0.2.3 — 更快的设置页与完整翻译

- 设置页现在先用未翻译的快速状态快照渲染，画像和记忆翻译在后台刷新，不再阻塞首屏显示；冷启动打开页面不再需要等待多次串行模型调用。
- 记忆摘要中英文混排、包含少量中文词的句子现在也会翻译。此前只要句子里出现任何中文字符就会跳过翻译，导致这些句子一直保持英文。
- 翻译批次并发执行，翻译缓存持久化到 `<profile>/dsh-mem0/translation-cache.json`，重启和重复打开页面都能保持快速。
- 后端选择器在有未保存的后端选择时，会在页面顶部显示**保存设置**按钮和**有未保存的修改**提示；选择「本地 OSS」后可以真正保存，不再在重新进入页面后悄悄变回「自动检测」。
- 记忆活动浮标轮询不再触发翻译工作。

验证：64 个 Node 测试和 4 个 Python 测试通过；`npm run check` 与 `npm pack` 通过。

### v0.2.2 — 详细巡检报告

- 「记忆维护」卡片现在可以展开详细巡检报告：开始/结束时间、耗时、巡检前后的记忆数量与 token、摘要条数与 token，以及重复、预算清理、删除和失败明细。
- 旧版本生成的报告仍可读取，并显示兼容提示。
- 新增报告字段已提供中英文文案。

验证：59 个 Node 测试和 4 个 Python 测试通过；`npm run check` 与 `npm pack` 通过。

### v0.2.1 — 首个公开版本

DSH-Mem0 是 DeepSeek Harness 的通用长期记忆插件，在同一套配置下支持 Mem0 Platform、自托管 Mem0 REST server 和本地 Mem0 OSS Python sidecar。

主要更新：

- 自动召回，注入 `<mem0-relevant-memories>`；失败或超时不会阻塞模型请求。
- 完成回合自动保存；启发式过滤会跳过问候、简短确认和纯命令回合。
- 记忆摘要从已存事实生成，按主题分节，在相关记忆之前注入，并有独立 token 预算；用户可随时编辑，Agent 可通过工具读取、更新和重建。旧版扁平摘要会在启动时自动重建，不会删除任何记忆。
- 记忆与记忆摘要 token 预算、存储上限、每周记忆卫生巡检；支持去重、按价值清理和手动「立即巡检」。
- 记忆文本会用当前 DSH 模型翻译成页面语言，带缓存，没有可用模型时回退原文。
- 设置页提供可搜索的「记忆库」和「上次召回的记忆」预览。
- 点阵地球仪前台状态：待命静止，记录/成功时沿倾斜方向滚动，失败变红；滚动时轮廓保持圆形，并尊重「减少动态效果」。
- 界面跟随 DSH 语言设置，内置中英文。
- 「记忆维护」卡片会显示最近一次巡检报告，包括扫描、重复、预算清理、删除和失败数量，以及运行时间和触发方式。
- 本地 `link:` 安装会在 DSH 插件详情中显示本机路径，这是安装元数据；npm 发布包不包含本机路径。

验证：59 个 Node 测试和 4 个 Python 测试通过；`npm run check` 与 `npm pack` 通过。

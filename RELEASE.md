# Release notes

English is the default; the Chinese version follows below.

## English

### Unreleased

- **Only a Qdrant server is supported; embedded Qdrant is rejected before startup** (fixes [#23](https://github.com/light-cheng/DSH-Mem0/issues/23)). The sidecar opens Qdrant twice (read and write paths), and embedded Qdrant (`vector_store.config.path`) locks its folder for one client, so the second open failed and the start only said `START_FAILED`. Now both the plugin (before it starts Python) and the sidecar's `build_memory_config` check `oss.json`: a Qdrant vector store with neither `url` nor `host` + `port` fails at once with "Embedded Qdrant is not supported. Start a Qdrant server and set vector_store.config.url in oss.json" (in English and Chinese) and a README link. It is shown as a **Configuration error** of the vector store on the failure card, in Test connection and in `mem0_status`. It does not count toward the circuit breaker, it is not retried until `oss.json` changes, and repeats fold into one failure entry whatever call hit them. With both `path` and `url`, `url` is used and `path` is ignored with a warning. The README now says server only and gives the shortest way to run one (download, a minimal loopback-only `config.yaml`, the `url` line).
- **The interpreter is found on Windows.** Without `pythonPath`, the plugin now looks under `~/.dsh/mem0` for `venv\Scripts\python.exe`, then `venv\bin\python.exe` / `venv\bin\python` on Windows, and for `venv/bin/python3`, then `venv/bin/python` elsewhere. Before, it looked only for the POSIX layout and on Windows fell back to the PATH `python3` (the Microsoft Store Python, without Mem0). A `pythonPath` you set always wins. When the PATH fallback is used (now `python` on Windows), `mem0_status`, the OSS sidecar block and `sidecar.log` say which interpreter and why. The sidecar checks for `mem0` first, and an interpreter without it fails with `ModuleNotFoundError: No module named 'mem0'` and the interpreter's path (home shown as `~`).
- **The real reason behind "sidecar failed to start recently".** The plugin keeps the latest failed start: time, exit code or signal, and the exception that stopped it (the sidecar's error line, else the last exception in its stderr), redacted and capped. Calls skipped during the restart backoff carry that reason; the failure is stored as cause **Sidecar failed to start** with component OSS sidecar (no longer "Other error"); circuit-breaker skips name it; the OSS sidecar block and `mem0_status` show it with its time. Fixed on the way: "ModuleNotFoundError" matched the `ENOTFOUND` network-error pattern and was classed as a connection failure.
- **Refused connections name host:port, with the Windows reserved-port hint.** When Qdrant or the embedder (Ollama) refuses the connection, at start, in Test connection, on a request or in `mem0_status`, the message reads like "Qdrant unreachable at 127.0.0.1:15333 (connection refused)", with host:port taken from `oss.json` (no scheme, path or credentials), and says what to check: is the service running, and on Windows does its log show `os error 10013` ("access a socket in a way forbidden"), a port inside a reserved range. Windows' "actively refused" (WinError 10061) is recognised too. The failure card shows the same hint in the page language.
- **Settings rewritten by DSH are noticed, and can live outside its reach.** DSH's settings sync has been seen to cut the dsh-mem0 block of `cordis.patch.yml` down to `backend`. The plugin now records which key settings were set the last time it ran fine (names only, in `config-fingerprint.json` next to `failures.json`). When some disappear, the settings page and `mem0_status` say "dsh-mem0 settings look rewritten; missing: …" with how to restore them. Settings may also be kept in a `dsh_mem0` block of `oss.json` (`pythonPath`, `collectionName`, `userId`, `agentId`, `historyDbPath`, `translateMemories`, `captureStrataFolds`), used when the profile does not set them.
- **A sidecar that ignores SIGTERM is killed.** Stopping the sidecar skipped SIGKILL because `child.killed` only says a signal was sent. It now checks whether the process has exited, sends SIGKILL after the stop grace and waits for the exit. On Windows both signals are TerminateProcess, so the first one already ends the launcher.
- **README: Windows troubleshooting.** Reserved port ranges (`netsh int ipv4 show excludedportrange protocol=tcp`, `show dynamicport tcp`), moving Qdrant and Ollama above 15000 (15333 / 15434, with `oss.json` and `OLLAMA_HOST`), the optional admin-only reset of the dynamic range and its risks, service checks, and a checklist after installing or updating a plugin.
- **Fact extraction is no longer cut off by a reasoning model's thinking.** With the OSS backend and a hybrid reasoning model, saves failed with "LLM extraction failed: answer cut off (truncated JSON); retry failed too". Mem0's default output budget of 2000 tokens is shared with the model's thinking: through magpie with `workbuddy/deepseek-v4.1-flash`, 2 of 3 extractions of a 1.4K-character fold summary stopped at `finish_reason=length` after 1.4–1.7K reasoning tokens. Now:
  - The sidecar uses `max_tokens: 8000` for fact extraction when `oss.llm.config` sets none (a value you set always wins). With 8000, 6 of 6 extractions finished; the largest used 2541 output tokens.
  - `oss.llm.config.reasoning_effort` is sent to every model, not only the ones Mem0 knows as reasoning models. `"none"` turns thinking off where the gateway supports it (6 of 6 finished with 0 reasoning tokens and about 850 output tokens even at 2000). `"low"` did not help (3 of 3 still cut off at 2000). It is not sent unless you set it.
  - An answer cut off at `finish_reason=length` is retried once with twice the output budget (capped at 65536), not with the same one. Activity says so while the retry runs.
  - A failed extraction records the call's `finish_reason`, output budget and prompt / output / reasoning token counts in the 502 body, the failure history, the Memory activity card and `sidecar.log`. Numbers only, never text.
  - Extraction failures (cut off, refusal, not JSON, empty) no longer count toward the circuit breaker: the LLM answered, so pausing memory would not help. Connection, timeout, auth and server failures still do.
  - The input side is unchanged: captures stay capped at `captureMaxChars` (2000 characters for dsh-strata folds), and a 2000-character fold summary extracted fine with the larger budget, so no input chunking was added.
- **A save that worked is no longer reported as "not valid JSON; nothing was stored".** After Mem0 had already processed a save, the OSS sidecar parsed the LLM's fact-extraction answer a second time, with a stricter parser than Mem0's, only to count facts for the activity card. When that parse failed, `/add` returned HTTP 500 even though Mem0 had stored the memories. A model that answers with a `<think>…</think>` section containing braces before its JSON triggered it every time. Now:
  - The fact count is for display only and never fails a save. If it cannot be read, Activity shows only the added / updated / deleted counts.
  - The answer is parsed exactly like Mem0 2.2.1 parses it, with Mem0's own `remove_code_blocks` and `extract_json`: a whole-answer code fence, `<think>` sections, a fence anywhere, then the first `{` to the last `}`.
  - A save fails only when Mem0 itself could not use the answer and stored nothing. It then fails with HTTP 502, code `LLM_EXTRACT_FAILED` and a reason: the answer was not JSON, was empty, was cut off (truncated JSON), or the model refused. The failure history shows cause **LLM extraction failed** with that reason, instead of "Other error".
  - Such a save is retried once when the reason is not JSON, empty or truncated: nothing was stored, so a retry cannot store a memory twice. A refusal is not retried. Activity shows **Saved after one retry** or **Retry failed too**. The first failure stays in the failure history, and only the final failure counts toward the circuit breaker.
  - `sidecar.log` never gets the LLM's answer: the sidecar logs only the reason, the answer's length and how it starts (for example `truncated; answer 60 chars, starts with JSON-like`). Mem0 warnings that quote memory or message text (entity names, a rejected message, pydantic input values) are scrubbed, and other libraries' log messages are capped at 500 characters.
- **"Nothing new" instead of a green "Saved" when a capture wrote nothing.** When a capture finished but added, updated and deleted nothing (and was not retried), the Memory activity badge is now a grey **Nothing new** and the composer status says **Nothing new to remember** instead of a success colour. The detail line ("No new facts extracted …" or the counts) is unchanged. Only a capture that wrote at least one memory shows the green **Saved**. Platform and server answers without counts keep **Saved**.
- **Delete one memory from the memory library.** Each memory this plugin wrote (`metadata.source = "dsh"`) has a **Delete** button in the Memory library. A confirmation shows the memory's full text and ID; nothing is deleted without it. The new route `DELETE /dsh-mem0/gui/memories?id=…` applies the same ownership check as the `mem0_delete` tool (the memory must belong to the configured user id) and also requires the `dsh` source; anything else gets HTTP 403 with the reason, and the page shows it. After a delete, the memory's cached translation is dropped and the list reloads. There is no bulk delete, clear-all or delete-by-filter. The mock server gained `POST /__seed` to add another app's or another user's memory for tests.
- **Localized plugin page in DSH.** DSH's plugin page now shows a page written for it instead of the GitHub README: `meta.detail` in `locale/en.json` and `locale/zh.json` points to `docs/plugin-page.en.md` and `docs/plugin-page.zh-CN.md`. Chinese users see Chinese, other languages fall back to English. The pages drop the GitHub-only language switch and HTML, and are kept short so DSH's settings stay near the top: a one-sentence intro, the three backends (Platform, self-hosted server, local OSS) and a link to the GitHub repository for source code, issues and release notes. The full documentation stays in the README. Only these two files are added to the package. Needs a DSH version that reads `meta.detail` (0.2.2-rc.1 does); older versions keep showing the README.
- **Failure history and a status bar that explains itself.** The last 20 memory failures (capture, recall, summary, maintenance) are kept in `<DSH profile>/dsh-mem0/failures.json`, so a later success or a restart no longer hides why memory failed. Each entry has the time, kind, backend, duration, a cause (timeout, connection (refused, DNS, reset), auth or quota (HTTP 401/403/429, quota and rate-limit messages), circuit-breaker skip, or other) and the component that failed: LLM, embedder, vector store, OSS sidecar, Mem0 API or unknown. With the OSS backend the sidecar now says which step failed (embedding, vector search, fact extraction or storing) and the provider and host:port it was talking to, so a hybrid setup tells a slow local Ollama embedder from a rate-limited cloud LLM or a stopped Qdrant; when the plugin's own timeout fires first, it asks the sidecar (`GET /steps`) which step was still running. Repeated identical failures fold into one entry with a count. Messages are redacted before they are stored (no keys, tokens, memory text or home-directory paths) and capped at 240 characters; the file is written atomically, and a corrupt file is ignored and replaced. The Memory activity card lists them under **Recent failures**. The composer status now tells two cases apart: **Memory failed** when a capture or recall failed, and **Status unavailable** when the page could not read the plugin's status. Hover shows the cause, and a click opens it in place: kind, component, cause, message and time. The mock server (`scripts/mock-mem0-server.mjs`) can now inject delays, HTTP errors (401, 429, …) and dropped connections through `POST /__fault`.
- **Why the OSS sidecar died, and saves that survive it.** A sidecar that dies mid-save used to leave only `POST /add failed: fetch failed`. Now:
  - **Exit details.** The plugin records each sidecar exit: exit code or signal, how long it had run, whether it was starting or running, and whether the plugin stopped it itself. A failed save or recall waits up to 500 ms for the exit and stores it with the failure in `failures.json` (`exitCode`, `signal`, `uptimeMs`, component `sidecar`). The same applies when the sidecar exits during startup. Each exit is its own entry; exits are never folded into a repeat count. The Memory activity card has an **OSS sidecar** block. It shows the interpreter's PID (reported by the sidecar itself; on Windows, the venv `python.exe` launcher's PID is shown separately), the start time, the restart count and the last exit.
  - **`sidecar.log`.** The sidecar's stderr, plus start and exit events, is written to `<DSH profile>/dsh-mem0/sidecar.log`, capped at 512 KB with one rotated copy (`sidecar.log.1`). Each line is redacted first (keys, tokens, home-directory paths shortened to `~`). The card shows the path, and a **Copy last 50 log lines** button copies the last lines, redacted again.
  - **One safe retry.** A capture is retried once, after the sidecar restarts, only when the connection was refused. A refused connection proves the sidecar never received the request. A reset, a closed socket, a timeout or an abort may come after the sidecar read the request, so those are never retried; a retry could store the same turn twice. Activity says **Saved after one retry** or **Retry failed too**.
- **Activity records no longer show stale errors.** Each new capture or recall state replaces the previous record instead of merging into it. A later "skipped" or "saved" no longer shows the previous failure's error. Skips say why: too short or not worth remembering, nothing left after redaction, queue full, no recall budget, or paused by the circuit breaker. A breaker pause also shows the time left and the failure that opened it. The composer status shows **Memory paused** for a breaker pause and **Capture skipped (too short)** for a filtered turn.
- **What a save extracted.** With the OSS backend, `/add` now reports the facts extracted and how many were added, updated, deleted or already known. Activity shows e.g. "Extracted 2: added 1, updated 0, already known 1". When nothing was extracted it shows "No new facts extracted (nothing worth keeping, or already known)". With Mem0 2.2, a turn whose facts are already stored usually extracts nothing, because Mem0 shows the model the existing memories first. If Mem0 could not use the model's extraction answer and stored nothing, the save counts as an LLM extraction failure with a reason (see above) instead of a silent "0 written". Platform and server backends show the add/update/delete counts their answers include.
- **No more writes to the shared `~/.dsh/mem0`.** When DSH gives the plugin no profile directory, the failure history, maintenance state and sidecar log stay in memory instead of falling back to the folder of `historyDbPath` (`~/.dsh/mem0`), which all profiles share. `npm test` now runs every test with a temporary `HOME` and `DSH_HOME`. A test checks that a plugin run with no profile directory writes nothing under `~/.dsh`.

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

- **只支持 Qdrant 服务端，嵌入式 Qdrant 在启动前直接报错**（修复 [#23](https://github.com/light-cheng/DSH-Mem0/issues/23)）。sidecar 会打开两次 Qdrant（读、写各一个），嵌入式 Qdrant（`vector_store.config.path`）对目录加的是只允许一个客户端的锁，第二次打开就失败，启动时只显示 `START_FAILED`。现在插件（启动 Python 之前）和 sidecar 的 `build_memory_config` 都会检查 `oss.json`：Qdrant 向量库既没有 `url`、也没有 `host` 加 `port` 时，立即报「不支持嵌入式 Qdrant，请启动 Qdrant 服务端并在 oss.json 里用 url」（中英文）并附 README 链接。失败卡片、测试连接和 `mem0_status` 都显示为向量库的**配置错误**。它不计入熔断，`oss.json` 不变就不重试；不管是哪类调用碰到的，重复的失败都合并成一条记录。同时有 `path` 和 `url` 时用 `url`，忽略 `path` 并记一条警告。README 改为写明只支持服务端，并给出最短的启动步骤（下载、只监听本机的最小 `config.yaml`、`url` 写法）。
- **Windows 上能找到解释器。** 没设置 `pythonPath` 时，插件在 `~/.dsh/mem0` 下找 venv：Windows 依次找 `venv\Scripts\python.exe`、`venv\bin\python.exe` / `venv\bin\python`，其他系统依次找 `venv/bin/python3`、`venv/bin/python`。以前只找 POSIX 布局，Windows 上会退回 PATH 里的 `python3`（没装 Mem0 的 Microsoft Store Python）。设置了的 `pythonPath` 始终优先。退回 PATH 时（Windows 上现在找 `python`），`mem0_status`、OSS sidecar 区块和 `sidecar.log` 会写明用了哪个解释器、为什么。sidecar 先检查有没有 `mem0`，没有就报 `ModuleNotFoundError: No module named 'mem0'` 并带上解释器路径（家目录显示为 `~`）。
- **「sidecar failed to start recently」背后的真正原因。** 插件记住最近一次启动失败：时间、退出码或信号，以及让启动失败的异常（sidecar 输出的错误行，没有就取 stderr 里最后一条异常），先脱敏再截断。启动退避期间被跳过的调用会带上这条原因；失败记录的原因写成 **sidecar 启动失败**、组件是 OSS 进程（不再是「其他错误」）；熔断跳过也会写明它；OSS sidecar 区块和 `mem0_status` 显示原因和时间。顺手修了一处：`ModuleNotFoundError` 会命中网络错误 `ENOTFOUND` 的匹配，被误判为连接失败。
- **连接被拒时写明 host:port，并提示 Windows 保留端口。** Qdrant 或 embedder（Ollama）拒绝连接时，无论在启动、测试连接、请求中还是 `mem0_status` 里，消息都写成「Qdrant unreachable at 127.0.0.1:15333 (connection refused)」这种形式（host:port 从 `oss.json` 解析，不带协议、路径和凭据），并附上排查提示：服务是否在运行；Windows 上服务日志里是否有 `os error 10013`（"access a socket in a way forbidden"），即端口落在系统保留段。也能识别 Windows 的 "actively refused"（WinError 10061）。失败卡片按页面语言显示同样的提示。
- **能发现被 DSH 重写的配置，配置也可以放到 DSH 改不到的地方。** 实际遇到过 DSH 的设置同步把 `cordis.patch.yml` 里的 dsh-mem0 块削到只剩 `backend`。现在插件记录上次正常运行时哪些关键配置有值（只记字段名，存在 `failures.json` 旁边的 `config-fingerprint.json`），有字段消失时，在设置页和 `mem0_status` 里提示「dsh-mem0 配置疑似被重写，缺少：…」并给出恢复办法。配置也可以写在 `oss.json` 的 `dsh_mem0` 段里（`pythonPath`、`collectionName`、`userId`、`agentId`、`historyDbPath`、`translateMemories`、`captureStrataFolds`），profile 没设置时生效。
- **不响应 SIGTERM 的 sidecar 会被强制结束。** 停止 sidecar 时，因为 `child.killed` 只表示信号已发出，强制停止那一步被跳过了。现在按进程是否已退出来判断，宽限期过后发 SIGKILL，并等待确认退出。Windows 上两种信号都是 TerminateProcess，第一次就会结束启动器进程。
- **README：Windows 排障。** 系统保留端口段（`netsh int ipv4 show excludedportrange protocol=tcp`、`show dynamicport tcp`），把 Qdrant 和 Ollama 挪到 15000 以上（15333 / 15434，同步改 `oss.json` 和 `OLLAMA_HOST`），可选的、需要管理员权限的动态端口段复原及其风险，服务检查，以及装插件或更新插件后的检查清单。
- **事实抽取不再被推理模型的思考挤到截断。** 使用 OSS 后端和 hybrid 推理模型时，保存会失败并显示「LLM 抽取失败: 回复被截断 (JSON 不完整) — 重试仍失败」。原因是 Mem0 默认 2000 token 的输出上限要和模型的思考共用：经 magpie 调用 `workbuddy/deepseek-v4.1-flash`，一段 1.4K 字的 fold 摘要抽取 3 次，有 2 次在思考用掉 1.4K–1.7K token 后以 `finish_reason=length` 截断。现在：
  - `oss.llm.config` 没有写 `max_tokens` 时，sidecar 抽取用 `max_tokens: 8000`（你自己写的值始终优先）。用 8000 抽取 6 次全部正常结束，最多用了 2541 个输出 token。
  - `oss.llm.config.reasoning_effort` 会发给所有模型，不再只发给 Mem0 认得的推理模型。在支持的网关上 `"none"` 会关闭思考（即使上限是 2000，6 次也全部正常结束，思考 0 token，输出约 850 token）。`"low"` 没有用（2000 时 3 次全部截断）。不设置就不发送。
  - 回复以 `finish_reason=length` 截断时，用加倍的输出上限重试一次（最多 65536），而不是用原参数再试。重试期间活动记录会说明这一点。
  - 抽取失败时，502 返回体、失败记录、记忆活动卡片和 `sidecar.log` 都会记下这次调用的 `finish_reason`、输出上限，以及输入、输出、思考的 token 数。只有数字，不含文本。
  - 抽取失败（被截断、拒答、不是 JSON、为空）不再计入熔断：LLM 已经回复了，暂停记忆也没有用。连接、超时、鉴权和服务端错误照常计入。
  - 输入端不变：捕获仍按 `captureMaxChars` 截断（dsh-strata 的 fold 为 2000 字）。2000 字的 fold 摘要在更大的上限下能正常抽取，所以没有加输入分块。
- **已经保存成功的记忆，不再被误报为「不是合法 JSON，没有存任何东西」。** Mem0 处理完一次保存后，OSS sidecar 为了在活动卡片上显示抽取数，会再解析一遍 LLM 的事实抽取回复，而且用的解析规则比 Mem0 自己的更严格。这一步解析失败时，`/add` 会返回 HTTP 500，即使 Mem0 已经把记忆存了。模型如果先输出带花括号的 `<think>…</think>` 段再给 JSON，每次都会触发。现在：
  - 抽取数只用于显示，永远不会让保存失败。读不出来时，活动记录只显示新增、更新、删除条数。
  - 解析方式和 Mem0 2.2.1 完全一致，直接调用 Mem0 自己的 `remove_code_blocks` 和 `extract_json`：先去掉包住整个回复的代码围栏和 `<think>` 段，再找任意位置的代码围栏，最后取第一个 `{` 到最后一个 `}`。
  - 只有 Mem0 自己也用不了这份回复、并且什么都没存时，这次保存才算失败：返回 HTTP 502，错误码 `LLM_EXTRACT_FAILED`，并给出原因：回复不是 JSON、回复为空、回复被截断（JSON 不完整）、模型拒答。失败记录显示原因「LLM 抽取失败」和具体子原因，不再笼统写成「其他错误」。
  - 原因是「不是 JSON」「为空」「被截断」时自动重试一次：第一次什么都没存，重试不会把同一条记忆存两次。模型拒答不重试。活动记录显示「重试后已保存」或「重试仍失败」。第一次失败照常留在失败记录里，熔断器只在最终失败时计一次。
  - `sidecar.log` 不会写入 LLM 回复的原文：sidecar 只记录原因、回复长度和开头的类型（例如 `truncated; answer 60 chars, starts with JSON-like`）。Mem0 日志里引用记忆或消息内容的部分（实体名、被拒绝的消息、pydantic 的 input value）会被替换掉，其他库的日志每条最长 500 字符。
- **自动保存没写入时显示「无新内容」，不再是绿色「已保存」。** 自动保存完成但新增、更新、删除都是 0（且没有重试）时，「记忆活动」的徽章改为灰色「无新内容」，状态栏显示「无新内容可记」，不再用成功色。下面的说明行（「没有抽取到新内容…」或各项计数）不变。只有至少写入一条记忆时才显示绿色「已保存」。Platform、server 后端的回应里没有计数时仍显示「已保存」。
- **在记忆库里删除单条记忆。** 「记忆库」里本插件写入的记忆（`metadata.source = "dsh"`）每条都有「删除」按钮。点击后先弹出确认，显示这条记忆的完整内容和 ID，不确认就不删。新增路由 `DELETE /dsh-mem0/gui/memories?id=…`，沿用 `mem0_delete` 工具的归属检查（记忆必须属于当前配置的 user id），并要求来源是 `dsh`；不符合的返回 HTTP 403 并附原因，页面会显示出来。删除后清掉这条记忆的译文缓存并刷新列表。不提供批量删除、清空全部或按条件删除。mock server 新增 `POST /__seed`，测试时可以加入其他应用或其他用户的记忆。
- **DSH 插件页本地化。** DSH 的插件页现在显示专门为它写的介绍，而不是 GitHub README：`locale/en.json` 和 `locale/zh.json` 的 `meta.detail` 分别指向 `docs/plugin-page.en.md` 和 `docs/plugin-page.zh-CN.md`。中文用户看到中文，其他语言回退到英文。页面去掉了只在 GitHub 上有用的语言切换行和 HTML，并且保持简短，让 DSH 的配置区留在页面上方：只有一句简介、三种后端（Platform、自托管 server、本地 OSS）和指向 GitHub 仓库的链接（源码、问题反馈和发布说明）。完整文档仍在 README 中。包里只新增这两个文件。需要支持 `meta.detail` 的 DSH 版本（0.2.2-rc.1 已支持）；更早的版本仍显示 README。
- **失败记录，状态栏说明失败原因。** 最近 20 次记忆失败（自动保存、自动召回、记忆摘要、记忆整理）保存在 `<DSH profile>/dsh-mem0/failures.json`，之后的成功或重启都不会再让失败原因消失。每条记录包括时间、类型、后端、耗时、原因分类（超时、连接失败（拒绝连接、DNS、连接重置）、认证或额度（HTTP 401/403/429、额度和限流提示）、熔断跳过、其他），以及出错的组件：LLM、向量模型、向量库、OSS 进程、Mem0 API 或未知。使用 OSS 后端时，sidecar 会报告失败的步骤（向量化、向量检索、事实抽取或写入）以及对应的提供方和 host:port，因此混合部署能分清是本地 Ollama 向量模型慢、云端 LLM 被限流，还是 Qdrant 没启动；插件自己的超时先到时，会向 sidecar 询问（`GET /steps`）当时还在运行的步骤。连续相同的失败合并成一条并计数。消息在保存前脱敏（不含密钥、token、记忆正文和用户主目录路径），最长 240 字符；文件原子写入，损坏时忽略并在下次写入时替换。「记忆活动」卡片在「最近失败」里列出这些记录。输入框下的状态现在区分两种情况：记忆操作失败显示「记忆失败」，读不到插件状态显示「状态读取失败」。悬停即可看到原因，点击会就地展开：类型、组件、原因、消息和时间。模拟服务器（`scripts/mock-mem0-server.mjs`）新增 `POST /__fault`，可以注入延迟、HTTP 错误（401、429 等）和断开连接。
- **sidecar 为什么退出，以及退出后保存不再丢失。** 以前 sidecar 在保存过程中退出，只会留下一条 `POST /add failed: fetch failed`。现在：
  - **退出信息。** 插件记录 sidecar 每一次退出：退出码或信号、运行了多久、退出时处于启动还是运行阶段、是不是插件自己停的。保存或召回失败时，插件最多等 500 ms 的退出事件，并把退出信息写进 `failures.json` 里的这条失败（`exitCode`、`signal`、`uptimeMs`，component 为 `sidecar`）。sidecar 在启动阶段退出也会记录。每次退出单独成一条，不会被合并计数。「记忆活动」卡片新增 **OSS sidecar** 一栏，显示解释器 PID（由 sidecar 自己上报；Windows 上 venv 的 `python.exe` 启动器 PID 单独列出）、启动时间、重启次数和最近一次退出。
  - **`sidecar.log`。** sidecar 的 stderr 以及启动、退出事件写入 `<DSH profile>/dsh-mem0/sidecar.log`。文件上限 512 KB，超过后轮转一份 `sidecar.log.1`。每一行写入前先脱敏（密钥、token，家目录路径换成 `~`）。卡片上显示日志路径；点 **复制最近 50 行日志** 会复制最后几行，复制前再脱敏一遍。
  - **只在安全时重试一次。** 只有连接被拒绝时，插件才会等 sidecar 重启后重试一次。连接被拒绝能证明 sidecar 没收到请求。连接被重置、socket 被关闭、超时或中止，都可能发生在 sidecar 已经读到请求之后，这些情况一律不重试，否则同一轮对话可能被存两次。活动记录会显示「重试后已保存」或「重试仍失败」。
- **活动记录不再显示残留的旧错误。** 每次保存或召回的新状态都整条替换旧记录，不再合并。之后的「已跳过」或「已保存」不会再带着上一次失败的错误信息。跳过时会说明原因：内容太短或不值得记、脱敏后没有内容、队列已满、本轮召回预算为 0、熔断中。熔断中还会显示剩余时间，以及触发熔断的那次失败。输入框旁的状态把两种情况分开显示：熔断时显示「记忆已暂停」，内容被过滤时显示「保存已跳过（内容太短）」。
- **保存时抽取到了什么。** OSS 后端的 `/add` 现在会返回抽取出的事实数，以及新增、更新、删除和已存在的条数。活动记录显示为「抽取 2 条：新增 1，更新 0，已存在 1」。什么都没抽取到时显示「没有抽取到新内容（不值得记，或已经记过）」。在 Mem0 2.2 里，如果这轮对话的事实已经存过，通常不会被抽取出来，因为 Mem0 会先把已有记忆给模型看。Mem0 用不了模型的抽取回复、什么都没存时，这次保存记为一次「LLM 抽取失败」并给出子原因（见上一条），不再静默显示「写入 0 条」。Platform 和 server 后端显示它们返回结果里带的新增、更新、删除条数。
- **不再写入共享的 `~/.dsh/mem0`。** DSH 没有给插件 profile 目录时，失败记录、维护状态和 sidecar 日志只保存在内存里，不再回退到 `historyDbPath` 所在的目录（`~/.dsh/mem0`，所有 profile 共用）。`npm test` 现在让每个测试都使用临时的 `HOME` 和 `DSH_HOME`。新增一个测试，检查没有 profile 目录时插件不会往 `~/.dsh` 写任何东西。

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

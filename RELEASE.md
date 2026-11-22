# Release notes

English is the default; the Chinese version follows below.

## English

### Publishing

Creating a GitHub release publishes the package to npm automatically (`.github/workflows/release.yml`, npm trusted publishing, no token). Tag the release `vX.Y.Z`, matching the `version` in `package.json`; a mismatch fails the workflow before anything is published. A release marked **pre-release** is published to the `next` dist-tag, otherwise to `latest`. If the first pre-release publish fails with an error about dist-tags, publish stable releases only (leave **pre-release** unticked).

### v0.4.1 — 2026-11-22

A patch release for the Local OSS backend. The setup wizard now says why a local model server fails and what to do about it, extraction can use the model you already selected in DSH, and the memory chip is shorter and follows the session's working directory. Nothing to migrate: memories, partition ids and saved settings stay as they are.

#### What changes for you

- **Setup wizard, local models: every failure says why and what to do.** Detecting local services, **List models**, **Test** and the self-test no longer show a bare status code. They tell apart: a service with API key verification on (HTTP 401/403, e.g. oMLX), a wrong address path (HTTP 404, with a **Change to …/v1** button when the address has no path), nothing running on the port, no answer in time, or another status with the first line of the server's error (secrets redacted). A service that answers 401/403 to detection counts as running, and its address is filled in for you.
- **Optional API key for a local server.** List models, the tests and, after saving, the embedding calls (and extraction calls that use a model you set yourself on that server) send it. It is stored in DSH credentials, never in oss.json. The hint says where each service keeps its key: oMLX (`auth.api_key` in its settings.json), LM Studio (Developer → Server Settings), Ollama (none: a 401 comes from a proxy in front of it). For oMLX, **Read the key from oMLX** reads `auth.api_key` from `~/.omlx/settings.json` (or `$OMLX_BASE_PATH/settings.json`) only when you click it; the key stays on the DSH side and is never shown on the page. **Show the settings file in Finder** points to the file without opening it.
- **Extraction can use DSH's current model.** Step 2 of the wizard offers **DSH's current model** next to **Set a model myself**; it is the default when no extraction model is set yet. Only the choice is saved (`llmProvider: "dsh"` in oss.json): no model name, no address, no key. Each extraction reads the model selected in DSH at that moment, so a model switch in DSH applies from the next captured turn (one already running keeps its model). DSH keeps the model's address and key; they never pass through the plugin. The wizard shows the current model's name, **Test** and the self-test use it, and each failure says what to fix in DSH (no model selected, no API key for the model, key refused, rate limit, quota, context too long, timeout). Secrets are removed from the conversation before it is sent, because DSH's `llm/stream` hooks (other plugins) can see the request. `mem0_status` shows the configuration (following DSH, the model now) and the last extraction (model, facts, tokens) on two lines. **Cost:** every captured turn calls the model once more, billed to your provider in DSH and not counted in DSH's usage statistics. A setup that already sets its own extraction model keeps it until you choose otherwise in the wizard.
- **The memory chip is shorter, and says more on hover.** The chip below the input box shows only **Project** or **Global** (Chinese UI: 「项目」/「全局」). Hover or focus it for a **Mem0 memory partition** panel: the project name, how it was decided (git `origin`, git repository root, plain folder; or why it is global: DSH default workspace, home folder, switch off), the project's folder and the current working directory (`~` for the home folder; a git worktree also shows its checkout), and the partition id. Screen readers get the full name, e.g. "Mem0 memory partition: project pocket-ledger". Paths are only shown, never stored.
- **A session that changes directory now changes project (behaviour change).** When the working directory changes during a session (the model's `working_directory` tool, or DSH entering a git worktree), the chip, recall and new memories follow the new folder's project from the next lookup; before, the session kept the project of the folder it started in. Project ids are computed as before, so no memory moves or is orphaned, and memories already written stay in their partition. A repeated question after such a change searches the new project instead of reusing the old result.

#### Upgrading from 0.4.0

1. **DSH desktop app:** uninstall Mem0 Memory in the app, then reinstall it as an unofficial plugin (`dsh-mem0`). Other installs: update the package as usual and restart DSH if it asks.
2. Nothing else is required. Your settings, memories and partitions are kept. To let extraction follow DSH's model, open **Local setup wizard** and pick **DSH's current model** in step 2.

### v0.4.0 — 2026-11-21

The local backend is rewritten: it no longer needs Python or Qdrant. Memories are now kept per project, memory hygiene uses your DSH model by default, and recall is faster. **If you use the Local OSS backend, read "Upgrading from 0.3.x" below first**: you go through the setup wizard once. Platform and self-hosted server users only get the new features.

#### What changes for you

- **No more Python or Qdrant (breaking).** `backend: oss` now runs inside DSH's own Node: memories live in one SQLite file, `~/.dsh/mem0/memory.sqlite` (`node:sqlite`, built in; several DSH profiles can share it), and memory extraction is a JavaScript port of Mem0 2.2.1's pipeline with Mem0's prompt copied verbatim (see NOTICE, Apache-2.0). There is no sidecar process to install, start or debug. Needs Node 24.9 or later; DSH ships 24.21. The old settings `pythonPath`, `mem0ConfigPath`, `historyDbPath` and `sidecarEnv` are ignored (a debug line, never an error).
- **New setup wizard** (settings page → Local OSS → **Local setup wizard**). Four steps: an embedding model (a cloud API, or a local server it finds: Ollama, LM Studio, oMLX on macOS), an extraction LLM (one test call, with a green or red result card and advice on `max_tokens` / `reasoning_effort`), the memory file, and a self-test with a throw-away test user. Nothing is saved until the self-test passes. Keys you type go into DSH credentials, never into plain files. Switching the backend to Local OSS offers the wizard when something is missing.
- **One-time move of your old memories from Qdrant.** The wizard's last step copies your memories from the Qdrant server 0.3.x used (only this setup's collection and your `userId`). It only reads Qdrant and never changes or deletes anything there. The copy is written to a temporary file and checked before it becomes your store, so a failure leaves everything as it was; it can be cancelled until the final switch-over. You can also skip it and move later.
- **Memories are partitioned by project.** There are three partitions: global, the current project and the current session. A project is recognised from the git `origin` (else the repository or folder). Recall reads global plus the current project and session; new memories go to the current project. Turn it off with **Partition by project** (`projectPartitions`, default on): then everything new goes to global, and project memories are kept untouched until you turn it back on.
  - The chip below the input box shows where memory goes, 「记忆：项目 X」/「记忆：全局」 ("Memory: project X" / "Memory: global"); a click flips the switch.
  - The **memory page** has a partition tree (all, global, each project and its sessions) with search, pin, delete and **Make global**, and the system-prompt summary has a global part plus one for the current project.
  - A chat in DSH's default workspace (the folder the desktop app creates on first use) counts as no project, so its memories go to global.
  - Memories from before 0.4.0 count as global. Project memories never move to global on their own; only **Make global** moves one.
- **Model-led memory hygiene, on by default.** Hygiene now asks the model currently set in DSH to merge duplicates, delete outdated memories and rate importance (1–5), and scripts check every action it proposes. **This calls your configured LLM and is billed by your provider**; the calls do not show in DSH's usage statistics, but each hygiene report lists the calls and tokens used. To avoid the cost, turn off **Model-led hygiene** (`modelHygiene: false`): hygiene then runs its script checks only. Safety rules from 0.3.0 still apply: automatic passes only preview deletes and merges until you confirm one manual run, pinned memories are never touched, at most 20 model deletes per pass. **Catch-up:** a pass reviews at most 96 new or changed memories; while more are waiting, the next pass comes 24 hours later instead of after the usual interval.
- **Faster recall.**
  - Each recall's step times (store, embedding, search, building the block) show in the settings page's activity and as `last recall:` in `mem0_status`.
  - With a local Ollama embedder, requests ask Ollama to keep the model loaded for 30 minutes (`embedderKeepAlive`, default `30m`), and the model is warmed up once at start, so the first recall after a pause no longer waits 2–7 s. Cloud embedders are never called for this.
  - The status icon next to the input box is the animated ThinkingOrb (from dissolve, MIT): a turning sphere when idle, radar while recalling, rings while saving, a check on success, red dots on failure.
- **One fact, one memory.** Saying "remember I travel next week" no longer leaves two or three near-identical memories. A captured fact is skipped when it means the same as a memory written in the same turn (cosine similarity at least `captureTurnDedupThreshold`, default 0.93, `0` turns it off), or when all its words already appear in one (similarity at least 0.75; for Chinese a small fixed word list evens out wording). Different facts on one topic said together are still both stored. Older memories are compared by exact text (md5) only, so a correction of an earlier fact is always kept. The assistant's own sentences confirming a memory or talking about tools are no longer sent to extraction.
- **How releases are published.** npm releases are now made from GitHub releases through npm trusted publishing (no token), and GitHub releases no longer carry a `.tgz` file. Install from npm as before.

#### Upgrading from 0.3.x

1. Install 0.4.0 as usual and restart DSH if it asks.
2. **Local OSS users:** on first start the settings page says the backend needs setting up. Open **Local setup wizard**, pick the embedding model and LLM, and run the self-test. If you had memories in Qdrant, keep the Qdrant server running for the last step and let the wizard move them (it is offered whenever 0.3.x settings are found).
3. Saving the wizard writes the `dsh_mem0` block of `~/.dsh/mem0/oss.json` and first copies the old file to `~/.dsh/mem0/oss.json.bak-<UTC time>` (for example `oss.json.bak-20261121T083000Z`, Windows `%USERPROFILE%\.dsh\mem0\`). If you moved a plain-text key into DSH credentials, it is removed from `oss.json` but still in that backup.
4. Afterwards the plugin no longer talks to Qdrant. Your old data stays there unused; stop or delete it once you are satisfied (or keep it for a rollback).
5. Model-led hygiene is on by default (see above). Turn it off before the first pass if you do not want LLM calls.

Platform and self-hosted server users need to do nothing.

#### Rolling back to 0.3.1

1. Install npm `dsh-mem0@0.3.1` the same way you installed the plugin.
2. Restore the configuration: copy the newest `~/.dsh/mem0/oss.json.bak-<UTC time>` back over `~/.dsh/mem0/oss.json`.
3. 0.3.1 needs its Python environment (`~/.dsh/mem0/venv`) and the Qdrant server again; start Qdrant if you stopped it.
4. 0.3.1 reads only Qdrant, which the migration never changed: memories saved since the upgrade are only in `memory.sqlite` and do not come back. `memory.sqlite` is left in place, so a later upgrade finds them again.

#### Other changes

- **Hygiene and summaries.** Summaries for global and the current project are written by the model (at most 6 calls per pass) with a script fallback. Pin or unpin a memory in the memory list or with the new `mem0_pin` tool; importance weighs recall and the summary (`importanceWeight`, default 0.2). Hygiene no longer deletes memories for size (`storeMaxMemories` and `storeMaxTokens` are removed; above `storeSafetyLimit`, default 20000, it only warns). Without a usable model (no key, quota, timeout, bad answer) a pass runs its script part and says why.
- **Data-safety fixes** (external review): duplicates are exact copies only (`dose 1.5 mg` and `dose 15 mg` are no longer one); a confirmed cleanup runs once (`planId` + idempotency key; `POST /dsh-mem0/gui/hygiene` without `dryRun: true` now needs both); summary, history and authorisation are kept per store and user; disposing stops a running pass; recall queries and summaries are redacted; deleting or editing a memory invalidates the summaries built from it; `mem0_get` / `mem0_update` / `mem0_delete` refuse memories not proven to be yours; `mem0_add` and `mem0_update` can no longer set the metadata hygiene relies on.
- **Memory library:** delete a single memory this plugin wrote (with a confirmation), and the hygiene report shows the text of merged and rated memories.
- **Clearer status.** The last 20 memory failures are kept in `<DSH profile>/dsh-mem0/failures.json` with time, cause and failing component, and shown under **Recent failures**; the status icon tells **Memory failed** from **Status unavailable**; a capture that wrote nothing shows a grey **Nothing new**; skips and circuit-breaker pauses say why; a refused connection names host:port with the Windows reserved-port hint (`os error 10013`).
- **Extraction.** A model's thinking no longer cuts the answer off (`llmMaxTokens` default 8000, one retry with twice the budget); answers are parsed like Mem0 2.2.1 parses them; a failed extraction is reported as **LLM extraction failed** with a reason and does not pause memory.
- **Settings.** Saving with decimal weights (`importanceWeight`, `projectRecallBoost`) works again. Settings DSH's sync drops from `cordis.patch.yml` are noticed ("dsh-mem0 settings look rewritten"), and settings can also live in the `dsh_mem0` block of `oss.json`. A running migration or re-embedding can be cancelled; changing the embedder recomputes only changed vectors.
- **Other:** DSH's plugin page shows a short localized page (English / Chinese) instead of the README; `authType: token` sends `Authorization: Token <key>`; nothing is written to the shared `~/.dsh/mem0` when DSH gives no profile folder; background calls to DSH's model create no session file; `projectRecallBoost` (default 1.1) weighs project and session memories in recall.
- **Development:** CI runs on Windows, macOS and Linux; a weekly workflow reports mem0ai releases whose prompt or pipeline differs from 2.2.1; the mock server can inject faults and seed memories; `npm test` runs with a temporary `HOME`.
- Fixes made during this cycle to the Python sidecar (embedded-Qdrant check, [#23](https://github.com/light-cheng/DSH-Mem0/issues/23); Windows interpreter discovery; sidecar start and exit reasons, `sidecar.log`, kill on stop, one safe retry) never shipped and are superseded by its removal.

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

### 如何发布

在 GitHub 上新建 release 就会自动发到 npm（`.github/workflows/release.yml`，npm trusted publishing，不用 token）。tag 写成 `vX.Y.Z`，和 `package.json` 的 `version` 一致；不一致时 workflow 在发布前失败，不会发出任何东西。勾选 **pre-release** 时发布到 `next` 标签，否则发布到 `latest`。如果第一次 prerelease 发布失败、报错和 dist-tag 有关，就改为只发正式版（不勾选 **pre-release**）。

### v0.4.1 — 2026-11-22

面向本地 OSS 后端的补丁版本。设置向导会说清本地模型服务为什么连不上、该怎么办；抽取可以直接用你在 DSH 里选好的模型；记忆标签更简洁，并且跟着会话的工作目录走。不需要迁移：记忆、分区 id 和已保存的设置都保持不变。

#### 对你有什么变化

- **设置向导的本地模型：失败时说清原因和下一步。** 探测本地服务、「列出模型」、「测试」和自检失败时不再只给一个状态码，而是区分：服务开启了 API key 验证（HTTP 401/403，例如 oMLX）、地址路径不对（HTTP 404；地址不带路径时给出「改成 …/v1」按钮）、端口上没有服务在跑、超时没有回应，或者其他状态码加上服务返回的错误信息第一行（已脱敏）。探测时返回 401/403 的服务算作运行中，会自动填入它的地址。
- **本地服务可以填 API key（可选）。** 列出模型、测试，以及保存后的 embedding 调用（还有在这个服务上「自己填写模型」时的抽取调用）都会带上它；key 存进 DSH 凭据库，不写进 oss.json。提示里写明各服务的 key 在哪：oMLX 在它的 settings.json 的 `auth.api_key`，LM Studio 在 Developer → Server Settings，Ollama 本身没有 key（401 来自它前面的代理）。对 oMLX，点「从 oMLX 读取 key」才会从 `~/.omlx/settings.json`（或 `$OMLX_BASE_PATH/settings.json`）读取 `auth.api_key`；key 只留在 DSH 这一侧，页面上不显示。「在 Finder 中显示配置文件」只显示文件位置，不打开文件。
- **抽取可以直接用 DSH 当前的模型。** 向导第 2 步新增「使用 DSH 当前配置的模型」，另一个选项是「自己填写模型」；还没设置抽取模型时默认选前者。只保存这个选择（oss.json 里的 `llmProvider: "dsh"`），不保存模型名、地址和 key。每次抽取都读取 DSH 当时选中的模型，所以在 DSH 里换了模型，从下一轮对话起就用新模型（正在进行的那次抽取仍用原来的模型）。模型的地址和 key 由 DSH 保管，不经过插件。向导里显示当前模型名，「测试」和自检也用它；失败时说明该在 DSH 里怎么处理（没有选中模型、模型没填 API key、key 被拒绝、被限流、额度用完、上下文超长、超时）。DSH 的 `llm/stream` hook（其他插件）能看到请求内容，所以对话发送前会先去掉密钥等敏感内容。`mem0_status` 分两行显示配置（跟随 DSH，以及现在选中的模型）和最近一次抽取（模型、事实数、token 数）。**费用：** 每捕获一轮对话，会多调用一次这个模型，费用记在你在 DSH 配置的 provider 上，不计入 DSH 的用量统计。已经自己填写了抽取模型的配置保持不变，除非你在向导里改选。
- **记忆标签变短了，悬停能看到更多。** 输入框下方的标签只显示「项目」或「全局」（英文界面：Project / Global）。鼠标悬停或用键盘聚焦，会弹出「Mem0 记忆分区」面板：项目名；判定依据（git `origin`、git 仓库根目录、普通文件夹；或者为什么算全局：DSH 默认工作区、主目录、开关关闭）；项目对应的文件夹和当前工作目录（主目录显示为 `~`，git worktree 还显示检出目录）；分区 id。读屏软件读到的是完整名称，例如「Mem0 记忆分区：项目 pocket-ledger」。路径只显示，不保存。
- **会话中途换目录，项目也跟着换（行为变化）。** 会话中途工作目录变了（模型用 `working_directory` 工具切换，或者 DSH 进入 git worktree），标签、召回和新记忆从下一次查询起都按新目录的项目走；以前一直沿用会话起始目录的项目。项目 id 的算法没变，所以没有记忆被移动或变成孤儿，已经写下的记忆留在原来的分区。换目录之后再问同一个问题，会在新项目里重新检索，不再沿用旧结果。

#### 从 0.4.0 升级

1. **DSH 桌面版：** 在 app 里卸载 Mem0 Memory，再作为非官方插件重新安装（`dsh-mem0`）。其他安装方式：照常更新包，DSH 提示需要重启就重启。
2. 其他什么都不用做。设置、记忆和分区都保留。想让抽取跟随 DSH 的模型，打开 **本地配置向导**，在第 2 步选「使用 DSH 当前配置的模型」。

### v0.4.0 — 2026-11-21

本地后端重写，不再需要 Python 和 Qdrant。记忆现在按项目分开保存，记忆巡检默认用你在 DSH 配置的模型，召回也更快了。**用本地 OSS 后端的用户请先看下面的「从 0.3.x 升级」**：需要走一遍配置向导。Platform 和自托管 server 用户只是多了新功能，无需操作。

#### 对你有什么变化

- **不再需要 Python 和 Qdrant（不兼容变更）。** `backend: oss` 现在直接跑在 DSH 自带的 Node 里：记忆存在一个 SQLite 文件 `~/.dsh/mem0/memory.sqlite`（内置的 `node:sqlite`，多个 DSH profile 可以共用），记忆抽取是 Mem0 2.2.1 流程的 JavaScript 移植，Mem0 的提示词原样照搬（见 NOTICE，Apache-2.0）。没有 sidecar 进程要安装、启动或排查。需要 Node 24.9 或更新，DSH 自带 24.21。旧设置 `pythonPath`、`mem0ConfigPath`、`historyDbPath`、`sidecarEnv` 会被忽略（只记一条 debug 日志，不报错）。
- **新的配置向导**（设置页 → 本地 OSS → **本地配置向导**）。共四步：embedding 模型（云端 API，或它在本机找到的服务：Ollama、LM Studio、macOS 上的 oMLX）、抽取用的 LLM（测试调用一次，结果以绿色或红色卡片显示，并给出 `max_tokens` / `reasoning_effort` 建议）、记忆文件、用一次性测试用户做的自测。自测通过之前什么都不保存。输入的 key 存进 DSH 凭据库，不写进明文文件。把后端切到本地 OSS 时，缺什么就会提示打开向导。
- **从 Qdrant 一次性迁移旧记忆。** 向导最后一步把 0.3.x 用的 Qdrant 服务端里的记忆复制过来（只读这套配置的 collection、只读你的 `userId`）。它只读 Qdrant，从不修改或删除 Qdrant 里的任何东西。数据先写进临时文件，校验通过才成为你的记忆库，失败时一切保持原样；在最后切换之前可以随时取消。也可以先跳过，以后再迁。
- **记忆按项目分区。** 分为三个分区：全局、当前项目、当前会话。项目按 git `origin` 识别（没有就按仓库或文件夹）。召回读取全局加当前项目和会话；新记忆写进当前项目。可以用 **按项目分区**（`projectPartitions`，默认开）关掉：关掉后新记忆全部进全局，项目记忆原样保留，重新打开后继续生效。
  - 输入框下方的标签显示记忆写到哪里：「记忆：项目 X」/「记忆：全局」，点一下就切换这个开关。
  - **记忆页**有分区树（全部、全局、各项目及其会话），可以搜索、置顶、删除和**改为全局**；系统提示词里的摘要分成全局部分和当前项目部分。
  - 在 DSH 默认工作区（桌面版首次使用时建的文件夹）里聊天算作不在项目里，记忆写进全局。
  - 0.4.0 之前的记忆算全局。项目记忆不会自己跑到全局，只有点**改为全局**才会移动。
- **记忆巡检改为以模型为主，默认开启。** 巡检会请你当前在 DSH 配置的模型合并重复、删除过时记忆、给重要度打分（1–5），模型提出的每个动作都由脚本校验。**这会调用你配置的 LLM，费用由你的 provider 收取**；这些调用不计入 DSH 的用量统计，但每份巡检报告都列出了调用次数和 token 数。不想花这笔钱，就关掉 **模型巡检**（`modelHygiene: false`），巡检只做脚本检查。0.3.0 的安全规则照旧：确认过一次手动巡检之前，自动巡检只预览删除和合并；置顶的记忆永远不动；每次最多删除 20 条。**自动追赶：** 一次巡检最多审 96 条新增或改过的记忆；还有剩余时，下一次巡检在 24 小时后进行，而不是等平常的间隔。
- **召回更快。**
  - 每次召回各步骤的耗时（打开存储、embedding、搜索、拼装记忆块）显示在设置页的活动记录里，也会出现在 `mem0_status` 的 `last recall:` 一行。
  - 用本机 Ollama 做 embedding 时，请求会让 Ollama 把模型保留 30 分钟（`embedderKeepAlive`，默认 `30m`），启动时还会预热一次，所以停一会儿之后的第一次召回不再多等 2–7 秒。云端 embedding 不会因此被调用。
  - 输入框旁的状态图标换成了 ThinkingOrb 动画（来自 dissolve，MIT）：空闲时是转动的球，召回时是雷达，保存时是圆环，成功是对勾，失败是红色的点。
- **一条事实只存一条记忆。** 说「记住我下周出差」不会再留下两三条几乎一样的记忆。捕获到的事实如果和同一轮里写入的记忆意思相同（相似度不低于 `captureTurnDedupThreshold`，默认 0.93，`0` 表示关闭），或者字词全都已经出现在那条记忆里（相似度不低于 0.75；中文另有一张固定小词表统一说法），就不再保存。同一轮里一起说的同话题不同事实仍然都会保存。和更早的记忆只按完全相同的文本（md5）比较，所以更正旧事实一定会存下。助手自己确认记忆、谈论工具的句子不再送去抽取。
- **发版方式。** npm 版本现在由 GitHub release 通过 npm trusted publishing 发布（不用 token），GitHub release 也不再附带 `.tgz` 文件。照常从 npm 安装即可。

#### 从 0.3.x 升级

1. 照常安装 0.4.0，DSH 提示需要重启就重启。
2. **本地 OSS 用户：** 首次启动后，设置页会提示后端需要配置。打开 **本地配置向导**，选好 embedding 模型和 LLM，跑完自测。如果 Qdrant 里有旧记忆，最后一步时请保持 Qdrant 服务端运行，让向导迁移（只要发现 0.3.x 的设置，就会提供这一步）。
3. 向导保存时写入 `~/.dsh/mem0/oss.json` 的 `dsh_mem0` 段，写之前先把旧文件复制为 `~/.dsh/mem0/oss.json.bak-<UTC 时间>`（例如 `oss.json.bak-20261121T083000Z`；Windows 在 `%USERPROFILE%\.dsh\mem0\`）。如果你把明文 key 挪进了 DSH 凭据库，它会从 `oss.json` 里删掉，但备份里还在。
4. 之后插件不再连接 Qdrant。旧数据留在 Qdrant 里不再使用；确认没问题后可以停掉或删掉（想保留回退余地就先留着）。
5. 模型巡检默认开启（见上文）。不想产生 LLM 调用，请在第一次巡检前关掉。

Platform 和自托管 server 用户无需任何操作。

#### 回退到 0.3.1

1. 用你当初安装插件的方式安装 npm 包 `dsh-mem0@0.3.1`。
2. 恢复配置：把最新的 `~/.dsh/mem0/oss.json.bak-<UTC 时间>` 复制回 `~/.dsh/mem0/oss.json`。
3. 0.3.1 需要它的 Python 环境（`~/.dsh/mem0/venv`）和 Qdrant 服务端；如果停了 Qdrant，请重新启动。
4. 0.3.1 只读 Qdrant，而迁移从未改动过 Qdrant：升级之后新存的记忆只在 `memory.sqlite` 里，回退后看不到。`memory.sqlite` 会保留在原处，以后再升级还能找回。

#### 其他变化

- **巡检和摘要。** 全局和当前项目的摘要由模型撰写（每次巡检最多 6 次调用），失败时退回脚本摘要。可以在记忆列表里或用新的 `mem0_pin` 工具置顶记忆；重要度影响召回和摘要（`importanceWeight`，默认 0.2）。巡检不再因为数量多而删除记忆（去掉了 `storeMaxMemories` 和 `storeMaxTokens`；超过 `storeSafetyLimit`，默认 20000，只提示）。没有可用模型时（没 key、额度用完、超时、回复不合格），巡检只跑脚本部分，并说明原因。
- **数据安全修复**（外部审阅）：只有完全相同才算重复（`dose 1.5 mg` 和 `dose 15 mg` 不再被当成一条）；确认的清理只执行一次（`planId` + 幂等键；不带 `dryRun: true` 的 `POST /dsh-mem0/gui/hygiene` 现在两者都要）；摘要、巡检历史和授权按记忆库和用户分开；dispose 会停下正在跑的巡检；召回查询和摘要都会脱敏；删除或修改记忆会让用到它的摘要失效；`mem0_get` / `mem0_update` / `mem0_delete` 拒绝不能证明属于你的记忆；`mem0_add` 和 `mem0_update` 不能再设置巡检依赖的元数据。
- **记忆库：** 可以删除本插件写入的单条记忆（需要确认）；巡检报告显示被合并、被打分记忆的正文。
- **状态更清楚。** 最近 20 次记忆失败保存在 `<DSH profile>/dsh-mem0/failures.json`，含时间、原因和出错的组件，显示在 **最近失败** 里；状态图标区分「记忆失败」和 **状态读取失败**；没有写入任何内容的捕获显示灰色的 **无新内容**；跳过和熔断暂停都会说明原因；连接被拒时写明 host:port，并提示 Windows 保留端口（`os error 10013`）。
- **抽取。** 模型的思考不会再把回答挤到截断（`llmMaxTokens` 默认 8000，截断时用加倍的上限重试一次）；回复按 Mem0 2.2.1 的方式解析；抽取失败报告为 **LLM 抽取失败** 并附原因，不会让记忆暂停。
- **设置。** 带小数权重（`importanceWeight`、`projectRecallBoost`）时又能保存了。DSH 同步时从 `cordis.patch.yml` 删掉的设置会被发现（「dsh-mem0 settings look rewritten」），设置也可以放在 `oss.json` 的 `dsh_mem0` 段里。正在进行的迁移或重算向量可以取消；更换 embedding 时只重算有变化的向量。
- **其他：** DSH 插件页显示简短的本地化页面（中文 / 英文），不再是 README；`authType: token` 发送 `Authorization: Token <key>`；DSH 没给 profile 目录时，不再往共享的 `~/.dsh/mem0` 写东西；后台调用 DSH 模型时不再生成会话文件；`projectRecallBoost`（默认 1.1）在召回时给项目和会话记忆加权。
- **开发：** CI 在 Windows、macOS、Linux 上运行；每周的工作流会报告提示词或流程与 2.2.1 不同的 mem0ai 新版本；mock server 可以注入故障、预置记忆；`npm test` 使用临时 `HOME`。
- 本周期里对 Python sidecar 的修复（嵌入式 Qdrant 检查 [#23](https://github.com/light-cheng/DSH-Mem0/issues/23)、Windows 解释器查找、sidecar 启动和退出原因、`sidecar.log`、停止时强制结束、一次安全重试）从未发布，随 sidecar 的移除一并作废。

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

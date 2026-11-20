# Release notes

English is the default; the Chinese version follows below.

## English

### Unreleased

- **One fact, one memory** (Windows test: "remember I travel next week" gave three near-identical memories). The local backend shows memories `mem0_add` stored in the same turn to that turn's capture as existing, and no longer stores a captured fact whose cosine similarity with one of those or an earlier fact of the batch is at least `captureDedupThreshold` (new, default 0.95, `0` = off). Only this turn's writes are compared by meaning; older memories get md5 only, so a correction of an older fact is never dropped (V3 additive cannot update it). This deviates from Mem0 2.2.1, which drops exact md5 duplicates only; see README "Near-duplicate check". The assistant's sentences that confirm a memory or talk about tools or screenshots are no longer sent to extraction (every backend; Mem0's prompt itself is unchanged). The activity record counts both.
- **Recall step times.** Each automatic recall records store open, key lookup, embedding, SQLite search, building the block and the rest, in the settings page's activity and as `last recall:` in `mem0_status`, also for a recall that timed out. README "Slow recall" lists the expected values and a PowerShell retest.
- **Faster first recall with Ollama.** Embedding requests to Ollama carry `keep_alive` (`embedderKeepAlive`, new, default `30m`), and a local embedding server is warmed up once at start, so a recall after a pause no longer waits 2–7 s for the model to load. Cloud embedders are never called for this.
- **Setup wizard, LLM step:** the test result is a green or red card under the test button with finish_reason, output / prompt tokens and time; a failure says why and what to do. It stays until a setting of the step (or its key) changes, and leaving the step before the test passed asks once (**Next anyway**).
- **Status orb from dissolve.** The composer status icon is now dissolve's ThinkingOrb (MIT, Rayan Selmi; vendored at commit 06eddec in `vendor/dissolve`, inlined into the client, no CDN): idle → slowly turning sphere, recalling → radar disc, saving → three rings, success → light-blue check (kept while the success shows), failure → dots fall and reform in red. 18 px, 36 dots, readable in light and dark themes, still under reduced motion. The orb is created once per mounted composer and destroyed on unmount (session switch, plugin dispose), which stops its frame loop and observers. The **Memory: project/global** chip is unchanged.
- **Memory partitions: global, project and session** (local backend).
  - A session's project is the hash of its normalised git `origin` (ssh and https forms match), else the repository root, else the working directory; Windows drive case and backslashes do not matter. Only the hash and the repository or folder name are stored.
  - A session keeps the project of the folder it started in (a `cd` does not move it). Without origin, worktrees of one repository share a project (`--git-common-dir`); a git project keeps its repository and folder ids as aliases, so memories from before an origin was added are still read. A git timeout is retried after a minute; inherited `GIT_DIR`-style variables are ignored; the home folder outside git is no project.
  - Recall reads global plus the current project and session, project and session scores × `projectRecallBoost` (new option, default 1.1, 1–2), from four times `recallTopK` candidates. Captures go to the current project; `mem0_add` and `mem0_search` take a `scope`. Without a known project (background work, no working directory) writes go to global; a dsh-strata fold whose session DSH no longer has is not saved. Memories from before partitions count as global and are not rewritten. Hygiene merges, replaces and removes exact duplicates only within one partition (a project copy of a global memory goes, never the global one). REST backends have no partitions.
- **Partition by project switch** (`projectPartitions`, default on), in the settings page and as a chip next to the status orb below the input box ("Memory: project dsh-mem0" / "Memory: global"; a click flips the same setting, from the next turn). Off: new memories all go to global, recall reads global and this session, hygiene and summaries handle global only; project memories and their summaries are kept unchanged and work again when it is back on. Project memories never reach global on their own: no project summary is merged into the global one, hygiene never merges across partitions, and only **Make global** moves a memory.
- **Settings page saves again with decimal weights.** Every save was refused as "not a number" because `importanceWeight` (0.2) and `projectRecallBoost` (1.1) were checked as whole numbers; they now take decimals, the other numeric fields stay whole.
- **Memory page.** The memory library has a partition tree (all, global, projects and their sessions) with search, pin, delete and **Make global** for this plugin's project memories; no editing. The hygiene report's merge and importance rows show the memories' text, read by id, or **deleted**.
- **Partition summaries written by the model.** The system-prompt summary has a global part and one for the current project. Due hygiene passes write each with the DSH model (at most 6 calls per pass, ranked memories, redacted), keep one whose sources did not change, and fall back to the script summary (also after two unusable answers for the same sources). A delete or edit marks only the summaries using that memory stale at once (#24 rules); they are rebuilt 45 seconds later by the script, never by the model. The global summary now covers global memories only; an empty global partition no longer brings an hourly pass.
- **Model-led memory hygiene, on by default** (scripts check every step).
  - The pass asks the model currently set in DSH (`ctx.llm`, the background default model, no session; lowest reasoning effort, an explicit output cap of 1536 tokens, doubled once when cut off; an answer that is not valid JSON is asked again once) about one group of memories at a time: the memories new or changed since the last review, each with its most similar older ones. The model answers one JSON object of `merge`, `delete`, `keep` and `importance` (1–5) actions, each with a reason and the record ids of the group. Scripts remove exact duplicates, pick and group the candidates, and check each action: ids must belong to the group, delete and merge only touch this plugin's own memories (`source=dsh`) and never pinned ones, no memory is used twice, a delete's `by` record must be newer than what it replaces, merged text must be plain text, a memory whose text had a secret redacted is never merged. A merged memory takes the highest importance given to its sources. Anything else is dropped and counted. A merge writes one new memory (`metadata.merged_from`) and deletes its sources.
  - All #24 safety rules stay: automatic passes only preview deletes and merges until you confirm one manual run; a confirmed preview runs once (planId + idempotency key) and only on memories still unchanged; at most 100 memories go per pass; the store's scope is kept; dispose stops the pass; deleted memories invalidate the summary. Importance is stored by every pass except a manual preview (it deletes nothing).
  - Billing: these calls are billed to your provider in DSH and do not appear in DSH usage statistics. Each report shows the calls and tokens used. Turn **Model-led hygiene** (`modelHygiene`) off to run the script checks only.
  - Fallback: with no DSH model service, no adapter or key, an unreachable provider, an exhausted quota, a timeout or an answer that is not the required JSON, the pass runs its script part only, says why in the report and activity, and does not count as a failure.
  - Memory text is redacted and stripped of recall tags before it is sent; records go in as one JSON document and the prompt says they are data, not instructions.
  - Two lanes: memories new or changed since the last review first, then the backlog stored before the first review with what is left of the pass (96 memories, 12 calls). Small groups share a call (up to 12 records, about 4000 estimated input tokens). Other apps' memories are context only.
  - **Catch-up:** while new or changed memories are left over and the model answers, the next pass comes a day later instead of after the interval, until they are all reviewed. The report and the settings page show how many are still to review. Not for the backlog, and not after a pass where the model was unavailable. Before the first confirmed run the early pass is a preview too; automatic previews keep their own place, so the same memories are not paid for again each week.
  - Before deleting, the store is listed again: a memory pinned, edited or removed while the model was asked is left alone; a merge goes only with all its sources. The sources are deleted only once the merged memory can be read back (a queued Platform write keeps them for a later pass). A merged memory keeps the latest date of its sources (`metadata.fact_date`).
  - Limits against a misled model: a `by` record must not be older than what it replaces and stays itself; noise deletes (no `by`) are at most a third of a call; an answer deleting every record of its call is dropped; at most 20 model deletes per pass, the rest wait for the next pass. A call that fails twice with the same memories is skipped until one of them changes. When the model becomes unavailable mid-pass, calls already answered keep their actions.
  - `mem0_add` and `mem0_update` can no longer set the metadata hygiene relies on (`source`, `channel`, `merged_from`, `merged_at`, `fact_date`, `pinned`, `importance`).
  - A manual **Run hygiene now** while another pass runs is refused as busy. An automatic pass waits for DSH's model service and the selected provider instead of degrading at startup; it degrades only if the model is still missing at the first hourly check, and a manual run before then says the model service is still starting. A route that refuses `temperature` is asked again without it.
- **No more deleting for size.** `storeMaxMemories` and `storeMaxTokens` are removed (ignored if set). Above `storeSafetyLimit` (default 20000) hygiene only warns.
- **Importance and pinning.** An unrated memory counts as 3 and ratings weigh freshness within bounds (× 0.5 to × 1.5), so old rated memories do not push fresh facts out of the summary. Importance orders the summary and weighs recall (`importanceWeight`, default 0.2: × 0.8 for importance 1 up to × 1.2 for 5; recall fetches a few extra hits to reorder). Pin or unpin a memory in the settings page's memory list or with the new `mem0_pin` tool (local backend): pinned memories are never deleted or merged by hygiene. The Mem0 Platform and self-hosted server backends have no pinning or importance; merges and deletes run the same.
- **Cancelling a migration or re-embedding.** A running move from Qdrant or vector recomputation has a **Cancel** button; it stops at the next step and changes nothing (the migration cannot be cancelled once it switches the store over). A retried re-embedding reuses the vectors of memories whose text did not change and recomputes only new or edited ones.

- **Local setup wizard and one-time move from Qdrant** (settings page → Local OSS → Local setup wizard). Part of the breaking change below: together they replace the removed fallback paths.
  - Steps: embedding model (cloud API first; or a local server found on 127.0.0.1: Ollama 11434/15434, LM Studio 1234, oMLX 8000 on macOS only; Windows gets the reserved-port / 10013 hint), extraction LLM (one test extraction with `max_tokens` / `reasoning_effort` advice), memory file (shown, changeable under advanced; writable, not on a network drive, including mapped Windows drives and SMB/NFS shares under `/Volumes`, or a synced folder), and a self-test with the test user `dsh-mem0-wizard-selftest` (write, find, delete, nothing left). Nothing is saved before the self-test passes.
  - Saving stores typed keys only in DSH credentials and writes credential names to the `dsh_mem0` block of `oss.json` (previous file kept as `oss.json.bak-<time>`); a plain-text key you move is removed from the `oss` block, and the result says the backup still holds it. A stored key is sent only to the server it was saved for, and only the wizard's own credential names or the one in use are read or written (replacing another key asks first). The setup route takes same-origin JSON only and refuses to run without DSH's trust fence. Switching the backend to Local OSS checks first and offers the wizard when something is missing.
  - Migration: reads the Qdrant collection of this setup (from `oss.json` or `collectionName`, default `dsh_mem0`; no free choice) of a Qdrant server, only the configured user's points; never lists collections, refuses names starting with `mem0`, sends `oss.json`'s Qdrant key only to that Qdrant, never writes or deletes in Qdrant, makes no backup. Vectors are copied when model and dimension match (and you agree), else recomputed. Written to `memory.sqlite.importing` in one transaction and checked (count against Qdrant's, read-back sample, top-5) before it becomes the store or is merged into it; a failure leaves the store as it was. Points with another form of `user_id` are counted and left out. Moving again into a filled store needs a confirmation (deleted memories would come back). Users who had the local backend on but no Qdrant block in `oss.json` are offered the step too. A running move or re-embedding is picked up again after a page reload. The manual memory summary comes along. Afterwards the settings page says the old data is still in Qdrant, unused.
  - Changing the embedder of a filled store: the self-test runs in a temporary file and saving recomputes the vectors before writing `oss.json` (the current setup keeps working until then). Vectors and embedder record are written in one transaction, which starts over if memories were added, deleted or edited meanwhile.
- **Breaking: the local backend is now native Node, on SQLite. The Python sidecar and Qdrant are gone.** The old fallback paths have been removed; please reconfigure with the settings-page wizard.
  - `backend: oss` keeps memories in `~/.dsh/mem0/memory.sqlite` (`node:sqlite`, built into DSH's Node; WAL and a busy timeout so several DSH profiles can share it; mode 0600 on macOS/Linux). Search is brute-force cosine over an in-memory vector cache that follows other processes' writes through `data_version`.
  - Adds follow Mem0 2.2.1's V3 additive pipeline, ported to JavaScript: last 10 messages of the scope, the 10 most similar memories, one LLM call with Mem0's extraction prompt copied verbatim (with "answer in the input language" on), ADD only, md5 de-duplication. Adds of one scope run one after another. The prompt is checked byte for byte against Mem0 2.2.1's own helpers. See NOTICE (Apache-2.0).
  - Two embedders: any OpenAI-compatible `/embeddings` server, or Ollama `/api/embed`. The store records which embedder wrote its vectors; another one is a clear `EMBEDDER_MISMATCH` configuration error instead of mixed vectors (an empty store takes the new one).
  - Configuration lives in the `dsh_mem0` block of `~/.dsh/mem0/oss.json` (`embedderProvider`, `embedderBaseUrl`, `embedderModel`, `embedderDims`, `embedderApiKeyRef`, `llmBaseUrl`, `llmModel`, `llmApiKeyRef`, `llmMaxTokens`, `llmTemperature`, `llmReasoningEffort`, `storePath`). Keys are credential names looked up in DSH credentials, then the environment; a Mem0-format `oss.json` with literal keys keeps working.
  - SQLite errors are attributed to the vector store with a code (`busy`, `corrupt`, `readonly`, `disk_full`, …). `mem0_status` shows `store: ok (sqlite)`; health keeps the old `qdrant` field for earlier settings pages.
  - Removed: `python/`, the sidecar client and log, `pythonPath`, `mem0ConfigPath`, `historyDbPath`, `sidecarEnv`, the legacy fallback config paths, the Qdrant checks and the Python CI steps. Old settings are ignored with a debug line, never an error, and do not trigger "settings look rewritten". Memories in Qdrant are not read by this version; the wizard's migration copies them.
  - Background calls to DSH's own model (memory translation) use the default model selection without a session, so they create no session file.
  - Requires Node >= 24.9 (DSH ships 24.21). CI runs on Windows, macOS and Linux; a weekly workflow reports new mem0ai releases whose prompts or pipeline differ from 2.2.1.
  - The earlier Unreleased entries below about the Python sidecar, its interpreter discovery, embedded Qdrant and `sidecar.log` describe code this release removes.
- **Hygiene and summary data-safety fixes** (external review of b93f4a0):
  - *Duplicates are exact copies only.* Deletion compares a hash of the full text after case and whitespace normalisation. Before, punctuation was dropped and only the first 240 characters compared, so `dose 1.5 mg` and `dose 15 mg`, or two long notes with opposite endings, were "duplicates" and one was deleted. Look-alikes are now reported as suspected duplicates and kept.
  - *A confirmed cleanup runs once.* The preview returns a `planId`; the confirmation must send it with an idempotency key, is never retried by the page, and deletes only the plan's memories that still exist unchanged. A resend returns the first result. Before, a lost response made the page resend, and the plugin computed a new plan: a 100-memory preview could delete 200. `POST /dsh-mem0/gui/hygiene` without `dryRun: true` now needs `planId` and `idempotencyKey` (HTTP 409 otherwise).
  - *Per-store summary, history and authorisation.* `maintenance.json` (now version 2) keeps them per backend + endpoint + OSS collection + user + agent. Switching user no longer lets a due pass delete the new user's memories with the old user's authorisation, and another backend or collection no longer gets the old summary. Upgrading keeps only a manual summary for the same user; automatic passes preview again until the next confirmed run.
  - *Disposing stops a running pass.* List and delete requests carry an abort signal; the pass stops before the next delete and state write, and a reloaded plugin waits for it.
  - *Redaction for queries and summaries.* Recall and `mem0_search` queries are redacted before the backend and in Activity. Summaries are redacted when built, saved and injected, and forged `</mem0-user-profile>` / `</mem0-relevant-memories>` tags are removed.
  - *Deleting or updating a memory invalidates the generated summary.* It stops being injected at once and is rebuilt in the background, also with hygiene off. A manual summary keeps being injected but is flagged on the Memory summary card when one of its sources was deleted or changed.
  - *Reports count real results.* Remaining count and summary are the store minus the deletes that succeeded (125 memories, limit 20, 100 per run: 25 left, not 20). An automatic preview's summary no longer drops facts that are still stored.
  - *Ownership must be proven.* `mem0_get`, `mem0_update`, `mem0_delete` and the library delete refuse a memory whose `user_id` is missing or empty (also agent-only memories) unless a listing filtered by the configured user contains it.
  - *Server `authType: token`* now sends `Authorization: Token <key>`; before, it sent `X-API-Key`.
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

- **一条事实只存一条记忆**（Windows 实测：「记住我下周要去某地出差」存出了三条近似记录）。本地后端把同一轮里 `mem0_add` 存下的记忆当作已有记忆交给这一轮的自动保存；抽出的事实和这些记忆或同批更早的事实余弦相似度达到 `captureDedupThreshold`（新增，默认 0.95，`0` 为关闭）就不存。只有本轮写入的内容按语义比较，更早的记忆只做 md5 去重，所以对旧事实的更正不会被丢掉（V3 additive 无法更新旧记忆）。这一点偏离 Mem0 2.2.1（上游只按 md5 去掉完全相同的），见 README「近重复检查」。助手回复里确认记忆、谈工具或截图的句子不再送去抽取（所有后端；Mem0 的 prompt 本身不变）。活动记录会写明两者各有几条。
- **召回分段耗时。** 每次自动召回都记下打开存储、凭据查询、embedding、SQLite 检索和打分、生成注入块和其他各用了多久，显示在设置页的记忆活动里，`mem0_status` 里是 `last recall:` 一行，召回超时时也有。README「召回慢」列出了预期值和 PowerShell 复测步骤。
- **用 Ollama 时首次召回更快。** 发给 Ollama 的 embedding 请求带上 `keep_alive`（新增 `embedderKeepAlive`，默认 `30m`），启动时还会预先加载一次本地 embedding 模型，隔一段时间再召回不用再等 2–7 秒的模型加载。云端 embedding 不会因此被调用。
- **设置向导 LLM 这一步：** 测试结果显示在测试按钮下方，成功是绿色、失败是红色，写明 finish_reason、输出和提示 token 数及耗时；失败时写出原因和建议。结果一直保留，直到这一步的设置（或 key）改动；测试没通过就离开这一步时会先提示一次（**仍然下一步**）。
- **状态图标换成 dissolve 的 ThinkingOrb。** 输入框下方的状态图标改用 dissolve 的 ThinkingOrb（MIT 许可，作者 Rayan Selmi；按 commit 06eddec 放在 `vendor/dissolve`，内联进客户端，不从 CDN 加载）：待命是缓慢转动的球，召回是雷达圆盘，保存是三道环，成功是浅蓝色对勾（成功状态显示期间一直保持），失败时圆点落下并重新聚成红色。18 像素、36 个点，浅色和深色主题下都看得清，开启「减少动态效果」时静止。每个输入框挂载时创建一个小球，卸载时（切换会话、插件停用）销毁，动画循环和监听随之停止。「记忆：项目/全局」标签不变。
- **记忆分区：全局、项目、会话**（本地后端）。
  - 会话的项目取规范化后 git `origin` 的哈希（ssh 和 https 写法一致），没有就取仓库根目录，再没有取工作目录；Windows 盘符大小写和反斜杠不影响。只保存哈希和仓库或文件夹名。
  - 会话的项目按起始目录锁定（中途 `cd` 不换项目）。没有 origin 时，同一个仓库的各个 worktree 算一个项目（`--git-common-dir`）；git 项目把仓库和文件夹的 id 记成别名，加 origin 之前的记忆照样能读到。git 超时一分钟后重试；不继承 `GIT_DIR` 之类的环境变量；不在 git 里的用户主目录不算项目。
  - 召回读取全局加当前项目和会话，项目和会话记忆分数乘以 `projectRecallBoost`（新选项，默认 1.1，范围 1–2），候选取 4 倍 `recallTopK`。自动保存写入当前项目；`mem0_add`、`mem0_search` 支持 `scope` 参数。不知道项目时（后台任务、没有工作目录）写入全局；DSH 里已经没有对应会话的 dsh-strata 折叠不保存。分区之前的旧记忆算作全局，不改写。巡检的合并、取代和精确去重都只在同一分区内进行（项目里和全局重复的删项目那条，全局的永远不删）。REST 后端没有分区。
- **记忆页。** 记忆库加了分区树（全部、全局、各项目及其会话），可搜索、置顶、删除，本插件的项目记忆可「改为全局」；不能编辑。巡检报告的合并和重要度明细按 id 显示记忆正文，已删的显示「已删除」。
- **「按项目分区」开关**（`projectPartitions`，默认开），在设置页里，也在输入框下方状态小球旁边显示为标签（「记忆：项目 dsh-mem0」/「记忆：全局」；点击切换的是同一个设置，从下一轮开始生效）。关闭后新记忆一律写进全局，召回只读全局和本会话，巡检和摘要只处理全局；已有的项目记忆和项目摘要原样保留，重新打开后照常能用。项目记忆不会自动进入全局：项目摘要不会汇总进全局摘要，巡检合并不跨分区，只有「改为全局」会移动记忆。
- **设置页带小数权重时又能保存了。** `importanceWeight`（0.2）和 `projectRecallBoost`（1.1）之前按整数校验，导致每次保存都提示不是数字；现在这两项允许小数，其他数值项仍要求整数。
- **分区摘要由模型生成。** 系统提示词里的摘要分为全局和当前项目两部分。到期的巡检用 DSH 的模型分别生成（每次最多 6 次调用，按排序取记忆并脱敏），来源没变就保留，失败时退回脚本摘要（同一组来源连续两次回答不可用也一样）。删除或修改记忆后，只有用到它的摘要立即失效（#24 规则），45 秒后用脚本重建，不调用模型。全局摘要现在只包含全局记忆；全局分区为空时不会再每小时跑一次巡检。
- **记忆巡检改成以模型为主，默认开启**（脚本逐步校验）。
  - 巡检调用你当前在 DSH 配置的模型（`ctx.llm`，后台默认模型，不带会话；推理强度取最低一档，输出上限 1536 token，被截断时加倍重试一次；回答不是合法 JSON 时再问一次），每次只看一组记忆：上次审阅之后新增或改过的记忆，各自带上最相似的旧记忆。模型返回一个 JSON 对象，里面是 `merge`、`delete`、`keep`、`importance`（1–5）几种动作，每个动作都带理由和本组记录的 id。脚本负责精确去重、挑选和分组候选，并逐条校验：id 必须属于本组；删除和合并只碰本插件写入的记忆（`source=dsh`），不碰置顶的记忆；同一条记忆不能用在两个动作里；删除时 `by` 指的记录必须比被删的更新；合并后的正文必须是纯文本；正文里有密钥被脱敏的记忆不参与合并。不合规的动作直接丢弃并计数。合并的做法是写入一条新记忆（带 `metadata.merged_from`），再删除原来的几条；新记忆取原记忆得到的最高重要度。
  - #24 的安全机制全部保留：确认过一次手动巡检之前，自动巡检只预览删除和合并；确认的预览只执行一次（planId 加幂等键），只处理预览后没改过的记忆；每次最多处理 100 条；按记忆库隔离；停用插件时中止巡检；删除记忆后摘要失效。重要度不删除任何东西，除手动预览外每次巡检都会写入。
  - 计费：这些调用的费用记在你在 DSH 配置的 provider 上，不计入 DSH 的用量统计。每份巡检报告都显示调用次数和用掉的 token。关掉「模型巡检」（`modelHygiene`）后只做脚本巡检。
  - 降级：DSH 没有模型服务、没有 adapter 或 key、provider 连不上、额度用完、超时，或者模型的回答不是要求的 JSON 时，本次只做脚本巡检，在报告和活动记录里写明原因，不算失败。
  - 记忆正文发出前先脱敏，并去掉召回块标记；记录作为一个 JSON 文档发送，提示词里写明它们是数据，不是指令。
  - 两条队列：先审上次审阅之后新增或改过的记忆，再用这次剩下的额度（共 96 条、12 次调用）补审第一次审阅之前的存量。小组合并到同一次调用（最多 12 条、估算输入约 4000 token）。别的应用写入的记忆只作为上下文。
  - **自动追赶：** 新增或改过的记忆还有剩余、而且模型能正常回答时，下一次巡检提前到一天后，直到全部审完。报告和设置页显示「还有 N 条待巡检」。存量补审不触发提前，模型不可用的那次之后也不提前。确认过一次手动巡检之前，提前的那一次也只出预览；自动预览单独记录进度，不会每周为同一批记忆重复付费。
  - 删除之前重新列一次记忆：模型审阅期间被置顶、编辑或删掉的记忆不动；合并只有全部原记忆都没变时才执行。能读回合并后的记忆之后才删原记忆（Platform 排队写入时，原记忆留到之后的巡检）。合并后的记忆记下原记忆里最晚的日期（`metadata.fact_date`）。
  - 防止模型被误导：`by` 指的记录不能比被删的旧，而且它自己必须保留；没有 `by` 的删除（噪声）最多占一次调用的三分之一；要删掉整组的回答整个丢弃；每次巡检最多执行 20 条模型发起的删除，其余留到下次。同一组记忆连续失败两次就跳过，直到其中有记忆变动。巡检中途模型不可用时，已经回答的调用照常使用。
  - `mem0_add` 和 `mem0_update` 不能再设置巡检依赖的元数据（`source`、`channel`、`merged_from`、`merged_at`、`fact_date`、`pinned`、`importance`）。
  - 另一次巡检正在进行时点「立即巡检」，会提示正在进行。自动巡检会等 DSH 的模型服务和选中的 provider 就绪再跑，启动时不再降级；到第一次每小时检查时仍然没有模型才降级，在那之前手动巡检会提示模型服务还在启动。路由不接受 `temperature` 时去掉它再问一次。
- **不再按条数删除记忆。** 去掉 `storeMaxMemories` 和 `storeMaxTokens`（旧配置里有也会忽略）。超过 `storeSafetyLimit`（默认 20000）时巡检只提醒。
- **重要度和置顶。** 没评分的记忆按 3 分算，重要度只在一定范围内（× 0.5 到 × 1.5）加权新鲜度，评过分的旧记忆不会把新事实挤出摘要。重要度用于摘要排序和召回加权（`importanceWeight`，默认 0.2：重要度 1 乘 0.8，重要度 5 乘 1.2；召回会多取几条再重排）。在设置页的记忆列表里，或用新的 `mem0_pin` 工具（本地后端）置顶、取消置顶；置顶的记忆不会被巡检删除或合并。Mem0 Platform 和自托管 server 后端没有置顶和重要度，合并和删除照常进行。
- **迁移和重算向量可以取消。** 正在进行的 Qdrant 迁移或向量重算有「取消」按钮，会在下一步停下，不做任何改动（迁移开始切换数据库之后就不能取消了）。重算向量重试时，正文没变的记忆沿用已算好的向量，只重算新增或改过的。

- **本地配置向导，以及从 Qdrant 一次性迁移**（设置页 → 本地 OSS →「本地配置向导」）。属于下面那条不兼容变更的一部分：两者一起取代已移除的旧版回退路径。
  - 步骤：embedding 模型（优先云端 API；也可以用在 127.0.0.1 上探测到的本地服务：Ollama 11434/15434、LM Studio 1234，oMLX 8000 只在 macOS 上探测；Windows 上给出端口保留段 / 10013 的提示），抽取 LLM（试抽一次，给出 `max_tokens` 和 `reasoning_effort` 的建议），记忆文件（只显示，在「高级」里可改；能写入，不在网络盘上，包括 Windows 映射盘和 `/Volumes` 下的 SMB/NFS 共享，也不在同步目录上），以及用测试用户 `dsh-mem0-wizard-selftest` 自测（写入、检索、删除、无残留）。自测通过之前什么都不保存。
  - 保存时，输入的 key 只存进 DSH 凭据库，`oss.json` 的 `dsh_mem0` 段里只写凭据名（原文件备份为 `oss.json.bak-<时间>`）；你选择移走的明文 key 会从 `oss` 段删除，并提示备份文件里仍有。已存的 key 只发给保存时的那个服务；向导只读写自己的凭据名或当前正在用的那个，替换别的 key 会先确认。配置接口只接受同源的 JSON 请求，拿不到 DSH 的信任检查时拒绝服务。把后端切到本地 OSS 时会先探测，缺东西就提示打开向导。
  - 迁移：只读 Qdrant 服务端上这套配置的 collection（取 `oss.json` 或 `collectionName`，默认 `dsh_mem0`；不能随便填），并且只读当前用户的点；不列出 collection，以 `mem0` 开头的名字一律拒绝，`oss.json` 里的 Qdrant key 只发给那个 Qdrant，不在 Qdrant 里写入或删除任何东西，也不做备份。模型和维度一致（并经你同意）时直接拷贝向量，否则重新计算。先写进 `memory.sqlite.importing`，在一个事务里提交并校验（条数和 Qdrant 的 count 对比、抽样读回比对、top-5），通过后才成为记忆文件或合并进去；失败时记忆文件保持原样。`user_id` 形式不同的点单独计数，不迁移。已迁移过的记忆文件再迁移需要确认（删掉的记忆会被导回来）。以前开着本地后端、但 `oss.json` 里没有 Qdrant 段的用户也会看到这一步。页面刷新后，正在进行的迁移或重算会接着显示。手动记忆摘要一起带过来。迁移后设置页提示：旧数据仍在 Qdrant，不再使用。
  - 已有记忆时换 embedding：自测改用临时文件，保存时先重算向量、再写 `oss.json`（在这之前当前配置照常运行）。向量和 embedding 记录在同一个事务里写入；期间有记忆增删或修改就从头再来。
- **不兼容变更：本地后端改为原生 Node + SQLite，去掉了 Python sidecar 和 Qdrant。** 旧版回退路径已移除，请用设置页向导重新配置。
  - `backend: oss` 把记忆存在 `~/.dsh/mem0/memory.sqlite`（DSH 自带 Node 内置的 `node:sqlite`；WAL 加 busy timeout，多个 DSH profile 可以共用；macOS/Linux 上权限 0600）。检索是对内存向量缓存做暴力余弦比较，通过 `data_version` 跟上其他进程的写入。
  - 写入流程按 Mem0 2.2.1 的 V3 追加式流程移植到 JavaScript：该范围最近 10 条消息、最相似的 10 条记忆、一次使用 Mem0 原文抽取 prompt 的 LLM 调用（开启「按输入语言回答」）、只做 ADD、md5 去重。同一范围的写入依次执行。prompt 与 Mem0 2.2.1 自己的函数逐字节对照测试。见 NOTICE（Apache-2.0）。
  - 两种 embedding：任意 OpenAI 兼容的 `/embeddings` 服务，或 Ollama `/api/embed`。存储记录写入向量的 embedding；配置成另一个时给出明确的 `EMBEDDER_MISMATCH` 配置错误，不会混用向量（空存储直接采用新的）。
  - 配置写在 `~/.dsh/mem0/oss.json` 的 `dsh_mem0` 段（`embedderProvider`、`embedderBaseUrl`、`embedderModel`、`embedderDims`、`embedderApiKeyRef`、`llmBaseUrl`、`llmModel`、`llmApiKeyRef`、`llmMaxTokens`、`llmTemperature`、`llmReasoningEffort`、`storePath`）。密钥写凭据名，先查 DSH 凭据再查环境变量；带明文密钥的 Mem0 格式 `oss.json` 仍然可用。
  - SQLite 错误归到向量库并带代码（`busy`、`corrupt`、`readonly`、`disk_full` 等）。`mem0_status` 显示 `store: ok (sqlite)`；健康检查保留旧的 `qdrant` 字段，兼容旧设置页。
  - 移除：`python/`、sidecar 客户端和日志、`pythonPath`、`mem0ConfigPath`、`historyDbPath`、`sidecarEnv`、旧的回退配置路径、Qdrant 检查和 CI 里的 Python 步骤。旧设置会被忽略，只记 debug 日志，不报错，也不会触发「配置疑似被重写」。这个版本不读取 Qdrant 里的记忆；向导的迁移步骤会复制它们。
  - 插件在后台调用 DSH 自己的模型（记忆翻译）时使用默认模型选择、不带会话，不会生成会话文件。
  - 需要 Node >= 24.9（DSH 自带 24.21）。CI 在 Windows、macOS、Linux 上运行；每周的工作流会在 mem0ai 发布 prompt 或流程与 2.2.1 不同的新版本时提醒。
  - 下面几条更早的「未发布」条目（Python sidecar、解释器查找、内嵌 Qdrant、`sidecar.log`）描述的代码已在本次移除。
- **巡检和摘要的数据安全修复**（外部审阅 b93f4a0）：
  - *只有完全相同才算重复*。删除前比较完整文本在大小写和空白规范化后的哈希。之前会去掉标点、只比前 240 字，`dose 1.5 mg` 和 `dose 15 mg`、或结尾结论相反的两条长记录会被判为重复并删掉一条。看起来相似的现在只列为「疑似重复」，不删除。
  - *确认的清理只执行一次*。预览返回 `planId`；确认必须带上它和幂等键，页面不会自动重发，只删除计划里仍然存在且未改动的记忆，重复提交返回第一次的结果。之前响应丢失时页面会重发，插件又重新算一份计划：预览 100 条可能删掉 200 条。`POST /dsh-mem0/gui/hygiene` 不带 `dryRun: true` 时必须带 `planId` 和 `idempotencyKey`，否则返回 HTTP 409。
  - *摘要、巡检历史和授权按记忆库分开*。`maintenance.json`（现为第 2 版）按「后端 + 端点 + OSS collection + 用户 + agent」分别保存。切换用户后，到期巡检不会再拿旧用户的授权删除新用户的记忆；换后端或 collection 后也不再注入旧摘要。升级时只保留同一用户的手动摘要；自动巡检重新只做预览，直到下一次确认巡检。
  - *dispose 会停下正在跑的巡检*。列表和删除请求都带取消信号；巡检在下一次删除和写状态前停下，重载后的插件会等它停完。
  - *查询和摘要脱敏*。自动召回和 `mem0_search` 的查询在发给后端前、在活动记录里都脱敏。摘要在生成、保存和注入时脱敏，并去掉伪造的 `</mem0-user-profile>` / `</mem0-relevant-memories>` 标记。
  - *删除或更新记忆会让自动摘要失效*。立即停止注入，并在后台重建，关闭巡检时也一样。手动摘要继续注入，但如果它的来源被删除或修改，「记忆摘要」卡片会提示。
  - *报告按实际结果计算*。剩余数量和摘要 = 原集合减去删除成功的记忆（125 条、上限 20、单次最多 100：剩 25 条，而不是 20 条）。自动预览生成的摘要不再漏掉仍在库中的事实。
  - *归属必须能证明*。`mem0_get`、`mem0_update`、`mem0_delete` 和记忆库删除，遇到 `user_id` 缺失或为空（包括只有 agent 的记忆）时拒绝，除非按当前用户过滤的列表里有这条记忆。
  - *server 后端的 `authType: token`* 现在发送 `Authorization: Token <key>`；之前发的是 `X-API-Key`。
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

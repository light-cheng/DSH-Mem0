# DSH-Mem0

**English** | [简体中文](README.zh-CN.md)

<p align="center"><img src="assets/icon.png" width="96" height="96" alt="Mem0 Memory icon"></p>

A universal Mem0 long-term memory plugin for DeepSeek Harness (DSH).

Repository: <https://github.com/light-cheng/DSH-Mem0>

Three backends are supported:

- **Mem0 Platform**: the managed Mem0 API; only an API key is required, and it is the best fit for most users.
- **Self-hosted server**: connect to your own Mem0 REST service.
- **Local (OSS)**: memories in a SQLite file on this machine (`~/.dsh/mem0/memory.sqlite`), with your own embedding model (OpenAI-compatible server such as oMLX / LM Studio / vLLM, or Ollama) and extraction LLM. It is a native Node port of Mem0 2.2.1's add and search pipeline: no Python, no Qdrant, no extra service besides the two models.

## Features

- **Automatic recall**: on every turn, the latest real user message is used to search for related memories, injected into the model context as a `<mem0-relevant-memories>` data block. A failed or timed-out search never blocks the model request.
- **Automatic capture and filtering**: after a turn completes normally, the turn's user messages and the final assistant reply (not the intermediate narration between tool calls) are handed to Mem0 for fact extraction and storage, so long tool-heavy turns are still captured; interrupted, failed or rejected turns are not saved. The default heuristic filter skips greetings, short acknowledgements and command-only turns to reduce low-value memories.
- **Editable memory summary**: a structured summary is derived from stored memories, ranked by pinned/importance metadata and then freshness (newer facts first, decaying over roughly 90 days; text length only breaks ties), and injected before relevant memories. It has its own token budget, can be edited directly in the settings page, and can be read or rewritten by the agent through `mem0_profile_get` / `mem0_profile_update` / `mem0_profile_reset`. Manual edits survive weekly hygiene; **Rebuild from memories** restores the generated version.
- **Memory budgets and weekly model-led hygiene**: recall memories and the profile each have a token budget; a hygiene pass runs every 7 days by default. Scripts remove exact duplicates; the model currently set in DSH then reviews new and changed memories in small groups and proposes merges, deletes of outdated facts and an importance (1–5), which scripts check one by one. It only ever deletes or merges memories written by this plugin (`metadata.source: "dsh"`) and never pinned ones, and automatic passes only preview until you confirm a manual run in the settings page. The model calls are billed to your provider in DSH (not counted in DSH usage statistics); each report shows the tokens used, and **Model-led hygiene** turns them off. Nothing is deleted for size.
- **Explicit tools**: `mem0_search`, `mem0_add`, `mem0_get`, `mem0_update`, `mem0_delete`, `mem0_pin`, `mem0_status`, plus `mem0_profile_get`, `mem0_profile_update`, `mem0_profile_reset` for the memory summary.
- **Switchable backends**: Platform, self-hosted server and the local SQLite backend share the same tools and automatic memory logic.
- **Verifiable memory activity**: the settings page shows the last automatic capture / recall status and the most recently written memories (text, ID, time); it can open a **Memory library** to search every memory stored for the current user. **Last recalled memories** shows the texts that the most recent recall actually matched.
- **Foreground status icon**: below the chat composer, an 18 px sphere of dots (the ThinkingOrb from [dissolve](https://github.com/rs-4/dissolve), MIT) shows what memory is doing: a slowly turning sphere while idle, a radar disc while recalling, three tilted rings while saving, a light-blue check after a recall or save, and red falling dots on failure. Dark dots in light themes, light dots in dark themes; still when the system asks for reduced motion.
- **Bilingual UI and memory text**: labels follow DSH's language setting. With `translateMemories` on (off by default), stored memory text is translated into the page language with the current DSH model, cached, and falls back to the original text when no model is available.
- **Security boundaries**: the local backend opens no port and runs no extra process; common secrets are redacted before capture/recall; `mem0_status` never returns an API key.

## UI

After installation, open **Plugins** in the DSH sidebar and open **Mem0 Memory** under **Installed plugins**. You can choose a backend, inspect live connection status and save settings directly in the bundle detail page:

![Plugin manager page](assets/screenshots/en/01-plugin-page.png)

![Automatic detection and connection status](assets/screenshots/en/02-settings-auto.png)

Each backend has its own fields and guidance:

![Mem0 Platform configuration](assets/screenshots/en/03-settings-platform.png)

![Local OSS configuration](assets/screenshots/en/04-settings-oss.png)

The **Test connection** button calls the same read-only health check as `mem0_status`, showing the current backend, where memories are stored, the store / embedder / extraction LLM status, and never an API key.

**Memory summary** is the editable summary injected before relevant memories. It is shown as structured sections; use **Edit summary** to edit it and **Rebuild from memories** to regenerate it from the store. Manual edits survive weekly hygiene.

**Memory activity** records the latest automatic capture and recall results; **Recent memories** reads the backend directly and shows real memory text, ID and time. This makes it clear whether automatic capture actually worked. A capture that ran but wrote nothing (no memory added, updated or deleted) shows a grey **Nothing new** badge instead of the green **Saved**, and the composer status says **Nothing new to remember**. Platform and server answers that report no counts keep the **Saved** badge.

**View all memories** opens the **Memory library**, where every memory stored for the current user can be searched by content or ID. Memories this plugin wrote (`metadata.source = "dsh"`) have a **Delete** button. It first shows the memory's full text and ID and asks for confirmation; only then is that one memory deleted, its cached translation dropped and the list reloaded. Memories written by other apps or for another Mem0 user have no button, and the plugin's route (`DELETE /dsh-mem0/gui/memories?id=…`) refuses them with HTTP 403 and the reason. There is no bulk delete, clear-all or delete-by-filter. On the local backend the library has a tree on the left (all, global, each project with its sessions) to browse one partition; each memory shows its partition, and a project memory of this plugin has **Make global** (there is no other move and no editing). In the hygiene report, merge and importance rows show the memories' text, read by id; one no longer there shows **deleted**. **Last recalled memories** shows the texts, IDs, count and latency of the most recent automatic recall:

![Memory library](assets/screenshots/en/10-memory-library.png)

![Last recalled memories](assets/screenshots/en/11-recall-preview.png)

The **Memory summary** card shows the editable, structured summary that is injected before relevant memories. Save a manual version or rebuild it from the store:

![Editable memory summary](assets/screenshots/en/12-memory-summary.png)

The **Memory maintenance** section lets you adjust the memory summary budget, recall budget, safety limit, importance weight and hygiene interval, switch model-led hygiene on or off, and shows the last/next hygiene time, the latest hygiene report (scanned, duplicates, merged, deleted, failed, model calls and tokens, run time and trigger) and current memory size. **Run hygiene now** first computes a preview and asks you to confirm "delete N memories" before removing duplicates and applying the model's merges and deletes to memories written by this plugin; a manually edited memory summary is preserved. The memory list can **Pin** or **Unpin** a memory (local backend).

![Memory maintenance](assets/screenshots/en/09-maintenance.png)

The status orb below the chat composer is dissolve's ThinkingOrb (36 dots at 18 px): idle turns slowly, recalling sweeps a radar disc, saving splits into three rings, success draws a light-blue check that stays until the next action, failure drops the dots and reforms them in red. Every change morphs the dots from where they are. With reduced motion requested by the system it draws each state still. The orb is vendored at a pinned commit (`vendor/dissolve`, see NOTICE); nothing is loaded from a CDN.

![Status orb states, light and dark: idle, recalling, saving, done, failed](assets/orb-states.png)

The actual status bar at the bottom of a conversation (cropped):

![Foreground status](assets/screenshots/en/08-foreground-status.png)

![Memory activity and recent memories](assets/screenshots/en/06-activity.png)

When **Test connection** succeeds, the status card shows a green **Connected** chip:

![Successful connection test](assets/screenshots/en/05-test-success.png)

The UI follows DSH's language setting. When `translateMemories` is on (off by default, see [Privacy and data](#privacy-and-data)), the visible memory text, memory summary and recall preview are translated into the page language with the current DSH model; otherwise, or when translation is unavailable, the original text is shown. A Chinese screenshot is available in the [Chinese README](README.zh-CN.md).

## Memory partitions

On the local backend (`backend: oss`) memories live in three partitions: **global** (everywhere), **project** (one repository or folder) and **session** (one DSH session).

- *Which project.* A session's project is fixed by the folder the session started in (its header's working directory; DSH's `workingDirectory` service only when there is none): a `cd` during the session does not move it. Start a new session in another folder to work in another project. The id is the hash of the normalised git `origin` URL (ssh and https forms of one remote are one project; credentials, port and `.git` dropped), else of the repository's shared git directory (every worktree of a repository is one project), else of the folder's real path. On Windows drive letter case, backslashes and 8.3 short names do not matter. The repository and folder ids of a git project are kept as its aliases, so memories written before an `origin` was added, or while git failed, are still read with it. Only the hashes and a display name (the repository or folder name) are stored, never a path or remote URL. git is asked once with a 2-second limit and without inherited `GIT_DIR`-style variables; a timeout is retried after a minute; without git the folder is the project. Your home folder outside git is no project (memories there are global), and neither is DSH's default workspace (the desktop app's first-use folder, `<Documents>/deepseek-harness/default-workspace` on macOS and Windows): a chat there is not in a project. It is recognised from DSH's workspace registry (the workspace DSH created on first use, or one still titled `default-workspace`), not from the folder name alone. A partition that an earlier version created for it is shown on the memory page as **DSH default workspace**.
- *Remote forms.* Hosts with different ssh and https paths are two projects: Azure DevOps (`ssh.dev.azure.com:v3/org/proj/repo` and `dev.azure.com/org/proj/_git/repo`) and GitHub's ssh-over-443 host `ssh.github.com`. Use one form for one repository.
- *Recall* reads global memories plus the current project's and session's, never another project's. Project and session scores are multiplied by `projectRecallBoost` (default 1.1, range 1–2); with a project, recall takes four times `recallTopK` candidates first so close global memories cannot keep the project's out.
- *Capture* writes to the current project. `mem0_add` writes to the project by default (`scope: "global"` or `"session"` to choose); `mem0_search` reads the current partitions (`scope: "global"`, `"project"` or `"all"` to choose).
- *No project known* (background work, a session without a working directory, a tool call without a session): captures and adds go to global. A dsh-strata fold of a session's turns goes to that session's project (looked up through DSH's session registry); when DSH no longer has the session the fold is not saved (its turns were captured already). Hygiene and summaries use each memory's own partition.
- *Old memories* (written before partitions, moved from Qdrant) have no partition and count as global; nothing rewrites them.
- Hygiene merges and replaces only within one partition (an action across partitions is dropped and counted). Exact duplicates are removed within one partition too; across partitions only a project or session copy of a global memory goes, never the global one. The summary in the system prompt has a **Global** part and a part for the current **Project**, each written separately (see below).
- The Mem0 Platform and self-hosted server backends have no partitions: everything is global and the tools have no `scope` parameter.

**Partition by project** (`projectPartitions`, default on; settings page → Memory maintenance, or the chip below the input box). Turn it off for work that does not need its own memory, for example a project that lives for one conversation:

- New memories (captures, folds, `mem0_add` without `scope`) all go to global; recall and `mem0_search` read only global and this session; the summary in the system prompt is the global one only.
- Existing project memories are not changed, moved or deleted, and their project summaries are kept. Turn the switch on again and they are recalled, summarised and checked as before.
- Hygiene and summaries handle only global memories while it is off.
- It applies from the next turn. The memory page still shows every partition.

The chip next to the orb below the input box shows where this conversation's new memories go: **Memory: project dsh-mem0** when a project is known and the switch is on, **Memory: global** when the switch is off or the conversation is not in a project. Hover for what it means; click to flip the same switch as the settings page (the two stay in step). The chip changes at once on each click: the session's project is looked up when the session starts, whatever the switch says, and kept; writes and recall follow from the next turn. When DSH has not reported the session yet, the chip shows **Memory: project (found next turn)**.

**Project memories never go to global on their own.** A project summary is never merged into the global summary, and hygiene never merges across partitions. A project memory becomes global only when you click **Make global** on the memory page. The one cross-partition rule (a project copy identical to a global memory is deleted) removes the project copy and brings no project content into global.

## Memory maintenance

The **Memory maintenance** section separates several budgets that are easy to confuse:

- **Memory summary budget**: upper bound for the `<mem0-user-profile>` block, 1375 tokens by default.
- **Recall memory budget**: upper bound for the `<mem0-relevant-memories>` block, 2200 tokens by default.
- **Safety limit** (`storeSafetyLimit`, default 20000 memories): above it hygiene warns in the report and the log. Nothing is ever deleted for size. The warning works on the local backend only: the Platform and server backends list one page of 1000 memories, and the report then says the scan stopped there.
- **Importance weight in recall** (`importanceWeight`, default 0.2): recall scores are multiplied by 0.8 (importance 1) up to 1.2 (importance 5, or pinned).

Hygiene runs every 7 days by default and can be set to 1–90 days. It runs once at plugin startup if due, then checks hourly. It deletes only among memories this plugin wrote (`metadata.source: "dsh"`, set by auto-capture and `mem0_add`), never pinned ones. Memories written by other apps under the same `userId` are read into the summary and shown to the model for context, but never deleted, merged or rated.

**Model-led review (default on).** After the exact-duplicate check, the pass reviews this plugin's memories in two lanes: first those new or changed since the last review, then, with what is left of the pass's budget, the backlog stored before the first review (oldest first). At most 96 memories and 12 model calls per pass (lowest reasoning effort, temperature 0 unless the route refuses it, at most 1536 output tokens). Each memory is grouped with its most similar memories (by stored vector on the local backend, by search elsewhere; other apps' memories join as context only), and small groups share a call up to 12 records and about 4000 estimated input tokens. While new or changed memories are left over and the model answers, the next pass comes a day later instead of after the interval; the report and the settings page show how many are still to review. The backlog never brings a pass forward, and a pass where the model was unavailable keeps the normal interval. Memory text is redacted first, records go in as JSON data, and the prompt tells the model they are data, not instructions. The answer must be a single JSON object of actions — `merge` (ids + merged text), `delete` (ids, optionally the newer record that replaces them `by`), `keep`, `importance` (1–5) — each with a reason. A cut-off answer is retried once with twice the room and time, a malformed one once with a note; a call that fails twice with the same memories is skipped until one of them changes. Scripts accept an action only when its ids are records of the call; delete or merge touches only this plugin's unpinned memories; no memory is used twice; a `by` record is not older than what it replaces and itself stays; deletes without `by` (noise) are at most a third of the call; merged text is plain text; and no merged source had a secret redacted. An answer that deletes every record of its call is dropped whole. At most 20 model deletes are carried out per pass; the rest wait for the next pass and are checked again then. Before anything is deleted, the store is listed again: a memory pinned, edited or removed while the model was asked is left alone, and a merge goes only with all its sources. A merge writes the merged memory first (`metadata.merged_from`: the source ids; `metadata.fact_date`: the latest date of the sources, so it does not look newer than it is) and deletes the sources only once that memory can be read back; a queued write (Platform) keeps them for a later pass. Importance is stored on the local backend without changing the memory's text or `updated_at`; in the summary an unrated memory counts as 3 and ratings weigh freshness within bounds, so a fresh fact is not pushed out by old rated ones. The Mem0 Platform and self-hosted server backends have no pinning or importance (`mem0_pin` is not offered there); merges and deletes run the same. With **Model-led hygiene** off, or when the model is unavailable (no model service, no adapter or key, provider unreachable, quota used up, timeout), the pass runs its script part only (calls answered before the failure keep their actions) and the report says why; that is not a failure. DSH starts its model service a little after the plugin: an automatic pass that is due waits until the service is injected and the selected model's provider is registered, then runs; only if the model is still missing at the first hourly check does it run as script-only. Until then a manual **Run hygiene now** says the model service is still starting (not a failure, no report). These calls are billed to your provider in DSH and do not appear in DSH usage statistics; each report shows how many calls and tokens it used. A manual **Run hygiene now** while another pass runs is refused (busy) instead of showing that pass's result. Until you have confirmed one manual **Run hygiene now**, automatic passes are dry runs: they write a report marked "Preview, nothing deleted" listing what would be deleted, and delete nothing. Each pass deletes at most 100 memories (merge sources included). The profile and hygiene history are stored in the current DSH profile's `dsh-mem0/maintenance.json`, not written back to Mem0. The latest report stays visible in the Memory maintenance card, including the scanned, duplicate, merged, deleted and failed counts, the model status and tokens, run time and trigger; a manual **Run hygiene now** also returns the same counts.

**What hygiene deletes, and how a run is confirmed.**

- *Duplicates* are exact copies only: the full text after Unicode NFC, case folding and collapsing whitespace, compared by hash. Punctuation, digits and the end of long texts count, so `dose 1.5 mg` and `dose 15 mg` are different facts. Memories that only look alike (same text without punctuation, or the same first 240 characters) are listed as **suspected duplicates** in the report and never deleted.
- *A manual run is a preview plus a confirmation.* **Run hygiene now** first previews and gets a plan with a `planId` (valid for 15 minutes, in this plugin instance). Confirming sends that `planId` and an idempotency key, and is never retried automatically. It deletes only the plan's memories that still exist, are still this plugin's and are unchanged since the preview. The same plan runs once; a resend gets the first result back. After a reload or expiry, preview again.
- *The report counts what really happened.* The remaining count and the summary are the scanned store minus the deletes that succeeded. A preview's count is what would be left.
- *Everything is per memory store.* A store is the backend, its endpoint (no credentials; for OSS, `mem0ConfigPath`), the OSS collection, `userId` and `agentId`. The summary, the hygiene history and the deletion authorisation are kept per store in `maintenance.json`. After switching any of them, the old summary is not injected and automatic passes preview again until you confirm a run for the new store. A Platform or server account behind a different API key with the same endpoint and user is not told apart. On upgrade from an older `maintenance.json`, only a manual summary for the same user is kept; automatic passes preview again until the next confirmed run.
- *Stopping.* Disabling or reloading the plugin aborts the list and delete requests in flight; a running pass stops before its next delete and writes nothing more. A reloaded plugin waits for the old pass to stop.

**Deleting or editing a memory and the summary.** When a memory is deleted or updated (the `mem0_delete` / `mem0_update` tools or the library's **Delete**), a generated summary built from it stops being injected at once and is rebuilt in the background, also when hygiene is off. A manual summary is your text and keeps being injected; if it was edited from a generated summary that used the memory (or its sources are unknown), the Memory summary card says it may contain deleted or outdated content until you edit or rebuild it. Summaries are redacted like captures, before they are saved and again before they are injected, and the plugin's own block tags are removed from them. Recall and `mem0_search` queries are redacted the same way before they reach the backend or the activity view.

Each due hygiene pass (every interval, or daily during a catch-up) writes the generated summaries (one global, one per project; session memories are left out) with your DSH model: at most 6 calls per pass, each from that partition's memories ranked by importance and freshness (redacted, about 3000 input tokens, up to about 2000 output tokens). A summary whose sources did not change is kept without a call, and a partition whose answer was unusable twice for the same sources gets the script summary until they change. Nothing else calls the model for summaries: after a delete, an edit or **Make global** only the summaries built from that memory are rebuilt, 45 seconds later (a run of deletes gives one rebuild), with the local deterministic summary (no model call; facts grouped into sections by topic), and the hourly check does the same for a summary that is missing. The script summary is also used with model-led hygiene off, or when the model is unavailable or answers badly. An empty global partition is saved as an empty summary. You can edit it at any time; manual edits are stored in `maintenance.json` and are not overwritten by hygiene. Use **Rebuild from memories** to return to the generated version. Section headings follow the dominant language of the memories (Chinese when most facts are Chinese, English otherwise).

**What each turn carries is the *project summary*, not an aggregate.** Every turn's system prompt holds the global summary and the current project's summary (the *project summary*; L0 in the design document: one summary per partition). It is not the design document's L1 aggregate summary: no summary across projects is written or injected. Injecting it every turn is deliberate and stays.

To keep DeepSeek's prefix cache warm, the summary is a system-prompt section (`plugin:dsh-mem0:profile`) that changes only when the stored summary changes. The per-turn `<mem0-relevant-memories>` block is a runtime context (`mem0:recall`), which DSH appends next to the latest user message, so it never rewrites earlier history.

## Working with context plugins

Context-management plugins (for example dsh-strata) can recognise what DSH-Mem0 injects by these names and tags. They are stable across releases; changing any of them is a breaking change, and `test/interop-contract.test.js` guards them.

| What | Where it goes | Name | Text starts / ends with | Changes |
|---|---|---|---|---|
| Memory summary | system-prompt section | `plugin:dsh-mem0:profile` | `<mem0-user-profile>` … `</mem0-user-profile>` | only when the stored summary changes |
| Recalled memories | runtime context, always last | `mem0:recall` | `<mem0-relevant-memories>` … `</mem0-relevant-memories>` | usually every turn |

- DSH joins all runtime contexts into one snapshot and appends it to history as a user-role message with `source.kind: "runtime-context"` whenever the joined text changes. Older snapshots stay in history, so their recall blocks are stale: a context plugin can trim or drop them without a model summary and without keeping the original, because Mem0 can recall again at any time. The newest snapshot should be left alone.
- The snapshot is not user input. Automatic capture only reads `user/message` events whose source is `user`, so recall blocks are never captured back into Mem0.
- Capture runs on `turn/end` from the text DSH-Mem0 buffered from that turn's events (the user messages and the final assistant reply). It does not read session history or tool output, so trimming history at the end of a turn, before or after capture, does not change what is saved.
- Memory text in a recall block has forged block tags removed, so each block contains exactly one opening and one closing tag.

### dsh-strata

With [dsh-strata](https://www.npmjs.com/package/@lightcheng/dsh-strata) installed, the two plugins follow a shared contract:

- **Shared recall budget.** Before each recall, DSH-Mem0 asks Strata's optional `strataBudget` service how many tokens the recall block may use this turn: the full `memoryBudgetTokens` normally, half once the context passes 65% (`tight`), and at most 512 tokens past 75% (`critical`). An allowance of 0 skips recall for that turn. The block is fitted with Strata's token counter, the same one its thresholds use. Without Strata, or if the service fails or returns something unusable, recall uses `memoryBudgetTokens` as before. The memory summary is never shrunk per turn: it sits in the cached system prompt, and changing it every turn would cost more than it saves. `mem0_status` and the Recent activity card show the last budget, e.g. `recall budget 1100 / 2200 (strata: tight)`.
- **Fold summaries as a memory source (`captureStrataFolds`, off by default).** When it is on, together with automatic capture, each first-level fold summary that Strata lands (`strata/fold-landed`, tier 1 only, main-agent sessions only) is redacted and saved through the same capture queue, with metadata `source: "dsh"`, `via: "dsh-strata"`, `fold`, `tier` and `session_id`, so hygiene treats it like any other capture. These are the same turns automatic capture already saved, a second time as a cleaner summary; Mem0's own inference merges repeated facts. Empty or low-value summaries are skipped. Recall blocks are never written to Strata's archive, and Strata drops stale recall snapshots instead of folding them.

## Architecture

```text
DSH Agent
  ├─ system-prompt/assemble ──┐
  ├─ session/event            ├─> Node plugin (index.js + lib/)
  ├─ mem0_* tools            ─┘        │
  │                                     ▼
  │                          backend adapter (one of)
  │                          ├─ Mem0RestClient (platform / server)
  │                          └─ Mem0NativeClient (oss)
  │                          (shared HTTP, timeouts, circuit breaker: lib/http.js)
  │                                     │
  │                     ┌───────────────┴──────────────┐
  │                     ▼                              ▼
  │          Mem0 Platform / server        SQLite store (node:sqlite, WAL)
  │                                        + your embedder + your LLM
```

## Installation

Install this directory through the DSH Plugin Manager (development/local install):

```text
plugin_manager action: install_bundle
target: <absolute path to this directory>
```

Or use the DSH CLI:

```bash
dsh plugin --profile desktop add link:"$(pwd)"
```

After the package is published to npm, install it by package name:

```bash
dsh plugin --profile desktop add dsh-mem0
```

If DSH reports `restart-required`, restart DSH before verifying.

> A local `link:` install makes DSH show the absolute checkout path under **Code source** in the plugin detail page. That is install metadata from the local profile, not part of the package. `npm pack` and registry installs contain no local paths; installing `dsh-mem0` from npm shows the package source instead. The published screenshots are captured so that this local-only row is not included.

## Configuration

After installation, configure it visually in **Plugins → Mem0 Memory** in the DSH sidebar (recommended); you can also write the profile's `cordis.patch.yml`. Full YAML example:

```yaml
- id: dsh-mem0
  name: dsh-mem0
  config:
    backend: platform
    apiKey: "your-platform-api-key"
    userId: "your-user-id"
    agentId: "dsh"
```

### Backend modes

#### Platform (simplest, recommended for new users)

```yaml
config:
  backend: platform
  apiKey: "your-platform-api-key"
  userId: "your-user-id"
```

The key does not have to be in the plugin config. Recommended: store it in DSH credentials (for example `~/.dsh/.credentials.yaml`), so it never appears in the profile config:

```yaml
version: 1
refs:
  MEM0_API_KEY: m0-your-key
```

and refer to it by name (this is the default):

```yaml
config:
  backend: platform
  apiKeyEnv: MEM0_API_KEY
```

Lookup order: a literal `apiKey` in the config, then DSH credentials for the name in `apiKeyEnv` (the store first, then the launching environment and `.env` files), then the environment variable of that name. With credentials, a rotated key applies on the next request without a restart. `mem0_status` reports where the key came from (`key source: config`, `credentials`, `env` or `none`), never the key.

> **Note on `backend: auto`:** if `MEM0_API_KEY` (or the name in `apiKeyEnv`) is stored in DSH credentials or set in DSH's environment, `auto` picks the cloud Platform even when a local OSS config exists. `mem0_status` and the settings page show why the backend was chosen ("backend choice"). Set `backend` explicitly if you want a specific one.

#### Self-hosted Mem0 server

```yaml
config:
  backend: server
  baseUrl: "http://127.0.0.1:8888"
  authType: apiKey
  apiKey: "your-server-key"
  userId: "your-user-id"
```

`authType` supports `apiKey` (`X-API-Key`), `bearer`, `token` and `none` (for local services with `AUTH_DISABLED=true`).

<a id="local-backend"></a>
#### Local backend (SQLite, no Python)

`backend: oss` keeps memories in one SQLite file, by default `~/.dsh/mem0/memory.sqlite` (Windows: `%USERPROFILE%\.dsh\mem0\memory.sqlite`). It uses `node:sqlite`, which is built into the Node that DSH ships (Node 24.9 or later); nothing is installed. You bring two models:

- an **embedding model**: any OpenAI-compatible `/embeddings` endpoint (oMLX, LM Studio, vLLM, OpenAI, …) or Ollama (`/api/embed`);
- an **extraction LLM**: any OpenAI-compatible `/chat/completions` endpoint (DeepSeek, a local gateway, …).

<a id="setup-wizard"></a>
**Setup wizard (recommended).** Settings page → Local OSS → **Local setup wizard**. Switching the backend to Local OSS checks first and offers the wizard when something is missing. The steps:

1. **Embedding model.** A cloud API first (any OpenAI-compatible `/embeddings`; suggestions: OpenAI `text-embedding-3-small`, SiliconFlow / Alibaba Cloud `bge-m3`-class models), or a local model: the wizard looks on `127.0.0.1` for Ollama (11434, 15434), LM Studio (1234) and, on macOS only, oMLX (8000), and lists their embedding models (bge-m3, 1024 dimensions, is the suggestion for Chinese and English). One test embedding gives the dimension.
2. **Extraction LLM.** Address, model, key; one test extraction with Mem0's prompt and a fixed sample, with advice on `max_tokens` (at least 8000 for reasoning models) and `reasoning_effort`.
3. **Memory file.** Shown, not asked: `~/.dsh/mem0/memory.sqlite` unless you change it under *advanced*. Checked writable and not on a network drive (UNC paths and mapped drives on Windows, SMB/NFS/AFP shares under `/Volumes` on macOS, network file systems on Linux) or a synced folder (iCloud, OneDrive, Dropbox, Google Drive, …), which damage SQLite files. A volume whose type cannot be told needs your confirmation.
4. **Self-test and save.** A probe memory for the test user `dsh-mem0-wizard-selftest` is written, found and deleted, and nothing of that user may be left. Only then are keys stored in DSH credentials (`DSH_MEM0_EMBEDDER_API_KEY`, `DSH_MEM0_LLM_API_KEY` by default), the `dsh_mem0` block of `oss.json` written (the previous file is kept as `oss.json.bak-<time>`), and the local backend switched on. A failure changes nothing. A plain-text key you chose to move is removed from the `oss` block; the backup still holds it, so delete the backup once everything works.
5. **Move memories from Qdrant** (only for earlier versions; see below).

The wizard probes nothing but `127.0.0.1`; an address you type is contacted only when you press a test button. A stored key is sent only to the server it was saved for: after changing the provider or address, type the key again. The wizard reads and writes only its own credential names or the one your settings use, and asks before replacing another key. If the memory file holds vectors of another embedder, the self-test runs in a temporary file and saving recomputes the vectors first; until then the current setup keeps working.

Or configure by hand in the `dsh_mem0` block of `~/.dsh/mem0/oss.json`, which DSH's settings sync never rewrites (see [examples/oss-config.example.json](examples/oss-config.example.json)):

```json
{
  "dsh_mem0": {
    "userId": "your-user-id",
    "embedderProvider": "openai",
    "embedderBaseUrl": "http://127.0.0.1:8000/v1",
    "embedderModel": "bge-m3",
    "embedderDims": 1024,
    "embedderApiKeyRef": "MEM0_EMBEDDER_API_KEY",
    "llmBaseUrl": "https://api.deepseek.com/v1",
    "llmModel": "deepseek-chat",
    "llmApiKeyRef": "MEM0_LLM_API_KEY"
  }
}
```

Keys are referenced by name (`embedderApiKeyRef`, `llmApiKeyRef`) and looked up in DSH credentials (`~/.dsh/.credentials.yaml`), then in the environment, on every request: they never sit in `oss.json` or the profile. An `oss.json` in Mem0's own format (`oss.embedder` / `oss.llm` with a literal `api_key`) still works as a fallback; the `oss.vector_store` block is ignored. The same fields can be set in the profile config; the profile wins over the `dsh_mem0` block, and a value equal to the default counts as not set.

| `dsh_mem0` key | Default | Meaning |
| --- | --- | --- |
| `storePath` | `~/.dsh/mem0/memory.sqlite` | The SQLite file |
| `embedderProvider` | `openai` | `openai` (any OpenAI-compatible server) or `ollama` |
| `embedderBaseUrl` | Ollama: `http://localhost:11434` | e.g. `http://127.0.0.1:8000/v1` |
| `embedderModel` | — | e.g. `bge-m3` |
| `embedderDims` | from the model | Sent as `dimensions` (OpenAI-compatible only) when set |
| `embedderApiKeyRef` | — | Credential name of the embedder key |
| `llmProvider` | — | `"dsh"`: extraction uses the model selected in DSH at the time of each call (no address, model or key here; DSH holds them). Leave unset to use `llmBaseUrl`/`llmModel` |
| `llmBaseUrl`, `llmModel`, `llmApiKeyRef` | — | The extraction LLM (when `llmProvider` is not `"dsh"`) |
| `llmMaxTokens` | `8000` | Output budget of each extraction call (Mem0's own default is 2000; hybrid reasoning models spend part of it on thinking) |
| `llmTemperature` | `0` | Mem0 sends 0 (and `top_p` 0.1) |
| `llmReasoningEffort` | not sent | e.g. `"none"` to turn thinking off on gateways that support it |
| `userId`, `agentId`, `translateMemories`, `captureStrataFolds` | | Plugin settings, as in the table below |

**How it works.** Adds follow Mem0 2.2.1's V3 additive pipeline: the last 10 messages of the conversation scope, the 10 most similar memories, one LLM call with Mem0's own extraction prompt (copied verbatim, with "answer in the language of the input" on), then only ADD: new facts whose md5 matches an existing or another new fact are skipped. Adds of one user/agent run one after another. Search embeds the query, compares it with every stored vector (cosine, brute force; a few thousand memories take milliseconds) and drops scores below 0.1. Vectors are cached in memory; another DSH process writing the same file is noticed through SQLite's `data_version`. WAL mode and a 5 s busy timeout let several DSH profiles share the file. See [NOTICE](NOTICE) for what is derived from Mem0.

<a id="near-duplicate-check"></a>
**Near-duplicate check (deviates from Mem0).** Upstream V3 additive only drops exact md5 duplicates, so one fact could be stored two or three times in one turn: once by `mem0_add`, once reworded by the automatic capture, and once more from the assistant's confirmation. The local backend now:

- shows the memories `mem0_add` stored in the same turn to that turn's extraction as existing memories, even when they are not among the 10 most similar;
- does not store a new fact that repeats one of those memories or an earlier fact of the same batch: its cosine similarity is at least `captureTurnDedupThreshold` (default **0.93**; `0` turns the check off, leaving md5 only as upstream), or it is at least 0.75 and every content word of the fact already appears in that memory (after dropping dates the model wrote out, such as "2026-11-25", and filler such as "the user plans to"). The window is the current turn: older memories, however similar, are only checked by md5. V3 additive never updates a memory, so a correction ("the trip moved to the week after") is a new fact close to the old one; compared with older memories it would be dropped and the new information lost. Rewordings repeated in later turns are left to memory hygiene, which merges them. Measured with bge-m3 on the Windows case ("remember: I travel to Shanghai next Wednesday"): the capture's copy of the explicit memory scored 0.84–0.94, because the extraction model writes the date out or splits the sentence; different facts on one topic said in the same turn score almost as high ("uses pnpm" / "uses npm" 0.89, "dark theme" / "light theme" 0.92). So the cosine rule alone stays at 0.93, above those, and the word check catches the copies below it; a fact that adds anything (another city, another day, `npm` for `pnpm`, "light" for "dark") keeps a word the other memory lacks and is stored. For Chinese, the word check uses a small fixed word list: 前往, 去往, 赶往 and 动身去 count as 去 ("go to"), 目的地 ("destination") and 出发 ("set off") are filler, and a bracket that explains a date (it contains 即 "that is" and a date or a phrase such as 当周 "that week") is dropped whole; other brackets keep their content. There are no English synonyms, so a copy in other words ("business trip" for "traveling") passes neither rule and is stored; memory hygiene merges it later. So is a copy that adds a remark of the model's own (measured: "…, which the user asked the assistant to remember", 0.82);
- leaves out of the extraction input the assistant's sentences that confirm a memory ("Got it, I've saved…", "已记住…") or talk about tools or screenshots. Mem0's prompt is kept byte for byte and also extracts from assistant messages, so this is filtered on the input side; the user's own words are always sent.

The activity record says how many facts were left out as near-duplicates and how many reply sentences were not sent. Platform and self-hosted server backends run their own pipeline and are unchanged (the reply filter applies to them too).

**Changing the embedding model.** The store remembers which embedder (model and dimension) wrote its vectors. With another one configured, recall and capture stop with a clear `EMBEDDER_MISMATCH` configuration error instead of mixing vectors. Switch back, or save the new model with the setup wizard, which recomputes the vectors before switching. An empty store simply takes the new embedder.

**Extraction failures.** When an answer is cut off (`finish_reason=length`), the capture is retried once with twice the output budget (up to 65536). An answer that is not JSON or empty is retried once; a refusal is not. A failed extraction records its `finish_reason`, output budget and token counts in the failure history and the Memory activity card (numbers only, never text). Extraction failures do not count toward the circuit breaker: the LLM answered, so pausing memory would not help.

**Errors.** SQLite errors are attributed to the vector store with a short code: `busy` (another process held the file too long; retried with the next call), `readonly`, `corrupt`, `disk_full`, `cantopen`, `ioerr`, or `schema_newer` (written by a newer DSH-Mem0). Configuration errors (no embedder configured, embedder mismatch, newer schema) are not retried until the settings or `oss.json` change.

**File permissions.** On macOS and Linux the file and its `-wal` / `-shm` companions are set to mode 0600. On Windows they inherit the ACL of `%USERPROFILE%\.dsh\mem0`, which by default only your account, SYSTEM and Administrators can read; keep the folder out of synced or shared folders.

**Keeping plugin settings out of DSH's reach.** DSH's settings sync can rewrite the profile's `cordis.patch.yml` and drop plugin settings (seen when a plugin was installed: the dsh-mem0 block was cut down to `backend`). Everything in the `dsh_mem0` block of `oss.json` survives that. The plugin also notices a rewrite: it records which key settings were set the last time it ran fine (names only, in `<DSH profile>/dsh-mem0/config-fingerprint.json`). When some of them disappear, the settings page and `mem0_status` say "dsh-mem0 settings look rewritten; missing: …". Settings kept in the `dsh_mem0` block do not count as missing. If you removed one on purpose, delete `config-fingerprint.json`.

<a id="migrating-from-qdrant"></a>
**Coming from the Python sidecar (0.3.x).** The Python sidecar, Qdrant and the fallback paths of earlier versions have been removed. Old settings (`pythonPath`, `mem0ConfigPath`, `historyDbPath`, `sidecarEnv`) are ignored with a debug line, never an error, and do not trigger the "settings look rewritten" warning. Reconfigure with the [setup wizard](#setup-wizard); its last step moves your memories:

- It reads one collection of a running Qdrant **server** (the one `oss.json` or `collectionName` names, else `dsh_mem0`; at the address in `oss.json`, else `127.0.0.1:6333`, on Windows often `127.0.0.1:15333`) and in it only the memories of your `userId`. No other collection can be chosen, none is listed, and names starting with `mem0` are refused. A Qdrant API key in `oss.json` is sent only to that Qdrant. Qdrant is only read: nothing there is changed or deleted, and **no backup is made**.
- Vectors are copied when the old and new embedder are the same model and dimension and you tick the box; otherwise they are recomputed with the new embedder. Timestamps become UTC (originals kept in the metadata); a manual memory summary comes along.
- Everything is written to `memory.sqlite.importing` first, in one transaction, and checked (the count against Qdrant's, a read-back sample, top-5 of fixed queries) before it becomes the store or is merged into it. Points whose `user_id` is stored in another form (for example a number) are counted and left out. A failure deletes the temporary file and says at which step; the store is unchanged. Once a store was filled, moving again needs a confirmation: memories you deleted since would come back.
- The wizard also suggests this step when you used the local backend before but `oss.json` names no Qdrant (earlier versions could read their settings from elsewhere); the address is then the default.
- Afterwards the plugin no longer talks to Qdrant. The old data stays there unused: delete it or stop the Qdrant service when you are satisfied.
- Qdrant does not start? See [Windows troubleshooting](#windows-troubleshooting). You can also skip the migration and start with an empty store; the memories stay in Qdrant and can be moved later. Embedded Qdrant (a `path` instead of a server) cannot be read; start a server or skip.

Before and after, you can count your points yourself (read-only). macOS / Linux:

```bash
curl -s -X POST http://127.0.0.1:6333/collections/dsh_mem0/points/count -H 'content-type: application/json' -d '{"exact":true}'
```

Windows (PowerShell):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:15333/collections/dsh_mem0/points/count -ContentType 'application/json' -Body '{"exact":true}'
```

#### Low-spec machines (CPU-only embeddings)

Extraction usually runs in the cloud, so the local embedding model is what decides whether recall stays fast.

- **Keep the embedding model loaded.** Ollama unloads a model after 5 idle minutes by default. The first recall after a break then waits for a cold load: about 2.5 s for bge-m3 on an i5-13500H, longer when memory is tight. The plugin now sends `keep_alive` with every Ollama embedding (`embedderKeepAlive`, default `30m`; `-1` never unloads, empty leaves Ollama's 5 minutes) and loads a local embedding model once when it starts, so the first recall does not pay for the load. For longer breaks, set `OLLAMA_KEEP_ALIVE=-1` or `24h` in the environment of the Ollama service as well. On Windows, add it as a user environment variable, then quit Ollama from the tray and start it again. bge-m3 needs about 1.2 GB of RAM while loaded.
- **`recallTimeoutMs`:** the default is 5000. If the model can still be unloaded (no keep-alive, or memory pressure), use 8000. A recall that times out only skips memories for that turn.
- **`addTimeoutMs`:** the default 120000 is plenty. With a cloud extraction model, captures took under 10 s in our tests.
- **Embedding model:** keep bge-m3 if you write in Chinese. Smaller English-centric models (`nomic-embed-text`, `all-minilm`) recall Chinese poorly. Switching models needs the vectors recomputed (see above).

<a id="slow-recall"></a>
#### Slow recall: which step is slow

Each automatic recall records how long each step took. The settings page shows it under **Memory activity → Automatic recall**, and `mem0_status` prints it as `last recall:`:

```text
last recall: 10 results, 7019 ms (store open 0 ms · credential 0 ms · embedding 6990 ms · search 12 ms · inject 1 ms · other 16 ms)
```

| Step | What it is | Expected |
|---|---|---|
| store open | open `memory.sqlite` (first call only) | 0–5 ms |
| credential | look up the embedder key in DSH credentials (none for a local server) | 0–5 ms |
| embedding | the embedding request for the question | 10–100 ms when the model is loaded (Ollama on CPU: 50–300 ms); 1.5–3 s or more when it was unloaded |
| search | SQLite vector scan and scoring | under 25 ms at 5000 memories (first search after start: up to about 100 ms) |
| inject | reorder and build the recall block | 0–2 ms |
| other | time no step accounts for (DSH busy, the event loop held up) | 0–20 ms |

Measured on an M-series Mac with oMLX bge-m3 and 5000 memories: warm recall 36 ms (embedding 18, search 20), cold model 1.6–1.8 s (embedding 1.5–1.7 s), with the start-up warm-up 131 ms. If **embedding** is the slow step, the model was unloaded or the machine is short of memory: keep it loaded (above). If **search** is slow, report it with the memory count. If **other** is large, DSH itself was busy.

Retest on Windows (PowerShell):

```powershell
# 1. Ollama is up and has bge-m3; "expires_at" says when it unloads (keep_alive)
Invoke-RestMethod http://127.0.0.1:11434/api/ps | Select-Object -ExpandProperty models | Format-Table name, size_vram, expires_at
# 2. One embedding, timed: the first after a long break is the cold load
Measure-Command { Invoke-RestMethod http://127.0.0.1:11434/api/embed -Method Post -ContentType 'application/json' -Body '{"model":"bge-m3","input":["test"],"keep_alive":"30m"}' } | Select-Object TotalMilliseconds
# 3. The same again: now warm (expect well under 300 ms on CPU)
Measure-Command { Invoke-RestMethod http://127.0.0.1:11434/api/embed -Method Post -ContentType 'application/json' -Body '{"model":"bge-m3","input":["test"],"keep_alive":"30m"}' } | Select-Object TotalMilliseconds
```

Then in DSH: restart it, wait a few seconds, ask a question that needs memory, and run `mem0_status`. Expect `embedder warm-up at start: ok in …` and a `last recall:` line whose embedding step is under 300 ms. Wait more than 5 minutes, ask again: with `keep_alive` the embedding step stays warm (before this change it was the cold load again).


### All options

| Field | Default | Description |
|---|---|---|
| `backend` | `auto` | `auto` / `platform` / `server` / `oss` |
| `apiKey` | empty | Platform or server API key (prefer DSH credentials, see `apiKeyEnv`) |
| `apiKeyEnv` | `MEM0_API_KEY` | Name of the API key in DSH credentials, or of the environment variable |
| `baseUrl` | Platform: `https://api.mem0.ai`; server: `http://127.0.0.1:8888` | API endpoint |
| `authType` | `apiKey` (Platform is fixed to token) | `apiKey` / `bearer` / `token` / `none` |
| `storePath` | `~/.dsh/mem0/memory.sqlite` | Local backend: the SQLite file. Embedder and LLM settings: see [Local backend](#local-backend) |
| `userId` | `dsh-user` | Memory owner |
| `agentId` | `dsh` | Agent identifier attached on DSH writes; recall currently filters by `userId`, not `agentId` |
| `autoRecall` | `true` | Automatic recall |
| `autoCapture` | `true` | Automatically save completed turns |
| `announceToAgent` | `true` | Announce memory capability to the model |
| `includeSubagents` | `false` | Enable automatic memory for subagents |
| `captureMaxChars` | `450` | Per-message truncation limit for automatic capture |
| `captureFilter` | `heuristic` | `heuristic` skips low-value turns; `off` saves every completed turn |
| `recallTopK` | `5` | Number of automatic recall results |
| `memoryBudgetTokens` | `2200` | Token limit for the recalled-memory block, 128–20000. This is the real limit (CJK ≈ 1 token per character, Latin ≈ 4 characters per token); there is no smaller character cap |
| `profileEnabled` | `true` | Generate and inject a compact user profile |
| `profileBudgetTokens` | `1375` | Token budget for the injected profile |
| `storeSafetyLimit` | `20000` | Above this many memories hygiene warns; it never deletes for size. 1000–1000000 |
| `hygieneEnabled` | `true` | Enable memory hygiene |
| `modelHygiene` | `true` | Hygiene asks the model currently set in DSH (billed to that provider, not in DSH usage statistics); `false` runs the script checks only |
| `importanceWeight` | `0.2` | How much hygiene's importance reorders recall, 0–1 (0 = off) |
| `projectRecallBoost` | `1.1` | Recall score factor for the current project's and session's memories, 1–2 (local backend) |
| `hygieneIntervalDays` | `7` | Hygiene interval in days, 1–90 |
| `translateMemories` | `false` | Translate memory text on the settings page with the DSH default model (sends memory text to that model) |
| `captureStrataFolds` | `false` | Also save dsh-strata's tier-1 fold summaries (needs `autoCapture` and dsh-strata). A second, cleaner copy of turns already captured; see [dsh-strata](#dsh-strata) |
| `timeoutMs` | `30000` | Timeout for each backend request on every backend (Platform, server and OSS): tools, listing, hygiene. Writes and automatic recall use the two settings below |
| `recallTimeoutMs` | `5000` | Timeout for automatic recall, 100–60000; on timeout the turn continues without recalled memories |
| `addTimeoutMs` | `120000` | Timeout for storing memories (capture and `mem0_add`), which may run LLM fact extraction, 1000–600000 |
| `captureTurnDedupThreshold` | `0.93` | Local backend: a captured fact at least this similar (cosine) to a memory `mem0_add` stored in the same turn, or to another fact of the same capture, is not stored, nor one whose words are all in such a memory (cosine at least 0.75); older memories are checked by md5 only; `0` = off, else 0.5–1. See [Near-duplicate check](#near-duplicate-check) |
| `embedderKeepAlive` | `30m` | Local backend with Ollama: `keep_alive` sent with each embedding (`30m`, `2h`, `300` seconds, `-1` = always); empty = Ollama's default 5 minutes |
| `enabled` | `true` | Master switch |

Changes saved in the settings page or the profile config apply on their own: the plugin restarts itself when the loader commits new values (`loader/volatile-update`), so no manual reload or DSH restart is needed. With `backend: auto`, storing or removing the key in DSH credentials restarts it too.

<a id="windows-troubleshooting"></a>
## Windows troubleshooting

Most local-backend failures on Windows come from three things: a port taken by a Windows reserved range, a model server that is not running, or plugin settings that DSH rewrote. Look in that order: ports, processes, settings.

**Reserved ports.** Hyper-V, WSL2 and Docker Desktop make Windows (WinNAT) reserve TCP port ranges at boot, at different places each time. A service whose port falls inside one cannot listen: its process runs, but the port is silent. Its own log says `os error 10013` or "An attempt was made to access a socket in a way forbidden by its access permissions". The plugin then reports, for example, "Embedder Ollama unreachable at 127.0.0.1:11434 (connection refused)" with this hint.

```powershell
netsh int ipv4 show excludedportrange protocol=tcp   # reserved ranges
netsh int ipv4 show dynamicport tcp                  # dynamic port range (default: start 49152)
```

If the dynamic range starts low (for example at 1024), reserved ranges can land on any common port (11434, 8000, 8080). Put the embedding server on a port above 15000 that is outside every listed range, for example 15434 for Ollama: the user environment variable `OLLAMA_HOST=127.0.0.1:15434` (quit Ollama from the tray and start it again; programs started before the change, DSH included, keep the old value until restarted), and `"embedderBaseUrl": "http://127.0.0.1:15434"` in `oss.json`.

Optional, needs an administrator shell: move the dynamic range back to the Windows default so reservations land above 49152. This briefly stops Windows NAT, which cuts network access for Hyper-V/WSL2/Docker until it is started again, and the tool that changed the range may change it again:

```powershell
net stop winnat
netsh int ipv4 set dynamicport tcp start=49152 num=16384
net start winnat
```

**Services.** A running process is not a working service; check the port:

```powershell
Invoke-RestMethod http://127.0.0.1:15434/api/tags   # Ollama
```

**The store file.** `readonly` or `cantopen` means the plugin cannot write `%USERPROFILE%\.dsh\mem0\memory.sqlite`: check that the folder exists and is yours, and that it is not inside OneDrive or another synced folder. `busy` means another DSH process held the file for more than 5 seconds; it is retried with the next memory call.

**After installing or updating a plugin**, check memory once:

1. Look at the memory status under the composer: no red **Memory failed**.
2. Ask the agent to run `mem0_status`: `status: ready`, `store: ok (sqlite)`, `embedder: ok`, and no `warning: dsh-mem0 settings look rewritten`.
3. If settings were rewritten, set them again on the plugin settings page (or restore `cordis.patch.yml` from the `.bak-<time>` copy DSH writes next to it), and consider moving them into the `dsh_mem0` block of `oss.json`.

## Tools

| Tool | Purpose |
|---|---|
| `mem0_search` | Semantic search; returns `[mem0:<id>]` and relevance |
| `mem0_add` | Store one persistent fact verbatim (`infer:false`) |
| `mem0_get` | Read by ID, or list for the configured user; ownership is checked |
| `mem0_update` | Update text by ID; ownership is checked |
| `mem0_delete` | Delete one memory by ID; no bulk delete/reset |
| `mem0_pin` | Pin or unpin one memory (local backend); hygiene never deletes or merges a pinned memory |
| `mem0_status` | Check backend connection and storage status |
| `mem0_profile_get` | Read the editable memory summary |
| `mem0_profile_update` | Replace memory summary text; empty clears it |
| `mem0_profile_reset` | Rebuild memory summary from stored facts |

## Tests

```bash
pnpm install --ignore-scripts
npm run check              # node --check on every .js/.mjs/.cjs file
npm test                   # Node >= 24.9; tests that need a local port skip with a reason where binding is not allowed
node scripts/smoke-store.mjs   # the SQLite store end to end in a temporary folder (CI runs it on Windows, macOS, Linux)

# Manual: the native backend against real embedder and LLM endpoints, in a
# temporary HOME (never your ~/.dsh); see the script header for the variables.
node scripts/smoke-native.mjs

# Manual: one model-led hygiene pass on ~28 test memories (near duplicates,
# contradictions, a pinned one, Chinese text, a fake key) against a real
# chat model and embedder, in a temporary HOME; prints calls, tokens and actions.
node scripts/smoke-hygiene.mjs

# Has mem0ai released a version whose prompts or pipeline differ from 2.2.1?
npm run upstream
```

## Privacy and data

**What leaves this machine**

| Backend / feature | Sent | To |
|---|---|---|
| Platform | Captured conversation text (user and assistant messages, redacted and truncated; with `captureStrataFolds`, also redacted dsh-strata fold summaries with metadata `via`, `fold`, `tier`), recall queries, `userId`/`agentId`, metadata `source`, `channel`, `session_id` | `https://api.mem0.ai` (or your `baseUrl`) |
| Server | The same | Your self-hosted Mem0 server |
| Local (OSS) | Conversation text and recalled queries to the extraction LLM; memory text and queries to the embedder | The endpoints in your `oss.json`; if those are cloud APIs (e.g. DeepSeek, OpenAI), the text goes there. Nothing else leaves the machine |
| Memory translation (`translateMemories`, off by default) | Memory text shown on the settings page, up to the full list when the memory browser opens | DSH's current default model, which may be a cloud model |

The working directory is not sent. With `backend: auto`, an inherited `MEM0_API_KEY` alone selects the Platform; check "backend choice" in `mem0_status` or the settings page.

**What is stored locally**

- `<DSH profile>/dsh-mem0/maintenance.json` (mode 0600): the memory summary text and hygiene reports. Reports keep only memory ids, counts and reasons, not the text of deleted memories.
- `<DSH profile>/dsh-mem0/failures.json` (mode 0600): the last 20 memory failures (time, kind, backend, cause, failing component, duration, short message). Messages are redacted and shortened before they are stored: no API keys, tokens, memory text or home-directory paths. Delete the file to clear the history.
- `<DSH profile>/dsh-mem0/translation-cache.json` (mode 0600, only when translation is on): memory text and its translation in plain form. Entries are dropped when a memory is deleted through `mem0_delete` or hygiene; memories deleted elsewhere stay until the cache evicts them (2,000 entries max). Delete the file to clear it.
- Local backend: `~/.dsh/mem0/memory.sqlite` (mode 0600 on macOS/Linux) with the memories, their vectors, and the last 10 messages of each conversation scope (Mem0 uses them as context for the next extraction). Nothing is written to `~/.mem0` and no telemetry is sent.

**Other notes**

- In Platform/server mode, memories are stored by the corresponding service; read that service's privacy and retention policy.
- In local mode, memories stay in the SQLite file; the embedder and LLM you configure see the text they process.
- `autoCapture` is enabled by default; set it to `false` if you do not want automatic saving. The default `captureFilter: heuristic` only skips clearly low-value turns; common secrets (API keys such as `sk-`, `tvly-`, `AIza…`, JWTs, `Bearer` tokens, passwords in URLs, `password=` / `密码：` phrasing, private keys) are still redacted before writing, but regular expressions are not a substitute for full secret management.
- Weekly hygiene deletes exact duplicates and, when the model proposes it and the checks pass, merges or deletes outdated memories written by this plugin (never pinned ones), and only after you have confirmed one manual run. Model-led hygiene sends redacted memory text to the model currently set in DSH, billed to that provider; switch **Model-led hygiene** off to keep memory text local. Deletion is real and there is no recycle bin; if you want full manual control, set `hygieneEnabled: false`. The profile is still built when missing, but memories are not automatically deleted.
- The local backend opens no port and starts no process; embedder and LLM keys are read from DSH credentials by name on each request; `mem0_status` never returns an API key.

## Marketplace notes

- Package name: `dsh-mem0`, `private: false`, with `dsh.bundle` and `dsh-plugin` keywords.
- Marketplace inclusion requires a public GitHub repository, the `dsh-plugin` topic, a repository at least 1 day old, and a `data/plugins/<owner>__<repo>.yml` entry in `awesome-dsh-plugin` with category `memory`.
- The repository is linked through `repository` / `homepage`: `https://github.com/light-cheng/DSH-Mem0`. It includes `screenshots.json` with eight marketplace screenshots, plus localized sets under `assets/screenshots/` (Chinese) and `assets/screenshots/en/` (English). The market reads `screenshots.json` from this repository; only the plugin YAML is submitted to awesome-dsh-plugin.
- The plugin ships a visual settings page (`dsh.client` + `plugins.bundle.config`). A GUI is not required for listing, but this plugin provides one so users can configure all three backends and test the connection right after installation.
- Local mode needs an embedding model and an extraction LLM endpoint; the README states this clearly and does not describe the plugin as "zero dependencies".

## Release notes

Release notes are bilingual with English first: [RELEASE.md](RELEASE.md).

Creating a GitHub release publishes the package to npm automatically: tag it `vX.Y.Z`, matching the `version` in `package.json`. A release marked **pre-release** is published to the `next` dist-tag. See "Publishing" in [RELEASE.md](RELEASE.md).

## License

MIT.

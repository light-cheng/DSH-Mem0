window.__ModuleLoader__.load({
  id: 'dsh-mem0',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    /** Browser locale namespace owned by this page. */
    const NS = 'dsh-mem0.settings'
    const PKG = 'dsh-mem0'
    /** Host plugin entry id declared by cordis.patch.yml. */
    const ENTRY_ID = 'dsh-mem0'
    /** Relative routes registered by lib/gui-routes.js. */
    const STATUS_PATH = 'dsh-mem0/gui/status'
    const TEST_PATH = 'dsh-mem0/gui/test'
    const ACTIVITY_PATH = 'dsh-mem0/gui/activity'
    const HYGIENE_PATH = 'dsh-mem0/gui/hygiene'
    const MEMORIES_PATH = 'dsh-mem0/gui/memories'
    const PROFILE_PATH = 'dsh-mem0/gui/profile'
    const SETUP_PATH = 'dsh-mem0/gui/setup'

    // The settings page's UI strings live only here (en + zh, same keys;
    // test/client.test.js checks parity). locale/*.json carry just the package
    // title and description the host shows in its plugin list, so they do not
    // duplicate these. The host loader runs one self-contained client.js per
    // plugin (sibling files only arrive as async build chunks), which is why
    // the page stays one file without a build step.
    const en = {
      title: 'Mem0 connection',
      subtitle: 'Choose where memories are stored. Changes apply immediately after saving.',
      checkAgain: 'Check again',
      checking: 'Checking connection…',
      statusReady: 'Connected',
      statusDegraded: 'Not connected',
      statusUnknown: 'Status unavailable',
      statusBackend: 'Backend',
      statusEndpoint: 'Endpoint',
      statusBackendChoice: 'Why this backend',
      backendChoiceAutoEnv: 'Auto: {env} is set in the environment, so memories are sent to the Mem0 Platform ({endpoint}). Pick a backend below to override.',
      backendChoiceAutoKey: 'Auto: an API key is configured, so memories are sent to the Mem0 Platform ({endpoint}).',
      backendChoiceAutoCredentials: 'Auto: {env} is stored in DSH credentials, so memories are sent to the Mem0 Platform ({endpoint}).',
      backendChoiceAutoUrl: 'Auto: a custom server address is configured ({endpoint}).',
      backendChoiceAutoOss: 'Auto: a local Mem0 OSS config was found; memories stay on this machine.',
      backendChoiceAutoDefault: 'Auto: nothing else is configured, so the Mem0 Platform ({endpoint}) is used. It needs an API key.',
      translateMemories: 'Translate memories on this page',
      translateMemoriesHint: 'Off by default. When on, memory text shown here is sent to DSH’s current default model (which may be a cloud model) for translation, and translations are cached in the profile folder.',
      captureStrataFolds: 'Save dsh-strata fold summaries',
      captureStrataFoldsHint: 'Off by default. Needs Automatic capture and the dsh-strata plugin. Also saves each first-level fold summary that Strata writes, a cleaner second copy of turns already captured; Mem0 dedupes repeated facts.',
      activityBudget: 'recall budget',
      hygieneItemDuplicate: 'duplicate',
      hygieneItemModel: 'outdated (model)',
      hygieneItemMerged: 'merged',
      hygieneItemImportance: 'importance {level}',
      statusCollection: 'Collection',
      statusUser: 'User',
      statusAgent: 'Agent',
      statusMem0: 'Mem0',
      statusMem0Native: 'native port of mem0 {version}',
      statusStore: 'Memory store',
      statusVectorStore: 'Vector store',
      statusLlm: 'Extraction LLM',
      statusLlmMissing: 'not configured',
      statusEmbedder: 'Embedder',
      statusKey: 'API key',
      keySet: 'configured',
      keyUnset: 'not configured',
      backendTitle: 'Backend',
      backendAuto: 'Auto detect',
      backendPlatform: 'Mem0 Platform',
      backendServer: 'Self-hosted server',
      backendOss: 'Local OSS',
      backendAutoHint: 'API key → Platform; custom base URL → Server; local Mem0 config → OSS.',
      backendPlatformHint: 'Use the managed Mem0 Platform API. All you need is an API key.',
      backendServerHint: 'Connect to a self-hosted Mem0 REST server.',
      backendOssHint: 'Keep memories in a local SQLite file, with your own embedding model and extraction LLM. No Python, no Qdrant.',
      apiKey: 'API key',
      apiKeyHint: 'Stored as a secret. Leave blank to keep the current key.',
      apiKeySet: 'A key is configured. Leave blank to keep it.',
      apiKeyUnset: 'No key configured.',
      clearKey: 'Clear saved key',
      apiKeyEnv: 'API key environment variable',
      apiKeyEnvHint: 'Used when the API key field is empty: looked up in DSH credentials (~/.dsh/.credentials.yaml), then in the environment.',
      baseUrl: 'Base URL',
      baseUrlPlatformHint: 'Leave blank for https://api.mem0.ai.',
      baseUrlServerHint: 'Example: http://127.0.0.1:8888',
      authType: 'Authentication',
      authApiKey: 'X-API-Key',
      authBearer: 'Bearer token',
      authToken: 'Token',
      authNone: 'No authentication',
      storePath: 'Memory database file',
      storePathHint: 'Leave blank for ~/.dsh/mem0/memory.sqlite.',
      ossConfigHint: 'The embedding model and the extraction LLM are set with the local setup wizard; it writes the "dsh_mem0" block of ~/.dsh/mem0/oss.json and stores keys in DSH credentials.',
      identityTitle: 'Memory owner',
      userId: 'User ID',
      agentId: 'Agent ID',
      behaviourTitle: 'Memory behaviour',
      autoRecall: 'Automatic recall',
      autoRecallHint: 'Search relevant memories before each model request.',
      autoCapture: 'Automatic capture',
      autoCaptureHint: 'Save facts from completed turns in the background.',
      announceToAgent: 'Tell the agent memory is available',
      announceToAgentHint: 'Adds a short memory capability note to the system prompt.',
      includeSubagents: 'Include subagents',
      includeSubagentsHint: 'Allow automatic memory for delegated agents too.',
      maintenanceTitle: 'Memory maintenance',
      maintenanceHint: 'A compact profile is rebuilt from stored facts, and a weekly hygiene pass removes duplicates and keeps the plugin’s own memories within budget (memories from other apps are never deleted). No extra model calls are made.',
      captureFilter: 'Capture filter',
      captureFilterHint: 'Heuristic skips greetings, short acknowledgements and command-only turns.',
      captureFilterHeuristic: 'Heuristic (recommended)',
      captureFilterOff: 'Capture every completed turn',
      profileEnabled: 'Build a compact user profile',
      profileEnabledHint: 'Derive a short profile from memories and inject it before relevant memories.',
      profileBudgetTokens: 'Profile budget (tokens)',
      profileBudgetTokensHint: 'Upper bound for the injected profile, 128–8000.',
      memoryBudgetTokens: 'Recall memory budget (tokens)',
      memoryBudgetTokensHint: 'Token limit for the recalled memories injected each turn, 128–20000 (CJK ≈ 1 token per character, Latin ≈ 4 characters per token).',
      storeSafetyLimit: 'Safety limit (memories)',
      storeSafetyLimitHint: 'Above this count hygiene warns; it never deletes for size. Default 20000.',
      importanceWeight: 'Importance weight in recall',
      importanceWeightHint: 'How much the importance rated by hygiene reorders recall, 0–1 (0 = off). Default 0.2.',
      projectPartitions: 'Partition by project',
      projectPartitionsHint: 'On: memories made in a project stay in that project, and recall reads the current project, this session and global. Off: new memories all go to global and recall reads only global and this session; existing project memories are kept unchanged and come back when you turn this on again. Project memories never move to global on their own. Takes effect from the next turn.',
      projectRecallBoost: 'Current project weight in recall',
      projectRecallBoostHint: 'Recall reads the current project and global memories together; the project’s scores are multiplied by this, 1–2 (1 = no preference). Default 1.1.',
      modelHygiene: 'Model-led hygiene',
      modelHygieneHint: 'Hygiene asks the model currently set in DSH to merge, retire and rate memories; scripts dedupe and check every action. The calls are billed to your provider in DSH and do not appear in DSH usage statistics; each report shows the tokens used. Off: script checks only.',
      hygieneEnabled: 'Weekly memory hygiene',
      hygieneEnabledHint: 'Runs at startup when due and hourly checks afterwards. Automatic passes only preview deletes and merges until you confirm a manual run; while previewing they still rate importance, which only changes the order.',
      hygieneIntervalDays: 'Hygiene interval (days)',
      hygieneIntervalDaysHint: 'Default 7 days, 1–90.',
      hygieneLastRun: 'Last run',
      hygieneNextRun: 'Next run',
      hygieneNever: 'never',
      hygieneDue: 'due now',
      hygieneProfile: 'Profile',
      hygieneRun: 'Run hygiene now',
      hygieneRunning: 'Running…',
      hygieneOk: 'Hygiene completed',
      hygieneFailed: 'Hygiene failed',
      hygieneReport: 'Scanned {scanned}, duplicates {duplicates}, merged {merged}, deleted {deleted}, failed {failed}.',
      hygieneModelOk: 'Model review: {calls} calls, {tokens} tokens.',
      hygieneModelOff: 'Model review is off: script checks only.',
      hygieneModelDegraded: 'This pass ran the script checks only: {reason}.',
      hygieneModelReason_NO_SERVICE: 'DSH model service not available',
      hygieneModelReason_NO_MODEL: 'no model is selected in DSH',
      hygieneModelReason_NO_ADAPTER: 'the selected provider is not set up',
      hygieneModelReason_MISSING_CREDENTIAL: 'the provider has no API key',
      hygieneModelReason_AUTH: 'the provider refused the API key',
      hygieneModelReason_INVALID_CREDENTIAL: 'the provider refused the API key',
      hygieneModelReason_TRANSPORT: 'the provider could not be reached',
      hygieneModelReason_TIMEOUT: 'the model did not answer in time',
      hygieneModelReason_RATE_LIMIT: 'rate limited by the provider',
      hygieneModelReason_QUOTA: 'the provider quota is used up',
      hygieneModelReason_ACCOUNT_QUOTA: 'the provider account has no balance',
      hygieneModelReason_BAD_JSON: 'the model did not answer in the required format',
      hygieneModelReason_UNKNOWN_MODEL: 'the model selected in DSH does not exist',
      hygieneModelReason_CONTEXT_WINDOW_EXCEEDED: 'a group of memories is too long for the model',
      hygieneModelReason_UNSUPPORTED_REASONING_EFFORT: 'the model refused the reasoning setting',
      hygieneModelReason_MAX_TOKENS: 'the model answer was cut off',
      hygieneModelReason_LLM_FAILED: 'the model call failed',
      hygieneModelReasonOther: 'the model call failed (code {code})',
      hygieneModelPartial: 'Calls answered before that were used.',
      hygieneModelBad: '{count} calls answered in the wrong format and were skipped.',
      hygieneModelSkipped: '{count} calls failed twice and are skipped until their memories change.',
      hygieneModelUnmetered: 'Some calls reported no token usage; the total is incomplete.',
      hygieneModelSuspicious: '{count} answers wanted to delete a whole group and were dropped.',
      hygieneModelDeferred: '{count} deletes wait for the next pass (at most 20 per pass).',
      hygienePending: '{count} new or changed memories still to review; the next pass comes in a day.',
      hygienePendingSlow: '{count} new or changed memories still to review.',
      hygieneMergesPending: '{count} merges are written but not confirmed yet; their sources stay until a later pass.',
      hygieneScanLimited: 'Only the first {limit} memories were scanned (this backend lists one page); the safety limit is checked on the local backend only.',
      hygieneBusy: 'A hygiene pass is running. Try again when it has finished.',
      hygieneModelStarting: 'The model service is still starting. Please try again shortly.',
      hygieneOverLimit: 'More than {limit} memories are stored (the safety limit). Nothing was deleted for size; review them in the memory list.',
      hygieneMergeDetails: 'Merges',
      hygieneImportanceDetails: 'Importance',
      hygieneLastReport: 'Last hygiene report',
      hygieneReasonSchedule: 'Scheduled',
      hygieneReasonStartup: 'Startup',
      hygieneReasonManual: 'Manual',
      hygieneDetails: 'Report details',
      hygieneReportWindow: 'Run time',
      hygieneReportDuration: 'Duration',
      hygieneReportStore: 'Stored memories',
      hygieneReportStoreTokens: 'Stored tokens',
      hygieneReportProfile: 'Memory summary',
      hygieneDuplicateDetails: 'Duplicate details',
      hygienePrunedDetails: 'Budget-pruned details',
      hygieneDeletedDetails: 'Deleted details',
      hygieneFailedDetails: 'Failed details',
      hygieneNoDetails: 'None',
      hygieneLegacyDetails: 'This report was created by an older version; only summary counts are available.',
      hygienePreviewing: 'Checking…',
      hygieneConfirm: 'Hygiene will permanently delete {planned} memories written by this plugin ({merges} merges: each writes one merged memory and deletes its sources). Memories from other apps and pinned memories are never deleted. This cannot be undone. Continue?',
      hygieneNothingToDelete: 'Nothing to delete.',
      hygieneCancelled: 'Cancelled, nothing deleted.',
      hygienePreviewTag: 'Preview, nothing deleted',
      hygienePlannedDetails: 'Would delete',
      hygieneForeign: '{foreign} memories from other apps were left untouched.',
      advanced: 'Advanced options',
      captureMaxChars: 'Capture length limit',
      captureMaxCharsHint: 'Characters per message when capturing, 50–4000.',
      recallTopK: 'Recall results',
      recallTopKHint: 'Number of memories returned per automatic recall, 1–20.',
      timeoutMs: 'Request timeout (ms)',
      timeoutMsHint: 'Timeout for each backend request on every backend (tools, listing, hygiene), 1–300000. Memory writes and automatic recall have their own limits.',
      recallTimeoutMs: 'Recall timeout (ms)',
      recallTimeoutMsHint: 'Automatic recall gives up after this and the turn continues without memories, 100–60000.',
      captureTurnDedupThreshold: 'Same-turn duplicate threshold',
      captureTurnDedupThresholdHint: 'Local backend: a captured fact at least this similar (cosine, 0.5–1) to a memory mem0_add stored in the same turn, or to another fact of the same capture, is not stored; nor is one that only restates such a memory (every word already in it, cosine at least 0.75). Older memories are checked for exact copies only, so corrections are kept. 0 = off (exact duplicates only, like Mem0). Default 0.93.',
      embedderKeepAlive: 'Ollama keep_alive',
      embedderKeepAliveHint: 'Local backend with Ollama: how long Ollama keeps the embedding model loaded, e.g. 30m, 2h, -1 (always). Empty = Ollama default (5m). Default 30m.',
      addTimeoutMs: 'Write timeout (ms)',
      addTimeoutMsHint: 'Timeout for storing memories, which may run LLM fact extraction, 1000–600000.',
      enabled: 'Enable Mem0 memory',
      enabledHint: 'Turn the whole plugin off without uninstalling it.',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Saved. Applying…',
      reset: 'Discard changes',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection successful',
      testFailed: 'Connection failed',
      unsaved: 'Unsaved changes',
      unavailable: 'This plugin is not active, so its settings cannot be edited.',
      readOnly: 'This profile does not accept configuration writes.',
      saveFailed: 'Could not save settings.',
      invalidNumber: 'Please enter a valid whole number.',
      loadFailed: 'Could not read plugin settings.',
      backendSection: 'Where should memories live?',
      connectionSection: 'Connection details',
      whatNext: 'After saving, use the memories tools in chat, or open a new conversation to start automatic recall.',
      activityTitle: 'Memory activity',
      activityCapture: 'Automatic capture',
      activityRecall: 'Automatic recall',
      activityQueued: 'Queued',
      activitySaving: 'Saving',
      activitySaved: 'Saved',
      activityNothingNew: 'Nothing new',
      activityExtracting: 'Extracting',
      activitySkipped: 'Skipped',
      activityStarting: 'Opening the memory store',
      skipReason_low_value: 'Too short or not worth remembering (capture filter)',
      skipReason_empty: 'Nothing left to save after redaction',
      skipReason_queue_full: 'Capture queue full (3 waiting)',
      skipReason_budget: 'No recall budget left this turn (dsh-strata)',
      skipReason_circuit_open: 'Paused after repeated failures (circuit breaker)',
      circuitRemaining: 'resumes in {time}',
      circuitTrippedBy: 'Tripped by: {kind} · {component} · {message} ({at})',
      captureFacts: 'Extracted {facts}: added {add}, updated {update}, already known {none}',
      captureFactsDeleted: ', deleted {delete}',
      captureFactsSimilar: ' ({similar} of them close to a memory written this turn, not stored again)',
      captureMetaDropped: '{count} sentences of the reply (memory confirmations, tool or screenshot notes) were not sent to extraction',
      recallTimings: 'Time per step: {steps}',
      recallTimingsTotal: '{total} ms in all',
      timingStep_openMs: 'store open',
      timingStep_credentialMs: 'key lookup',
      timingStep_embedMs: 'embedding',
      timingStep_searchMs: 'SQLite search',
      timingStep_injectMs: 'build block',
      timingStep_otherMs: 'other',
      recallSlowEmbed: 'Most of the time went to the embedding model. A local model may have been unloaded: see "Slow recall" in the README.',
      captureNoFacts: 'No new facts extracted (nothing worth keeping, or already known)',
      captureEvents: 'added {add}, updated {update}, deleted {delete}',
      retryPending: 'Not delivered; retrying once',
      retryPendingExtraction: 'LLM answer unusable ({reason}); retrying once',
      retryPendingBudget: 'LLM answer cut off at its output limit; retrying once with max_tokens {tokens}',
      extractStatsOutput: 'output {completion}/{max} tokens',
      extractStatsReasoning: '{reasoning} thinking',
      retrySaved: 'Saved after one retry',
      retryFailed: 'Retry failed too',
      dockCircuitOpen: 'Memory paused',
      dockCaptureSkippedShort: 'Capture skipped (too short)',
      sidecarExitCode: 'code {code}',
      sidecarExitSignal: 'signal {signal}',
      storeTitle: 'Local memory store',
      storeFile: 'File: {path}',
      storeOpen: 'Open',
      storeClosed: 'Not open yet (opens with the next memory call)',
      storeLastFailure: 'Last failure to open ({at}, {code}): {reason}',
      storeConfigErrorNoRetry: 'Configuration error: not retried until the settings or oss.json change.',
      storeConfigHint: 'Embedder and LLM: "dsh_mem0" block of ~/.dsh/mem0/oss.json.',
      failureExit: 'process exit {how}, up {uptime}',
      failureRetryFailed: 'retry failed',
      activitySearching: 'Searching',
      activityOk: 'Recalled',
      activityError: 'Failed',
      activityNever: 'Not yet',
      activityMessages: 'messages',
      activityWritten: 'written',
      activityReturned: 'returned',
      activityEvent: 'event',
      activityEmpty: 'No automatic memory activity yet. Finish one conversation and capture/recall results will appear here.',
      activityScopeHint: 'Activity covers automatic capture and recall performed by this plugin process. Recent memories are read directly from the configured backend.',
      dockIdle: 'Mem0 ready',
      dockDisabled: 'Mem0 off',
      dockCaptureSaving: 'Saving memory',
      dockCaptureQueued: 'Memory queued',
      dockCaptureExtracting: 'Extracting memory',
      dockCaptureSaved: 'Memory saved',
      dockCaptureNothingNew: 'Nothing new to remember',
      dockCaptureSkipped: 'Capture skipped',
      dockRecallSearching: 'Recalling memory',
      dockRecallOk: 'Memory recalled',
      dockError: 'Memory failed',
      dockStatusUnavailable: 'Status unavailable',
      dockStatusUnavailableDetail: 'Could not read the Mem0 plugin status from DSH. This is not a memory failure: the plugin or DSH did not answer.',
      dockLatestFailure: 'Latest memory failure',
      dockNoFailureDetail: 'No failure details recorded.',
      failuresTitle: 'Recent failures',
      failuresHint: 'The last 20 failures, newest first. Kept across restarts; a later success does not clear them.',
      failuresEmpty: 'No memory failures recorded.',
      failureKind_capture: 'Capture',
      failureKind_recall: 'Recall',
      failureKind_summary: 'Summary',
      failureKind_maintenance: 'Maintenance',
      failureCause_timeout: 'Timeout',
      failureCause_connection: 'Connection failed',
      failureCause_auth: 'Auth or quota',
      failureCause_circuit: 'Circuit breaker skip',
      failureCause_extraction: 'LLM extraction failed',
      extractReason_not_json: 'answer was not JSON',
      extractReason_empty: 'empty answer',
      extractReason_truncated: 'answer cut off (truncated JSON)',
      extractReason_refusal: 'model refused',
      failureCause_other: 'Other error',
      failureCause_startup: 'Local backend failed to start',
      failureCause_config: 'Configuration error',
      failureHintUnreachable: '{component} unreachable at {endpoint}. Is it running? On Windows, a port in a reserved range fails to bind (os error 10013 in the service log): see the README, Windows troubleshooting.',
      configWarning: 'dsh-mem0 settings look rewritten (DSH settings sync); missing: {fields}',
      upgradeLegacyQdrant: 'Earlier memories are still in Qdrant ({endpoint}, collection {collection}). This version keeps memories in SQLite and does not read them; move them with the local setup wizard (last step).',
      upgradeNoLocalConfig: 'No local backend settings were found in ~/.dsh/mem0/oss.json. Earlier versions fell back to reading settings from elsewhere; this one does not. Set it up again with the setup wizard.',
      wzOpen: "Local setup wizard",
      wzTitle: "Local setup wizard",
      wzIntro: "Set up the embedding model, the extraction LLM and the memory file. Nothing is saved until the self-test passes.",
      wzClose: "Close",
      wzDone: "Done",
      wzNext: "Next",
      wzBack: "Back",
      wzStepEmbedder: "Embedding model",
      wzStepLlm: "Extraction LLM",
      wzStepStore: "Memory file",
      wzStepSelfTest: "Self-test and save",
      wzStepMigrate: "Move memories from Qdrant",
      wzCloud: "Cloud API (recommended)",
      wzLocal: "Local model",
      wzCloudHint: "Any OpenAI-compatible /embeddings API. The key is stored in DSH credentials, never in oss.json.",
      wzLocalHint: "A model served on this computer (Ollama or LM Studio). Nothing leaves the machine.",
      wzLocalHintMac: "A model served on this computer (Ollama, LM Studio or oMLX). Nothing leaves the machine.",
      wzPreset: "Suggested service",
      wzPresetCustom: "Other (type below)",
      wzProvider: "Server type",
      wzOpenAiCompatible: "OpenAI-compatible (LM Studio, oMLX, vLLM…)",
      wzBaseUrl: "Address",
      wzModel: "Model",
      wzModelTyped: "Model name",
      wzKey: "API key",
      wzKeyHint: "Stored in DSH credentials under the name below, never in oss.json.",
      wzKeyNewServer: "The server changed: type the key for this one. A stored key is only sent to the server it was saved for.",
      wzKeyStored: "A key is stored in DSH credentials as {ref}. Leave blank to keep it.",
      wzKeyRef: "Credential name",
      wzLiteral: "oss.json holds a plain-text key for this server: on save, store it in DSH credentials and remove it from oss.json",
      wzBackupHasKeys: "The backup {backup} still holds the plain-text key; delete it once everything works.",
      wzRefExists: "{ref} in DSH credentials already holds another key.",
      wzRefReplace: "Replace {ref}",
      wzDetect: "Detect local services",
      wzDetecting: "Detecting…",
      wzServiceUp: "{label} on port {port}: running, {count} models",
      wzServiceDown: "{label} on port {port}: {error}",
      wzUse: "Use",
      wzRecommended: "Suggested local models",
      wzModelDims: "{model} ({dims} dims)",
      wzModelDimsBest: "{model} ({dims} dims, recommended for Chinese and English)",
      wzReserved: "Windows: a service cannot listen on a port inside a range Windows reserved (Hyper-V, WSL, Docker) and fails with os error 10013. List the ranges in PowerShell, then pick a port outside them (for example above 15000):",
      wzTest: "Test",
      wzTesting: "Testing…",
      wzListModels: "List models",
      wzCheck: "Check",
      wzEmbedOk: "Works: {dims} dimensions.",
      wzDimsDiffer: "The server returned {actual} dimensions, not {expected}.",
      wzStoreMismatch: "The memory file holds {memories} memories embedded with {model} ({dims} dimensions). Switch back to that model, or keep this one: saving then recomputes their vectors.",
      wzReembedOnSave: "Saving recomputes the vectors of {memories} memories first (the text is not changed; one embedder call per 32 memories). Until then everything keeps running as it is; the self-test uses a temporary file.",
      wzReembedDone: "Vectors recomputed: {count}.",
      wzProgress: "Working… {done}/{total}",
      wzCancel: 'Cancel',
      wzErr_CANCELLED: 'Cancelled; nothing was changed',
      wzFailed: "Failed: {error}",
      wzAuthFailed: "The server refused the key (HTTP 401/403).",
      wzFail_authOmlx: "oMLX has API key verification on (HTTP {status}). Either: (1) put the value of auth.api_key in {file} into the API key field below, or click \"Read the key from oMLX\"; or (2) stop oMLX, set auth.skip_api_key_verification to true in that file, and start it again (this works only while oMLX listens on this computer only).",
      wzFail_authKeyOmlx: "oMLX refused this API key (HTTP {status}). Check that it matches auth.api_key in {file} (if oMLX was started with --api-key or OMLX_API_KEY, that key counts); or stop oMLX, set auth.skip_api_key_verification to true and start it again.",
      wzFail_authLmStudio: "LM Studio has Require Authentication on (HTTP {status}). Either: (1) create an API token in LM Studio under Developer → Server Settings and put it into the API key field below; or (2) turn off Require Authentication in the same place.",
      wzFail_authKeyLmStudio: "LM Studio refused this API token (HTTP {status}). A token is shown only once, when it is created: create a new one in LM Studio under Developer → Server Settings and put it into the API key field below.",
      wzFail_authOllama: "Ollama itself needs no API key: this HTTP {status} comes from a proxy or another program in front of it. Put the key that layer wants into the API key field below, or connect to Ollama's own port.",
      wzFail_authAny: "The service needs an API key (HTTP {status}). Put it into the API key field below.",
      wzFail_authKeyAny: "The server refused this API key (HTTP {status}). Check the key and its credential name.",
      wzOmlxRead: "Read the key from oMLX",
      wzOmlxReveal: "Show the settings file in Finder",
      wzOmlxRevealOther: "Show where the settings file is",
      wzOmlxReadOk: "Read the key from {file} (not shown). It is used for this setup only and stored in DSH credentials when you save.",
      wzOmlxRead_missing_file: "{file} was not found. If oMLX's base path was changed (or OMLX_BASE_PATH is set), the file is elsewhere. Put the value of auth.api_key into the API key field below yourself.",
      wzOmlxRead_no_permission: "No permission to read {file}. Put the value of its auth.api_key into the API key field below yourself.",
      wzOmlxRead_bad_json: "{file} is not valid JSON, so no key could be read. Put the value of auth.api_key into the API key field below yourself.",
      wzOmlxRead_no_field: "{file} has no auth.api_key. oMLX may have been started with --api-key or OMLX_API_KEY: put that key into the API key field below yourself.",
      wzOmlxRead_read_error: "Could not read {file} ({code}). Put the value of auth.api_key into the API key field below yourself.",
      wzOmlxRead_not_omlx: "Only an oMLX address (port 8000 on this computer) can have its key read.",
      wzOmlxRevealed: "{file} is shown in Finder.",
      wzOmlxFileAt: "Settings file: {file}",
      wzOmlxReveal_missing_file: "{file} was not found.",
      wzFail_notFoundSuggest: "Wrong address path (HTTP 404). An OpenAI-compatible address usually ends with /v1, for example {example}.",
      wzFail_notFound: "{service} answered HTTP 404{detail}. Check the address path and the model name: an OpenAI-compatible address usually ends with /v1, for example {example}.",
      wzFail_notFoundAny: "The server answered HTTP 404{detail}. Check the address path and the model name: an OpenAI-compatible address usually ends with /v1, for example {example}.",
      wzFail_notFoundOllama: "Ollama answered HTTP 404{detail}. Check the model name (download it with ollama pull first); an Ollama address has no path, for example http://127.0.0.1:11434.",
      wzFail_refused: "Nothing is running on {endpoint} (connection refused). Start {service} first, then try again.",
      wzFail_refusedAny: "Nothing is running on {endpoint} (connection refused). Start {starters} first, then try again.",
      wzFail_refusedRemote: "Cannot reach {endpoint} (connection refused). Check the address and port.",
      wzFail_timeout: "{service} ({endpoint}) did not answer within {seconds} s: nothing may be running on the port, or it is still loading a model. Make sure {service} is started, then try again.",
      wzFail_timeoutAny: "{endpoint} did not answer within {seconds} s: nothing may be running on the port, or it is still loading a model. Start {starters} first, then try again.",
      wzFail_timeoutRemote: "{endpoint} did not answer within {seconds} s. Check the network and the address, then try again.",
      wzFail_http: "{service} answered HTTP {status}{detail}.",
      wzFail_httpAny: "The server answered HTTP {status}{detail}.",
      wzFail_network: "Cannot reach {endpoint}{detail}. Check the address and the network.",
      wzFail_badResponse: "{endpoint} answered in an unexpected shape{detail}. Check that the address is an OpenAI-compatible (or Ollama) API and the model name is right.",
      wzFail_badUrl: "The address must start with http:// or https://.",
      wzFailDetail: ": {detail}",
      wzStarters: "Ollama or LM Studio",
      wzStartersMac: "oMLX, Ollama or LM Studio",
      wzUseSuggested: "Change to {url}",
      wzProbeRefused: "not running. To use it, start {label} first.",
      wzProbeTimeout: "no answer: nothing may be running on the port, or {label} is stuck. Restart {label}, then detect again.",
      wzLocalKeyHint: "Optional: only needed when the local service has API key verification on. Stored in DSH credentials, never in oss.json.",
      wzLlmHint: "An OpenAI-compatible chat API that turns conversations into facts. The test sends a fixed sample conversation, not your data.",
      wzLlmViaDsh: "DSH's current model",
      wzLlmViaManual: "Set a model myself",
      wzLlmDshHint: "Extraction uses the model selected in DSH right now and follows it when you switch models in DSH. DSH keeps that model's address and key; nothing about them is stored here. The test sends a fixed sample conversation, not your data.",
      wzLlmDshNow: "Current model: {model}",
      wzLlmDshNone: "No model is selected in DSH. Pick one in DSH first, then test again.",
      wzLlmDshNoService: "DSH's model service is not available yet. Wait a few seconds; if this stays, restart DSH.",
      wzLlmDshBilling: "Cost: every captured turn calls this model once more. The conversation and similar memories are sent to it (secrets removed first). It is billed to your provider in DSH and not counted in DSH usage statistics; mem0_status shows the tokens of the last extraction.",
      wzLlmDshUsed: "model {model}",
      wzLlmDshModelAny: "DSH's model",
      wzAdviceOtherModel: "The model did not answer JSON. Select another model in DSH, or set a model yourself.",
      wzCheckModel: "Extraction model {model} answers",
      wzFailDsh_NO_SERVICE: "DSH's model service is not available yet. Wait a few seconds and test again; if this stays, restart DSH.",
      wzFailDsh_NO_MODEL: "No model is selected in DSH. Pick a model in DSH, then test again.",
      wzFailDsh_NO_ADAPTER: "The provider of {model} is not loaded in DSH. Check DSH's model settings, or select another model.",
      wzFailDsh_MISSING_CREDENTIAL: "{model} has no API key in DSH. Add it in DSH's model settings, then test again.",
      wzFailDsh_INVALID_CREDENTIAL: "The API key of {model} in DSH is not valid. Correct it in DSH's model settings, then test again.",
      wzFailDsh_AUTH: "{model} refused the API key DSH sent. Update the key in DSH's model settings, then test again.",
      wzFailDsh_RATE_LIMIT: "{model} is rate limited right now. Wait a moment and test again.",
      wzFailDsh_QUOTA: "{model} has no quota left. Top up with its provider, or select another model in DSH.",
      wzFailDsh_ACCOUNT_QUOTA: "{model} has no balance left. Top up the account, or select another model in DSH.",
      wzFailDsh_CONTEXT_WINDOW_EXCEEDED: "The extraction prompt is longer than the context window of {model}. Select a model with a larger context window in DSH.",
      wzFailDsh_TIMEOUT: "{model} did not answer in time. Test again, or select a faster model in DSH.",
      wzFailDsh_other: "{model} failed ({code}). Check the model in DSH, then test again.",
      statusLlmDsh: "Extraction follows DSH's current model: {model}",
      statusLlmDshLabel: "Extraction LLM · follows DSH",
      statusLlmDshNone: "no model selected in DSH",
      wzHygieneBilling: 'Memory hygiene is separate: by default it uses the model currently set in DSH (not this one), billed to your provider in DSH and not counted in DSH usage statistics. Each hygiene report shows the tokens used; switch "Model-led hygiene" off in the settings to run script checks only.',
      wzMaxTokens: "Output budget (max_tokens)",
      wzEffort: "reasoning_effort (optional)",
      wzEffortHint: "For reasoning models: \"low\", or \"none\" if the gateway supports it. Leave blank for other models.",
      wzLlmOk: "Works: {facts} facts extracted ({stats}).",
      wzLlmBad: "The answer could not be used ({reason}; {stats}).",
      wzAdviceRaise: "The answer ran into its output budget. Use max_tokens of at least 8000, or lower reasoning_effort.",
      wzAdviceEffort: "This is a reasoning model: its thinking counts against max_tokens. Keep max_tokens at 8000 or more, or set reasoning_effort to \"low\" (\"none\" if supported).",
      wzAdviceJson: "The model did not answer JSON. Pick a model that supports JSON output.",
      wzLlmPassed: "Test passed",
      wzLlmFailed: "Test failed",
      wzLlmUntestedBadge: "Not tested yet",
      wzLlmFacts: "{facts} facts extracted from the sample conversation",
      wzLlmFinish: "finish_reason: {reason}",
      wzLlmOutput: "output {used} / {max} tokens",
      wzLlmReasoning: " ({tokens} of them reasoning)",
      wzLlmPrompt: "prompt {tokens} tokens",
      wzLlmTime: "{ms} ms",
      wzLlmReason: "Why: {reason}",
      wzLlmSuggest: "What to do: {advice}",
      wzLlmKeep: "This result stays until you change a setting of this step.",
      wzReason_truncated: "the answer was cut off before the JSON ended",
      wzReason_not_json: "the answer was not JSON",
      wzReason_empty: "the answer was empty",
      wzReason_refusal: "the model refused the task",
      wzAdviceEmpty: "The model returned nothing. Check that the model name is a chat model, and raise max_tokens if it is a reasoning model.",
      wzAdviceRefusal: "The model refused to extract facts. Pick another model; a general chat model works best.",
      wzAdviceAuth: "Check the API key (or its credential name) for this server.",
      wzAdviceNetwork: "Check the address and port, and that the server is running.",
      wzAdviceTimeout: "The server did not answer in time. Try again, or pick a faster model.",
      wzAdviceNotFound: "Check the model name and that the address ends with the API path (often /v1).",
      wzAdviceGeneric: "Check the address, model and key, then test again.",
      wzLlmUntested: "The LLM test has not passed yet. Without a working LLM, automatic capture stores nothing. Test it first, or press \"Next anyway\".",
      wzNextAnyway: "Next anyway",
      wzStorePath: "Memory database file",
      wzStoreHint: "Leave blank for ~/.dsh/mem0/memory.sqlite. It must be on a local disk: not a network drive, not a synced folder (iCloud, OneDrive, Dropbox…).",
      wzStoreWhere: "Memories are kept in {path}.",
      wzStoreChange: "Change the location (advanced)",
      wzStoreUnverified: "{path}: the disk type could not be confirmed ({reason}).",
      wzStoreConfirm: "This is a disk of this computer, not a network share",
      wzStoreOk: "{path}: writable, on a local disk.",
      wzStoreExternal: "{path}: writable, but on another volume. Keep it attached while DSH runs.",
      wzStoreSync: "{path} is inside a {provider} folder. Synced folders damage SQLite files; choose a local folder.",
      wzStoreNetwork: "{path} is on a network drive. SQLite needs a local disk; choose a local folder.",
      wzStoreNotWritable: "{path}: {error}",
      wzStoreHas: "The memory file already holds {count} memories.",
      wzSelfTestHint: "Writes one probe memory for the test user {user}, finds it, deletes it and checks nothing is left. Your own memories are not touched. Saving needs a passed self-test.",
      wzRunSelfTest: "Run self-test",
      wzCheckWrite: "write",
      wzCheckSearch: "search",
      wzCheckDelete: "delete",
      wzCheckLeftover: "nothing left",
      wzCheckCredentials: "credentials",
      wzSelfTestOk: "Self-test passed.",
      wzMismatchGoBack: "Go back to step 1 to recompute the vectors or switch the model back.",
      wzSaveEnable: "Save and switch on",
      wzSaving: "Saving…",
      wzSaved: "Saved to {path}{backup}. Keys stored in DSH credentials: {refs}.",
      wzBackup: " (previous file kept as {backup})",
      wzNone: "none",
      wzShadowed: "These settings are set in the DSH profile and win over the wizard: {fields}.",
      wzCredNoService: "The key could not be stored: this DSH has no credential store the plugin can write to. Add it in DSH credentials as {ref}, then save again.",
      wzMigrateIntro: "Earlier versions kept memories in Qdrant. This copies the memories of user {user} in collection {collection} into the memory file, once. Qdrant is only read: nothing there is changed or deleted, and no backup is made. Other collections are never read.",
      wzQdrantUrl: "Qdrant address",
      wzQdrantHint: "Default 127.0.0.1:6333; on Windows often 127.0.0.1:15333.",
      wzCollection: "Collection",
      wzPreflight: "Check Qdrant",
      wzPreflightOk: "Found {points} memories of {user} ({dims} dimensions).",
      wzCopyVectors: "Copy the vectors as they are (same model {model}, {dims} dimensions)",
      wzRecompute: "The vectors will be recomputed with {model}: the old ones came from another model or dimension.",
      wzMigrate: "Move memories",
      wzMigrating: "Moving… {phase} {done}/{total}",
      wzPhaseRead: "reading",
      wzPhaseEmbed: "computing vectors",
      wzMigrated: "Moved {imported} memories ({vectors}; {skipped} already there, {empty} without text). The old data is still in Qdrant and no longer used: you may delete it or stop the Qdrant service.",
      wzForeign: "{count} points whose user id is stored in another form (for example as a number) were left out.",
      wzMigrateAgain: "Move again (memories deleted since the first move come back)",
      wzLegacyPossible: "If you used the local mode before, your memories may still be in Qdrant ({endpoint}): move them in step 5.",
      wzRefusedSummary: "Not running: {list}. If one of them is running, its port may lie in a range Windows reserved:",
      wzVectorsCopied: "vectors copied",
      wzVectorsRecomputed: "vectors recomputed",
      wzMigrateFailed: "The migration failed at step \"{step}\": {error}. Nothing was written; the memory file is as it was.",
      wzQdrantDown: "Start Qdrant again the way you ran it before (for example docker start, or the qdrant command), then check again.",
      wzQdrantDownWin: "Start Qdrant again the way you ran it before (README, \"Windows troubleshooting\"), then check again.",
      wzStepName_preflight: "check",
      wzStepName_read: "reading Qdrant",
      wzStepName_map: "reading the memories",
      wzStepName_embed: "computing vectors",
      wzStepName_write: "writing",
      wzStepName_verify: "verifying",
      wzStepName_switch: "switching",
      wzStepName_merge: "merging",
      wzStepName_embedder: "embedding model",
      wzStepName_store: "memory file",
      wzStepName_credentials: "credentials",
      wzStepName_reembed: "recomputing vectors",
      wzErr_LOCAL_BACKEND_OFF: "Finish the setup first: save it and switch the local backend on.",
      wzErr_ALREADY_MIGRATED: "This memory file was filled from Qdrant already.",
      wzErr_FORBIDDEN_COLLECTION: "This collection belongs to another app and is never read.",
      wzErr_COLLECTION_NOT_ALLOWED: "Only the collection of this setup is read.",
      wzErr_COLLECTION_NOT_FOUND: "Qdrant has no such collection.",
      wzErr_QDRANT_UNREACHABLE: "Qdrant is not reachable at this address.",
      wzErr_QDRANT_AUTH: "Qdrant refused the request (API key).",
      wzErr_QDRANT_EMBEDDED_UNSUPPORTED: "oss.json names an embedded Qdrant folder; the move needs a Qdrant server.",
      wzErr_VERIFY_FAILED: "A check after copying failed.",
      wzErr_EMBEDDER_MISMATCH: "The memory file holds vectors of another embedding model.",
      wzErr_BAD_VECTOR: "A memory in Qdrant has no vector of the expected size.",
      wzErr_CONFIG_INVALID: "A setting is not valid.",
      wzErr_REF_NOT_ALLOWED: "The wizard uses only its own credential names or the one in use.",
      wzErr_EMBEDDER_FAILED: "The embedding model does not answer.",
      wzErr_REEMBED_CONFLICT: "Memories kept changing while the vectors were recomputed; try again when DSH is idle.",
      wzErr_STORE_REFUSED: "The memory file cannot be kept there.",
      wzSkip: "Skip, start empty",
      wzSkipHint: "Skipping leaves the old memories in Qdrant and recall starts from an empty store. You can still move them later from this wizard.",
      wzSkipped: "Migration skipped.",
      wzAlreadyMigrated: "Moved on {at}: {imported} memories from {endpoint}.",
      wzNeedEnable: "Save and switch on the local backend first (step 4).",
      wzSwitchMissing: "The local backend is not set up yet ({missing} missing).",
      wzSwitchOpen: "Open wizard",
      wzSwitchAnyway: "Switch anyway",
      wzMissingEmbedder: "embedding model",
      wzMissingLlm: "extraction LLM",
      upgradeQdrantMigrated: "The old data is still in Qdrant and no longer used: you may delete it or stop the Qdrant service.",
      configWarningFix: 'Restore them above and save, or keep them in the "dsh_mem0" block of oss.json, which DSH does not rewrite. Removed on purpose: delete config-fingerprint.json next to failures.json.',
      failureRepeated: '{count} times since {since}',
      failureComponent_llm: 'LLM',
      failureComponent_embedder: 'Embedder',
      failureComponent_vector_store: 'Vector store',
      failureComponent_sidecar: 'Python sidecar (earlier version)',
      failureComponent_mem0_api: 'Mem0 API',
      failureComponent_unknown: 'Unknown component',
      failureStep_embed: 'embedding',
      failureStep_search: 'vector search',
      failureStep_llm_extract: 'fact extraction',
      failureStep_store: 'storing',
      failureStepRunning: '{step} still running after {ms} ms',
      dockOpen: 'Open Mem0 settings',
      scopeChipProject: 'Project',
      scopeChipGlobal: 'Global',
      scopeChipAria: 'Mem0 memory partition: {where}',
      scopeChipAriaProject: 'project {name}',
      scopeChipAriaGlobal: 'global',
      scopePopTitle: 'Mem0 memory partition',
      scopePopProject: 'Project: {name}',
      scopePopGlobal: 'Global (shared by every project)',
      scopePopBasis: 'Decided by: {basis}',
      scopeBasis_gitOrigin: 'git repository, by its origin remote',
      scopeBasis_gitRoot: 'git repository root (no origin remote)',
      scopeBasis_folder: 'folder (not in a git repository)',
      scopeBasis_defaultWorkspace: 'DSH default workspace, so global',
      scopeBasis_home: 'home folder outside git, so global',
      scopeBasis_none: 'no working directory, so global',
      scopeBasis_off: '"Partition by project" is off, so global',
      scopeBasis_pending: 'not identified yet (DSH reports this conversation at its next turn), global until then',
      scopePopWorktree: 'git worktree: shares the main checkout\'s partition',
      scopePopCheckout: 'Worktree: {path}',
      scopePopPath: 'Path: {path}',
      scopePopCwd: 'Working directory: {path}',
      scopePopPartition: 'Partition id: {id}',
      scopePopWhenOn: 'With the switch on: project {name}',
      scopePopGitError: 'git did not answer ({error}); treated as a plain folder',
      scopeChipPendingHint: 'Partition by project is on. This conversation\'s project is identified at its next turn; until then new memories go to global. Click to turn the switch off. Applies from the next turn; the same switch is in Mem0 settings.',
      dshDefaultWorkspace: 'DSH default workspace',
      scopeChipOnHint: 'Partition by project is on: new memories from this conversation stay in its project, and recall reads this project, this session and global. Click to turn it off (new memories then go to global). Applies from the next turn; the same switch is in Mem0 settings.',
      scopeChipOnNoProjectHint: 'Partition by project is on, but this conversation is not in a project folder, so its new memories go to global. Click to turn the switch off. Applies from the next turn; the same switch is in Mem0 settings.',
      scopeChipOffHint: 'Partition by project is off: new memories go to global, and recall reads only global and this session. Project memories are kept and come back when you turn it on. Click to turn it on. Applies from the next turn; the same switch is in Mem0 settings.',
      scopeChipSaveFailed: 'Could not change the switch; open Mem0 settings to change it there.',

      activityAsyncHint: 'Platform extraction runs in the background. Queued memories can take a few seconds before they appear in the list below.',
      recentTitle: 'Recent memories',
      recentEmpty: 'No memories yet. Completed turns will appear here after automatic capture.',
      recentError: 'Could not read recent memories',
      memoryBrowserTitle: 'Memory library',
      memoryBrowserHint: 'Search and browse every memory stored for this user. The list is read directly from the configured backend.',
      memoryBrowserOpen: 'View all memories',
      memoryBrowserClose: 'Hide memory library',
      memorySearchPlaceholder: 'Search memory text or ID…',
      memorySearch: 'Search',
      memoryLoading: 'Loading memories…',
      memoryEmpty: 'No memories match this search.',
      memoryCount: '{count} memories',
      memoryCountFiltered: '{shown} of {total} memories',
      memoryBrowserError: 'Could not read memories',
      memoryDelete: 'Delete',
      memoryPin: 'Pin',
      memoryUnpin: 'Unpin',
      memoryPinnedTag: 'Pinned',
      memoryImportance: 'Importance {level}',
      memoryPinError: 'Could not change the pin',
      memoryMakeGlobal: 'Make global',
      memoryMakeGlobalError: 'Could not move the memory',
      memoryMakeGlobalNotProject: 'only a project memory can be made global',
      memoryMakeGlobalNotOwn: 'only memories this plugin wrote can be moved',
      memoryMakeGlobalNotFound: 'the memory no longer exists',
      memoryMakeGlobalOtherUser: 'the memory belongs to another Mem0 user',
      tokUnit: 'tok',
      sessionAt: 'Session · {time}',
      memorySource: 'source {source}',
      memoryTreeTitle: 'Memory page',
      memoryTreeHint: 'Memories by where they apply: global (everywhere), a project (one repository or folder) or a session. Browse, search, pin and delete; memories cannot be edited here.',
      treeAll: 'All',
      treeProjects: 'Projects',
      treeSessions: 'Sessions without a project',
      scopeGlobal: 'Global',
      scopeProject: 'Project {name}',
      scopeSession: 'Session {id}',
      reportDeleted: 'deleted',
      reportPending: 'merge pending',
      projectSummaries: 'Project summaries: {list}',
      projectSummaryStale: 'being rebuilt',
      memoryDeleting: 'Deleting…',
      memoryDeleteConfirm: 'Permanently delete this memory? This cannot be undone.\n\nID: {id}\n\n{memory}',
      memoryDeleted: 'Deleted',
      memoryDeleteError: 'Could not delete the memory',
      memoryDeleteReason_foreign_source: 'it was written by another app, and only memories written by DSH-Mem0 can be deleted here',
      memoryDeleteReason_other_user: 'it belongs to another Mem0 user',
      memoryDeleteReason_not_found: 'it no longer exists',
      memoryDeleteReason_unproven_owner: 'the backend did not confirm it belongs to the configured Mem0 user',
      profileSourcesChanged: 'A memory this summary was built from was deleted or changed; the summary may contain outdated or deleted content. Edit or reset it.',
      profileStale: 'A memory this summary was built from was deleted or changed; the summary is not injected until it is rebuilt.',
      recallPreviewTitle: 'Last recalled memories',
      profileSummaryTitle: 'Memory summary',
      profileSummaryHint: 'Editable global memory summary, injected with the current project’s summary during recall. Hygiene has the model rewrite summaries whose memories changed; a delete or an edit stops a summary until it is rebuilt.',
      profileSummaryEmpty: 'No memory summary yet. It is generated after the next maintenance pass.',
      profileSummaryDisabled: 'Memory summary is disabled.',
      profileSummaryItems: 'items',
      profileSummaryUpdated: 'Updated',
      profileEditHint: 'Edit the summary and save. The new text is used on the next turn. Markdown headings and bullets are supported.',
      profileEdit: 'Edit summary',
      profileCancel: 'Cancel',
      profileSave: 'Save memory summary',
      profileSaving: 'Saving…',
      profileSaved: 'Saved',
      profileReset: 'Rebuild from memories',
      profileResetHint: 'Discard manual edits and rebuild from stored memories.',
      profileManual: 'Edited manually',
      profileGenerated: 'Generated',
      profileTooLong: 'Memory summary is too long.',
      recallPreviewEmpty: 'The last recall returned no memory text.',
      memoryScore: 'score',
      refresh: 'Refresh',
      memoryId: 'ID',
    }

    const zh = {
      title: 'Mem0 连接设置',
      subtitle: '选择记忆的存储位置。保存后立即生效。',
      checkAgain: '重新检查',
      checking: '正在检查连接…',
      statusReady: '已连接',
      statusDegraded: '未连接',
      statusUnknown: '状态未知',
      statusBackend: '后端',
      statusEndpoint: '地址',
      statusBackendChoice: '后端选择依据',
      backendChoiceAutoEnv: '自动：环境变量 {env} 已设置，因此记忆会发送到 Mem0 Platform（{endpoint}）。可在下方明确选择后端来改变。',
      backendChoiceAutoKey: '自动：已配置 API Key，因此记忆会发送到 Mem0 Platform（{endpoint}）。',
      backendChoiceAutoCredentials: '自动：DSH 凭据里存有 {env}，因此记忆会发送到 Mem0 Platform（{endpoint}）。',
      backendChoiceAutoUrl: '自动：已配置自定义服务器地址（{endpoint}）。',
      backendChoiceAutoOss: '自动：找到了本地 Mem0 OSS 配置，记忆留在本机。',
      backendChoiceAutoDefault: '自动：没有其他配置，因此使用 Mem0 Platform（{endpoint}），需要 API Key。',
      translateMemories: '在本页翻译记忆',
      translateMemoriesHint: '默认关闭。开启后，本页显示的记忆原文会发送给 DSH 当前默认模型（可能是云端模型）进行翻译，译文缓存在 profile 目录中。',
      captureStrataFolds: '保存 dsh-strata 折叠摘要',
      captureStrataFoldsHint: '默认关闭。需要开启自动保存并安装 dsh-strata。额外保存 Strata 写下的每份一级折叠摘要，相当于已保存回合的一份更干净的副本；重复的事实由 Mem0 自己去重。',
      activityBudget: '召回预算',
      hygieneItemDuplicate: '重复',
      hygieneItemModel: '过时（模型判断）',
      hygieneItemMerged: '已合并',
      hygieneItemImportance: '重要度 {level}',
      statusCollection: '集合',
      statusUser: '用户',
      statusAgent: 'Agent',
      statusMem0: 'Mem0',
      statusMem0Native: 'mem0 {version} 的原生移植',
      statusStore: '记忆存储',
      statusVectorStore: '向量库',
      statusLlm: '抽取 LLM',
      statusLlmMissing: '未配置',
      statusEmbedder: 'Embedder',
      statusKey: 'API Key',
      keySet: '已配置',
      keyUnset: '未配置',
      backendTitle: '后端',
      backendAuto: '自动检测',
      backendPlatform: 'Mem0 Platform',
      backendServer: '自建 Server',
      backendOss: '本地 OSS',
      backendAutoHint: '有 API Key → Platform；自定义 Base URL → Server；找到本地 Mem0 配置 → OSS。',
      backendPlatformHint: '使用 Mem0 托管平台，只需要一个 API Key。',
      backendServerHint: '连接自建的 Mem0 REST 服务。',
      backendOssHint: '记忆存进本地 SQLite 文件，使用你自己的 embedding 模型和抽取 LLM。不需要 Python，也不需要 Qdrant。',
      apiKey: 'API Key',
      apiKeyHint: '作为密钥保存。留空表示保持当前 Key。',
      apiKeySet: '已配置 Key，留空保持不变。',
      apiKeyUnset: '尚未配置 Key。',
      clearKey: '清除已保存的 Key',
      apiKeyEnv: 'API Key 环境变量名',
      apiKeyEnvHint: 'API Key 输入框为空时使用：先在 DSH 凭据（~/.dsh/.credentials.yaml）里找这个名字，再找同名环境变量。',
      baseUrl: 'Base URL',
      baseUrlPlatformHint: '留空使用 https://api.mem0.ai。',
      baseUrlServerHint: '例如 http://127.0.0.1:8888',
      authType: '认证方式',
      authApiKey: 'X-API-Key',
      authBearer: 'Bearer token',
      authToken: 'Token',
      authNone: '无认证',
      storePath: '记忆数据库文件',
      storePathHint: '留空即 ~/.dsh/mem0/memory.sqlite。',
      ossConfigHint: 'embedding 模型和抽取 LLM 用本地配置向导设置：向导写入 ~/.dsh/mem0/oss.json 的 "dsh_mem0" 段，key 存进 DSH 凭据库。',
      identityTitle: '记忆归属',
      userId: '用户 ID',
      agentId: 'Agent ID',
      behaviourTitle: '记忆行为',
      autoRecall: '自动召回',
      autoRecallHint: '每次模型请求前搜索相关记忆。',
      autoCapture: '自动保存',
      autoCaptureHint: '在回合完成后后台保存事实。',
      announceToAgent: '向 Agent 宣告记忆能力',
      announceToAgentHint: '在系统提示中加入一段记忆能力说明。',
      includeSubagents: '包含子代理',
      includeSubagentsHint: '允许被委派的子代理也使用自动记忆。',
      maintenanceTitle: '记忆维护',
      maintenanceHint: '从已存事实重建精简画像，并按周清理重复项、把本插件写入的记忆控制在预算内（其他应用的记忆不会被删除）。不会额外调用模型。',
      captureFilter: '保存过滤',
      captureFilterHint: '启发式会跳过问候、简短确认和纯命令回合。',
      captureFilterHeuristic: '启发式（推荐）',
      captureFilterOff: '保存每个已完成回合',
      profileEnabled: '生成精简用户画像',
      profileEnabledHint: '从记忆中提取短画像，并在相关记忆之前注入。',
      profileBudgetTokens: '画像预算（tokens）',
      profileBudgetTokensHint: '注入画像的上限，128–8000。',
      memoryBudgetTokens: '召回记忆预算（tokens）',
      memoryBudgetTokensHint: '每轮注入的召回记忆 token 上限，128–20000（中文约 1 字 1 token，英文约 4 字符 1 token）。',
      storeSafetyLimit: '安全上限（条）',
      storeSafetyLimitHint: '超过后巡检只提醒，不会因为条数多而删除记忆。默认 20000。',
      importanceWeight: '召回时的重要度权重',
      importanceWeightHint: '巡检评出的重要度对召回排序的影响，0–1（0 表示不用）。默认 0.2。',
      projectPartitions: '按项目分区',
      projectPartitionsHint: '开启：在项目里产生的记忆只存在这个项目，召回时读取当前项目、本会话和全局的记忆。关闭：新记忆一律写进全局，召回只读全局和本会话；已有的项目记忆原样保留，重新开启后照常能用。项目记忆不会自动进入全局。从下一轮开始生效。',
      projectRecallBoost: '召回时当前项目的权重',
      projectRecallBoostHint: '召回同时读取当前项目和全局的记忆，当前项目的分数乘以这个系数，1–2（1 表示不偏向）。默认 1.1。',
      modelHygiene: '模型巡检',
      modelHygieneHint: '巡检会调用你当前在 DSH 配置的模型，判断哪些记忆该合并、删除，并评出重要度；脚本负责去重，并逐条校验模型给出的动作。费用记在你在 DSH 配置的 provider 上，不计入 DSH 的用量统计；每次巡检报告都会显示用了多少 token。关闭后只做脚本巡检。',
      hygieneEnabled: '每周记忆卫生巡检',
      hygieneEnabledHint: '到期时在启动后运行，之后每小时检查。确认过一次手动巡检之前，自动巡检只出预览，不删除也不合并；预览期间会评重要度，只影响排序。',
      hygieneIntervalDays: '巡检间隔（天）',
      hygieneIntervalDaysHint: '默认 7 天，范围 1–90。',
      hygieneLastRun: '上次运行',
      hygieneNextRun: '下次运行',
      hygieneNever: '尚未运行',
      hygieneDue: '现在到期',
      hygieneProfile: '画像',
      hygieneRun: '立即巡检',
      hygieneRunning: '正在巡检…',
      hygieneOk: '巡检完成',
      hygieneFailed: '巡检失败',
      hygieneReport: '扫描 {scanned}，重复 {duplicates}，合并 {merged}，删除 {deleted}，失败 {failed}。',
      hygieneModelOk: '模型审阅：调用 {calls} 次，用了 {tokens} tokens。',
      hygieneModelOff: '模型巡检已关闭，只做了脚本巡检。',
      hygieneModelDegraded: '本次只做了脚本巡检：{reason}。',
      hygieneModelReason_NO_SERVICE: 'DSH 的模型服务不可用',
      hygieneModelReason_NO_MODEL: 'DSH 里没有选模型',
      hygieneModelReason_NO_ADAPTER: '所选的 provider 没有配置好',
      hygieneModelReason_MISSING_CREDENTIAL: 'provider 没有配置 API key',
      hygieneModelReason_AUTH: 'provider 拒绝了 API key',
      hygieneModelReason_INVALID_CREDENTIAL: 'provider 拒绝了 API key',
      hygieneModelReason_TRANSPORT: '连不上 provider',
      hygieneModelReason_TIMEOUT: '模型没有按时回答',
      hygieneModelReason_RATE_LIMIT: 'provider 限流',
      hygieneModelReason_QUOTA: 'provider 额度已用完',
      hygieneModelReason_ACCOUNT_QUOTA: 'provider 账户余额不足',
      hygieneModelReason_BAD_JSON: '模型没有按要求的格式回答',
      hygieneModelReason_UNKNOWN_MODEL: 'DSH 里选的模型不存在',
      hygieneModelReason_CONTEXT_WINDOW_EXCEEDED: '这组记忆超出了模型的上下文',
      hygieneModelReason_UNSUPPORTED_REASONING_EFFORT: '模型不接受这个推理强度',
      hygieneModelReason_MAX_TOKENS: '模型的回答被截断了',
      hygieneModelReason_LLM_FAILED: '模型调用失败',
      hygieneModelReasonOther: '模型调用失败（代码 {code}）',
      hygieneModelPartial: '在这之前已经回答的调用照常使用。',
      hygieneModelBad: '其中 {count} 次回答格式不对，已跳过。',
      hygieneModelSkipped: '{count} 次调用连续失败两次，在相关记忆有变动之前不再调用。',
      hygieneModelUnmetered: '部分调用没有返回 token 用量，总数不完整。',
      hygieneModelSuspicious: '{count} 次回答要删掉整组记忆，已整组丢弃。',
      hygieneModelDeferred: '还有 {count} 条删除留到下次（每次最多 20 条）。',
      hygienePending: '还有 {count} 条待巡检，下次巡检提前到一天后。',
      hygienePendingSlow: '还有 {count} 条待巡检。',
      hygieneMergesPending: '{count} 组合并已写入但还没确认，原记忆保留，下次巡检再处理。',
      hygieneScanLimited: '只扫描了前 {limit} 条（这个后端一次只列一页）；安全上限的提醒只在本地后端有效。',
      hygieneBusy: '巡检正在进行，请等它结束后再试。',
      hygieneModelStarting: '模型服务还在启动，请稍后再试。',
      hygieneOverLimit: '记忆超过 {limit} 条（安全上限）。不会因为条数多而删除，请在记忆列表里自行查看。',
      hygieneMergeDetails: '合并明细',
      hygieneImportanceDetails: '重要度',
      hygieneLastReport: '上次巡检报告',
      hygieneReasonSchedule: '定时',
      hygieneReasonStartup: '启动检查',
      hygieneReasonManual: '手动',
      hygieneDetails: '巡检详情',
      hygieneReportWindow: '运行时间',
      hygieneReportDuration: '耗时',
      hygieneReportStore: '存储记忆',
      hygieneReportStoreTokens: '存储 tokens',
      hygieneReportProfile: '记忆摘要',
      hygieneDuplicateDetails: '重复明细',
      hygienePrunedDetails: '预算清理明细',
      hygieneDeletedDetails: '删除明细',
      hygieneFailedDetails: '失败明细',
      hygieneNoDetails: '无',
      hygieneLegacyDetails: '该报告由旧版本生成，只有汇总数量。',
      hygienePreviewing: '正在检查…',
      hygieneConfirm: '巡检将永久删除 {planned} 条本插件写入的记忆（其中合并 {merges} 组：每组先写入一条合并后的记忆，再删除原来的几条）。其他应用写入的记忆和置顶的记忆不会被删除。删除后无法恢复，继续吗？',
      hygieneNothingToDelete: '没有需要删除的记忆。',
      hygieneCancelled: '已取消，未删除任何记忆。',
      hygienePreviewTag: '预览，未删除',
      hygienePlannedDetails: '将删除明细',
      hygieneForeign: '其他应用写入的 {foreign} 条记忆未被处理。',
      advanced: '高级选项',
      captureMaxChars: '单条保存长度上限',
      captureMaxCharsHint: '自动保存时每条消息截断的字符数，50–4000。',
      recallTopK: '召回条数',
      recallTopKHint: '每次自动召回返回的记忆数量，1–20。',
      timeoutMs: '请求超时（毫秒）',
      timeoutMsHint: '所有后端每次请求的超时（工具、列表、巡检），1–300000。写入记忆和自动召回另有单独的超时。',
      recallTimeoutMs: '召回超时（毫秒）',
      recallTimeoutMsHint: '自动召回超过这个时间就放弃，本轮不带记忆继续，100–60000。',
      captureTurnDedupThreshold: '本轮近重复阈值',
      captureTurnDedupThresholdHint: '本地后端：自动保存抽出的事实和同一轮 mem0_add 存下的记忆、或同一次保存里的其他事实，相似度（余弦，0.5–1）达到这个值就不存；只是把这类记忆换个说法、内容都已包含在内的（相似度不低于 0.75）也不存。更早的记忆只查完全相同的，所以更正不会丢。0 表示关闭（只去掉完全相同的，和 Mem0 一样）。默认 0.93。',
      embedderKeepAlive: 'Ollama keep_alive',
      embedderKeepAliveHint: '本地后端用 Ollama 时：Ollama 把 embedding 模型留在内存里多久，例如 30m、2h、-1（一直保留）。留空则用 Ollama 默认的 5m。默认 30m。',
      addTimeoutMs: '写入超时（毫秒）',
      addTimeoutMsHint: '保存记忆的超时，写入时可能要调用 LLM 抽取事实，1000–600000。',
      enabled: '启用 Mem0 记忆',
      enabledHint: '关闭整个插件但保留安装。',
      save: '保存设置',
      saving: '正在保存…',
      saved: '已保存，正在应用…',
      reset: '放弃修改',
      test: '测试连接',
      testing: '正在测试…',
      testOk: '连接成功',
      testFailed: '连接失败',
      unsaved: '有未保存的修改',
      unavailable: '插件当前未激活，无法编辑设置。',
      readOnly: '当前 profile 不接受配置写入。',
      saveFailed: '保存设置失败。',
      invalidNumber: '请输入有效的整数。',
      loadFailed: '读取插件设置失败。',
      backendSection: '记忆存储在哪里？',
      connectionSection: '连接信息',
      whatNext: '保存后即可在对话中使用记忆工具，或开启新对话体验自动召回。',
      activityTitle: '记忆活动',
      activityCapture: '自动保存',
      activityRecall: '自动召回',
      activityQueued: '排队中',
      activitySaving: '保存中',
      activitySaved: '已保存',
      activityNothingNew: '无新内容',
      activityExtracting: '后台抽取中',
      activitySkipped: '已跳过',
      activityStarting: '正在打开记忆存储',
      skipReason_low_value: '内容太短或不值得记（保存过滤）',
      skipReason_empty: '脱敏后没有可保存的内容',
      skipReason_queue_full: '保存队列已满（已有 3 条在等）',
      skipReason_budget: '本轮召回预算为 0（dsh-strata）',
      skipReason_circuit_open: '连续失败后暂停（熔断中）',
      circuitRemaining: '{time} 后恢复',
      circuitTrippedBy: '触发熔断的失败：{kind} · {component} · {message}（{at}）',
      captureFacts: '抽取 {facts} 条：新增 {add}，更新 {update}，已存在 {none}',
      captureFactsDeleted: '，删除 {delete}',
      captureFactsSimilar: '（其中 {similar} 条与本轮刚写入的记忆过于相近，没有再存）',
      captureMetaDropped: '回复里有 {count} 句是记忆确认或工具、截图说明，没有送去抽取',
      recallTimings: '各步耗时：{steps}',
      recallTimingsTotal: '共 {total} ms',
      timingStep_openMs: '打开存储',
      timingStep_credentialMs: '凭据查询',
      timingStep_embedMs: 'embedding',
      timingStep_searchMs: 'SQLite 检索和打分',
      timingStep_injectMs: '生成注入块',
      timingStep_otherMs: '其他',
      recallSlowEmbed: '大部分时间花在 embedding 模型上。本地模型可能已被卸载，见 README 的「召回慢」。',
      captureNoFacts: '没有抽取到新内容（不值得记，或已经记过）',
      captureEvents: '新增 {add}，更新 {update}，删除 {delete}',
      retryPending: '未送达，正在重试一次',
      retryPendingExtraction: 'LLM 回复不可用（{reason}），正在重试一次',
      retryPendingBudget: 'LLM 回复达到输出上限被截断，正在以 max_tokens {tokens} 重试一次',
      extractStatsOutput: '输出 {completion}/{max} token',
      extractStatsReasoning: '其中思考 {reasoning}',
      retrySaved: '重试后已保存',
      retryFailed: '重试仍失败',
      dockCircuitOpen: '记忆已暂停',
      dockCaptureSkippedShort: '保存已跳过（内容太短）',
      sidecarExitCode: '退出码 {code}',
      sidecarExitSignal: '信号 {signal}',
      storeTitle: '本地记忆存储',
      storeFile: '文件：{path}',
      storeOpen: '已打开',
      storeClosed: '尚未打开（下次读写记忆时打开）',
      storeLastFailure: '最近一次打开失败（{at}，{code}）：{reason}',
      storeConfigErrorNoRetry: '这是配置错误：设置或 oss.json 改动之前不会再重试。',
      storeConfigHint: 'embedding 模型和 LLM：~/.dsh/mem0/oss.json 的 "dsh_mem0" 段。',
      failureExit: '进程退出（{how}），运行了 {uptime}',
      failureRetryFailed: '重试仍失败',
      activitySearching: '召回中',
      activityOk: '已召回',
      activityError: '失败',
      activityNever: '未发生',
      activityMessages: '条消息',
      activityWritten: '条写入',
      activityReturned: '条返回',
      activityEvent: '事件',
      activityEmpty: '还没有自动记忆活动。完成一轮对话后，这里会显示自动保存和自动召回的结果。',
      activityScopeHint: '“记忆活动”只统计本插件进程内发生的自动保存和召回；下面的“最近写入的记忆”直接读取后端实际存储。',
      dockIdle: 'Mem0 待命',
      dockDisabled: 'Mem0 已关闭',
      dockCaptureSaving: '保存记忆中',
      dockCaptureQueued: '记忆排队中',
      dockCaptureExtracting: '后台抽取中',
      dockCaptureSaved: '已保存记忆',
      dockCaptureNothingNew: '无新内容可记',
      dockCaptureSkipped: '保存已跳过',
      dockRecallSearching: '召回记忆中',
      dockRecallOk: '已召回记忆',
      dockError: '记忆失败',
      dockStatusUnavailable: '状态读取失败',
      dockStatusUnavailableDetail: '无法从 DSH 读取 Mem0 插件状态。这不是记忆操作失败，而是插件或 DSH 没有响应。',
      dockLatestFailure: '最近一次记忆失败',
      dockNoFailureDetail: '没有记录到失败详情。',
      failuresTitle: '最近失败',
      failuresHint: '最近 20 次失败，最新的在前。重启后仍保留，之后的成功不会清掉它们。',
      failuresEmpty: '没有记忆失败记录。',
      failureKind_capture: '自动保存',
      failureKind_recall: '自动召回',
      failureKind_summary: '记忆摘要',
      failureKind_maintenance: '记忆整理',
      failureCause_timeout: '超时',
      failureCause_connection: '连接失败',
      failureCause_auth: '认证或额度',
      failureCause_circuit: '熔断跳过',
      failureCause_extraction: 'LLM 抽取失败',
      extractReason_not_json: '回复不是 JSON',
      extractReason_empty: '回复为空',
      extractReason_truncated: '回复被截断（JSON 不完整）',
      extractReason_refusal: '模型拒答',
      failureCause_other: '其他错误',
      failureCause_startup: '本地后端启动失败',
      failureCause_config: '配置错误',
      failureHintUnreachable: '{component}不可达：{endpoint}。请确认服务在运行；Windows 上端口落在系统保留段时服务会绑定失败（服务日志里有 os error 10013），见 README「Windows 排障」。',
      configWarning: 'dsh-mem0 配置疑似被重写（DSH 设置同步），缺少：{fields}',
      upgradeLegacyQdrant: '旧记忆仍在 Qdrant（{endpoint}，collection {collection}）。这个版本把记忆存在 SQLite，不读取它们；请用本地配置向导的最后一步迁移。',
      upgradeNoLocalConfig: '在 ~/.dsh/mem0/oss.json 里没有找到本地后端配置。旧版本会从其他位置回退读取配置，这个版本不会，请用设置向导重新配置。',
      wzOpen: "本地配置向导",
      wzTitle: "本地配置向导",
      wzIntro: "依次配置 embedding 模型、抽取 LLM 和记忆文件。自测通过之前不会保存任何内容。",
      wzClose: "关闭",
      wzDone: "完成",
      wzNext: "下一步",
      wzBack: "上一步",
      wzStepEmbedder: "Embedding 模型",
      wzStepLlm: "抽取 LLM",
      wzStepStore: "记忆文件",
      wzStepSelfTest: "自测并保存",
      wzStepMigrate: "从旧版迁移记忆",
      wzCloud: "云端 API（推荐）",
      wzLocal: "本地模型",
      wzCloudHint: "任何 OpenAI 兼容的 /embeddings 接口。key 只存进 DSH 凭据库，不写进 oss.json。",
      wzLocalHint: "本机运行的模型（Ollama 或 LM Studio），数据不出本机。",
      wzLocalHintMac: "本机运行的模型（Ollama、LM Studio 或 oMLX），数据不出本机。",
      wzPreset: "推荐服务",
      wzPresetCustom: "其他（在下面填写）",
      wzProvider: "服务类型",
      wzOpenAiCompatible: "OpenAI 兼容（LM Studio、oMLX、vLLM 等）",
      wzBaseUrl: "地址",
      wzModel: "模型",
      wzModelTyped: "模型名",
      wzKey: "API key",
      wzKeyHint: "存进 DSH 凭据库（名称见下一项），不写进 oss.json。",
      wzKeyNewServer: "服务地址变了：请填写这个服务的 key。已存的 key 只会发给保存时的那个服务。",
      wzKeyStored: "DSH 凭据库里已有 {ref}。留空即沿用。",
      wzKeyRef: "凭据名",
      wzLiteral: "oss.json 里有这个服务的明文 key：保存时存进 DSH 凭据库，并从 oss.json 删除",
      wzBackupHasKeys: "备份文件 {backup} 里仍有明文 key，确认一切正常后可以删除。",
      wzRefExists: "DSH 凭据库里的 {ref} 已经存了另一个 key。",
      wzRefReplace: "替换 {ref}",
      wzDetect: "探测本地服务",
      wzDetecting: "探测中…",
      wzServiceUp: "{label}（端口 {port}）：运行中，{count} 个模型",
      wzServiceDown: "{label}（端口 {port}）：{error}",
      wzUse: "使用",
      wzRecommended: "推荐的本地模型",
      wzModelDims: "{model}（{dims} 维）",
      wzModelDimsBest: "{model}（{dims} 维，中英文都推荐）",
      wzReserved: "Windows：端口落在系统保留段（Hyper-V、WSL、Docker 占用）时，服务无法监听，会报 os error 10013。在 PowerShell 里查看保留段，再换一个段外的端口（例如 15000 以上）：",
      wzTest: "测试",
      wzTesting: "测试中…",
      wzListModels: "列出模型",
      wzCheck: "检查",
      wzEmbedOk: "可用：{dims} 维。",
      wzDimsDiffer: "服务返回 {actual} 维，不是 {expected} 维。",
      wzStoreMismatch: "记忆文件里有 {memories} 条记忆，向量来自 {model}（{dims} 维）。可以换回那个模型；或者继续用现在这个，保存时会重新计算这些向量。",
      wzReembedOnSave: "保存时会先重新计算 {memories} 条记忆的向量（正文不变，每 32 条调用一次 embedding）。在这之前一切照常运行；自测用的是临时文件。",
      wzReembedDone: "已重新计算 {count} 条向量。",
      wzProgress: "处理中… {done}/{total}",
      wzCancel: '取消',
      wzErr_CANCELLED: '已取消，没有做任何改动',
      wzFailed: "失败：{error}",
      wzAuthFailed: "服务拒绝了这个 key（HTTP 401/403）。",
      wzFail_authOmlx: "oMLX 开启了 API key 验证（HTTP {status}）。你可以：① 把 {file} 里 auth.api_key 的值填到下面的 API key 栏，或者点「从 oMLX 读取 key」；② 或者停掉 oMLX，把这个文件里的 auth.skip_api_key_verification 改成 true，再重启（只在 oMLX 只监听本机时有效）。",
      wzFail_authKeyOmlx: "oMLX 拒绝了这个 API key（HTTP {status}）。请核对它和 {file} 里 auth.api_key 的值是否一致（oMLX 用 --api-key 或 OMLX_API_KEY 启动时，以启动时给的 key 为准）；或者停掉 oMLX，把 auth.skip_api_key_verification 改成 true，再重启。",
      wzFail_authLmStudio: "LM Studio 开启了 Require Authentication（HTTP {status}）。你可以：① 在 LM Studio 的 Developer → Server Settings 里新建一个 API token，填到下面的 API key 栏；② 或者在同一处关掉 Require Authentication。",
      wzFail_authKeyLmStudio: "LM Studio 拒绝了这个 API token（HTTP {status}）。token 只在创建时显示一次：请在 LM Studio 的 Developer → Server Settings 里新建一个，填到下面的 API key 栏。",
      wzFail_authOllama: "Ollama 本身不需要 API key，这个 HTTP {status} 来自它前面的反向代理或其他程序。请把那一层要求的 key 填到下面的 API key 栏，或者直接连 Ollama 自己的端口。",
      wzFail_authAny: "服务需要 API key（HTTP {status}）。请填到下面的 API key 栏。",
      wzFail_authKeyAny: "服务拒绝了这个 API key（HTTP {status}）。请核对 key 和凭据名。",
      wzOmlxRead: "从 oMLX 读取 key",
      wzOmlxReveal: "在 Finder 中显示配置文件",
      wzOmlxRevealOther: "显示配置文件位置",
      wzOmlxReadOk: "已从 {file} 读取 key（不显示），只在这次设置里使用；保存时存进 DSH 凭据库。",
      wzOmlxRead_missing_file: "没有找到 {file}。如果改过 oMLX 的 Base Path（或者设了 OMLX_BASE_PATH），配置文件在别处。请手动把 auth.api_key 的值填到下面的 API key 栏。",
      wzOmlxRead_no_permission: "没有权限读取 {file}。请手动把其中 auth.api_key 的值填到下面的 API key 栏。",
      wzOmlxRead_bad_json: "{file} 不是有效的 JSON，读不出 key。请手动把 auth.api_key 的值填到下面的 API key 栏。",
      wzOmlxRead_no_field: "{file} 里没有 auth.api_key。oMLX 可能是用 --api-key 或 OMLX_API_KEY 启动的，请手动把那个 key 填到下面的 API key 栏。",
      wzOmlxRead_read_error: "读取 {file} 失败（{code}）。请手动把 auth.api_key 的值填到下面的 API key 栏。",
      wzOmlxRead_not_omlx: "只有 oMLX 的地址（本机 8000 端口）才能读取它的 key。",
      wzOmlxRevealed: "已在 Finder 中显示 {file}。",
      wzOmlxFileAt: "配置文件位置：{file}",
      wzOmlxReveal_missing_file: "没有找到 {file}。",
      wzFail_notFoundSuggest: "地址路径不对（HTTP 404）。OpenAI 兼容的地址通常以 /v1 结尾，比如 {example}。",
      wzFail_notFound: "{service} 返回 HTTP 404{detail}。请核对地址路径和模型名：OpenAI 兼容的地址通常以 /v1 结尾，比如 {example}。",
      wzFail_notFoundAny: "服务返回 HTTP 404{detail}。请核对地址路径和模型名：OpenAI 兼容的地址通常以 /v1 结尾，比如 {example}。",
      wzFail_notFoundOllama: "Ollama 返回 HTTP 404{detail}。请核对模型名（先用 ollama pull 下载）；Ollama 的地址不带路径，比如 http://127.0.0.1:11434。",
      wzFail_refused: "{endpoint} 端口上没有服务在跑（连接被拒）。先启动 {service}，再试一次。",
      wzFail_refusedAny: "{endpoint} 端口上没有服务在跑（连接被拒）。先启动 {starters}，再试一次。",
      wzFail_refusedRemote: "连不上 {endpoint}（连接被拒）。请检查地址和端口。",
      wzFail_timeout: "{service}（{endpoint}）没有在 {seconds} 秒内回应：端口上可能没有服务在跑，或者还在加载模型。确认 {service} 已启动，再试一次。",
      wzFail_timeoutAny: "{endpoint} 没有在 {seconds} 秒内回应：端口上可能没有服务在跑，或者还在加载模型。先启动 {starters}，再试一次。",
      wzFail_timeoutRemote: "{endpoint} 没有在 {seconds} 秒内回应。请检查网络和地址，稍后再试。",
      wzFail_http: "{service} 返回 HTTP {status}{detail}。",
      wzFail_httpAny: "服务返回 HTTP {status}{detail}。",
      wzFail_network: "连不上 {endpoint}{detail}。请检查地址和网络。",
      wzFail_badResponse: "{endpoint} 的回答格式不对{detail}。请确认地址是 OpenAI 兼容（或 Ollama）接口，模型名也正确。",
      wzFail_badUrl: "地址要以 http:// 或 https:// 开头。",
      wzFailDetail: "：{detail}",
      wzStarters: "Ollama 或 LM Studio",
      wzStartersMac: "oMLX、Ollama 或 LM Studio",
      wzUseSuggested: "改成 {url}",
      wzProbeRefused: "没有运行。要用它，先启动 {label}。",
      wzProbeTimeout: "没有回应：端口上可能没有服务，或者 {label} 卡住了。重启 {label} 后再探测一次。",
      wzLocalKeyHint: "可选：本地服务开启了 API key 验证时才需要填。key 存进 DSH 凭据库，不写进 oss.json。",
      wzLlmHint: "用来从对话里抽取事实的 OpenAI 兼容聊天接口。测试时发送一段固定的示例对话，不发送你的数据。",
      wzLlmViaDsh: "使用 DSH 当前配置的模型",
      wzLlmViaManual: "自己填写模型",
      wzLlmDshHint: "抽取使用 DSH 里当前选中的模型；在 DSH 里换了模型，这里也跟着换。这个模型的地址和 key 由 DSH 保管，这里不保存任何相关信息。测试时发送一段固定的示例对话，不发送你的数据。",
      wzLlmDshNow: "当前模型：{model}",
      wzLlmDshNone: "DSH 里还没有选中模型。请先在 DSH 里选一个模型，再测试。",
      wzLlmDshNoService: "DSH 的模型服务还没就绪。请等几秒；如果一直这样，重启 DSH。",
      wzLlmDshBilling: "费用：每记住一轮对话，会额外调用一次这个模型，发送的是这轮对话和相似的已有记忆（先去掉密钥等敏感内容）。费用记在你在 DSH 配置的 provider 上，不计入 DSH 的用量统计；mem0_status 会显示最近一次抽取用了多少 token。",
      wzLlmDshUsed: "模型 {model}",
      wzLlmDshModelAny: "DSH 的模型",
      wzAdviceOtherModel: "模型没有返回 JSON。请在 DSH 里换一个模型，或者改成自己填写模型。",
      wzCheckModel: "抽取模型 {model} 能正常回答",
      wzFailDsh_NO_SERVICE: "DSH 的模型服务还没就绪。请等几秒再测；如果一直这样，重启 DSH。",
      wzFailDsh_NO_MODEL: "DSH 里还没有选中模型。请在 DSH 里选一个模型，再测试。",
      wzFailDsh_NO_ADAPTER: "DSH 没有加载 {model} 的 provider。请检查 DSH 的模型设置，或者换一个模型。",
      wzFailDsh_MISSING_CREDENTIAL: "{model} 在 DSH 里没有填 API key。请在 DSH 的模型设置里填上，再测试。",
      wzFailDsh_INVALID_CREDENTIAL: "{model} 在 DSH 里的 API key 格式不对。请在 DSH 的模型设置里改正，再测试。",
      wzFailDsh_AUTH: "{model} 拒绝了 DSH 发送的 API key。请在 DSH 的模型设置里更新 key，再测试。",
      wzFailDsh_RATE_LIMIT: "{model} 现在被限流了。请稍等一会儿再测。",
      wzFailDsh_QUOTA: "{model} 的额度用完了。请到它的服务商那里充值，或者在 DSH 里换一个模型。",
      wzFailDsh_ACCOUNT_QUOTA: "{model} 的账户余额不足。请充值，或者在 DSH 里换一个模型。",
      wzFailDsh_CONTEXT_WINDOW_EXCEEDED: "抽取用的提示词超出了 {model} 的上下文长度。请在 DSH 里换一个上下文更长的模型。",
      wzFailDsh_TIMEOUT: "{model} 没有及时回答。请再测一次，或者在 DSH 里换一个更快的模型。",
      wzFailDsh_other: "{model} 调用失败（{code}）。请检查 DSH 里的这个模型，再测试。",
      statusLlmDsh: "抽取跟随 DSH 当前模型：{model}",
      statusLlmDshLabel: "抽取 LLM · 跟随 DSH",
      statusLlmDshNone: "DSH 里没有选中模型",
      wzHygieneBilling: '记忆巡检是另一回事：默认调用你当前在 DSH 配置的模型（不是这里填的模型），费用记在你在 DSH 配置的 provider 上，不计入 DSH 的用量统计。每次巡检报告都会显示用了多少 token；在设置里关掉「模型巡检」后只做脚本巡检。',
      wzMaxTokens: "输出上限（max_tokens）",
      wzEffort: "reasoning_effort（可选）",
      wzEffortHint: "推理模型可填 \"low\"，网关支持的话填 \"none\"；其他模型留空。",
      wzLlmOk: "可用：抽出 {facts} 条事实（{stats}）。",
      wzLlmBad: "回复无法使用（{reason}；{stats}）。",
      wzAdviceRaise: "回复用完了输出上限。建议 max_tokens 至少 8000，或调低 reasoning_effort。",
      wzAdviceEffort: "这是推理模型，思考过程也计入 max_tokens。建议 max_tokens 不低于 8000，或把 reasoning_effort 设成 \"low\"（支持的话设 \"none\"）。",
      wzAdviceJson: "模型没有返回 JSON，请换一个支持 JSON 输出的模型。",
      wzLlmPassed: "测试通过",
      wzLlmFailed: "测试失败",
      wzLlmUntestedBadge: "还没测试",
      wzLlmFacts: "从示例对话里抽出 {facts} 条事实",
      wzLlmFinish: "finish_reason：{reason}",
      wzLlmOutput: "输出 {used} / {max} tokens",
      wzLlmReasoning: "（其中推理 {tokens}）",
      wzLlmPrompt: "提示 {tokens} tokens",
      wzLlmTime: "{ms} ms",
      wzLlmReason: "原因：{reason}",
      wzLlmSuggest: "建议：{advice}",
      wzLlmKeep: "这个结果会一直显示，直到你改了这一步的设置。",
      wzReason_truncated: "回复在 JSON 结束前被截断",
      wzReason_not_json: "回复不是 JSON",
      wzReason_empty: "回复是空的",
      wzReason_refusal: "模型拒绝了这个任务",
      wzAdviceEmpty: "模型什么也没返回。请确认模型名是对话模型；如果是推理模型，调高 max_tokens。",
      wzAdviceRefusal: "模型拒绝抽取事实，请换一个模型，通用对话模型最合适。",
      wzAdviceAuth: "请检查这个服务的 API key（或凭据名）。",
      wzAdviceNetwork: "请检查地址和端口，并确认服务正在运行。",
      wzAdviceTimeout: "服务没有及时回复。请再试一次，或者换一个更快的模型。",
      wzAdviceNotFound: "请检查模型名，并确认地址带上了 API 路径（通常是 /v1）。",
      wzAdviceGeneric: "请检查地址、模型和 key，然后再测一次。",
      wzLlmUntested: "LLM 测试还没有通过。没有可用的 LLM，自动保存什么也存不下。请先点「测试」，或者点「仍然下一步」。",
      wzNextAnyway: "仍然下一步",
      wzStorePath: "记忆数据库文件",
      wzStoreHint: "留空即 ~/.dsh/mem0/memory.sqlite。必须在本机磁盘上，不能放在网络盘或同步目录（iCloud、OneDrive、Dropbox 等）。",
      wzStoreWhere: "记忆保存在 {path}。",
      wzStoreChange: "更改位置（高级）",
      wzStoreUnverified: "{path}：无法确认所在磁盘的类型（{reason}）。",
      wzStoreConfirm: "这是本机的磁盘，不是网络共享",
      wzStoreOk: "{path}：可写，在本机磁盘上。",
      wzStoreExternal: "{path}：可写，但在另一个卷上。DSH 运行时请保持它连接。",
      wzStoreSync: "{path} 在 {provider} 同步目录里。同步目录会损坏 SQLite 文件，请换到本机目录。",
      wzStoreNetwork: "{path} 在网络盘上。SQLite 需要本机磁盘，请换到本机目录。",
      wzStoreNotWritable: "{path}：{error}",
      wzStoreHas: "记忆文件里已有 {count} 条记忆。",
      wzSelfTestHint: "用测试用户 {user} 写入一条探针记忆，检索到它，再删掉，最后核对没有残留。你自己的记忆不会被动到。自测通过才能保存。",
      wzRunSelfTest: "运行自测",
      wzCheckWrite: "写入",
      wzCheckSearch: "检索",
      wzCheckDelete: "删除",
      wzCheckLeftover: "无残留",
      wzCheckCredentials: "凭据",
      wzSelfTestOk: "自测通过。",
      wzMismatchGoBack: "请回到第 1 步重新计算向量，或换回原来的模型。",
      wzSaveEnable: "保存并启用",
      wzSaving: "保存中…",
      wzSaved: "已写入 {path}{backup}。存进 DSH 凭据库的 key：{refs}。",
      wzBackup: "（原文件备份为 {backup}）",
      wzNone: "无",
      wzShadowed: "这些设置在 DSH profile 里另有值，会覆盖向导的设置：{fields}。",
      wzCredNoService: "key 没能存进凭据库：当前 DSH 没有插件可写的凭据库。请在 DSH 的凭据设置里自己添加 {ref}，再保存一次。",
      wzMigrateIntro: "旧版本把记忆存在 Qdrant。这一步把用户 {user} 在 collection {collection} 里的记忆一次性复制到记忆文件。Qdrant 只读不写：里面的数据不改、不删，也不做备份；其他 collection 一概不读。",
      wzQdrantUrl: "Qdrant 地址",
      wzQdrantHint: "默认 127.0.0.1:6333；Windows 上常见的是 127.0.0.1:15333。",
      wzCollection: "Collection",
      wzPreflight: "检查 Qdrant",
      wzPreflightOk: "找到 {user} 的 {points} 条记忆（{dims} 维）。",
      wzCopyVectors: "直接拷贝向量（模型同为 {model}，{dims} 维）",
      wzRecompute: "向量会用 {model} 重新计算：旧向量来自别的模型或维度。",
      wzMigrate: "开始迁移",
      wzMigrating: "迁移中… {phase} {done}/{total}",
      wzPhaseRead: "读取",
      wzPhaseEmbed: "计算向量",
      wzMigrated: "已迁移 {imported} 条记忆（{vectors}；已存在而跳过 {skipped} 条，无正文 {empty} 条）。旧数据仍在 Qdrant，不再使用，可以自行删除或停掉 Qdrant 服务。",
      wzForeign: "有 {count} 个点的用户 id 存成了别的形式（比如数字），没有迁移。",
      wzMigrateAgain: "再迁移一次（第一次迁移后删掉的记忆会回来）",
      wzLegacyPossible: "如果以前用过本地模式，记忆可能还在 Qdrant（{endpoint}）里，可以在第 5 步迁移。",
      wzRefusedSummary: "没有运行：{list}。如果其中某个其实在运行，它的端口可能落在 Windows 保留的范围里：",
      wzVectorsCopied: "向量直接拷贝",
      wzVectorsRecomputed: "向量重新计算",
      wzMigrateFailed: "迁移在「{step}」这一步失败：{error}。没有写入任何内容，记忆文件保持原样。",
      wzQdrantDown: "请按之前的方式重新启动 Qdrant（比如 docker start 或 qdrant 命令），再检查一次。",
      wzQdrantDownWin: "请按之前的方式重新启动 Qdrant（见 README 的「Windows 排障」），再检查一次。",
      wzStepName_preflight: "检查",
      wzStepName_read: "读取 Qdrant",
      wzStepName_map: "整理记忆",
      wzStepName_embed: "计算向量",
      wzStepName_write: "写入",
      wzStepName_verify: "核对",
      wzStepName_switch: "切换",
      wzStepName_merge: "合并",
      wzStepName_embedder: "embedding 模型",
      wzStepName_store: "记忆文件",
      wzStepName_credentials: "凭据",
      wzStepName_reembed: "重新计算向量",
      wzErr_LOCAL_BACKEND_OFF: "请先完成设置：保存并启用本地后端。",
      wzErr_ALREADY_MIGRATED: "这个记忆文件已经从 Qdrant 迁移过一次。",
      wzErr_FORBIDDEN_COLLECTION: "这个 collection 属于别的应用，不会读取。",
      wzErr_COLLECTION_NOT_ALLOWED: "只读取这套配置用的 collection。",
      wzErr_COLLECTION_NOT_FOUND: "Qdrant 里没有这个 collection。",
      wzErr_QDRANT_UNREACHABLE: "这个地址连不上 Qdrant。",
      wzErr_QDRANT_AUTH: "Qdrant 拒绝了请求（API key）。",
      wzErr_QDRANT_EMBEDDED_UNSUPPORTED: "oss.json 里配的是嵌入式 Qdrant 目录，迁移需要 Qdrant 服务。",
      wzErr_VERIFY_FAILED: "复制后的核对没有通过。",
      wzErr_EMBEDDER_MISMATCH: "记忆文件里的向量来自另一个 embedding 模型。",
      wzErr_BAD_VECTOR: "Qdrant 里有记忆的向量维度不对。",
      wzErr_CONFIG_INVALID: "有一项设置无效。",
      wzErr_REF_NOT_ALLOWED: "向导只使用自己的凭据名，或者当前配置正在用的那个。",
      wzErr_EMBEDDER_FAILED: "embedding 模型没有响应。",
      wzErr_REEMBED_CONFLICT: "重新计算向量期间记忆一直在变，请在 DSH 空闲时再试。",
      wzErr_STORE_REFUSED: "记忆文件不能放在这里。",
      wzSkip: "跳过，从空库开始",
      wzSkipHint: "跳过的话旧记忆留在 Qdrant，召回从空库开始。以后仍可以在这个向导里迁移。",
      wzSkipped: "已跳过迁移。",
      wzAlreadyMigrated: "已于 {at} 从 {endpoint} 迁移 {imported} 条记忆。",
      wzNeedEnable: "请先保存并启用本地后端（第 4 步）。",
      wzSwitchMissing: "本地后端还没配置好（缺少：{missing}）。",
      wzSwitchOpen: "打开向导",
      wzSwitchAnyway: "仍然切换",
      wzMissingEmbedder: "embedding 模型",
      wzMissingLlm: "抽取 LLM",
      upgradeQdrantMigrated: "旧数据仍在 Qdrant，不再使用，可以自行删除或停掉 Qdrant 服务。",
      configWarningFix: '在上方补回并保存，或写进 oss.json 的 "dsh_mem0" 段（DSH 不会重写它）。如果是有意删除，删掉 failures.json 旁边的 config-fingerprint.json。',
      failureRepeated: '自 {since} 起共 {count} 次',
      failureComponent_llm: 'LLM',
      failureComponent_embedder: '向量模型',
      failureComponent_vector_store: '向量库',
      failureComponent_sidecar: 'Python sidecar（旧版本）',
      failureComponent_mem0_api: 'Mem0 API',
      failureComponent_unknown: '未知组件',
      failureStep_embed: '向量化',
      failureStep_search: '向量检索',
      failureStep_llm_extract: '事实抽取',
      failureStep_store: '写入',
      failureStepRunning: '{step}已运行 {ms} ms 仍未完成',
      dockOpen: '打开 Mem0 设置',
      scopeChipProject: '项目',
      scopeChipGlobal: '全局',
      scopeChipAria: 'Mem0 记忆分区：{where}',
      scopeChipAriaProject: '项目 {name}',
      scopeChipAriaGlobal: '全局',
      scopePopTitle: 'Mem0 记忆分区',
      scopePopProject: '项目：{name}',
      scopePopGlobal: '全局（所有项目共用）',
      scopePopBasis: '判定依据：{basis}',
      scopeBasis_gitOrigin: 'git 仓库（按远程 origin 识别）',
      scopeBasis_gitRoot: 'git 仓库根目录（没有远程 origin）',
      scopeBasis_folder: '文件夹（不在 git 仓库里）',
      scopeBasis_defaultWorkspace: 'DSH 默认工作区，所以算全局',
      scopeBasis_home: '主目录（不在 git 仓库里），所以算全局',
      scopeBasis_none: '没有工作目录，所以算全局',
      scopeBasis_off: '「按项目分区」已关闭，所以算全局',
      scopeBasis_pending: '还没识别（DSH 会在下一轮报告这个对话），在那之前算全局',
      scopePopWorktree: 'git worktree：和主仓库共用分区',
      scopePopCheckout: 'worktree 目录：{path}',
      scopePopPath: '路径：{path}',
      scopePopCwd: '当前工作目录：{path}',
      scopePopPartition: '分区 id：{id}',
      scopePopWhenOn: '开启后：项目 {name}',
      scopePopGitError: 'git 没有响应（{error}），按普通文件夹处理',
      scopeChipPendingHint: '「按项目分区」已开启。这个对话的项目会在下一轮识别出来，在那之前新记忆写进全局。点击关闭这个开关。从下一轮开始生效；Mem0 设置里是同一个开关。',
      dshDefaultWorkspace: 'DSH 默认工作区',
      scopeChipOnHint: '「按项目分区」已开启：这个对话产生的新记忆只存在它所在的项目，召回时读取这个项目、本会话和全局的记忆。点击关闭（关闭后新记忆写进全局）。从下一轮开始生效；Mem0 设置里是同一个开关。',
      scopeChipOnNoProjectHint: '「按项目分区」已开启，但这个对话不在项目文件夹里，新记忆写进全局。点击关闭这个开关。从下一轮开始生效；Mem0 设置里是同一个开关。',
      scopeChipOffHint: '「按项目分区」已关闭：新记忆一律写进全局，召回只读全局和本会话。已有的项目记忆保留，重新开启后照常能用。点击开启。从下一轮开始生效；Mem0 设置里是同一个开关。',
      scopeChipSaveFailed: '没能切换开关，请到 Mem0 设置里修改。',

      activityAsyncHint: 'Platform 的事实抽取在后台进行；显示“后台抽取中”时，稍等几秒再刷新最近记忆。',
      recentTitle: '最近写入的记忆',
      recentEmpty: '还没有记忆。完成的回合会自动保存到这里。',
      recentError: '读取最近记忆失败',
      memoryBrowserTitle: '记忆库',
      memoryBrowserHint: '搜索并浏览当前用户存储的全部记忆，列表直接读取配置的后端。',
      memoryBrowserOpen: '查看全部记忆',
      memoryBrowserClose: '收起记忆库',
      memorySearchPlaceholder: '搜索记忆内容或 ID…',
      memorySearch: '搜索',
      memoryLoading: '正在读取记忆…',
      memoryEmpty: '没有匹配的记忆。',
      memoryCount: '共 {count} 条记忆',
      memoryCountFiltered: '显示 {shown} / 共 {total} 条',
      memoryBrowserError: '读取记忆失败',
      memoryDelete: '删除',
      memoryPin: '置顶',
      memoryUnpin: '取消置顶',
      memoryPinnedTag: '已置顶',
      memoryImportance: '重要度 {level}',
      memoryPinError: '置顶操作失败',
      memoryMakeGlobal: '改为全局',
      memoryMakeGlobalError: '移动记忆失败',
      memoryMakeGlobalNotProject: '只有项目记忆可以改为全局',
      memoryMakeGlobalNotOwn: '只能移动本插件写入的记忆',
      memoryMakeGlobalNotFound: '这条记忆已经不存在',
      memoryMakeGlobalOtherUser: '这条记忆属于另一个 Mem0 用户',
      tokUnit: 'token',
      sessionAt: '会话 · {time}',
      memorySource: '来源 {source}',
      memoryTreeTitle: '记忆页',
      memoryTreeHint: '按适用范围浏览记忆：全局（处处适用）、项目（一个仓库或文件夹）或会话。可以搜索、置顶和删除，这里不能编辑记忆。',
      treeAll: '全部',
      treeProjects: '项目',
      treeSessions: '不属于项目的会话',
      scopeGlobal: '全局',
      scopeProject: '项目 {name}',
      scopeSession: '会话 {id}',
      reportDeleted: '已删除',
      reportPending: '合并待完成',
      projectSummaries: '项目摘要：{list}',
      projectSummaryStale: '重建中',
      memoryDeleting: '正在删除…',
      memoryDeleteConfirm: '永久删除这条记忆吗？删除后无法恢复。\n\nID：{id}\n\n{memory}',
      memoryDeleted: '已删除',
      memoryDeleteError: '删除记忆失败',
      memoryDeleteReason_foreign_source: '这条记忆由其他应用写入，这里只能删除 DSH-Mem0 写入的记忆',
      memoryDeleteReason_other_user: '这条记忆属于另一个 Mem0 用户',
      memoryDeleteReason_not_found: '这条记忆已不存在',
      memoryDeleteReason_unproven_owner: '后端没有确认这条记忆属于当前配置的 Mem0 用户',
      profileSourcesChanged: '生成这份摘要的记忆中有被删除或修改的，摘要可能含已删除或过时的内容，请编辑或重置。',
      profileStale: '生成这份摘要的记忆中有被删除或修改的，摘要重建前不会注入。',
      recallPreviewTitle: '上次召回的记忆',
      profileSummaryTitle: '记忆摘要',
      profileSummaryHint: '可编辑的全局记忆摘要，召回时和当前项目的摘要一起注入。巡检时由模型重写记忆有变化的摘要；删改记忆后，相关摘要会先停用，等待重建。',
      profileSummaryEmpty: '尚未生成记忆摘要；下次维护后会自动生成。',
      profileSummaryDisabled: '记忆摘要已关闭。',
      profileSummaryItems: '条',
      profileSummaryUpdated: '更新于',
      profileEditHint: '编辑记忆摘要并保存，下一轮对话即可使用；支持 Markdown 标题和列表。',
      profileEdit: '编辑摘要',
      profileCancel: '取消',
      profileSave: '保存记忆摘要',
      profileSaving: '正在保存…',
      profileSaved: '已保存',
      profileReset: '从记忆重建',
      profileResetHint: '丢弃手动编辑，按已存记忆重新生成。',
      profileManual: '手动编辑',
      profileGenerated: '自动生成',
      profileTooLong: '记忆摘要内容超出预算。',
      recallPreviewEmpty: '上次召回没有返回可展示的记忆内容。',
      memoryScore: '相关度',
      refresh: '刷新',
      memoryId: 'ID',
    }

    const CSS = `
      .mem0-page{display:flex;flex-direction:column;gap:14px;max-width:820px;padding:2px 0 18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
      .mem0-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .mem0-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .mem0-title{font-size:16px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
      .mem0-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}
      .mem0-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
      .mem0-status{display:flex;flex-direction:column;gap:10px}
      .mem0-status-main{display:flex;align-items:center;gap:8px;min-width:0}
      .mem0-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
      .mem0-dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-success-tertiary)}
      .mem0-dot.error{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-warn-tertiary)}
      .mem0-status-label{font-weight:600}
      .mem0-status-detail{color:var(--dsw-alias-label-tertiary);font-size:12px}
      .mem0-status-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 14px}
      .mem0-stat{display:flex;flex-direction:column;gap:1px;min-width:0}
      .mem0-stat-label{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
      .mem0-stat-value{font-size:12px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mem0-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:2px 8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;white-space:nowrap}
      .mem0-chip b{font-weight:600;color:var(--dsw-alias-label-primary)}
      .mem0-chip-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
      .mem0-chip-warn{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}
      .mem0-error{color:var(--dsw-alias-label-error);font-size:12px;margin:8px 0 0;white-space:pre-wrap}
      .mem0-section{display:flex;flex-direction:column;gap:10px}
      .mem0-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
      .mem0-section-title{font-size:13px;font-weight:600;margin:0}
      .mem0-section-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
      .mem0-segments{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
      .mem0-segment{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 8px;font:inherit;font-size:12px;cursor:pointer;text-align:center;transition:background .12s,border-color .12s,color .12s}
      .mem0-segment:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .mem0-segment[data-active="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}
      .mem0-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
      .mem0-grid-single{grid-column:1/-1}
      .mem0-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .mem0-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
      .mem0-input,.mem0-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:7px 9px;font:inherit;font-size:12px;outline:none}
      .mem0-input:focus,.mem0-select:focus{border-color:var(--dsw-focus-ring-color);box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
      .mem0-input::placeholder{color:var(--dsw-alias-label-dimmed)}
      .mem0-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
      .mem0-toggles{display:flex;flex-direction:column;gap:10px}
      .mem0-toggle-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .mem0-toggle-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
      .mem0-toggle-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
      .mem0-toggle{position:relative;flex:0 0 auto;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);padding:0;cursor:pointer;transition:background .12s,border-color .12s}
      .mem0-toggle span{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .12s,background .12s}
      .mem0-toggle[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
      .mem0-toggle[data-on="true"] span{left:16px;background:var(--dsw-alias-label-primary-foreground)}
      .mem0-details{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
      .mem0-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;user-select:none}
      .mem0-details[open] summary{margin-bottom:10px}
      .mem0-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}
      .mem0-primary,.mem0-secondary{border-radius:8px;padding:7px 14px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;border:1px solid transparent}
      .mem0-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .mem0-primary:hover{background:var(--dsw-alias-button-primary-hover)}
      .mem0-secondary{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
      .mem0-secondary:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .mem0-primary:disabled,.mem0-secondary:disabled{opacity:.5;cursor:default}
      .mem0-actions-note{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}
      .mem0-saved{color:var(--dsw-alias-state-success-primary);font-size:12px}
      .mem0-empty{padding:8px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .mem0-activity-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .mem0-activity{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:4px;min-width:0}
      .mem0-activity-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .mem0-activity-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .mem0-activity-main{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0;line-height:1.5}
      .mem0-activity-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5;word-break:break-word}
      .mem0-report-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 16px;font-size:12px;color:var(--dsw-alias-label-secondary);margin:8px 0}
      .mem0-report-details-list{display:flex;flex-direction:column;gap:8px}
      .mem0-report-block strong{display:block;font-size:12px;margin-bottom:2px}
      .mem0-report-list{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;word-break:break-word}
      @media(max-width:640px){.mem0-report-grid{grid-template-columns:1fr}}
      .mem0-state-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
      .mem0-state-warn{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
      .mem0-state-error{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error);background:var(--dsw-alias-bg-layer-2)}
      .mem0-memory-list{display:flex;flex-direction:column;gap:8px}
      .mem0-memory{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
      .mem0-memory:first-child{border-top:0;padding-top:0}
      .mem0-memory-text{font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .mem0-memory-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px}
      .mem0-memory-delete{margin-left:auto;padding:2px 10px;font-size:11px}
      .mem0-memory-delete:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
      .mem0-section-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .mem0-search-row{display:flex;align-items:center;gap:8px;margin:10px 0}
      .mem0-explorer{display:grid;grid-template-columns:minmax(160px,220px) minmax(0,1fr);gap:16px;align-items:start}
      .mem0-explorer-flat{display:block}
      .mem0-tree{display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--dsw-alias-border-l1);padding-right:12px}
      .mem0-tree-row{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;background:none;border:0;border-radius:6px;padding:4px 8px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
      .mem0-tree-row:hover{background:var(--dsw-alias-fill-l1,rgba(127,127,127,.08))}
      .mem0-tree-row[aria-current="true"]{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.16));font-weight:600}
      .mem0-tree-head{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:8px 8px 2px}
      .mem0-tree-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
      @media (max-width:640px){.mem0-explorer{grid-template-columns:1fr}.mem0-tree{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 0 8px}}
      .mem0-search-row .mem0-input{flex:1;min-width:0}
      .mem0-recall-preview{margin-top:9px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
      .mem0-profile{margin:10px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
      .mem0-profile-preview{margin:10px 0 0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1.7;max-height:320px;overflow:auto;word-break:break-word}
      .mem0-profile-preview>*:first-child{margin-top:0}
      .mem0-profile-heading{margin:14px 0 6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .mem0-profile-item{position:relative;margin:4px 0;padding-left:14px}
      .mem0-profile-item:before{content:'•';position:absolute;left:0;color:var(--dsw-alias-label-tertiary)}
      .mem0-profile-paragraph{margin:6px 0}
      .mem0-profile-edit{display:block;width:100%;box-sizing:border-box;margin:10px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.6;resize:vertical;min-height:150px}
      .mem0-profile-edit:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .mem0-profile-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
      .mem0-recall-item + .mem0-recall-item{margin-top:7px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1)}
      .mem0-recall-text{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
      .mem0-recall-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .mem0-dock{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1.5;padding:0 2px;cursor:pointer;white-space:nowrap;max-width:100%}
      .mem0-dock:hover{color:var(--dsw-alias-label-secondary)}
      .mem0-orb{display:inline-block;width:18px;height:18px;flex:none;color:var(--dsw-alias-label-primary);--dissolve-success:#38bdf8;--dissolve-danger:var(--dsw-alias-state-error-primary)}
      body[data-ds-dark-theme] .mem0-orb{--dissolve-success:#7dd3fc}
      .mem0-orb.is-error{color:var(--dsw-alias-state-error-primary)}
      .mem0-dock-text{overflow:hidden;text-overflow:ellipsis}
      .mem0-scope{display:inline-flex;align-items:center;margin-left:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10.5px;line-height:1.4;padding:0 6px;cursor:pointer;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;flex-shrink:1;min-width:0}
      .mem0-scope:hover{color:var(--dsw-alias-label-secondary)}
      .mem0-scope:disabled{opacity:.6;cursor:default}
      .mem0-dock-wrap{position:relative;display:inline-flex;max-width:100%}
      .mem0-dock-pop{position:fixed;z-index:1000;width:max-content;max-width:min(360px,80vw);white-space:normal;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2));box-shadow:0 6px 24px rgba(0,0,0,.18);padding:9px 11px;display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
      .mem0-dock-pop-title{font-weight:600;color:var(--dsw-alias-state-error-primary)}
      .mem0-scope-pop{pointer-events:none}
      .mem0-scope-pop-title{font-weight:600;color:var(--dsw-alias-label-primary)}
      .mem0-scope-pop-hint{margin-top:4px;color:var(--dsw-alias-label-tertiary)}
      .mem0-scope-pop-failed{color:var(--dsw-alias-state-error-primary)}
      .mem0-dock-pop-line{word-break:break-word}
      .mem0-dock-pop-link{align-self:flex-start;margin-top:4px;border:0;background:transparent;padding:0;font:inherit;color:var(--dsw-alias-label-primary);text-decoration:underline;cursor:pointer}
      .mem0-failures{display:flex;flex-direction:column;gap:6px;margin-top:10px;max-height:320px;overflow:auto}
      .mem0-failure{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}
      .mem0-failure-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
      .mem0-failure-msg{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word;margin:0}
      .mem0-wz{display:flex;flex-direction:column;gap:10px}
      .mem0-wz-steps{display:flex;flex-wrap:wrap;gap:6px}
      .mem0-wz-step{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;padding:4px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .mem0-wz-step[data-active=true]{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:600}
      .mem0-wz-modes{grid-template-columns:repeat(2,minmax(0,1fr));grid-column:1/-1}
      .mem0-wz-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;grid-column:1/-1}
      .mem0-wz-nav{justify-content:flex-end}
      .mem0-wz-list{display:flex;flex-direction:column;gap:6px;grid-column:1/-1;font-size:12px}
      .mem0-wz-item{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}
      .mem0-wz-ok{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0;grid-column:1/-1;white-space:pre-wrap}
      .mem0-wz-code{display:block;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;user-select:all}
      .mem0-wz-note,.mem0-wz-prompt,.mem0-wz-notice{grid-column:1/-1;display:flex;flex-direction:column;gap:6px;margin-top:6px}
      .mem0-wz .mem0-error,.mem0-wz .mem0-hint{grid-column:1/-1}
      .mem0-wz-result{grid-column:1/-1;display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:8px;border:1px solid;font-size:13px}
      .mem0-wz-result[data-ok=true]{border-color:#1f9d55;background:rgba(31,157,85,.10);color:#13703c}
      .mem0-wz-result[data-ok=false]{border-color:#d93025;background:rgba(217,48,37,.10);color:#a8221a}
      .mem0-wz-result p{margin:0;white-space:pre-wrap}
      .mem0-wz-result-title{font-weight:600;font-size:14px}
      .mem0-wz-result-meta{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
      .mem0-wz-result-keep{font-size:11px;opacity:.75}
      .mem0-wz-badge{display:inline-flex;align-items:center;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;border:1px solid}
      .mem0-wz-badge[data-ok=true]{border-color:#1f9d55;color:#13703c;background:rgba(31,157,85,.10)}
      .mem0-wz-badge[data-ok=false]{border-color:#d93025;color:#a8221a;background:rgba(217,48,37,.10)}
      .mem0-wz-badge[data-ok=none]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
      @media (prefers-color-scheme:dark){.mem0-wz-result[data-ok=true],.mem0-wz-badge[data-ok=true]{color:#6fdc9a}.mem0-wz-result[data-ok=false],.mem0-wz-badge[data-ok=false]{color:#ff8a80}}
      .mem0-wz-untested{grid-column:1/-1;margin:0;padding:8px 12px;border-radius:8px;border:1px solid #d97706;background:rgba(217,119,6,.10);font-size:13px}
      @media (max-width:640px){.mem0-segments{grid-template-columns:1fr 1fr}.mem0-grid{grid-template-columns:1fr}.mem0-status-grid{grid-template-columns:1fr 1fr}}
    `

    const NUMERIC_FIELDS = new Set([
      'captureMaxChars',
      'recallTopK',
      'timeoutMs',
      'recallTimeoutMs',
      'addTimeoutMs',
      'profileBudgetTokens',
      'memoryBudgetTokens',
      'storeSafetyLimit',
      'importanceWeight',
      'projectRecallBoost',
      'hygieneIntervalDays',
      'captureTurnDedupThreshold',
    ])
    // Numeric fields that take decimals (the rest must be whole numbers).
    const DECIMAL_FIELDS = new Set(['importanceWeight', 'projectRecallBoost', 'captureTurnDedupThreshold'])
    /** The draft with numeric fields as numbers; null when one is empty or not a number (decimals only where allowed). */
    function numericDraft(draft) {
      const next = { ...draft }
      for (const key of NUMERIC_FIELDS) {
        const raw = next[key]
        const number = raw === '' || raw === null || raw === undefined ? NaN : Number(raw)
        if (DECIMAL_FIELDS.has(key) ? !Number.isFinite(number) : !Number.isInteger(number)) return null
        next[key] = number
      }
      return next
    }
    const FIELD_ORDER = [
      'backend',
      'apiKey',
      'apiKeyEnv',
      'baseUrl',
      'authType',
      'storePath',
      'userId',
      'agentId',
      'autoRecall',
      'autoCapture',
      'announceToAgent',
      'includeSubagents',
      'captureMaxChars',
      'recallTopK',
      'timeoutMs',
      'recallTimeoutMs',
      'addTimeoutMs',
      'captureTurnDedupThreshold',
      'embedderKeepAlive',
      'captureFilter',
      'profileEnabled',
      'profileBudgetTokens',
      'memoryBudgetTokens',
      'storeSafetyLimit',
      'hygieneEnabled',
      'modelHygiene',
      'importanceWeight',
      'projectPartitions',
      'projectRecallBoost',
      'hygieneIntervalDays',
      'translateMemories',
      'captureStrataFolds',
      'enabled',
    ]

    function normalise(value) {
      return {
        backend: value?.backend ?? 'auto',
        apiKeyEnv: value?.apiKeyEnv ?? 'MEM0_API_KEY',
        baseUrl: value?.baseUrl ?? '',
        authType: value?.authType ?? 'apiKey',
        storePath: value?.storePath ?? '',
        userId: value?.userId ?? 'dsh-user',
        agentId: value?.agentId ?? 'dsh',
        autoRecall: value?.autoRecall !== false,
        autoCapture: value?.autoCapture !== false,
        announceToAgent: value?.announceToAgent !== false,
        includeSubagents: value?.includeSubagents === true,
        captureMaxChars: Number(value?.captureMaxChars ?? 450),
        recallTopK: Number(value?.recallTopK ?? 5),
        timeoutMs: Number(value?.timeoutMs ?? 30000),
        recallTimeoutMs: Number(value?.recallTimeoutMs ?? 5000),
        addTimeoutMs: Number(value?.addTimeoutMs ?? 120000),
        captureTurnDedupThreshold: Number(value?.captureTurnDedupThreshold ?? 0.93),
        embedderKeepAlive: typeof value?.embedderKeepAlive === 'string' ? value.embedderKeepAlive : '30m',
        captureFilter: value?.captureFilter === 'off' ? 'off' : 'heuristic',
        profileEnabled: value?.profileEnabled !== false,
        profileBudgetTokens: Number(value?.profileBudgetTokens ?? 1375),
        memoryBudgetTokens: Number(value?.memoryBudgetTokens ?? 2200),
        storeSafetyLimit: Number(value?.storeSafetyLimit ?? 20000),
        hygieneEnabled: value?.hygieneEnabled !== false,
        modelHygiene: value?.modelHygiene !== false,
        importanceWeight: Number(value?.importanceWeight ?? 0.2),
        projectPartitions: value?.projectPartitions !== false,
        projectRecallBoost: Number(value?.projectRecallBoost ?? 1.1),
        hygieneIntervalDays: Number(value?.hygieneIntervalDays ?? 7),
        translateMemories: value?.translateMemories === true,
        captureStrataFolds: value?.captureStrataFolds === true,
        enabled: value?.enabled !== false,
      }
    }

    function same(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    function route(path) {
      return new URL(path, document.baseURI).toString()
    }

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function newIdempotencyKey() {
      if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
    }

    async function fetchJson(path, options, attempt = 0) {
      // `retry: false` (deletes): never resend; a 404 there is an answer.
      const { retry = true, ...fetchOptions } = options ?? {}
      let response
      try {
        response = await fetch(route(path), {
          credentials: 'same-origin',
          headers: { accept: 'application/json', ...(fetchOptions.headers ?? {}) },
          ...fetchOptions,
        })
      } catch (error) {
        if (retry && attempt < 5) {
          await delay(250)
          return fetchJson(path, options, attempt + 1)
        }
        throw error
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        if (retry && attempt < 5 && [404, 502, 503].includes(response.status)) {
          await delay(300)
          return fetchJson(path, options, attempt + 1)
        }
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        error.status = response.status
        if (payload?.reason) error.reason = payload.reason
        throw error
      }
      return payload
    }

    /**
     * Language for server-side text (activity, profile, memory translations):
     * the host's active locale from `ctx.locale`. Chinese, and any language
     * pack whose fallback chain is Chinese, maps to 'zh'; everything else to
     * 'en', the only two languages the routes produce.
     */
    function pageLanguage(ctx) {
      const snapshot = ctx?.locale?.getLocale?.()
      const active = String(snapshot?.active ?? '')
      if (/^zh\b/i.test(active)) return 'zh'
      const definition = snapshot?.locales?.find?.((locale) => locale?.id === active)
      return /^zh\b/i.test(String(definition?.fallback ?? '')) ? 'zh' : 'en'
    }

    function Field(props) {
      const { label, hint, className, children } = props
      return h(
        'label',
        { className: ['mem0-field', className].filter(Boolean).join(' ') },
        h('span', { className: 'mem0-label' }, label),
        children,
        hint ? h('span', { className: 'mem0-hint' }, hint) : null,
      )
    }

    function TextField(props) {
      const { label, hint, value, onChange, placeholder, type = 'text', autoComplete, className } = props
      return h(
        Field,
        { label, hint, className },
        h('input', {
          className: 'mem0-input',
          type,
          value: value ?? '',
          placeholder,
          autoComplete,
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    function SelectField(props) {
      const { label, hint, value, onChange, options } = props
      return h(
        Field,
        { label, hint },
        h(
          'select',
          { className: 'mem0-select', value, onChange: (event) => onChange(event.target.value) },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      )
    }

    function ToggleRow(props) {
      const { label, hint, checked, onChange, disabled } = props
      return h(
        'div',
        { className: 'mem0-toggle-row' },
        h(
          'div',
          { className: 'mem0-toggle-copy' },
          h('span', { className: 'mem0-toggle-label' }, label),
          hint ? h('span', { className: 'mem0-hint' }, hint) : null,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mem0-toggle',
            'data-on': checked ? 'true' : 'false',
            'aria-pressed': checked,
            disabled,
            onClick: () => onChange(!checked),
          },
          h('span', { 'aria-hidden': true }),
        ),
      )
    }

    /**
     * Memories a saved capture actually wrote (add + update + delete), or
     * null when the backend did not report counts (Platform/server answers
     * without events): those keep the plain "Saved" badge.
     */
    function captureWritten(record) {
      if (!record || record.status !== 'saved') return null
      if (record.facts === 0) return 0
      const keys = ['add', 'update', 'delete']
      if (!keys.some((key) => Number.isInteger(record[key]))) return null
      return keys.reduce((sum, key) => sum + (Number.isInteger(record[key]) ? record[key] : 0), 0)
    }

    /** Badge state for an activity record: a saved capture that wrote nothing is "nothing_new". */
    function chipState(record) {
      if (!record) return undefined
      if (record.status === 'saved' && !record.retry && captureWritten(record) === 0) return 'nothing_new'
      return record.status
    }

    /** [dictionary key, class] for a badge state. Pure, for tests. */
    function activityChipSpec(state) {
      const map = {
        queued: ['activityQueued', 'mem0-state-warn'],
        saving: ['activitySaving', 'mem0-state-warn'],
        saved: ['activitySaved', 'mem0-state-ok'],
        nothing_new: ['activityNothingNew', ''],
        extracting: ['activityExtracting', 'mem0-state-warn'],
        skipped: ['activitySkipped', ''],
        starting: ['activityStarting', 'mem0-state-warn'],
        searching: ['activitySearching', 'mem0-state-warn'],
        ok: ['activityOk', 'mem0-state-ok'],
        error: ['activityError', 'mem0-state-error'],
      }
      return map[state] ?? ['activityNever', '']
    }

    function activityChip(t, record) {
      const [key, className] = activityChipSpec(chipState(record))
      return h('span', { className: ['mem0-chip', className].filter(Boolean).join(' ') }, t(key))
    }

    function activityTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString()
    }

    function template(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ''))
    }

    /** 950 ms → "950 ms", 75 s → "1 min 15 s", 3 h → "3 h 0 min". */
    function formatDuration(ms) {
      const value = Math.max(0, Math.round(Number(ms) || 0))
      if (value < 1000) return `${value} ms`
      const seconds = Math.round(value / 1000)
      if (seconds < 60) return `${seconds} s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes} min ${seconds % 60} s`
      return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
    }

    /** "code 1" / "signal SIGKILL" for a sidecar exit or stored failure. */
    function exitHow(t, exit) {
      if (exit?.signal) return template(t('sidecarExitSignal'), { signal: exit.signal })
      return template(t('sidecarExitCode'), { code: exit?.exitCode ?? exit?.code ?? '?' })
    }

    /**
     * Lines explaining a capture/recall activity record beyond its chip: why
     * it was skipped (circuit: time left and the failure that tripped it),
     * what /add extracted, and the retry outcome. Pure, for tests.
     */
    function activityDetails(t, record, now = Date.now()) {
      const lines = []
      if (!record) return lines
      if (record.status === 'skipped' && record.reason) {
        let line = t(`skipReason_${String(record.reason).replace(/-/g, '_')}`)
        if (record.reason === 'circuit-open') {
          const left = Date.parse(record.circuitUntil) - now
          if (Number.isFinite(left) && left > 0) line += ` · ${template(t('circuitRemaining'), { time: formatDuration(left) })}`
        }
        lines.push(line)
        const trip = record.trippedBy
        if (record.reason === 'circuit-open' && trip) {
          lines.push(template(t('circuitTrippedBy'), {
            kind: trip.kind ? t(`failureKind_${trip.kind}`) : '?',
            component: t(`failureComponent_${trip.component || 'unknown'}`),
            message: trip.message || '—',
            at: activityTime(trip.at),
          }))
        }
      }
      if (record.status === 'saved') {
        if (Number.isInteger(record.facts)) {
          if (record.facts === 0) lines.push(t('captureNoFacts'))
          else {
            let line = template(t('captureFacts'), {
              facts: record.facts,
              add: record.add ?? 0,
              update: record.update ?? 0,
              none: record.none ?? 0,
            })
            if (record.delete > 0) line += template(t('captureFactsDeleted'), { delete: record.delete })
            if (record.similar > 0) line += template(t('captureFactsSimilar'), { similar: record.similar })
            lines.push(line)
          }
        } else if (Number.isInteger(record.add)) {
          lines.push(template(t('captureEvents'), { add: record.add, update: record.update ?? 0, delete: record.delete ?? 0 }))
        }
      }
      if (record.status === 'saved' && record.metaDropped > 0) lines.push(template(t('captureMetaDropped'), { count: record.metaDropped }))
      const timingLine = recallTimingLine(t, record.timings)
      if (timingLine) {
        lines.push(timingLine)
        const { embedMs, totalMs } = record.timings
        if (totalMs >= 1500 && embedMs >= totalMs * 0.6) lines.push(t('recallSlowEmbed'))
      }
      if (record.status === 'error' && record.extractReason) {
        lines.push(failureCauseLabel(t, { cause: 'extraction', reason: record.extractReason, extract: record.extractStats }))
      }
      if (record.retry === 'pending') {
        lines.push(record.retryReason !== 'extraction'
          ? t('retryPending')
          : Number.isInteger(record.retryMaxTokens)
            ? template(t('retryPendingBudget'), { tokens: record.retryMaxTokens })
            : template(t('retryPendingExtraction'), { reason: t(`extractReason_${record.extractReason || 'not_json'}`) }))
      }
      if (record.retry === 'saved') lines.push(t('retrySaved'))
      if (record.retry === 'failed') lines.push(t('retryFailed'))
      return lines
    }

    const TIMING_STEPS = ['openMs', 'credentialMs', 'embedMs', 'searchMs', 'injectMs', 'otherMs']

    /** A recall's step times as one line (lib/memory-lifecycle.js recallTimings). */
    function recallTimingLine(t, timings) {
      if (!timings || !Number.isFinite(timings.totalMs)) return ''
      const steps = TIMING_STEPS.filter((key) => Number.isFinite(timings[key])).map((key) => `${t(`timingStep_${key}`)} ${timings[key]} ms`)
      steps.push(template(t('recallTimingsTotal'), { total: timings.totalMs }))
      return template(t('recallTimings'), { steps: steps.join(' · ') })
    }

    const DELETE_REASONS = ['foreign-source', 'other-user', 'not-found', 'unproven-owner']

    function deleteErrorText(t, error) {
      const reason = DELETE_REASONS.includes(error?.reason)
        ? t(`memoryDeleteReason_${error.reason.replace(/-/g, '_')}`)
        : String(error?.message ?? error)
      return `${t('memoryDeleteError')}: ${reason}`
    }

    /**
     * Delete one memory from the library: ask the server for its full text
     * (which also checks owner and source), show both in a confirmation,
     * delete only on yes, then reload the list. `request` is fetchJson,
     * `confirm` window.confirm; injected so tests drive it. Pure otherwise.
     */
    async function deleteMemoryFlow({ t, id, request, confirm, reload }) {
      const path = `${MEMORIES_PATH}?id=${encodeURIComponent(id)}`
      let info
      try {
        info = await request(path, { retry: false })
      } catch (error) {
        return { outcome: 'error', message: deleteErrorText(t, error) }
      }
      const memory = info?.memory ?? {}
      if (!confirm(template(t('memoryDeleteConfirm'), { id: memory.id ?? id, memory: memory.memory || '—' }))) {
        return { outcome: 'cancelled', message: '' }
      }
      try {
        await request(path, { method: 'DELETE', retry: false })
      } catch (error) {
        return { outcome: 'error', message: deleteErrorText(t, error) }
      }
      await reload?.()
      return { outcome: 'deleted', message: t('memoryDeleted') }
    }

    /** Lines for the local store block: file, open or not, last failure. */
    function storeLines(t, store) {
      if (!store) return []
      const lines = []
      lines.push(template(t('storeFile'), { path: store.path || '~/.dsh/mem0/memory.sqlite' }))
      lines.push(store.running ? t('storeOpen') : t('storeClosed'))
      const failure = store.lastStartFailure
      if (failure && !store.running) {
        lines.push(template(t('storeLastFailure'), { at: activityTime(failure.at), code: failure.code || '?', reason: failure.reason || '—' }))
        if (failure.configError) lines.push(t('storeConfigErrorNoRetry'))
      }
      lines.push(t('storeConfigHint'))
      return lines
    }

    function formatHygieneReport(t, report) {
      const value = report ?? {}
      const base = t('hygieneReport')
        .replace('{scanned}', String(value.scanned ?? 0))
        .replace('{duplicates}', String(value.duplicates ?? 0))
        .replace('{merged}', String(value.merged ?? 0))
        .replace('{deleted}', String(value.deleted ?? 0))
        .replace('{failed}', String(value.failed ?? 0))
      const parts = [base]
      if (value.foreign > 0) parts.push(template(t('hygieneForeign'), value))
      const model = value.model
      if (model?.status === 'ok') parts.push(template(t('hygieneModelOk'), { calls: model.calls ?? 0, tokens: model.usage?.totalTokens ?? 0 }))
      if (model?.status === 'degraded' || model?.status === 'skipped') {
        const key = `hygieneModelReason_${model.reason}`
        const reason = t(key) !== key ? t(key) : template(t('hygieneModelReasonOther'), { code: String(model.reason ?? '?') })
        parts.push(template(t('hygieneModelDegraded'), { reason }))
        if (model.partial) parts.push(t('hygieneModelPartial'))
        if (model.calls > 0) parts.push(template(t('hygieneModelOk'), { calls: model.calls, tokens: model.usage?.totalTokens ?? 0 }))
      }
      if (model?.status === 'off') parts.push(t('hygieneModelOff'))
      if (model?.badAnswers > 0 && model.status === 'ok') parts.push(template(t('hygieneModelBad'), { count: model.badAnswers }))
      if (model?.skippedGroups > 0) parts.push(template(t('hygieneModelSkipped'), { count: model.skippedGroups }))
      if (model?.suspicious > 0) parts.push(template(t('hygieneModelSuspicious'), { count: model.suspicious }))
      if (model?.unmetered > 0) parts.push(t('hygieneModelUnmetered'))
      if (model?.deferred > 0) parts.push(template(t('hygieneModelDeferred'), { count: model.deferred }))
      if (value.mergesPending > 0) parts.push(template(t('hygieneMergesPending'), { count: value.mergesPending }))
      if (value.pending > 0) parts.push(template(t(value.catchUp ? 'hygienePending' : 'hygienePendingSlow'), { count: value.pending }))
      if (value.overLimit) parts.push(template(t('hygieneOverLimit'), { limit: value.safetyLimit ?? 20000 }))
      if (value.scanLimited) parts.push(template(t('hygieneScanLimited'), { limit: value.scanLimit ?? 1000 }))
      if (value.dryRun) parts.unshift(`[${t('hygienePreviewTag')}]`)
      return parts.join(' ')
    }

    function hygieneReason(t, reason) {
      if (reason === 'manual') return t('hygieneReasonManual')
      if (reason === 'startup') return t('hygieneReasonStartup')
      return t('hygieneReasonSchedule')
    }

    // Stored reports keep only ids and reasons, never memory text.
    function reportItem(t, item) {
      if (item?.preview) return item.preview
      const reason =
        item?.reason === 'duplicate'
          ? t('hygieneItemDuplicate')
          : item?.reason === 'model'
            ? t('hygieneItemModel')
            : item?.reason === 'merged'
              ? t('hygieneItemMerged')
              : item?.reason === 'importance'
                ? template(t('hygieneItemImportance'), { level: item.level ?? '?' })
                : ''
      return reason ? `${item?.id ?? '—'} · ${reason}` : String(item?.id ?? '—')
    }

    // Ids of the memories a report's merge and importance rows name.
    function reportMemoryIds(report) {
      const ids = new Set()
      for (const item of [...(Array.isArray(report?.mergedDetails) ? report.mergedDetails : []), ...(Array.isArray(report?.mergePlan) ? report.mergePlan : [])]) {
        if (item?.id) ids.add(String(item.id))
        for (const id of Array.isArray(item?.ids) ? item.ids : []) ids.add(String(id))
      }
      for (const item of Array.isArray(report?.reviewDetails) ? report.reviewDetails : []) if (item?.id) ids.add(String(item.id))
      return [...ids].slice(0, 60)
    }

    // The current text of a memory a report names (looked up by id), or
    // "deleted" when it is gone; the id while the lookup has not answered.
    function reportBody(t, texts, id) {
      if (!texts || !Object.hasOwn(texts, String(id))) return String(id ?? '—')
      const entry = texts[String(id)]
      const text = String(entry?.memory ?? '').trim()
      if (!entry || !text) return t('reportDeleted')
      return text.length > 120 ? `${text.slice(0, 119)}…` : text
    }

    function mergeLine(t, texts, item) {
      const head = item?.preview ? item.preview : item?.id ? reportBody(t, texts, item.id) : item?.pending ? t('reportPending') : ''
      const sources = (Array.isArray(item?.ids) ? item.ids : []).map((id) => reportBody(t, texts, id)).join(' · ')
      return head ? `${head} ← ${sources}` : sources
    }

    function importanceLine(t, texts, item) {
      return `${reportBody(t, texts, item?.id)} · ${template(t('hygieneItemImportance'), { level: item?.level ?? '?' })}`
    }

    function shortId(id) {
      return String(id ?? '').slice(0, 8)
    }

    // Rows of the memory page's tree: all, global, projects (with their
    // sessions), sessions without a project. Headers are not selectable.
    // A session node: the time of its latest memory, else its short id.
    function sessionLabel(t, session) {
      const date = session?.newest ? new Date(session.newest) : null
      if (date && !Number.isNaN(date.getTime())) {
        const pad = (value) => String(value).padStart(2, '0')
        return template(t('sessionAt'), { time: `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` })
      }
      return template(t('scopeSession'), { id: shortId(session?.id) })
    }

    // The localized reason a move to global was refused.
    function makeGlobalReason(t, error) {
      const keys = { 'not-project': 'memoryMakeGlobalNotProject', 'not-own': 'memoryMakeGlobalNotOwn', 'not-found': 'memoryMakeGlobalNotFound', 'other-user': 'memoryMakeGlobalOtherUser' }
      const key = keys[error?.reason]
      return key ? t(key) : String(error?.message ?? '')
    }

    function treeEntries(t, tree) {
      if (!tree?.partitioned) return []
      const rows = [
        { key: '', label: t('treeAll'), count: tree.total ?? 0, depth: 0 },
        { key: 'global', label: t('scopeGlobal'), count: tree.global ?? 0, depth: 0 },
      ]
      const projects = Array.isArray(tree.projects) ? tree.projects : []
      if (projects.length > 0) rows.push({ key: null, label: t('treeProjects'), header: true, depth: 0 })
      for (const project of projects) {
        rows.push({ key: project.key, label: projectName(t, project), count: project.count ?? 0, depth: 1 })
        for (const session of Array.isArray(project.sessions) ? project.sessions : []) {
          rows.push({ key: session.key, label: sessionLabel(t, session), count: session.count ?? 0, depth: 2 })
        }
      }
      const loose = Array.isArray(tree.sessions) ? tree.sessions : []
      if (loose.length > 0) rows.push({ key: null, label: t('treeSessions'), header: true, depth: 0 })
      for (const session of loose) rows.push({ key: session.key, label: sessionLabel(t, session), count: session.count ?? 0, depth: 1 })
      return rows
    }

    /** A project partition's name on the memory page (DSH's default workspace by its role, not its folder). */
    function projectName(t, project) {
      if (project?.dshDefault) return t('dshDefaultWorkspace')
      return project?.name || shortId(project?.id)
    }

    // The partition chip of one memory on the memory page.
    function scopeLabel(t, memory, tree) {
      if (memory?.scope === 'project') {
        const project = (tree?.projects ?? []).find((item) => item.id === memory.projectId)
        return template(t('scopeProject'), { name: project ? projectName(t, project) : shortId(memory.projectId) })
      }
      if (memory?.scope === 'session') return template(t('scopeSession'), { id: shortId(memory.sessionId) })
      return t('scopeGlobal')
    }

    function backendChoiceText(t, data) {
      const values = { env: data?.apiKeyEnv || 'MEM0_API_KEY', endpoint: data?.endpoint ?? '—' }
      switch (data?.backendSource) {
        case 'auto-api-key-env':
          return template(t('backendChoiceAutoEnv'), values)
        case 'auto-api-key-credentials':
          return template(t('backendChoiceAutoCredentials'), values)
        case 'auto-api-key':
          return template(t('backendChoiceAutoKey'), values)
        case 'auto-base-url':
          return template(t('backendChoiceAutoUrl'), values)
        case 'auto-oss-config':
          return t('backendChoiceAutoOss')
        case 'auto-default':
          return template(t('backendChoiceAutoDefault'), values)
        default:
          return ''
      }
    }

    function reportDetail(t, label, items, formatter) {
      const list = Array.isArray(items) ? items.filter(Boolean) : []
      return h(
        'div',
        { className: 'mem0-report-block' },
        h('strong', null, label),
        list.length > 0
          ? h(
              'ul',
              { className: 'mem0-report-list' },
              list.map((item, index) => h('li', { key: `${label}-${index}` }, formatter(item))),
            )
          : h('p', { className: 'mem0-hint' }, t('hygieneNoDetails')),
      )
    }

    function statusLabel(t, backend) {
      if (backend === 'platform') return t('backendPlatform')
      if (backend === 'server') return t('backendServer')
      if (backend === 'oss') return t('backendOss')
      return t('backendAuto')
    }

    // <dissolve-thinking-orb>
    // Generated by scripts/vendor-dissolve.mjs from vendor/dissolve/src: ThinkingOrb from
    // dissolve (https://github.com/rs-4/dissolve) commit 06eddec11725e5874eafce69e97d10cca0f7f882, MIT License,
    // Copyright (c) 2026 Rayan Selmi (vendor/dissolve/LICENSE). Do not edit by hand.
    function dissolveThinkingOrb() {
      'use strict'
      // kit.ts (subset: CALM, clamp, el, injectStyle, loop, onThemeChange, propsOf, reducedMotion, rgbOf, scope, token, value, vibrate and what they use)

      /** prefers-reduced-motion, read live. False outside the browser. */
      const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

      /** A haptic where the browser has one (Android Chrome). Silent elsewhere and before the first tap. */
      function vibrate(pattern) {
        if (typeof navigator === 'undefined' || !navigator.userActivation?.hasBeenActive) return;
        navigator.vibrate?.(pattern);
      }

      /**
       * Adds a stylesheet once per document, keyed by id. Components ship their base CSS this way, with
       * :where() selectors so any class of yours wins over it.
       */
      function injectStyle(id, css) {
        if (typeof document === 'undefined' || document.getElementById(id)) return;
        const s = document.createElement('style');
        s.id = id;
        s.textContent = css;
        document.head.appendChild(s);
      }

      /** A dissolve theme token (--dissolve-<name>, see theme.css) as resolved on node, or the fallback. */
      function token(node, name, fallback) {
        return getComputedStyle(node).getPropertyValue(`--dissolve-${name}`).trim() || fallback;
      }

      /**
       * Calls fn when the theme may have changed: the system color scheme, or a class, data-theme or
       * style change on <html> (how theme switchers flip it). Stops with the scope.
       */
      function onThemeChange(sc, fn) {
        const mo = new MutationObserver(fn);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        const mq = matchMedia('(prefers-color-scheme: dark)');
        mq.addEventListener('change', fn);
        sc.onDispose(() => { mo.disconnect(); mq.removeEventListener('change', fn); });
      }

      let probe = null;

      /** Any CSS color (hex, rgb(), hsl(), oklch()...) as [r, g, b, a], 0..255 and 0..1. */
      function rgbOf(color) {
        probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#000';
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      }

      /**
       * The props of a component instance over its defaults. update() takes a partial set, where an
       * undefined value puts the default back, and returns the names whose value changed.
       */
      function propsOf(defaults, initial) {
        let raw = { ...initial };
        const resolve = () => {
          const out = { ...defaults };
          for (const [k, v] of Object.entries(raw)) if (v !== undefined) out[k] = v;
          return out ;
        };
        const box = {
          current: resolve(),
          update(next) {
            raw = { ...raw, ...next };
            const prev = box.current ;
            box.current = resolve();
            const cur = box.current ;
            return new Set([...Object.keys(prev), ...Object.keys(cur)].filter((k) => prev[k] !== cur[k])) ;
          },
        };
        return box;
      }

      function bezier(x1, y1, x2, y2) {
        const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
        const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
        const X = (t) => ((ax * t + bx) * t + cx) * t;
        const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
        const Y = (t) => ((ay * t + by) * t + cy) * t;
        return (x) => {
          if (x <= 0) return 0;
          if (x >= 1) return 1;
          let t = x;
          for (let i = 0; i < 8; i++) {
            const e = X(t) - x, d = dX(t);
            if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
            t -= e / d;
          }
          if (t < 0 || t > 1 || Math.abs(X(t) - x) > 1e-4) {
            let lo = 0, hi = 1;
            t = x;
            for (let i = 0; i < 40; i++) { if (X(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
          }
          return Y(t);
        };
      }

      /** iOS sheet curve, the dissolve default. */
      const CALM = bezier(0.32, 0.72, 0, 1);

      const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

      function scope() {
        const timers = new Set(), handles = new Set(), fns = [];
        const sc = {
          alive: true,
          wait: (ms) => new Promise((res) => {
            const t = setTimeout(() => { timers.delete(t); if (sc.alive) res(); }, ms);
            timers.add(t);
          }),
          track(h) { handles.add(h); h.done.then(() => handles.delete(h)); return h; },
          onDispose(fn) { fns.push(fn); },
          dispose() {
            if (!sc.alive) return;
            sc.alive = false;
            timers.forEach(clearTimeout);
            handles.forEach((h) => h.cancel());
            fns.forEach((f) => f());
          },
        };
        return sc;
      }

      /** An animated number. A newer animation supersedes the running one. onChange runs every frame. */
      function value(sc, v0, onChange) {
        let id = 0;
        const a = {
          v: v0, vel: 0,
          set(x) { id++; a.v = x; a.vel = 0; onChange(); },
          to(to, ms, ease = CALM, delay = 0) {
            const my = ++id, from = a.v;
            return new Promise((res) => {
              const t0 = performance.now() + delay;
              let lastT = t0;
              const f = (now) => {
                if (my !== id) return res(false);
                if (!sc.alive) return;
                if (now < t0) return void requestAnimationFrame(f);
                const k = ms > 0 ? Math.min(1, (now - t0) / ms) : 1;
                const prev = a.v;
                a.v = from + (to - from) * ease(k);
                const dt = (now - lastT) / 1000;
                a.vel = dt > 0 ? (a.v - prev) / dt : 0;
                lastT = now;
                onChange();
                if (k < 1) requestAnimationFrame(f);
                else { a.vel = 0; res(true); }
              };
              requestAnimationFrame(f);
            });
          },
          spring(to, { stiffness = 260, damping = 31, mass = 1, eps = 0.02 } = {}) {
            const my = ++id;
            return new Promise((res) => {
              let last = performance.now();
              const f = (now) => {
                if (my !== id) return res(false);
                if (!sc.alive) return;
                let dt = Math.min(0.064, (now - last) / 1000);
                last = now;
                while (dt > 0) {
                  const h = Math.min(1 / 480, dt);
                  a.vel += ((-stiffness * (a.v - to) - damping * a.vel) / mass) * h;
                  a.v += a.vel * h;
                  dt -= h;
                }
                if (Math.abs(a.v - to) < eps && Math.abs(a.vel) < eps * 10) { a.v = to; a.vel = 0; onChange(); return res(true); }
                onChange();
                requestAnimationFrame(f);
              };
              requestAnimationFrame(f);
            });
          },
        };
        return a;
      }

      function el(tag, cls = '', html = '') {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html) e.innerHTML = html;
        return e;
      }

      /** Tracks whether node is on screen. on: the current state; shown() resolves once it is. */
      function onScreen(sc, node, onChange) {
        let waiting = [];
        const st = {
          on: true,
          shown: () => (st.on ? Promise.resolve() : new Promise((res) => waiting.push(res))),
        };
        const io = new IntersectionObserver(([e]) => {
          st.on = e.isIntersecting;
          if (st.on) { waiting.forEach((res) => res()); waiting = []; }
          onChange?.(st.on);
        });
        io.observe(node);
        sc.onDispose(() => io.disconnect());
        return st;
      }

      /** rAF loop that sleeps while the node is off screen or while active() is false. kick() wakes it. */
      function loop(sc, node, fn, active = () => true) {
        let raf = 0;
        const tick = (now) => {
          raf = 0;
          if (!sc.alive) return;
          fn(now);
          if (seen.on && active()) raf = requestAnimationFrame(tick);
        };
        const kick = () => { if (!raf && sc.alive) raf = requestAnimationFrame(tick); };
        const seen = onScreen(sc, node, (on) => on && kick());
        kick();
        sc.onDispose(() => cancelAnimationFrame(raf));
        return { kick };
      }

      // engine.ts (DPR only)

      const DPR = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);

      // thinking-orb.core.ts

      /**
       * ThinkingOrb for the web, framework free, from dissolve (dissolve-ui). This file is yours.
       * The React component (thinking-orb.tsx) wraps it; it also runs on its own:
       *
       *   const orb = createThinkingOrb(el, { state: 'thinking', size: 96 });
       *   orb.update({ state: 'done' });
       *
       * A sphere of dots whose motion shows what an AI agent is doing. Every state change moves each dot
       * from where it is to its new place on the calm curve (600 ms, staggered), never an instant swap.
       * Idle breathes, thinking splits into three tilted rings, searching flattens into a disc swept by
       * a radar arc, listening pulses with the level, done draws a check, error falls and reforms.
       * Dots follow --dissolve-foreground, done --dissolve-success, error --dissolve-danger.
       */

      const DEFAULTS = { state: 'idle' , size: 64, dots: 180, interactive: false, haptics: true };

      const TAU = Math.PI * 2;
      const GA = Math.PI * (3 - Math.sqrt(5));
      const MORPH = 600;
      const STAGGER = 1.5;
      /** Error: how long the dots fall before they reform into the sphere. */
      const FALL = 900;
      const FLEE = 40;
      const RING_SPD = [0.0021, -0.0016, 0.0012], RING_TZ = [0, 1.05, -1.05];
      /** Checkmark, unit space, y down. */
      const CHECK = [[-0.52, 0.02], [-0.16, 0.38], [0.56, -0.36]];

      const CSS = `
      :where([data-dissolve="thinking-orb"]) { position: relative; display: block; flex: none; -webkit-tap-highlight-color: transparent; }
      :where(.dissolve-orb-canvas) { display: block; }
      `;

      const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const unit = (c) => { const [r, g, b] = rgbOf(c); return [r / 255, g / 255, b / 255]; };

      function createThinkingOrb(host, initial = {}) {
        injectStyle('dissolve-thinking-orb', CSS);
        const props = propsOf(DEFAULTS, initial);
        const p = () => props.current;
        const sc = scope();

        host.dataset.dissolve = 'thinking-orb';
        host.setAttribute('role', 'img');
        const cv = el('canvas', 'dissolve-orb-canvas');
        host.append(cv);
        const ctx = cv.getContext('2d');

        let S = 0, N = 0, R = 0, DOT = 0;
        let r1 = new Float32Array(0), r2 = new Float32Array(0), fib = new Float32Array(0), check = new Float32Array(0);
        let cur = new Float32Array(0), from = new Float32Array(0), vel = new Float32Array(0), off = new Float32Array(0), offV = new Float32Array(0);
        const tg = new Float32Array(4);
        let colors = null;

        /** What is drawn: the state prop, except after an error, which reforms into the idle sphere. */
        let shape = 'idle';
        let t0 = -1e9, fallUntil = 0, level = 0, last = performance.now();
        const epoch = performance.now();
        const ok = value(sc, 0, () => {}), bad = value(sc, 0, () => {});
        let ptr = null;

        /** Sizes the canvas. */
        function layout() {
          S = p().size;
          R = S * 0.4;
          DOT = p().dotSize != null ? p().dotSize / 2 : Math.max(1.25, S * 0.0105);
          cv.width = Math.round(S * DPR);
          cv.height = Math.round(S * DPR);
          cv.style.width = cv.style.height = S + 'px';
          host.style.width = host.style.height = S + 'px';
        }

        /** Per dot randoms, the Fibonacci sphere and the check path, sampled by arc length. */
        function seed() {
          N = Math.max(1, Math.round(p().dots));
          r1 = new Float32Array(N); r2 = new Float32Array(N); fib = new Float32Array(N * 3); check = new Float32Array(N * 3);
          for (let i = 0; i < N; i++) {
            r1[i] = Math.random(); r2[i] = Math.random();
            const y = 1 - ((i + 0.5) / N) * 2, r = Math.sqrt(1 - y * y), th = i * GA;
            fib[i * 3] = Math.cos(th) * r; fib[i * 3 + 1] = y; fib[i * 3 + 2] = Math.sin(th) * r;
          }
          const segs = [];
          let tot = 0;
          for (let k = 0; k < 2; k++) {
            const a = CHECK[k], b = CHECK[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            segs.push([a, b, l]);
            tot += l;
          }
          for (let i = 0; i < N; i++) {
            let s = ((i + 0.5) / N) * tot, k = 0;
            while (k < 1 && s > segs[k][2]) { s -= segs[k][2]; k++; }
            const [a, b, l] = segs[k], u = s / l, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l, j = (r1[i] - 0.5) * 0.11;
            check[i * 3] = a[0] + (b[0] - a[0]) * u + nx * j;
            check[i * 3 + 1] = a[1] + (b[1] - a[1]) * u + ny * j;
            check[i * 3 + 2] = (r2[i] - 0.5) * 0.5;
          }
          cur = new Float32Array(N * 4); from = new Float32Array(N * 4);
          vel = new Float32Array(N * 2); off = new Float32Array(N * 2); offV = new Float32Array(N * 2);
          for (let i = 0; i < N; i++) { cur[i * 4] = fib[i * 3]; cur[i * 4 + 1] = fib[i * 3 + 1]; cur[i * 4 + 2] = fib[i * 3 + 2]; cur[i * 4 + 3] = 1; }
          from.set(cur);
        }

        function target(st, i, tm, o) {
          let x, y, z, a = 1;
          if (st === 'thinking') {
            const r = i % 3, ang = (((i / 3) | 0) / (N / 3)) * TAU + tm * RING_SPD[r];
            const x0 = Math.cos(ang) * 0.95, z0 = Math.sin(ang) * 0.95;
            const y1 = -z0 * Math.sin(0.45), z1 = z0 * Math.cos(0.45);
            const c2 = Math.cos(RING_TZ[r]), s2 = Math.sin(RING_TZ[r]);
            x = x0 * c2 - y1 * s2; y = x0 * s2 + y1 * c2; z = z1;
          } else if (st === 'searching') {
            const rd = 0.95 * Math.sqrt((i + 0.5) / N), th = i * GA;
            x = Math.cos(th) * rd; y = Math.sin(th) * rd;
            let d = ((tm / 1000) * TAU - th) % TAU;
            if (d < 0) d += TAU;
            a = 0.3 + 0.7 * Math.exp(-d * 1.4);
            z = a * 0.6 - 0.3;
          } else if (st === 'done') {
            x = check[i * 3]; y = check[i * 3 + 1]; z = check[i * 3 + 2];
          } else {
            // Idle and listening: the rotating sphere.
            x = fib[i * 3]; y = fib[i * 3 + 1]; z = fib[i * 3 + 2];
            let s = 0.98 + 0.02 * Math.sin((tm / 2400) * TAU);
            if (st === 'listening') s = (0.84 + level * 0.2) * (1 + 0.06 * level * Math.sin(y * 5 - tm * 0.012));
            x *= s; y *= s; z *= s;
          }
          if (st !== 'done' && st !== 'searching' && st !== 'thinking') {
            const ra = tm * 0.0004, c = Math.cos(ra), sn = Math.sin(ra);
            const xr = x * c + z * sn, zr = -x * sn + z * c;
            const cb = Math.cos(0.3), sb = Math.sin(0.3);
            x = xr; z = y * sb + zr * cb; y = y * cb - zr * sb;
          }
          o[0] = x; o[1] = y; o[2] = z; o[3] = a;
        }

        function go(next) {
          if (next === shape && next !== 'error') return;
          from.set(cur);
          shape = next;
          t0 = performance.now();
          ok.to(next === 'done' ? 1 : 0, 600, CALM);
          if (next === 'error') {
            bad.to(1, 150, CALM);
            for (let i = 0; i < N; i++) { vel[i * 2] = (r1[i] - 0.5) * 0.7; vel[i * 2 + 1] = -r2[i] * 0.6; }
            fallUntil = t0 + (reducedMotion() ? 0 : FALL);
          } else bad.to(0, 500, CALM);
        }

        function inputLevel(tm) {
          const l = p().level;
          if (l == null) return clamp(0.3 + 0.35 * Math.sin(tm * 0.0047) * Math.sin(tm * 0.0013 + 1) + 0.3 * Math.abs(Math.sin(tm * 0.011)));
          return clamp(typeof l === 'number' ? l : l.value);
        }

        function draw(now) {
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          const red = reducedMotion(), tm = red ? 0 : now - epoch;
          const dur = red ? 150 : MORPH, stg = red ? 0 : STAGGER;
          level += (inputLevel(tm) - level) * 0.15;
          if (shape === 'error' && fallUntil && now >= fallUntil) { fallUntil = 0; go('idle'); }
          if (!colors) {
            colors = {
              fg: unit(p().color ?? token(host, 'foreground', 'rgb(28 28 30)')),
              ok: unit(token(host, 'success', 'rgb(52 199 89)')),
              bad: unit(token(host, 'danger', 'rgb(255 59 48)')),
            };
          }
          const col = lerp3(lerp3(colors.fg, colors.ok, ok.v), colors.bad, bad.v);
          ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
          ctx.clearRect(0, 0, S, S);
          ctx.fillStyle = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`;
          const falling = shape === 'error' && fallUntil;
          const flee = ptr && !red && p().interactive ? ptr : null;
          for (let i = 0; i < N; i++) {
            const k4 = i * 4;
            if (falling) {
              vel[i * 2 + 1] += 4.2 * dt;
              cur[k4] += vel[i * 2] * dt;
              cur[k4 + 1] += vel[i * 2 + 1] * dt;
              if (cur[k4 + 1] > 1.05) { cur[k4 + 1] = 1.05; vel[i * 2 + 1] *= -0.28; vel[i * 2] *= 0.7; }
            } else {
              target(shape, i, tm, tg);
              const e = CALM(clamp((now - t0 - i * stg) / dur));
              for (let c = 0; c < 4; c++) cur[k4 + c] = from[k4 + c] + (tg[c] - from[k4 + c]) * e;
            }
            let px = S / 2 + cur[k4] * R, py = S / 2 + cur[k4 + 1] * R;
            // Flee the pointer within 40 px, crisp spring back.
            let gx = 0, gy = 0;
            if (flee) {
              const dx = px - flee.x, dy = py - flee.y, d = Math.hypot(dx, dy);
              if (d < FLEE && d > 0.01) { gx = (dx / d) * (FLEE - d) * 0.8; gy = (dy / d) * (FLEE - d) * 0.8; }
            }
            for (let c = 0; c < 2; c++) {
              const j = i * 2 + c, to = c ? gy : gx;
              offV[j] += (260 * (to - off[j]) - 22 * offV[j]) * dt;
              off[j] += offV[j] * dt;
            }
            px += off[i * 2]; py += off[i * 2 + 1];
            const d = clamp((cur[k4 + 2] + 1) / 2);
            ctx.globalAlpha = (0.38 + 0.62 * d) * cur[k4 + 3];
            ctx.beginPath();
            ctx.arc(px, py, DOT * (0.8 + 0.4 * d), 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }

        const local = (e) => { const b = cv.getBoundingClientRect(), s = b.width / S || 1; return { x: (e.clientX - b.left) / s, y: (e.clientY - b.top) / s }; };
        const onMove = (e) => { ptr = local(e); };
        const onLeave = () => { ptr = null; };
        const onUp = (e) => { if (e.pointerType !== 'mouse') ptr = null; };
        host.addEventListener('pointermove', onMove);
        host.addEventListener('pointerdown', onMove);
        host.addEventListener('pointerleave', onLeave);
        host.addEventListener('pointerup', onUp);
        host.addEventListener('pointercancel', onLeave);

        function decorate() {
          host.setAttribute('aria-label', `Assistant ${p().state}`);
          host.style.touchAction = p().interactive ? 'pan-y' : '';
        }

        onThemeChange(sc, () => { colors = null; });
        layout();
        seed();
        decorate();
        shape = p().state;
        if (shape === 'done') ok.set(1);
        loop(sc, cv, draw);

        return {
          update(next) {
            const changed = props.update(next);
            if (!changed.size) return;
            if (changed.has('size') || changed.has('dotSize')) layout();
            if (changed.has('dots')) { seed(); t0 = -1e9; }
            if (changed.has('color')) colors = null;
            if (changed.has('state')) {
              const st = p().state;
              if (p().haptics && st === 'done') vibrate(10);
              if (p().haptics && st === 'error') vibrate([20, 60, 20]);
              go(st);
            }
            decorate();
          },
          destroy() {
            sc.dispose();
            host.removeEventListener('pointermove', onMove);
            host.removeEventListener('pointerdown', onMove);
            host.removeEventListener('pointerleave', onLeave);
            host.removeEventListener('pointerup', onUp);
            host.removeEventListener('pointercancel', onLeave);
            cv.remove();
            delete host.dataset.dissolve;
            host.removeAttribute('role');
            host.removeAttribute('aria-label');
            for (const k of ['width', 'height', 'touch-action']) host.style.removeProperty(k);
          },
        };
      }
      return { createThinkingOrb }
    }
    // </dissolve-thinking-orb>

    /** Composer status icon: dissolve's ThinkingOrb, small. */
    const ORB_SIZE = 18
    const ORB_DOTS = 36
    const ORB_DOT_SIZE = 1.9
    /** dissolve state per dockView `orb`; anything else is idle. */
    const ORB_STATES = new Set(['idle', 'thinking', 'searching', 'done', 'error'])
    let orbKit = null

    /**
     * The orb on a <span>. Created once per mount and destroyed in the effect
     * cleanup, which React runs on unmount: a session switch (the session slot
     * entry is keyed by session) and plugin dispose (the registration goes
     * away) both unmount it. Dots take the span's CSS `color`, re-read when
     * DSH flips its theme (`data-ds-dark-theme` on <body>, which dissolve's
     * own theme watcher does not see).
     */
    function OrbStatus({ state }) {
      const hostRef = useRef(null)
      const orbRef = useRef(null)
      const orbState = ORB_STATES.has(state) ? state : 'idle'

      useLayoutEffect(() => {
        const host = hostRef.current
        if (!host || typeof document === 'undefined' || typeof window === 'undefined') return undefined
        let orb
        try {
          orbKit ??= dissolveThinkingOrb()
          orb = orbKit.createThinkingOrb(host, {
            state: orbState,
            size: ORB_SIZE,
            dots: ORB_DOTS,
            dotSize: ORB_DOT_SIZE,
            haptics: false,
            color: getComputedStyle(host).color,
          })
        } catch {
          // No canvas (or no 2D context): show nothing rather than break the dock.
          return undefined
        }
        host.removeAttribute('role')
        orbRef.current = orb
        const recolor = () => orb.update({ color: getComputedStyle(host).color })
        const observer = new MutationObserver(recolor)
        const attributeFilter = ['class', 'style', 'data-theme', 'data-ds-dark-theme']
        observer.observe(document.documentElement, { attributes: true, attributeFilter })
        if (document.body) observer.observe(document.body, { attributes: true, attributeFilter })
        const media = window.matchMedia?.('(prefers-color-scheme: dark)')
        media?.addEventListener?.('change', recolor)
        return () => {
          observer.disconnect()
          media?.removeEventListener?.('change', recolor)
          orbRef.current = null
          orb.destroy()
        }
      }, [])

      useLayoutEffect(() => {
        const host = hostRef.current
        if (!orbRef.current || !host) return
        orbRef.current.update({ state: orbState, color: getComputedStyle(host).color })
        host.removeAttribute('role')
      }, [orbState])

      return h('span', {
        ref: hostRef,
        className: `mem0-orb is-${orbState}`,
        'data-orb-state': orbState,
        'aria-hidden': 'true',
      })
    }

    /** "LLM extraction failed: answer was not JSON"; other causes as is. */
    function failureCauseLabel(t, failure) {
      const label = t(`failureCause_${failure?.cause}`)
      if (failure?.cause !== 'extraction' || !failure.reason) return label
      const stats = extractStatsLabel(t, failure.extract ?? failure.extractStats)
      return `${label}: ${t(`extractReason_${failure.reason}`)}${stats ? ` (${stats})` : ''}`
    }

    /**
     * "finish_reason=length · output 2000/2000 tokens (1697 thinking)" for an
     * extraction call; '' without numbers. Pure, for tests.
     */
    function extractStatsLabel(t, stats) {
      if (!stats || typeof stats !== 'object') return ''
      const parts = []
      if (typeof stats.finishReason === 'string') parts.push(`finish_reason=${stats.finishReason}`)
      if (Number.isInteger(stats.completionTokens) || Number.isInteger(stats.maxTokens)) {
        let output = template(t('extractStatsOutput'), { completion: stats.completionTokens ?? '?', max: stats.maxTokens ?? '?' })
        if (Number.isInteger(stats.reasoningTokens)) output += ` (${template(t('extractStatsReasoning'), { reasoning: stats.reasoningTokens })})`
        parts.push(output)
      }
      if (typeof stats.reasoningEffort === 'string') parts.push(`reasoning_effort=${stats.reasoningEffort}`)
      return parts.join(' · ')
    }

    /** "Embedder (ollama @ 127.0.0.1:11434, embedding)" for a stored failure. */
    function failureComponentLabel(t, failure) {
      const component = failure?.component || 'unknown'
      const extra = []
      if (failure?.provider) extra.push(failure.endpoint ? `${failure.provider} @ ${failure.endpoint}` : failure.provider)
      if (failure?.step) extra.push(t(`failureStep_${failure.step}`))
      return `${t(`failureComponent_${component}`)}${extra.length ? ` (${extra.join(', ')})` : ''}`
    }

    /** One-line description of a stored failure: kind · component · cause · message. */
    function failureSummary(t, failure) {
      if (!failure) return ''
      const parts = [t(`failureKind_${failure.kind}`), failureComponentLabel(t, failure), failureCauseLabel(t, failure)]
      if (Number.isFinite(failure.stepElapsedMs) && failure.step) {
        parts.push(template(t('failureStepRunning'), { step: t(`failureStep_${failure.step}`), ms: failure.stepElapsedMs }))
      }
      if (Number.isInteger(failure.exitCode) || failure.signal) {
        parts.push(template(t('failureExit'), { how: exitHow(t, failure), uptime: formatDuration(failure.uptimeMs) }))
      }
      if (failure.retry === 'failed') parts.push(t('failureRetryFailed'))
      if (failure.message) parts.push(failure.message)
      const hint = unreachableHint(t, failure)
      if (hint) parts.push(hint)
      return parts.join(' · ')
    }

    /** Localized "Qdrant unreachable at host:port" hint for a refused connection. */
    function unreachableHint(t, failure) {
      if (failure?.cause !== 'connection' || !failure.endpoint) return ''
      const provider = String(failure.provider || '').toLowerCase()
      const name = provider === 'qdrant' ? 'Qdrant' : provider === 'ollama' ? 'Ollama' : t(`failureComponent_${failure.component || 'unknown'}`)
      return template(t('failureHintUnreachable'), { component: name, endpoint: failure.endpoint })
    }

    /**
     * What the composer status shows. Pure, for tests. Two failure states:
     * - `failed` (the page could not read /activity): "Status unavailable",
     *   with the read error; it says nothing about the memory backend;
     * - a capture/recall operation failed: "Memory failed", with the latest
     *   stored failure (kind, cause, message, time).
     * `details` (lines) is set only for the two failure states.
     */
    function dockView(t, input, now = Date.now()) {
      const view = dockViewState(t, input, now)
      return { ...view, orb: view.orb ?? DOCK_ORB[view.state] ?? 'idle' }
    }

    /**
     * Orb state per dock state: recall searches, capture thinks (set on the
     * view itself), success draws dissolve's done check, failures error.
     */
    const DOCK_ORB = { idle: 'idle', success: 'done', error: 'error' }

    function dockViewState(t, { data, failed = false, fetchError = '', failedAt = '' } = {}, now = Date.now()) {
      if (failed) {
        const details = [t('dockStatusUnavailableDetail')]
        if (fetchError) details.push(String(fetchError).slice(0, 200))
        if (failedAt) details.push(activityTime(failedAt))
        return { state: 'error', kind: 'status', label: t('dockStatusUnavailable'), details }
      }
      const capture = data?.activity?.capture ?? null
      const recall = data?.activity?.recall ?? null
      if (data && data.enabled === false) return { state: 'idle', kind: 'disabled', label: t('dockDisabled'), details: null }
      if (capture?.status === 'saving') return { state: 'active', orb: 'thinking', kind: 'busy', label: t('dockCaptureSaving'), details: null }
      if (capture?.status === 'queued') return { state: 'active', orb: 'thinking', kind: 'busy', label: t('dockCaptureQueued'), details: null }
      if (capture?.status === 'extracting') return { state: 'active', orb: 'thinking', kind: 'busy', label: t('dockCaptureExtracting'), details: null }
      if (capture?.status === 'error' || recall?.status === 'error') {
        const latest = Array.isArray(data?.failures) ? data.failures[0] : null
        const details = [t('dockLatestFailure')]
        if (latest) {
          details.push(failureSummary(t, latest))
          details.push(activityTime(latest.at))
        } else {
          const error = capture?.status === 'error' ? capture : recall
          details.push(error?.error ? String(error.error) : t('dockNoFailureDetail'))
          if (error?.at) details.push(activityTime(error.at))
        }
        return { state: 'error', kind: 'memory', label: t('dockError'), details }
      }
      if (recall?.status === 'searching') return { state: 'active', orb: 'searching', kind: 'busy', label: t('dockRecallSearching'), details: null }
      // Paused by the breaker is not "skipped because short": say which.
      const paused = [capture, recall].find(
        (record) => record?.status === 'skipped' && record.reason === 'circuit-open' && Date.parse(record.circuitUntil) > now,
      )
      if (paused) return { state: 'error', kind: 'circuit', label: t('dockCircuitOpen'), details: activityDetails(t, paused, now) }
      const recent = (at) => {
        const value = Date.parse(at)
        return Number.isFinite(value) && now - value < 10 * 60 * 1000
      }
      const items = []
      if (capture?.status === 'saved' && recent(capture.at)) {
        // Wrote nothing: neutral, not the success colour.
        if (chipState(capture) === 'nothing_new') {
          items.push({ at: Date.parse(capture.at), state: 'idle', kind: 'idle', label: t('dockCaptureNothingNew') })
        } else {
          items.push({ at: Date.parse(capture.at), label: `${t('dockCaptureSaved')}${capture.count ? ` ${capture.count}` : ''}` })
        }
      }
      if (recall?.status === 'ok' && recent(recall.at)) {
        items.push({ at: Date.parse(recall.at), label: `${t('dockRecallOk')}${recall.count !== undefined ? ` ${recall.count}` : ''}` })
      }
      const latest = items.sort((left, right) => right.at - left.at)[0]
      if (latest) return { state: latest.state ?? 'success', kind: latest.kind ?? 'ok', label: latest.label, details: null }
      if (capture?.status === 'skipped') {
        const label = capture.reason === 'low-value' ? t('dockCaptureSkippedShort') : t('dockCaptureSkipped')
        return { state: 'idle', kind: 'idle', label, details: null }
      }
      return { state: 'idle', kind: 'idle', label: t('dockIdle'), details: null }
    }

    /**
     * The composer chip: where this conversation's new memories go. Null when
     * the backend has no partitions (REST backends keep everything global).
     * `partitions` is the switch as the config form holds it (it changes at
     * once on a click), else as the server last reported it. The server
     * names the session's project whatever the switch says, so a click
     * shows the project at once.
     */
    function scopeChipView(t, scope, partitions) {
      if (!scope || scope.available === false) return null
      const on = typeof partitions === 'boolean' ? partitions : scope.partitions !== false
      const projectName = scope.project?.name ? String(scope.project.name).replace(/\s+/g, ' ').trim().slice(0, 40) : ''
      const name = on ? projectName : ''
      const global = (hint, kind) => ({ on, label: t('scopeChipGlobal'), ariaLabel: template(t('scopeChipAria'), { where: t('scopeChipAriaGlobal') }), hint, kind })
      let view
      if (!on) view = global(t('scopeChipOffHint'), 'global')
      // Switched on before DSH reported the session: named at its next turn;
      // its new memories go to global until then.
      else if (!name && scope.pending) view = global(t('scopeChipPendingHint'), 'pending')
      else if (!name) view = global(t('scopeChipOnNoProjectHint'), 'global')
      else view = { on, label: t('scopeChipProject'), ariaLabel: template(t('scopeChipAria'), { where: template(t('scopeChipAriaProject'), { name }) }), hint: t('scopeChipOnHint'), kind: 'project' }
      return { ...view, lines: scopeDetailLines(t, scope, { on, name, projectName, kind: view.kind }) }
    }

    const SCOPE_BASIS_KEYS = { 'git-origin': 'scopeBasis_gitOrigin', 'git-root': 'scopeBasis_gitRoot', folder: 'scopeBasis_folder', 'default-workspace': 'scopeBasis_defaultWorkspace', home: 'scopeBasis_home', none: 'scopeBasis_none' }

    /**
     * The chip's hover lines under "Mem0 memory partition": where new
     * memories go, how the project was decided (git origin, git root, folder,
     * DSH default workspace, home folder), the paths (the server shows the
     * home folder as ~) and the partition id.
     */
    function scopeDetailLines(t, scope, { on, name, projectName, kind }) {
      const detail = scope?.detail && typeof scope.detail === 'object' ? scope.detail : {}
      const text = (value) => String(value ?? '').slice(0, 400)
      const lines = [name ? template(t('scopePopProject'), { name }) : t('scopePopGlobal')]
      let basis
      if (!on) basis = t('scopeBasis_off')
      else if (kind === 'pending') basis = t('scopeBasis_pending')
      else basis = t(SCOPE_BASIS_KEYS[detail.basis] ?? 'scopeBasis_none')
      lines.push(template(t('scopePopBasis'), { basis }))
      if (!on && projectName) lines.push(template(t('scopePopWhenOn'), { name: projectName }))
      if (detail.gitError) lines.push(template(t('scopePopGitError'), { error: text(detail.gitError) }))
      if (detail.worktree) lines.push(t('scopePopWorktree'))
      if (detail.path) lines.push(template(t('scopePopPath'), { path: text(detail.path) }))
      if (detail.worktree && detail.checkout) lines.push(template(t('scopePopCheckout'), { path: text(detail.checkout) }))
      const shown = [detail.path, detail.checkout].filter(Boolean)
      if (detail.cwd && !shown.includes(detail.cwd)) lines.push(template(t('scopePopCwd'), { path: text(detail.cwd) }))
      const partition = name && scope.project?.id ? `project:${scope.project.id}` : 'global'
      lines.push(template(t('scopePopPartition'), { id: partition }))
      return lines
    }

    /** The "partition by project" switch as the config form holds it (undefined: not loaded). */
    function formPartitions(form) {
      try {
        const snapshot = form?.getSnapshot?.()
        if (snapshot?.status !== 'ready') return undefined
        return snapshot.value?.projectPartitions !== false
      } catch {
        return undefined
      }
    }

    let scopeTipCounter = 0

    /**
     * The scope chip: "Project" or "Global" for where new memories go; hover
     * or focus shows how that was decided; a click flips the switch (same
     * config as the settings page). DSH's `conversation.composer.dock` slot
     * takes plain React entries (no chip, tooltip or details props), so the
     * panel is the plugin's own, fixed-positioned like the dock's.
     */
    function ScopeChip({ ctx, t, scope }) {
      const form = useMemo(() => {
        try {
          return ctx.configForms?.get?.(ENTRY_ID) ?? null
        } catch {
          return null
        }
      }, [ctx])
      const [partitions, setPartitions] = useState(() => formPartitions(form))
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      // Hover / keyboard-focus panel with the details (fixed, from the chip's
      // rect, like the dock's failure panel: host containers clip overflow).
      const [tip, setTip] = useState(null)
      const tipRef = useRef(null)
      const tipId = useMemo(() => `mem0-scope-tip-${++scopeTipCounter}`, [])
      useLayoutEffect(() => {
        const element = tipRef.current
        if (!tip || !element) return
        const rect = element.getBoundingClientRect()
        const dx = rect.left - tip.left
        const dy = rect.bottom - (window.innerHeight - tip.bottom)
        if (Math.abs(dx) > 1) element.style.left = `${tip.left - dx}px`
        if (Math.abs(dy) > 1) element.style.bottom = `${tip.bottom + dy}px`
      }, [tip])
      useEffect(() => {
        if (!tip) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setTip(null)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [tip])
      useEffect(() => {
        if (!form?.subscribe) return undefined
        setPartitions(formPartitions(form))
        return form.subscribe(() => setPartitions(formPartitions(form)))
      }, [form])
      const view = scopeChipView(t, scope, partitions)
      if (!view) return null
      const flip = async () => {
        if (busy) return
        setFailed(false)
        const openSettings = () => {
          try {
            ctx.get('pluginNavigation')?.openBundle?.(PKG)
          } catch {
            // Navigation is optional.
          }
        }
        if (!form?.mutate || !form.getSnapshot) return openSettings()
        setBusy(true)
        try {
          const snapshot = form.getSnapshot()
          if (snapshot?.status !== 'ready' || snapshot.writable === false) return openSettings()
          const accepted = await form.mutate([{ op: 'set', path: ['projectPartitions'], value: !view.on }], snapshot.revision)
          if (!accepted) setFailed(true)
        } catch {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }
      const show = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const width = Math.min(360, window.innerWidth - 16)
        setTip({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          bottom: Math.max(8, window.innerHeight - rect.top + 6),
          width,
        })
      }
      const hide = () => setTip(null)
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'mem0-scope',
            'data-scope-kind': view.kind,
            'aria-pressed': view.on,
            // The chip says only "Project" / "Global"; its accessible name is whole.
            'aria-label': view.ariaLabel,
            'aria-describedby': tip ? tipId : undefined,
            disabled: busy,
            onMouseEnter: show,
            onMouseLeave: hide,
            onFocus: show,
            onBlur: hide,
            onClick: () => void flip(),
          },
          view.label,
        ),
        tip
          ? h(
              'div',
              {
                className: 'mem0-dock-pop mem0-scope-pop',
                role: 'tooltip',
                id: tipId,
                ref: tipRef,
                style: { left: `${tip.left}px`, bottom: `${tip.bottom}px`, maxWidth: `${tip.width}px` },
              },
              h('div', { className: 'mem0-scope-pop-title' }, t('scopePopTitle')),
              view.lines.map((line, index) => h('div', { className: 'mem0-dock-pop-line', key: index }, line)),
              h('div', { className: 'mem0-scope-pop-hint' }, view.hint),
              failed ? h('div', { className: 'mem0-scope-pop-failed' }, t('scopeChipSaveFailed')) : null,
            )
          : null,
      )
    }

    function MemoryDockStatus({ ctx, t, sessionId }) {
      const [data, setData] = useState(null)
      const [readFailure, setReadFailure] = useState(null)
      // Popover position (fixed, from the button's rect): the composer dock
      // sits inside host containers with overflow hidden/auto, which clip
      // anything positioned relative to it.
      const [open, setOpen] = useState(null)
      const rootRef = useRef(null)
      const popRef = useRef(null)

      // A transformed host ancestor turns `position: fixed` into a box
      // relative to that ancestor; measure once and shift by the difference.
      useLayoutEffect(() => {
        const element = popRef.current
        if (!open || !element) return
        const rect = element.getBoundingClientRect()
        const dx = rect.left - open.left
        const dy = rect.bottom - (window.innerHeight - open.bottom)
        if (Math.abs(dx) > 1) element.style.left = `${open.left - dx}px`
        if (Math.abs(dy) > 1) element.style.bottom = `${open.bottom + dy}px`
      }, [open])

      useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const session = sessionId ? `&session=${encodeURIComponent(String(sessionId))}` : ''
            const next = await fetchJson(`${ACTIVITY_PATH}?lang=${pageLanguage(ctx)}&translate=0${session}`)
            if (live) {
              setData(next)
              setReadFailure(null)
            }
          } catch (error) {
            if (live) {
              setReadFailure((previous) => ({
                message: error instanceof Error ? error.message : String(error),
                // Keep the time of the first failed read in a row.
                at: previous?.at ?? new Date().toISOString(),
              }))
            }
          }
        }
        void load()
        const timer = setInterval(() => void load(), 2000)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [sessionId])

      const view = dockView(t, {
        data,
        failed: Boolean(readFailure),
        fetchError: readFailure?.message,
        failedAt: readFailure?.at,
      })
      const details = view.details

      useEffect(() => {
        if (!details) setOpen(null)
      }, [Boolean(details)])

      const toggle = (event) => {
        if (open) return setOpen(null)
        const rect = event.currentTarget.getBoundingClientRect()
        const width = Math.min(360, window.innerWidth - 16)
        setOpen({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          bottom: Math.max(8, window.innerHeight - rect.top + 6),
          width,
        })
      }

      useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(null)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(null)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const openSettings = () => {
        setOpen(null)
        try {
          ctx.get('pluginNavigation')?.openBundle?.(PKG)
        } catch {
          // Navigation is optional; the indicator still works without it.
        }
      }

      return h(
        'span',
        { className: 'mem0-dock-wrap', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'mem0-dock',
            // Hover shows the cause; a click on a failure state opens it in place.
            title: details ? `${view.label}\n${details.join('\n')}` : t('dockOpen'),
            'aria-expanded': details ? Boolean(open) : undefined,
            'data-dock-kind': view.kind,
            onClick: details ? toggle : openSettings,
          },
          h(OrbStatus, { state: view.orb }),
          h('span', { className: 'mem0-dock-text' }, view.label),
        ),
        h(ScopeChip, { ctx, t, scope: data?.memoryScope ?? null }),
        details && open
          ? h(
              'div',
              {
                className: 'mem0-dock-pop',
                role: 'dialog',
                ref: popRef,
                style: { left: `${open.left}px`, bottom: `${open.bottom}px`, maxWidth: `${open.width}px` },
              },
              h('div', { className: 'mem0-dock-pop-title' }, view.label),
              details.map((line, index) => h('div', { className: 'mem0-dock-pop-line', key: index }, line)),
              h(
                'button',
                { type: 'button', className: 'mem0-dock-pop-link', onClick: openSettings },
                t('dockOpen'),
              ),
            )
          : null,
      )
    }

    /** The local SQLite store: file, open or not, last failure (activity card). */
    function StoreStatus({ t, store }) {
      return h(
        'div',
        { className: 'mem0-failures-block' },
        h('div', { className: 'mem0-activity-head', style: { marginTop: '12px' } }, h('span', { className: 'mem0-activity-title' }, t('storeTitle'))),
        ...storeLines(t, store).map((line, index) => h('p', { className: 'mem0-activity-meta', key: `s${index}` }, line)),
      )
    }

    /** "Recent failures" in the activity card (stored history, newest first). */
    function FailureList({ t, failures }) {
      const list = Array.isArray(failures) ? failures : []
      return h(
        'div',
        { className: 'mem0-failures-block' },
        h('div', { className: 'mem0-activity-head', style: { marginTop: '12px' } }, h('span', { className: 'mem0-activity-title' }, t('failuresTitle'))),
        h('p', { className: 'mem0-hint' }, list.length > 0 ? t('failuresHint') : t('failuresEmpty')),
        list.length > 0
          ? h(
              'div',
              { className: 'mem0-failures' },
              list.map((failure, index) => {
                const meta = [activityTime(failure.at), failure.backend]
                if (Number.isFinite(failure.durationMs)) meta.push(`${failure.durationMs} ms`)
                if (failure.status) meta.push(`HTTP ${failure.status}`)
                if (Number.isFinite(failure.stepElapsedMs) && failure.step) {
                  meta.push(template(t('failureStepRunning'), { step: t(`failureStep_${failure.step}`), ms: failure.stepElapsedMs }))
                }
                if (failure.count > 1) {
                  meta.push(template(t('failureRepeated'), { count: failure.count, since: activityTime(failure.firstAt) }))
                }
                if (Number.isInteger(failure.exitCode) || failure.signal) {
                  meta.push(template(t('failureExit'), { how: exitHow(t, failure), uptime: formatDuration(failure.uptimeMs) }))
                }
                if (failure.retry === 'failed') meta.push(t('failureRetryFailed'))
                return h(
                  'div',
                  { className: 'mem0-failure', key: `${failure.at}-${index}` },
                  h(
                    'div',
                    { className: 'mem0-failure-head' },
                    h('span', { className: 'mem0-chip mem0-state-error' }, failureCauseLabel(t, failure)),
                    h('strong', null, t(`failureKind_${failure.kind}`)),
                    h('span', { className: 'mem0-chip' }, failureComponentLabel(t, failure)),
                    h('span', { className: 'mem0-activity-meta' }, meta.filter(Boolean).join(' · ')),
                  ),
                  failure.message ? h('p', { className: 'mem0-failure-msg' }, failure.message) : null,
                )
              }),
            )
          : null,
      )
    }

    // ---- local setup wizard (lib/setup-routes.js) ------------------------

    const WIZARD_STEPS = ['embedder', 'llm', 'store', 'selftest', 'migrate']

    function emptyWizardDraft(state) {
      const current = state?.current
      const cloud = state?.recommendations?.cloud?.[0]
      const embedder = current?.embedder?.model
        ? {
            mode: /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(current.embedder.baseUrl || '') ? 'local' : 'cloud',
            provider: current.embedder.provider || 'openai',
            baseUrl: current.embedder.baseUrl || '',
            model: current.embedder.model || '',
            dims: current.embedder.dims || '',
            apiKeyRef: current.embedder.apiKeyRef || state?.refs?.embedder || '',
            // A local server with a stored key (API key verification on).
            keyTyped: Boolean(current.embedder.apiKeyRef),
          }
        : { mode: 'cloud', provider: 'openai', baseUrl: cloud?.baseUrl ?? '', model: cloud?.model ?? '', dims: cloud?.dims ?? '', apiKeyRef: state?.refs?.embedder ?? '' }
      // DSH's current model unless a model of its own was saved before.
      const llm = {
        provider: current?.llm?.provider === 'dsh' || !current?.llm?.model ? 'dsh' : 'openai',
        baseUrl: current?.llm?.baseUrl || '',
        model: current?.llm?.model || '',
        apiKeyRef: current?.llm?.apiKeyRef || state?.refs?.llm || '',
        maxTokens: current?.llm?.maxTokens || 8000,
        reasoningEffort: current?.llm?.reasoningEffort || '',
      }
      return {
        embedder,
        llm,
        storePath: current?.storePath && current.storePath !== '~/.dsh/mem0/memory.sqlite' ? current.storePath : '',
        useLiteralKey: { embedder: false, llm: false },
      }
    }

    /** The draft as the routes take it (no UI-only fields). */
    function wizardPayload(draft) {
      const embedder = { ...draft.embedder }
      delete embedder.mode
      // A local server needs no key: drop a leftover credential name.
      // A local OpenAI-compatible server may want one (API key verification
      // on): kept when typed now or stored for it before.
      if (draft.embedder.mode === 'local' && !draft.embedder.keyTyped) embedder.apiKeyRef = ''
      delete embedder.keyTyped
      // DSH's current model: only the choice (and the output budget) goes.
      const llm = draft.llm.provider === 'dsh'
        ? { provider: 'dsh', maxTokens: Number(draft.llm.maxTokens) || undefined }
        : { ...draft.llm, provider: 'openai', maxTokens: Number(draft.llm.maxTokens) || undefined }
      return { embedder, llm, storePath: draft.storePath, storeConfirmed: draft.storeConfirmed === true, useLiteralKey: draft.useLiteralKey }
    }

    /** `provider|host` of a server, as lib/setup-routes.js compares them. */
    function wizardServer(component, block) {
      const provider = component === 'llm' ? 'openai' : String(block?.provider || 'openai')
      const base = String(block?.baseUrl ?? '').trim()
      if (!base) return `${provider}|default`
      const match = /^https?:\/\/([^/?#]+)/i.exec(base)
      return `${provider}|${match ? match[1].toLowerCase() : 'invalid'}`
    }

    /** Whether the stored key applies to the draft (same name, provider and host as saved). */
    function storedKeyApplies(state, component, block) {
      const saved = state?.current?.[component]
      const info = state?.credentials?.[component]
      if (!saved || !info?.configured || !block?.apiKeyRef) return false
      return info.ref === block.apiKeyRef && (saved.apiKeyRef || '') === block.apiKeyRef && wizardServer(component, saved) === wizardServer(component, block)
    }

    /**
     * Why a model server call failed, in the page language, with what to do
     * next: from the route's structured `failure` (lib/setup-wizard.js
     * failureOf), never from its English text. Pure, for tests.
     */
    function failureText(t, failure) {
      if (!failure?.reason) return ''
      if (failure.reason === 'dsh') {
        const code = String(failure.code || '')
        const key = code && t(`wzFailDsh_${code}`) !== `wzFailDsh_${code}` ? `wzFailDsh_${code}` : 'wzFailDsh_other'
        return template(t(key), { model: failure.model || t('wzLlmDshModelAny'), code: code || '?' })
      }
      const service = failure.service || ''
      const values = {
        service,
        endpoint: failure.endpoint || '',
        status: failure.status ?? '',
        detail: failure.detail ? template(t('wzFailDetail'), { detail: failure.detail }) : '',
        example: failure.suggestedBaseUrl || `${failure.origin || 'http://127.0.0.1:8000'}/v1`,
        seconds: Number.isFinite(failure.timeoutMs) ? Math.max(0.1, Math.round(failure.timeoutMs / 100) / 10) : '?',
        starters: t(failure.platform === 'darwin' ? 'wzStartersMac' : 'wzStarters'),
        file: failure.keyFile || '~/.omlx/settings.json',
      }
      const named = (key) => (service ? key : `${key}Any`)
      let key
      switch (failure.reason) {
        case 'auth': {
          // Where each service keeps its key: oMLX settings.json, LM Studio
          // Developer → Server Settings; Ollama has none (a proxy asks).
          const id = failure.serviceId ?? ''
          key = id === 'omlx' ? (failure.keySent ? 'wzFail_authKeyOmlx' : 'wzFail_authOmlx')
            : id === 'lmstudio' ? (failure.keySent ? 'wzFail_authKeyLmStudio' : 'wzFail_authLmStudio')
              : id.startsWith('ollama') ? 'wzFail_authOllama'
                : failure.keySent ? 'wzFail_authKeyAny' : 'wzFail_authAny'
          break
        }
        case 'not_found':
          key = failure.suggestedBaseUrl ? 'wzFail_notFoundSuggest' : failure.provider === 'ollama' ? 'wzFail_notFoundOllama' : named('wzFail_notFound')
          break
        case 'refused':
          key = failure.local ? named('wzFail_refused') : 'wzFail_refusedRemote'
          break
        case 'timeout':
          key = failure.local ? named('wzFail_timeout') : 'wzFail_timeoutRemote'
          break
        case 'http':
          key = named('wzFail_http')
          break
        case 'bad_response':
          key = 'wzFail_badResponse'
          break
        case 'bad_url':
          key = 'wzFail_badUrl'
          break
        default:
          key = 'wzFail_network'
      }
      return template(t(key), values)
    }

    /** One probe line's state: what the page shows after the label and port. */
    function probeLineText(t, service) {
      if (service.ok) return template(t('wzServiceUp'), { label: service.label, port: service.port, count: service.models?.length ?? 0 })
      const reason = service.failure?.reason
      const text = reason === 'refused'
        ? template(t('wzProbeRefused'), { label: service.label })
        : reason === 'timeout'
          ? template(t('wzProbeTimeout'), { label: service.label })
          : service.failure ? failureText(t, service.failure) : String(service.error ?? '')
      return template(t('wzServiceDown'), { label: service.label, port: service.port, error: text })
    }

    /** What a click on "Read the key from oMLX" or "Show the settings file" gave. Pure, for tests. */
    function omlxActionText(t, result) {
      if (!result) return ''
      const values = { file: result.file ?? '', code: result.code ?? '' }
      if (result.action === 'reveal') {
        if (!result.ok) return template(t('wzOmlxReveal_missing_file'), values)
        return template(t(result.revealed ? 'wzOmlxRevealed' : 'wzOmlxFileAt'), values)
      }
      if (result.ok) return template(t('wzOmlxReadOk'), values)
      const key = `wzOmlxRead_${result.reason}`
      return template(t(key) !== key ? t(key) : t('wzOmlxRead_read_error'), values)
    }

    /**
     * The service the wizard fills in after a probe: the first one listing
     * embedding models, else the first listing any, else the first that
     * runs but needs a key. Only when the address is empty or one of the
     * probed ones (a typed address is kept). Pure, for tests.
     */
    function probeAutofill(services, embedder) {
      const list = Array.isArray(services) ? services : []
      const current = String(embedder?.baseUrl ?? '').trim()
      if (current && !list.some((service) => service.baseUrl === current)) return null
      return list.find((service) => service.ok && service.embeddingModels?.length)
        ?? list.find((service) => service.ok && service.models?.length)
        ?? list.find((service) => service.needsKey)
        ?? null
    }

    /** A route's failure in the page language; the server's English text after it. */
    function wizardError(t, result) {
      if (result?.failure?.reason) return failureText(t, result.failure)
      const code = result?.code
      const key = code ? `wzErr_${code}` : ''
      const local = key && t(key) !== key ? t(key) : ''
      const detail = String(result?.error ?? result?.message ?? '')
      if (local) return detail ? `${local} (${detail})` : local
      return template(t('wzFailed'), { error: detail })
    }

    function wizardStepName(t, name) {
      const key = `wzStepName_${name}`
      return name && t(key) !== key ? t(key) : String(name ?? '?')
    }

    function wizardKeys(keys) {
      const out = {}
      if (keys.embedder.trim()) out.embedder = keys.embedder.trim()
      if (keys.llm.trim()) out.llm = keys.llm.trim()
      return out
    }

    function storeCheckText(t, result) {
      if (!result) return ''
      if (!result.writable) return template(t('wzStoreNotWritable'), { path: result.path, error: result.error ?? '' })
      if (result.kind === 'sync') return template(t('wzStoreSync'), { path: result.path, provider: result.provider ?? '' })
      if (result.kind === 'network') return template(t('wzStoreNetwork'), { path: result.path })
      if (result.kind === 'unverified') return template(t('wzStoreUnverified'), { path: result.path, reason: result.reason ?? '' })
      if (result.kind === 'external') return template(t('wzStoreExternal'), { path: result.path })
      return template(t('wzStoreOk'), { path: result.path })
    }

    /**
     * What the LLM step shows for a test result, next to the test button:
     * `{ ok, badge, facts, details[], reason, advice[] }`. Pure, for tests.
     */
    function llmTestView(t, result) {
      if (!result) return null
      const stats = result.stats ?? {}
      const details = []
      if (stats.finishReason) details.push(template(t('wzLlmFinish'), { reason: stats.finishReason }))
      if (Number.isInteger(stats.completionTokens) || Number.isInteger(stats.maxTokens)) {
        let line = template(t('wzLlmOutput'), { used: stats.completionTokens ?? '?', max: stats.maxTokens ?? '?' })
        if (stats.reasoningTokens > 0) line += template(t('wzLlmReasoning'), { tokens: stats.reasoningTokens })
        details.push(line)
      }
      if (Number.isInteger(stats.promptTokens)) details.push(template(t('wzLlmPrompt'), { tokens: stats.promptTokens }))
      if (Number.isFinite(result.ms)) details.push(template(t('wzLlmTime'), { ms: result.ms }))
      if (result.via === 'dsh' && result.model) details.unshift(template(t('wzLlmDshUsed'), { model: result.model }))
      if (result.ok) {
        return { ok: true, badge: t('wzLlmPassed'), facts: template(t('wzLlmFacts'), { facts: result.facts ?? 0 }), details, reason: '', advice: llmAdvice(t, result.advice) }
      }
      let reason
      let advice = llmAdvice(t, result.advice)
      if (result.reason) {
        reason = t(`wzReason_${result.reason}`) !== `wzReason_${result.reason}` ? t(`wzReason_${result.reason}`) : result.reason
        if (advice.length === 0) advice = [t(result.reason === 'empty' ? 'wzAdviceEmpty' : result.reason === 'refusal' ? 'wzAdviceRefusal' : 'wzAdviceGeneric')]
      } else {
        reason = result.authFailed && !result.failure ? t('wzAuthFailed') : wizardError(t, result)
        // A failure's text says what to do next already.
        if (advice.length === 0 && !result.failure?.reason) {
          advice = [t(
            result.authFailed ? 'wzAdviceAuth'
              : result.code === 'ETIMEDOUT' ? 'wzAdviceTimeout'
                : result.code === 'NETWORK_ERROR' ? 'wzAdviceNetwork'
                  : result.status === 404 ? 'wzAdviceNotFound'
                    : 'wzAdviceGeneric',
          )]
        }
      }
      return { ok: false, badge: t('wzLlmFailed'), facts: '', details, reason: template(t('wzLlmReason'), { reason }), advice }
    }

    /** The LLM test result: a green or red card right under the test button. */
    function LlmTestResult({ t, result }) {
      const view = llmTestView(t, result)
      if (!view) return null
      return h('div', { className: 'mem0-wz-result', 'data-ok': view.ok ? 'true' : 'false', role: 'status', 'aria-live': 'polite' },
        h('p', { className: 'mem0-wz-result-title' }, `${view.ok ? '✓' : '✗'} ${view.badge}${view.facts ? ` · ${view.facts}` : ''}`),
        view.details.length ? h('p', { className: 'mem0-wz-result-meta' }, view.details.join(' · ')) : null,
        view.reason ? h('p', { className: 'mem0-wz-result-line' }, view.reason) : null,
        ...view.advice.map((line, i) => h('p', { key: `advice-${i}`, className: 'mem0-wz-result-line' }, template(t('wzLlmSuggest'), { advice: line }))),
        h('p', { className: 'mem0-wz-result-keep' }, t('wzLlmKeep')),
      )
    }

    function llmAdvice(t, advice) {
      const map = { 'raise-max-tokens': 'wzAdviceRaise', 'lower-effort': 'wzAdviceEffort', 'json-mode': 'wzAdviceJson', 'other-model': 'wzAdviceOtherModel' }
      return (advice ?? []).map((code) => (map[code] ? t(map[code]) : '')).filter(Boolean)
    }

    function migrationText(t, report) {
      return template(t('wzMigrated'), {
        imported: report.imported ?? 0,
        vectors: report.vectors === 'copied' ? t('wzVectorsCopied') : t('wzVectorsRecomputed'),
        skipped: report.skippedExisting ?? 0,
        empty: report.skippedEmpty ?? 0,
      })
    }

    function ReservedPortHint({ t, hint }) {
      if (!hint?.command) return null
      return h(
        'div',
        { className: 'mem0-hint mem0-wz-note' },
        h('span', null, t('wzReserved')),
        h('code', { className: 'mem0-wz-code' }, hint.command),
      )
    }

    function ResultLine({ ok, text }) {
      if (!text) return null
      return h('p', { className: ok ? 'mem0-wz-ok' : 'mem0-error' }, text)
    }

    /** "Change to …/v1" after a 404 from an address without a path. */
    function SuggestedUrl({ t, failure, onUse }) {
      const url = failure?.suggestedBaseUrl
      if (!url) return null
      return h('div', { className: 'mem0-wz-row' }, h('button', { type: 'button', className: 'mem0-secondary', onClick: () => onUse(url) }, template(t('wzUseSuggested'), { url })))
    }

    function SetupWizard({ t, backend, onClose, onEnable }) {
      const [state, setState] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [step, setStep] = useState('embedder')
      const [draft, setDraft] = useState(null)
      const [keys, setKeys] = useState({ embedder: '', llm: '' })
      const [busy, setBusy] = useState('')
      const [results, setResults] = useState({})
      const [services, setServices] = useState(null)
      const [models, setModels] = useState({ embedder: [], llm: [] })
      const [qdrant, setQdrant] = useState({ url: '', collection: '', copyVectors: false })
      const [skipped, setSkipped] = useState(false)
      // The "LLM not tested" notice was shown once for this step visit.
      const [untestedWarned, setUntestedWarned] = useState(false)
      // DSH's current model (names only), refreshed while the LLM step shows it.
      const [dshModel, setDshModel] = useState(null)
      const lastDshName = useRef(null)
      const followsDshNow = step === 'llm' && draft?.llm?.provider === 'dsh'
      useEffect(() => {
        if (!followsDshNow) return undefined
        let stopped = false
        const refresh = async () => {
          try {
            const data = await fetchJson(SETUP_PATH, { method: 'POST', retry: false, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dshModel' }) })
            if (stopped || !data?.dshModel) return
            // Another model now: earlier test results were for the old one.
            const name = data.dshModel.name ?? ''
            if (lastDshName.current !== null && lastDshName.current !== name) setResults((current) => ({ ...current, llm: null, selftest: null }))
            lastDshName.current = name
            setDshModel(data.dshModel)
          } catch {
            // the last known model stays shown
          }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), 3000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [followsDshNow])

      const load = useCallback(async () => {
        try {
          const data = await fetchJson(SETUP_PATH)
          setState(data)
          setDraft((current) => current ?? emptyWizardDraft(data))
          setQdrant((current) => current.url || current.collection
            ? current
            : { url: data?.legacy?.endpoint ?? '', collection: data?.legacy?.collection ?? 'dsh_mem0', copyVectors: false })
          return data
        } catch (error) {
          setLoadError(error.message)
          return null
        }
      }, [])

      useEffect(() => {
        let resumed = false
        void load().then((data) => {
          // A job still running (page reloaded): show it and keep polling.
          for (const job of data?.jobs ?? []) {
            if (resumed) break
            const key = job.kind === 'migrate' ? 'migrate' : job.kind === 'save' ? 'save' : null
            if (!key) continue
            resumed = true
            setStep(key === 'migrate' ? 'migrate' : 'selftest')
            setResults((current) => ({ ...current, [key]: { id: job.id, cancellable: job.cancellable === true, running: true, progress: job.progress } }))
            void pollJobRef.current?.(job.id, key).then((done) => {
              if (done?.state === 'done') void load()
            })
          }
        })
      }, [load])

      const post = async (action, extra = {}) => {
        setBusy(action)
        try {
          return await fetchJson(SETUP_PATH, {
            method: 'POST',
            retry: false,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, draft: draft ? wizardPayload(draft) : undefined, keys: wizardKeys(keys), ...extra }),
          })
        } catch (error) {
          return { ok: false, error: error.message }
        } finally {
          setBusy('')
        }
      }

      const record = (key, value) => setResults((current) => ({ ...current, [key]: value }))
      const setEmbedder = (patch) => {
        setDraft((current) => ({ ...current, embedder: { ...current.embedder, ...patch } }))
        record('embedder', null)
        record('selftest', null)
      }
      const setLlm = (patch) => {
        setDraft((current) => ({ ...current, llm: { ...current.llm, ...patch } }))
        record('llm', null)
        record('selftest', null)
      }

      const pollJobRef = useRef(null)
      const pollJob = async (id, key) => {
        for (let attempt = 0; attempt < 3600; attempt += 1) {
          await delay(attempt < 5 ? 300 : 1000)
          let data
          try {
            data = await fetchJson(`${SETUP_PATH}?job=${encodeURIComponent(id)}`)
          } catch {
            continue
          }
          const job = data?.job
          if (!job) continue
          record(key, { id: job.id, cancellable: job.cancellable === true, running: job.state === 'running', progress: job.progress, result: job.result, error: job.error })
          if (job.state !== 'running') return job
        }
        return null
      }
      pollJobRef.current = pollJob
      // A running migration or re-embedding can be stopped; nothing is changed then.
      const cancelButton = (entry, key) =>
        entry?.running && entry.id && entry.cancellable
          ? h('button', { key, type: 'button', className: 'mem0-secondary', onClick: () => void post('cancelJob', { job: entry.id }) }, t('wzCancel'))
          : null

      if (loadError) {
        return h('div', { className: 'mem0-card mem0-section mem0-wz' }, h('p', { className: 'mem0-error' }, template(t('wzFailed'), { error: loadError })), h('button', { type: 'button', className: 'mem0-secondary', onClick: onClose }, t('wzClose')))
      }
      if (!state || !draft) return h('div', { className: 'mem0-card mem0-section mem0-wz' }, h('p', { className: 'mem0-hint' }, t('checking')))

      const isMac = state.platform === 'darwin'
      const isWindows = state.platform === 'win32'
      const steps = WIZARD_STEPS
      const index = steps.indexOf(step)

      const keyField = (component, value, setValue, { optional = false } = {}) => {
        const info = state.credentials?.[component]
        const ref = draft[component].apiKeyRef
        const stored = storedKeyApplies(state, component, draft[component])
        const moved = !stored && info?.configured && info.ref === ref && !value.trim()
        return [
          h(TextField, {
            key: `${component}-key`,
            label: t('wzKey'),
            hint: !value.trim() && results[`omlx:${component}`]?.ok && results[`omlx:${component}`]?.action === 'read'
              ? omlxActionText(t, results[`omlx:${component}`])
              : stored ? template(t('wzKeyStored'), { ref }) : moved ? t('wzKeyNewServer') : optional ? t('wzLocalKeyHint') : t('wzKeyHint'),
            type: 'password',
            autoComplete: 'off',
            value,
            onChange: (next) => {
              setValue(next)
              if (component === 'embedder') setDraft((current) => ({ ...current, embedder: { ...current.embedder, keyTyped: Boolean(next.trim()) || Boolean(state.current?.embedder?.apiKeyRef) } }))
              record(component, null)
              record('selftest', null)
            },
          }),
          h(TextField, {
            key: `${component}-ref`,
            label: t('wzKeyRef'),
            value: ref,
            placeholder: state.refs?.[component],
            onChange: (next) => (component === 'embedder' ? setEmbedder({ apiKeyRef: next.trim() }) : setLlm({ apiKeyRef: next.trim() })),
          }),
          state.current?.[component]?.literalKey
            ? h(ToggleRow, {
                key: `${component}-literal`,
                label: t('wzLiteral'),
                checked: draft.useLiteralKey?.[component] === true,
                onChange: (checked) => setDraft((current) => ({ ...current, useLiteralKey: { ...current.useLiteralKey, [component]: checked } })),
              })
            : null,
        ]
      }

      const testEmbedderNow = async () => {
        const result = await post('testEmbedder')
        record('embedder', result)
        if (result?.ok && result.dims) setEmbedder({ dims: result.dims })
        if (result?.ok) record('embedder', result)
      }

      const useService = (service) => {
        const first = service.embeddingModels?.[0] ?? ''
        setEmbedder({ provider: service.provider, baseUrl: service.baseUrl, model: first, dims: '' })
        setModels((current) => ({ ...current, embedder: service.embeddingModels?.length ? service.embeddingModels : service.models ?? [] }))
      }

      // oMLX answered 401/403: read its key server side (the page never gets
      // it), then list models and test again; or show where the file is.
      const readOmlxKey = async (component) => {
        const result = { action: 'read', ...(await post('readOmlxKey', { component })) }
        record(`omlx:${component}`, result)
        if (!result.ok) return
        if (component === 'embedder') setDraft((current) => ({ ...current, embedder: { ...current.embedder, keyTyped: true } }))
        const listed = await post('listModels', { component })
        if (component === 'embedder') setModels((current) => ({ ...current, embedder: listed?.embeddingModels?.length ? listed.embeddingModels : listed?.models ?? [] }))
        else setModels((current) => ({ ...current, llm: (listed?.models ?? []).filter((name) => !/embed/i.test(name)) }))
        if (!listed?.ok) {
          record(component, listed)
          return
        }
        record(component, null)
        if (!draft[component].model) return
        if (component === 'embedder') await testEmbedderNow()
        else record('llm', await post('testLlm'))
      }
      const revealOmlx = async (component) => record(`omlx:${component}`, { action: 'reveal', ...(await post('revealOmlxSettings')) })
      const omlxActions = (component, failure) => {
        if (failure?.reason !== 'auth' || failure.serviceId !== 'omlx') return null
        const done = results[`omlx:${component}`]
        return h('div', { key: `omlx-${component}`, className: 'mem0-wz-list' },
          h('div', { className: 'mem0-wz-row' },
            h('button', { type: 'button', className: 'mem0-secondary', disabled: Boolean(busy), onClick: () => void readOmlxKey(component) }, t('wzOmlxRead')),
            h('button', { type: 'button', className: 'mem0-secondary', disabled: Boolean(busy), onClick: () => void revealOmlx(component) }, t(isMac ? 'wzOmlxReveal' : 'wzOmlxRevealOther')),
          ),
          done ? h(ResultLine, { ok: Boolean(done.ok), text: omlxActionText(t, done) }) : null,
        )
      }

      const embedderStep = () => {
        const e = draft.embedder
        const result = results.embedder
        const cloud = state.recommendations?.cloud ?? []
        const preset = cloud.find((item) => item.baseUrl === e.baseUrl && item.model === e.model)?.id ?? 'custom'
        const body = [
          h(
            'div',
            { key: 'mode', className: 'mem0-segments mem0-wz-modes' },
            [['cloud', t('wzCloud')], ['local', t('wzLocal')]].map(([id, label]) =>
              h('button', {
                key: id,
                type: 'button',
                className: 'mem0-segment',
                'data-active': e.mode === id ? 'true' : 'false',
                onClick: () => setEmbedder(id === 'cloud'
                  ? { mode: 'cloud', provider: 'openai', baseUrl: cloud[0]?.baseUrl ?? '', model: cloud[0]?.model ?? '', dims: cloud[0]?.dims ?? '', apiKeyRef: e.apiKeyRef || state.refs?.embedder }
                  : { mode: 'local', baseUrl: '', model: '', dims: '' }),
              }, label),
            ),
          ),
          h('p', { key: 'mode-hint', className: 'mem0-hint' }, e.mode === 'cloud' ? t('wzCloudHint') : isMac ? t('wzLocalHintMac') : t('wzLocalHint')),
        ]
        if (e.mode === 'cloud') {
          body.push(
            h(SelectField, {
              key: 'preset',
              label: t('wzPreset'),
              value: preset,
              options: [...cloud.map((item) => ({ value: item.id, label: `${item.label} (${item.dims})` })), { value: 'custom', label: t('wzPresetCustom') }],
              onChange: (id) => {
                const item = cloud.find((entry) => entry.id === id)
                if (item) setEmbedder({ provider: 'openai', baseUrl: item.baseUrl, model: item.model, dims: item.dims })
              },
            }),
          )
        } else {
          body.push(
            h('div', { key: 'detect', className: 'mem0-wz-row' },
              h('button', {
                type: 'button',
                className: 'mem0-secondary',
                disabled: busy === 'probe',
                onClick: async () => {
                  const result = await post('probe')
                  const found = result?.services ?? []
                  setServices(found)
                  // Fill in a running service (one that needs a key too).
                  const pick = probeAutofill(found, e)
                  if (pick) useService(pick)
                },
              }, busy === 'probe' ? t('wzDetecting') : t('wzDetect')),
            ),
          )
          if (services) {
            body.push(h('div', { key: 'services', className: 'mem0-wz-list' }, services.map((service) =>
              h('div', { key: service.id, className: 'mem0-wz-item' },
                h('span', null, probeLineText(t, service)),
                service.ok || service.running
                  ? h('button', {
                      type: 'button',
                      className: 'mem0-secondary',
                      onClick: () => useService(service),
                    }, t('wzUse'))
                  : null,
                service.hint ? h(ReservedPortHint, { t, hint: service.hint }) : null,
                service.needsKey && e.baseUrl === service.baseUrl ? omlxActions('embedder', service.failure) : null,
              ),
            )))
            const refused = services.filter((service) => !service.ok && !service.hint && service.error === 'not running')
            if (isWindows && refused.length > 0) {
              body.push(h('div', { key: 'refused', className: 'mem0-hint mem0-wz-note' },
                h('span', null, template(t('wzRefusedSummary'), { list: refused.map((service) => `${service.label} (${service.port})`).join(', ') })),
                h('code', { className: 'mem0-wz-code' }, 'netsh int ipv4 show excludedportrange protocol=tcp'),
              ))
            }
          }
          body.push(h('p', { key: 'recommended', className: 'mem0-hint' }, `${t('wzRecommended')}: ${(state.recommendations?.local ?? []).map((item, i) => template(t(i === 0 ? 'wzModelDimsBest' : 'wzModelDims'), { model: item.model, dims: item.dims })).join(' · ')}`))
          body.push(h(SelectField, {
            key: 'provider',
            label: t('wzProvider'),
            value: e.provider,
            options: [{ value: 'ollama', label: 'Ollama' }, { value: 'openai', label: t('wzOpenAiCompatible') }],
            onChange: (value) => setEmbedder({ provider: value }),
          }))
        }
        body.push(
          h(TextField, { key: 'url', label: t('wzBaseUrl'), value: e.baseUrl, placeholder: e.mode === 'local' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1', onChange: (value) => setEmbedder({ baseUrl: value }) }),
          models.embedder.length > 0
            ? h(SelectField, {
                key: 'model-pick',
                label: t('wzModel'),
                value: models.embedder.includes(e.model) ? e.model : '',
                options: [{ value: '', label: '—' }, ...models.embedder.map((name) => ({ value: name, label: name }))],
                onChange: (value) => value && setEmbedder({ model: value, dims: '' }),
              })
            : null,
          h(TextField, { key: 'model', label: models.embedder.length > 0 ? t('wzModelTyped') : t('wzModel'), value: e.model, onChange: (value) => setEmbedder({ model: value, dims: '' }) }),
        )
        if (e.mode === 'cloud') body.push(...keyField('embedder', keys.embedder, (value) => setKeys((current) => ({ ...current, embedder: value }))))
        // A local server may have API key verification on (oMLX, LM Studio,
        // a proxy in front of Ollama): an optional key, stored like a cloud one.
        else body.push(...keyField('embedder', keys.embedder, (value) => setKeys((current) => ({ ...current, embedder: value })), { optional: true }))
        body.push(
          h('div', { key: 'actions', className: 'mem0-wz-row' },
            h('button', {
              type: 'button',
              className: 'mem0-secondary',
              disabled: busy === 'listModels' || !e.baseUrl,
              onClick: async () => {
                const result = await post('listModels', { component: 'embedder' })
                setModels((current) => ({ ...current, embedder: result?.embeddingModels?.length ? result.embeddingModels : result?.models ?? [] }))
                if (!result?.ok) record('embedder', result)
              },
            }, t('wzListModels')),
            h('button', { type: 'button', className: 'mem0-primary', disabled: busy === 'testEmbedder' || !e.baseUrl || !e.model, onClick: testEmbedderNow }, busy === 'testEmbedder' ? t('wzTesting') : t('wzTest')),
          ),
        )
        if (result) {
          if (result.ok) {
            body.push(h(ResultLine, { key: 'ok', ok: true, text: template(t('wzEmbedOk'), { dims: result.dims }) }))
            if (result.dimsDiffer) body.push(h(ResultLine, { key: 'dims', ok: false, text: template(t('wzDimsDiffer'), result.dimsDiffer) }))
          } else {
            body.push(h(ResultLine, { key: 'err', ok: false, text: result.authFailed && !result.failure ? t('wzAuthFailed') : wizardError(t, result) }))
            body.push(h(SuggestedUrl, { key: 'suggest', t, failure: result.failure, onUse: (url) => setEmbedder({ baseUrl: url }) }))
            body.push(omlxActions('embedder', result.failure))
            if (result.hint) body.push(h(ReservedPortHint, { key: 'hint', t, hint: result.hint }))
          }
          if (result.storeMismatch) {
            body.push(
              h(ResultLine, { key: 'mismatch', ok: false, text: template(t('wzStoreMismatch'), result.storeMismatch) }),
              h('p', { key: 'reembed', className: 'mem0-hint' }, template(t('wzReembedOnSave'), result.storeMismatch)),
            )
          }
        }
        return body
      }

      const llmStep = () => {
        const l = draft.llm
        const result = results.llm
        const followsDsh = l.provider === 'dsh'
        const modes = h(
          'div',
          { key: 'mode', className: 'mem0-segments mem0-wz-modes' },
          [['dsh', t('wzLlmViaDsh')], ['openai', t('wzLlmViaManual')]].map(([id, label]) =>
            h('button', { key: id, type: 'button', className: 'mem0-segment', 'data-active': (followsDsh ? 'dsh' : 'openai') === id ? 'true' : 'false', onClick: () => setLlm({ provider: id }) }, label),
          ),
        )
        const badge = busy === 'testLlm'
          ? null
          : h('span', { className: 'mem0-wz-badge', 'data-ok': result ? (result.ok ? 'true' : 'false') : 'none' }, result ? `${result.ok ? '✓' : '✗'} ${t(result.ok ? 'wzLlmPassed' : 'wzLlmFailed')}` : t('wzLlmUntestedBadge'))
        if (followsDsh) {
          const current = dshModel ?? state.dshModel
          const body = [
            modes,
            h('p', { key: 'hint', className: 'mem0-hint' }, t('wzLlmDshHint')),
            h(ResultLine, {
              key: 'model',
              ok: Boolean(current?.available),
              text: current?.available ? template(t('wzLlmDshNow'), { model: current.name }) : current?.reason === 'no_service' ? t('wzLlmDshNoService') : t('wzLlmDshNone'),
            }),
            h('p', { key: 'billing', className: 'mem0-hint' }, t('wzLlmDshBilling')),
            h('div', { key: 'actions', className: 'mem0-wz-row' },
              h('button', { type: 'button', className: 'mem0-primary', disabled: busy === 'testLlm', onClick: async () => record('llm', await post('testLlm')) }, busy === 'testLlm' ? t('wzTesting') : t('wzTest')),
              badge,
            ),
          ]
          if (result) body.push(h(LlmTestResult, { key: 'result', t, result }))
          return body
        }
        const body = [
          modes,
          h('p', { key: 'hint', className: 'mem0-hint' }, t('wzLlmHint')),
          h('p', { key: 'hygiene-billing', className: 'mem0-hint' }, t('wzHygieneBilling')),
          h(TextField, { key: 'url', label: t('wzBaseUrl'), value: l.baseUrl, placeholder: 'https://api.deepseek.com', onChange: (value) => setLlm({ baseUrl: value }) }),
          models.llm.length > 0
            ? h(SelectField, {
                key: 'model-pick',
                label: t('wzModel'),
                value: models.llm.includes(l.model) ? l.model : '',
                options: [{ value: '', label: '—' }, ...models.llm.map((name) => ({ value: name, label: name }))],
                onChange: (value) => value && setLlm({ model: value }),
              })
            : null,
          h(TextField, { key: 'model', label: models.llm.length > 0 ? t('wzModelTyped') : t('wzModel'), value: l.model, onChange: (value) => setLlm({ model: value }) }),
          ...keyField('llm', keys.llm, (value) => {
            setKeys((current) => ({ ...current, llm: value }))
            record('llm', null)
            record('selftest', null)
          }),
          h(TextField, { key: 'max', label: t('wzMaxTokens'), value: String(l.maxTokens ?? ''), onChange: (value) => setLlm({ maxTokens: value.replace(/[^0-9]/g, '') }) }),
          h(TextField, { key: 'effort', label: t('wzEffort'), hint: t('wzEffortHint'), value: l.reasoningEffort, onChange: (value) => setLlm({ reasoningEffort: value.trim().toLowerCase() }) }),
          h('div', { key: 'actions', className: 'mem0-wz-row' },
            h('button', {
              type: 'button',
              className: 'mem0-secondary',
              disabled: busy === 'listModels' || !l.baseUrl,
              onClick: async () => {
                const listed = await post('listModels', { component: 'llm' })
                setModels((current) => ({ ...current, llm: (listed?.models ?? []).filter((name) => !/embed/i.test(name)) }))
                if (!listed?.ok) record('llm', listed)
              },
            }, t('wzListModels')),
            h('button', { type: 'button', className: 'mem0-primary', disabled: busy === 'testLlm' || !l.baseUrl || !l.model, onClick: async () => record('llm', await post('testLlm')) }, busy === 'testLlm' ? t('wzTesting') : t('wzTest')),
            // Right beside the button: passed, failed or not tested yet.
            badge,
          ),
        ]
        if (result) {
          body.push(h(LlmTestResult, { key: 'result', t, result }))
          body.push(h(SuggestedUrl, { key: 'suggest', t, failure: result.failure, onUse: (url) => setLlm({ baseUrl: url }) }))
          body.push(omlxActions('llm', result.failure))
          if (result.hint) body.push(h(ReservedPortHint, { key: 'hint', t, hint: result.hint }))
        }
        return body
      }

      const storeStep = () => {
        const result = results.store
        const editing = Boolean(draft.storePath) || results.storeEditing === true
        return [
          h('p', { key: 'where', className: 'mem0-hint' }, template(t('wzStoreWhere'), { path: draft.storePath || state.store?.path || '~/.dsh/mem0/memory.sqlite' })),
          editing
            ? h(TextField, {
                key: 'path',
                label: t('wzStorePath'),
                hint: t('wzStoreHint'),
                value: draft.storePath,
                placeholder: '~/.dsh/mem0/memory.sqlite',
                className: 'mem0-grid-single',
                onChange: (value) => {
                  setDraft((current) => ({ ...current, storePath: value, storeConfirmed: false }))
                  record('store', null)
                  record('selftest', null)
                },
              })
            : h('div', { key: 'change', className: 'mem0-wz-row' }, h('button', { type: 'button', className: 'mem0-secondary', onClick: () => record('storeEditing', true) }, t('wzStoreChange'))),
          h('div', { key: 'actions', className: 'mem0-wz-row' },
            h('button', { type: 'button', className: 'mem0-primary', disabled: busy === 'checkStore', onClick: async () => record('store', await post('checkStore')) }, busy === 'checkStore' ? t('wzTesting') : t('wzCheck')),
          ),
          result ? h(ResultLine, { key: 'result', ok: Boolean(result.ok), text: result.error && !result.path ? template(t('wzFailed'), { error: result.error }) : storeCheckText(t, result) }) : null,
          result?.kind === 'unverified'
            ? h(ToggleRow, {
                key: 'confirm',
                label: t('wzStoreConfirm'),
                checked: draft.storeConfirmed === true,
                onChange: (checked) => {
                  setDraft((current) => ({ ...current, storeConfirmed: checked }))
                  record('selftest', null)
                },
              })
            : null,
          state.store?.memoryCount > 0 && !draft.storePath ? h('p', { key: 'count', className: 'mem0-hint' }, template(t('wzStoreHas'), { count: state.store.memoryCount })) : null,
        ]
      }

      const stepLabel = (name, item) => name === 'model' ? template(t('wzCheckModel'), { model: item?.model || t('wzLlmDshModelAny') }) : t({ write: 'wzCheckWrite', search: 'wzCheckSearch', delete: 'wzCheckDelete', leftover: 'wzCheckLeftover', store: 'wzStepStore', credentials: 'wzCheckCredentials' }[name] ?? 'wzCheckWrite')

      const saveNow = async (extra = {}) => {
        let outcome = await post('save', extra)
        if (outcome?.ok && outcome.job?.id) {
          // Vectors to recompute first: a job.
          record('save', { running: true })
          const job = await pollJob(outcome.job.id, 'save')
          outcome = job?.state === 'done' ? job.result : { ok: false, step: job?.error?.step ?? 'reembed', code: job?.error?.code ?? null, error: job?.error?.message ?? '' }
        }
        record('save', outcome)
        if (outcome?.ok) {
          setKeys({ embedder: '', llm: '' })
          if (backend !== 'oss') await onEnable?.()
          await delay(800)
          const fresh = await load()
          const legacy = fresh?.legacy ?? state.legacy
          if ((legacy?.detected || legacy?.possible) && !(fresh?.migration ?? state.migration)) setStep('migrate')
        }
      }

      const selfTestStep = () => {
        const result = results.selftest
        const saved = results.save
        const body = [
          h('p', { key: 'hint', className: 'mem0-hint' }, template(t('wzSelfTestHint'), { user: state.selftestUserId })),
          state.shadowed?.length ? h('p', { key: 'shadowed', className: 'mem0-error' }, template(t('wzShadowed'), { fields: state.shadowed.join(', ') })) : null,
          h('div', { key: 'actions', className: 'mem0-wz-row' },
            h('button', { type: 'button', className: 'mem0-secondary', disabled: Boolean(busy), onClick: async () => record('selftest', await post('selfTest')) }, busy === 'selfTest' ? t('wzTesting') : t('wzRunSelfTest')),
            h('button', {
              type: 'button',
              className: 'mem0-primary',
              disabled: Boolean(busy) || !result?.ok,
              onClick: () => saveNow(),
            }, busy === 'save' ? t('wzSaving') : t('wzSaveEnable')),
          ),
        ]
        if (result?.steps?.length) {
          body.push(h('div', { key: 'steps', className: 'mem0-wz-list' }, result.steps.map((item) =>
            h('div', { key: item.step, className: item.ok ? 'mem0-wz-ok' : 'mem0-error' }, `${item.ok ? '✓' : '✗'} ${stepLabel(item.step, item)}${item.error ? `: ${item.error}` : ''}`),
          )))
        }
        if (result) {
          if (result.ok) body.push(h(ResultLine, { key: 'ok', ok: true, text: t('wzSelfTestOk') }))
          else if (result.failure?.reason) {
            // A model server failed: why, and what to do (the step to go back to).
            body.push(h(ResultLine, { key: 'err', ok: false, text: `${result.component === 'llm' ? t('wzStepLlm') : t('wzStepEmbedder')}: ${failureText(t, result.failure)}` }))
          } else if (!result.steps?.length || result.step === 'store') body.push(h(ResultLine, { key: 'err', ok: false, text: result.location ? storeCheckText(t, result.location) : result.authFailed || result.probe?.authFailed ? t('wzAuthFailed') : wizardError(t, result) }))
          if (result.ok && result.reembed > 0) body.push(h('p', { key: 'reembed', className: 'mem0-hint' }, template(t('wzReembedOnSave'), { memories: result.reembed })))
          if (result.code === 'EMBEDDER_MISMATCH') body.push(h('p', { key: 'mismatch', className: 'mem0-hint' }, t('wzMismatchGoBack')))
        }
        if (saved?.running) body.push(h('p', { key: 'saving', className: 'mem0-hint' }, template(t('wzProgress'), { done: saved.progress?.done ?? 0, total: saved.progress?.total ?? '?' })), cancelButton(saved, 'cancel-save'))
        if (saved && !saved.running) {
          if (saved.ok) {
            body.push(h(ResultLine, {
              key: 'saved',
              ok: true,
              text: template(t('wzSaved'), {
                path: saved.written?.path ?? '',
                backup: saved.written?.backup ? template(t('wzBackup'), { backup: saved.written.backup }) : '',
                refs: saved.storedCredentials?.length ? saved.storedCredentials.join(', ') : t('wzNone'),
              }),
            }))
            if (saved.reembedded > 0) body.push(h(ResultLine, { key: 'reembedded', ok: true, text: template(t('wzReembedDone'), { count: saved.reembedded }) }))
            if (saved.written?.backupHasKeys) body.push(h('p', { key: 'backup-keys', className: 'mem0-hint' }, template(t('wzBackupHasKeys'), { backup: saved.written.backup ?? '' })))
          } else if (saved.code === 'REF_EXISTS') {
            body.push(
              h(ResultLine, { key: 'ref-exists', ok: false, text: template(t('wzRefExists'), { ref: saved.ref ?? '' }) }),
              h('div', { key: 'ref-replace', className: 'mem0-wz-row' }, h('button', { type: 'button', className: 'mem0-secondary', disabled: Boolean(busy), onClick: () => saveNow({ overwriteRefs: [saved.ref] }) }, template(t('wzRefReplace'), { ref: saved.ref ?? '' }))),
            )
          } else if (saved.step === 'credentials') {
            body.push(h(ResultLine, { key: 'cred', ok: false, text: template(t(saved.reason === 'no-service' || saved.reason === 'read-only' ? 'wzCredNoService' : 'wzFailed'), { ref: saved.ref ?? '', error: saved.error ?? '' }) }))
          } else {
            body.push(h(ResultLine, { key: 'save-err', ok: false, text: wizardError(t, saved) }))
          }
        }
        return body
      }

      const migrateStep = () => {
        const pre = results.preflight
        const run = results.migrate
        const enabled = state.backend === 'oss'
        const body = [
          h('p', { key: 'intro', className: 'mem0-hint' }, template(t('wzMigrateIntro'), { user: state.userId ?? '', collection: qdrant.collection || 'dsh_mem0' })),
          state.legacy?.possible && !state.legacy?.detected && !state.migration ? h('p', { key: 'possible', className: 'mem0-hint' }, template(t('wzLegacyPossible'), { endpoint: state.legacy.endpoint ?? '' })) : null,
        ]
        if (state.migration) {
          body.push(h(ResultLine, { key: 'done', ok: true, text: template(t('wzAlreadyMigrated'), { at: activityTime(state.migration.at), imported: state.migration.imported, endpoint: state.migration.endpoint ?? '' }) }))
          body.push(h('p', { key: 'left', className: 'mem0-hint' }, t('upgradeQdrantMigrated')))
        }
        if (!enabled) {
          body.push(h('p', { key: 'enable', className: 'mem0-error' }, t('wzNeedEnable')))
          return body
        }
        body.push(
          h(TextField, { key: 'url', label: t('wzQdrantUrl'), hint: t('wzQdrantHint'), value: qdrant.url, placeholder: isWindows ? '127.0.0.1:15333' : '127.0.0.1:6333', onChange: (value) => { setQdrant((current) => ({ ...current, url: value })); record('preflight', null) } }),
          // Only the collections of this setup; never typed freely.
          (state.legacy?.collections ?? []).length > 1
            ? h(SelectField, { key: 'collection', label: t('wzCollection'), value: qdrant.collection, options: state.legacy.collections.map((name) => ({ value: name, label: name })), onChange: (value) => { setQdrant((current) => ({ ...current, collection: value })); record('preflight', null) } })
            : h('p', { key: 'collection', className: 'mem0-hint' }, `${t('wzCollection')}: ${qdrant.collection || 'dsh_mem0'}`),
          state.migration
            ? h(ToggleRow, { key: 'again', label: t('wzMigrateAgain'), checked: qdrant.again === true, onChange: (checked) => setQdrant((current) => ({ ...current, again: checked })) })
            : null,
          h('div', { key: 'actions', className: 'mem0-wz-row' },
            h('button', { type: 'button', className: 'mem0-secondary', disabled: Boolean(busy) || Boolean(run?.running), onClick: async () => record('preflight', await post('migratePreflight', { url: qdrant.url, collection: qdrant.collection })) }, busy === 'migratePreflight' ? t('wzTesting') : t('wzPreflight')),
            h('button', {
              type: 'button',
              className: 'mem0-primary',
              disabled: !pre?.ok || Boolean(run?.running) || Boolean(busy) || (Boolean(state.migration) && qdrant.again !== true),
              onClick: async () => {
                const started = await post('migrate', { url: qdrant.url, collection: qdrant.collection, copyVectors: qdrant.copyVectors, again: qdrant.again === true })
                if (!started?.ok || !started.job?.id) return record('migrate', { error: { message: started?.error ?? '', step: started?.step ?? 'preflight', code: started?.code ?? null } })
                record('migrate', { running: true })
                const job = await pollJob(started.job.id, 'migrate')
                if (job?.state === 'done') await load()
              },
            }, run?.running ? template(t('wzMigrating'), { phase: run.progress?.phase === 'embed' ? t('wzPhaseEmbed') : t('wzPhaseRead'), done: run.progress?.done ?? 0, total: run.progress?.total ?? '?' }) : t('wzMigrate')),
            h('button', { type: 'button', className: 'mem0-secondary', disabled: Boolean(run?.running), onClick: () => { if (window.confirm(t('wzSkipHint'))) setSkipped(true) } }, t('wzSkip')),
          ),
          h('p', { key: 'skip-hint', className: 'mem0-hint' }, t('wzSkipHint')),
        )
        if (pre) {
          if (pre.ok) {
            body.push(h(ResultLine, { key: 'pre', ok: true, text: template(t('wzPreflightOk'), { points: pre.preflight.points, user: pre.preflight.userId, dims: pre.preflight.dims ?? '?' }) }))
            body.push(pre.copyPossible
              ? h(ToggleRow, { key: 'copy', label: template(t('wzCopyVectors'), { model: pre.embedder.model, dims: pre.embedder.dims }), checked: qdrant.copyVectors, onChange: (checked) => setQdrant((current) => ({ ...current, copyVectors: checked })) })
              : h('p', { key: 'recompute', className: 'mem0-hint' }, template(t('wzRecompute'), { model: pre.embedder.model })))
          } else {
            body.push(h(ResultLine, { key: 'pre-err', ok: false, text: wizardError(t, pre) }))
            if (pre.code === 'QDRANT_UNREACHABLE') body.push(h('p', { key: 'down', className: 'mem0-hint' }, t(isWindows ? 'wzQdrantDownWin' : 'wzQdrantDown')))
            if (pre.hint) body.push(h(ReservedPortHint, { key: 'hint', t, hint: pre.hint }))
          }
        }
        if (run?.result) body.push(h(ResultLine, { key: 'done-now', ok: true, text: migrationText(t, run.result) }))
        if (run?.result?.skippedForeign > 0) body.push(h('p', { key: 'foreign', className: 'mem0-hint' }, template(t('wzForeign'), { count: run.result.skippedForeign })))
        if (run?.error) body.push(h(ResultLine, { key: 'run-err', ok: false, text: template(t('wzMigrateFailed'), { step: wizardStepName(t, run.error.step), error: wizardError(t, run.error) }) }))
        if (run?.running && run.progress) body.push(h('p', { key: 'progress', className: 'mem0-hint' }, template(t('wzMigrating'), { phase: run.progress.phase === 'embed' ? t('wzPhaseEmbed') : t('wzPhaseRead'), done: run.progress.done ?? 0, total: run.progress.total ?? '?' })))
        if (run?.running) body.push(cancelButton(run, 'cancel-migrate'))
        if (skipped) body.push(h(ResultLine, { key: 'skipped', ok: true, text: t('wzSkipped') }))
        return body
      }

      // Leaving the LLM step forward before its test passed asks once more.
      const llmUntested = step === 'llm' && results.llm?.ok !== true
      const goTo = (target) => {
        const forward = steps.indexOf(target) > steps.indexOf(step)
        if (forward && llmUntested && !untestedWarned) {
          setUntestedWarned(true)
          return
        }
        setUntestedWarned(false)
        setStep(target)
      }
      const content = { embedder: embedderStep, llm: llmStep, store: storeStep, selftest: selfTestStep, migrate: migrateStep }[step]()
      const labels = { embedder: 'wzStepEmbedder', llm: 'wzStepLlm', store: 'wzStepStore', selftest: 'wzStepSelfTest', migrate: 'wzStepMigrate' }
      return h(
        'div',
        { className: 'mem0-card mem0-section mem0-wz' },
        h('div', { className: 'mem0-section-head' },
          h('h3', { className: 'mem0-section-title' }, t('wzTitle')),
          h('button', { type: 'button', className: 'mem0-secondary', onClick: onClose }, t('wzClose')),
        ),
        h('p', { className: 'mem0-hint' }, t('wzIntro')),
        h('div', { className: 'mem0-wz-steps' }, steps.map((name, i) =>
          h('button', { key: name, type: 'button', className: 'mem0-wz-step', 'data-active': name === step ? 'true' : 'false', onClick: () => goTo(name) }, `${i + 1}. ${t(labels[name])}`),
        )),
        h('div', { className: 'mem0-grid' }, content),
        llmUntested && untestedWarned ? h('p', { className: 'mem0-wz-untested', role: 'alert' }, t('wzLlmUntested')) : null,
        h('div', { className: 'mem0-wz-row mem0-wz-nav' },
          index > 0 ? h('button', { type: 'button', className: 'mem0-secondary', onClick: () => goTo(steps[index - 1]) }, t('wzBack')) : null,
          index < steps.length - 1
            ? h('button', { type: 'button', className: 'mem0-secondary', onClick: () => goTo(steps[index + 1]) }, llmUntested && untestedWarned ? t('wzNextAnyway') : t('wzNext'))
            : h('button', { type: 'button', className: 'mem0-secondary', onClick: onClose }, t('wzDone')),
        ),
      )
    }

    /** What the local backend lacks, from the wizard state (for the switch prompt). */
    function missingLocalSetup(state) {
      const problems = state?.current?.problems ?? []
      const missing = []
      if (problems.some((problem) => problem.component === 'embedder')) missing.push('embedder')
      if (problems.some((problem) => problem.component === 'llm')) missing.push('llm')
      return missing
    }

    function ConfigPage({ t, ctx }) {
      const form = ctx.configForms.get(ENTRY_ID)
      const mirror = ctx.configForms.describe()
      const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
      const [draft, setDraft] = useState(null)
      const [initial, setInitial] = useState(null)
      const [loaded, setLoaded] = useState(false)
      const [apiKey, setApiKey] = useState('')
      const [apiKeySet, setApiKeySet] = useState(false)
      const [status, setStatus] = useState({ phase: 'loading', data: null, message: '' })
      const [saveState, setSaveState] = useState('idle')
      const [saveMessage, setSaveMessage] = useState('')
      const [testState, setTestState] = useState('idle')
      const [hygieneState, setHygieneState] = useState('idle')
      const [hygieneMessage, setHygieneMessage] = useState('')
      const [browserOpen, setBrowserOpen] = useState(false)
      const [memoryQuery, setMemoryQuery] = useState('')
      // The memory page's tree and the partition it shows ('' = all).
      const [memoryTree, setMemoryTree] = useState(null)
      const [memoryPartition, setMemoryPartition] = useState('')
      // Current text of the memories the last hygiene report names, by id.
      const [reportTexts, setReportTexts] = useState(null)
      const [memoryState, setMemoryState] = useState({ phase: 'idle', data: null, message: '' })
      const [deleteState, setDeleteState] = useState({ id: null, outcome: 'idle', message: '' })
      const [profileDraft, setProfileDraft] = useState(null)
      const [profileEditing, setProfileEditing] = useState(false)
      const [profileState, setProfileState] = useState('idle')
      const [profileMessage, setProfileMessage] = useState('')
      // Local setup wizard, and the prompt shown when switching to the local
      // backend while it is not set up yet.
      const [wizardOpen, setWizardOpen] = useState(false)
      const [switchPrompt, setSwitchPrompt] = useState(null)

      useEffect(() => {
        const unsubscribe = form.subscribe(() => setSnapshot(form.getSnapshot()))
        return unsubscribe
      }, [form])

      useEffect(() => {
        if (snapshot.status === 'ready' && !loaded) {
          const next = normalise(snapshot.value)
          setDraft(next)
          setInitial(next)
          setLoaded(true)
        }
      }, [snapshot, loaded])

      // The composer chip saves "partition by project" too: follow it while
      // this field has no unsaved change here.
      useEffect(() => {
        if (!loaded || snapshot.status !== 'ready' || !initial || !draft) return
        const saved = snapshot.value?.projectPartitions !== false
        if (saved === initial.projectPartitions || draft.projectPartitions !== initial.projectPartitions) return
        setInitial((current) => ({ ...current, projectPartitions: saved }))
        setDraft((current) => ({ ...current, projectPartitions: saved }))
      }, [snapshot, loaded])

      useEffect(() => {
        const readSecrets = () => {
          const ns = mirror.getSnapshot().view?.namespaces?.find((item) => item.ns === ENTRY_ID)
          const secret = (ns?.secrets ?? []).find(
            (item) => item.path.length === 1 && item.path[0] === 'apiKey',
          )
          setApiKeySet(Boolean(secret?.set))
        }
        readSecrets()
        return mirror.subscribe(readSecrets)
      }, [mirror])

      const refreshStatus = useCallback(async ({ translate = true } = {}) => {
        setStatus((current) => ({ ...current, phase: current.data ? current.phase : 'loading' }))
        try {
          const data = await fetchJson(
            `${STATUS_PATH}?lang=${pageLanguage(ctx)}&translate=${translate ? '1' : '0'}`,
          )
          setStatus({ phase: 'ready', data, message: '' })
          return data
        } catch (error) {
          // Keep usable status data when a background translation refresh fails.
          setStatus((current) =>
            current.data ? current : { phase: 'error', data: null, message: error.message },
          )
          return null
        }
      }, [])

      useEffect(() => {
        // Render the page from the fast, untranslated status first. Profile
        // translation can take several model calls; it must not hold the page.
        void refreshStatus({ translate: false }).then(() => {
          void refreshStatus({ translate: true })
        })
      }, [refreshStatus])

      useEffect(() => {
        if (status.phase === 'ready' && !profileEditing) {
          setProfileDraft(status.data?.profileText ?? '')
        }
      }, [status, profileEditing])

      const loadTree = useCallback(async () => {
        try {
          setMemoryTree(await fetchJson(`${MEMORIES_PATH}?tree=1`))
        } catch {
          setMemoryTree(null)
        }
      }, [])

      // Only the latest request's answer is shown (quick clicks on the tree).
      const memoryRequest = useRef(0)
      const loadMemories = useCallback(async (query, partition = '') => {
        const q = String(query ?? '').trim()
        const request = ++memoryRequest.current
        setMemoryState((current) => ({ phase: 'loading', data: current.data, message: '' }))
        try {
          const data = await fetchJson(`${MEMORIES_PATH}?q=${encodeURIComponent(q)}&limit=500&lang=${pageLanguage(ctx)}&partition=${encodeURIComponent(partition)}`)
          if (request !== memoryRequest.current) return
          setMemoryState({ phase: 'ready', data, message: '' })
        } catch (error) {
          if (request !== memoryRequest.current) return
          setMemoryState({ phase: 'error', data: null, message: error.message })
        }
      }, [])

      const deleteMemory = async (id) => {
        setDeleteState({ id, outcome: 'deleting', message: '' })
        const result = await deleteMemoryFlow({
          t,
          id,
          request: fetchJson,
          confirm: (text) => window.confirm(text),
          reload: async () => {
            await loadMemories(memoryQuery, memoryPartition)
            void loadTree()
            void refreshStatus({ translate: false })
          },
        })
        setDeleteState({ id: null, outcome: result.outcome, message: result.message })
      }

      // Pin or unpin (local backend): pinned memories are never deleted or merged by hygiene.
      const pinMemory = async (id, pinned) => {
        try {
          const outcome = await fetchJson(MEMORIES_PATH, {
            method: 'POST',
            retry: false,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, pinned }),
          })
          if (!outcome?.ok) throw new Error(outcome?.error || t('memoryPinError'))
          await loadMemories(memoryQuery, memoryPartition)
        } catch (error) {
          setDeleteState({ id: null, outcome: 'error', message: `${t('memoryPinError')}: ${error.message}` })
        }
      }

      // Move a project memory to global (text unchanged; no other edit).
      const makeGlobal = async (id) => {
        try {
          const outcome = await fetchJson(MEMORIES_PATH, {
            method: 'POST',
            retry: false,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, scope: 'global' }),
          })
          if (!outcome?.ok) throw Object.assign(new Error(outcome?.error || t('memoryMakeGlobalError')), { reason: outcome?.reason })
          await Promise.all([loadMemories(memoryQuery, memoryPartition), loadTree()])
        } catch (error) {
          setDeleteState({ id: null, outcome: 'error', message: `${t('memoryMakeGlobalError')}: ${makeGlobalReason(t, error)}` })
        }
      }

      const selectPartition = (key) => {
        setMemoryPartition(key)
        void loadMemories(memoryQuery, key)
      }

      const toggleBrowser = () => {
        if (!browserOpen) {
          void loadMemories(memoryQuery, memoryPartition)
          void loadTree()
        }
        setBrowserOpen((open) => !open)
      }

      const dirty = useMemo(
        () => loaded && draft !== null && (!same(draft, initial) || apiKey.trim().length > 0),
        [draft, initial, apiKey, loaded],
      )

      const setField = (key, value) => {
        setDraft((current) => (current ? { ...current, [key]: value } : current))
        setSaveState('idle')
        setSaveMessage('')
      }

      // Switching to the local backend: look first. Set up → switch; missing
      // pieces → say which, and offer the wizard or switching anyway.
      const chooseBackend = async (id) => {
        setSwitchPrompt(null)
        if (id !== 'oss' || draft?.backend === 'oss') return setField('backend', id)
        let state = null
        try {
          state = await fetchJson(SETUP_PATH, { retry: false })
        } catch {
          state = null
        }
        const missing = missingLocalSetup(state)
        if (state && missing.length === 0) return setField('backend', id)
        setSwitchPrompt({ missing: state ? missing : ['embedder', 'llm'] })
      }

      // The wizard saved oss.json: switch the profile to the local backend.
      const enableLocal = async () => {
        if (!draft || !snapshot.writable) return false
        const accepted = await form.mutate([{ op: 'set', path: ['backend'], value: 'oss' }], snapshot.revision)
        if (accepted) {
          const next = { ...draft, backend: 'oss' }
          setInitial((current) => ({ ...(current ?? next), backend: 'oss' }))
          setDraft(next)
        }
        return accepted
      }

      const applySaved = (next) => {
        setInitial(next)
        setDraft(next)
        setApiKey('')
        setSaveState('saved')
        setSaveMessage('')
        setTimeout(() => setSaveState((current) => (current === 'saved' ? 'idle' : current)), 2600)
      }

      const save = async () => {
        if (!draft || !snapshot.writable) return false
        const next = numericDraft(draft)
        if (!next) {
          setSaveState('error')
          setSaveMessage(t('invalidNumber'))
          return false
        }
        const ops = []
        for (const key of FIELD_ORDER) {
          if (!same(next[key], initial[key])) ops.push({ op: 'set', path: [key], value: next[key] })
        }
        if (apiKey.trim().length > 0) ops.push({ op: 'set', path: ['apiKey'], value: apiKey.trim() })
        if (ops.length === 0) {
          await refreshStatus()
          return true
        }
        setSaveState('saving')
        setSaveMessage('')
        try {
          const accepted = await form.mutate(ops, snapshot.revision)
          if (!accepted) {
            setSaveState('error')
            setSaveMessage(t('saveFailed'))
            return false
          }
          applySaved(next)
          await delay(450)
          await refreshStatus()
          return true
        } catch (error) {
          setSaveState('error')
          setSaveMessage(error.message || t('saveFailed'))
          return false
        }
      }

      const test = async () => {
        if (dirty) {
          const saved = await save()
          if (!saved) return
        }
        setTestState('testing')
        try {
          const data = await fetchJson(TEST_PATH, { method: 'POST' })
          setStatus({ phase: 'ready', data, message: '' })
          setTestState(data?.ok ? 'ok' : 'error')
        } catch (error) {
          setStatus({ phase: 'error', data: null, message: error.message })
          setTestState('error')
        }
      }

      const saveProfile = async () => {
        if (!draft?.profileEnabled) return
        setProfileState('saving')
        setProfileMessage('')
        try {
          const response = await fetchJson(PROFILE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: profileDraft ?? '' }),
          })
          if (!response?.ok) throw new Error(response?.error || t('saveFailed'))
          setProfileDraft(response.profileText ?? '')
          setStatus((current) =>
            current.data
              ? {
                  ...current,
                  data: {
                    ...current.data,
                    profileText: response.profileText ?? '',
                    maintenance: response.maintenance ?? current.data.maintenance,
                  },
                }
              : current,
          )
          setProfileEditing(false)
          setProfileState('saved')
          setProfileMessage(t('profileSaved'))
        } catch (error) {
          setProfileState('error')
          setProfileMessage(error.message || t('profileTooLong'))
        }
      }

      const resetProfile = async () => {
        if (!draft?.profileEnabled) return
        setProfileState('saving')
        setProfileMessage('')
        try {
          const response = await fetchJson(PROFILE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          })
          if (!response?.ok) throw new Error(response?.error || t('saveFailed'))
          setProfileDraft(response.profileText ?? '')
          setStatus((current) =>
            current.data
              ? {
                  ...current,
                  data: {
                    ...current.data,
                    profileText: response.profileText ?? '',
                    maintenance: response.maintenance ?? current.data.maintenance,
                  },
                }
              : current,
          )
          setProfileEditing(false)
          setProfileState('saved')
          setProfileMessage(t('profileSaved'))
        } catch (error) {
          setProfileState('error')
          setProfileMessage(error.message || t('saveFailed'))
        }
      }

      const cancelProfileEdit = () => {
        setProfileDraft(status.data?.profileText ?? '')
        setProfileEditing(false)
        setProfileState('idle')
        setProfileMessage('')
      }

      const applyHygieneResponse = (response) => {
        if (response?.maintenance) {
          setStatus((current) =>
            current.data ? { ...current, data: { ...current.data, maintenance: response.maintenance } } : current,
          )
        }
        if (!response?.ok) throw new Error(response?.reason === 'busy' ? t('hygieneBusy') : response?.reason === 'model-starting' ? t('hygieneModelStarting') : response?.error || t('hygieneFailed'))
        return response.report ?? {}
      }

      // Preview first (dryRun), then delete only after the user confirms.
      const runHygiene = async () => {
        setHygieneState('previewing')
        setHygieneMessage('')
        try {
          const preview = applyHygieneResponse(
            await fetchJson(HYGIENE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dryRun: true }),
            }),
          )
          const planned = Number(preview.planned ?? 0)
          if (planned > 0 && !window.confirm(template(t('hygieneConfirm'), { planned, merges: Array.isArray(preview.mergePlan) ? preview.mergePlan.length : 0 }))) {
            setHygieneState('cancelled')
            setHygieneMessage(t('hygieneCancelled'))
            return
          }
          setHygieneState('running')
          // Deletes only the previewed plan, once: never resent on a network
          // error or 5xx, and a resend with the same key replays the result.
          const report = applyHygieneResponse(
            await fetchJson(HYGIENE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                dryRun: false,
                planId: preview.planId,
                idempotencyKey: newIdempotencyKey(),
              }),
              retry: false,
            }),
          )
          setHygieneState('ok')
          setHygieneMessage(
            planned > 0 ? formatHygieneReport(t, report) : `${t('hygieneNothingToDelete')} ${formatHygieneReport(t, report)}`,
          )
          await refreshStatus()
        } catch (error) {
          setHygieneState('error')
          setHygieneMessage(error.reason === 'busy' ? t('hygieneBusy') : error.reason === 'model-starting' ? t('hygieneModelStarting') : error.message || t('hygieneFailed'))
        }
      }

      const discard = () => {
        setDraft(initial)
        setApiKey('')
        setSaveState('idle')
        setSaveMessage('')
      }

      const clearKey = async () => {
        if (!snapshot.writable) return
        setSaveState('saving')
        try {
          const accepted = await form.unset('apiKey')
          if (!accepted) {
            setSaveState('error')
            setSaveMessage(t('saveFailed'))
            return
          }
          setApiKeySet(false)
          applySaved({ ...(draft ?? initial), apiKey: '' })
          await refreshStatus()
        } catch (error) {
          setSaveState('error')
          setSaveMessage(error.message || t('saveFailed'))
        }
      }

      const reportIdsKey = reportMemoryIds(status.data?.maintenance?.lastReport ?? null).join(',')
      useEffect(() => {
        // Stored reports keep ids only: read the current text by id.
        if (!reportIdsKey) {
          setReportTexts(null)
          return undefined
        }
        let cancelled = false
        fetchJson(`${MEMORIES_PATH}?ids=${encodeURIComponent(reportIdsKey)}`)
          .then((data) => {
            if (!cancelled) setReportTexts(data?.ok ? data.texts ?? {} : null)
          })
          .catch(() => {
            if (!cancelled) setReportTexts(null)
          })
        return () => {
          cancelled = true
        }
      }, [reportIdsKey])
      if (snapshot.status === 'unavailable') {
        return h('div', { className: 'mem0-page' }, h('p', { className: 'mem0-empty' }, t('unavailable')))
      }
      if (snapshot.status === 'loading' || !loaded || !draft) {
        return h('div', { className: 'mem0-page' }, h('p', { className: 'mem0-empty' }, t('checking')))
      }

      const data = status.data
      const keyConfigured = data ? Boolean(data.apiKeyConfigured) : apiKeySet
      const statusOk = status.phase === 'ready' && data?.ok
      const statusItems = []
      if (data) {
        statusItems.push(
          { key: 'backend', label: t('statusBackend'), value: statusLabel(t, data.backend) },
          { key: 'collection', label: t('statusCollection'), value: data.collection ?? '—' },
          { key: 'endpoint', label: t('statusEndpoint'), value: data.endpoint ?? '—' },
        )
        const choice = backendChoiceText(t, data)
        if (choice) statusItems.push({ key: 'backendChoice', label: t('statusBackendChoice'), value: choice })
        if (data.mem0Reference) statusItems.push({ key: 'mem0', label: t('statusMem0'), value: template(t('statusMem0Native'), { version: data.mem0Reference }) })
        if (data.store) {
          statusItems.push({
            key: 'store',
            label: t('statusStore'),
            value: data.store.ok ? `OK (${data.store.kind ?? 'sqlite'})` : data.store.error ?? '—',
          })
        } else if (data.qdrant) {
          statusItems.push({
            key: 'qdrant',
            label: t('statusVectorStore'),
            value: data.qdrant.ok ? 'OK' : data.qdrant.error ?? '—',
          })
        }
        if (data.embedder) {
          statusItems.push({
            key: 'embedder',
            label: t('statusEmbedder'),
            value: data.embedder.ok
              ? `${data.embedder.model ? `${data.embedder.model} · ` : ''}${data.embedder.dimensions ?? '?'} dims`
              : data.embedder.error ?? '—',
          })
        }
        if (data.llm) {
          // Following DSH: the label says so; the value is the model id now
          // (provider in the tooltip), so it fits the cell.
          const dshName = data.llm.followsDsh ? String(data.llm.model ?? '') : ''
          statusItems.push({
            key: 'llm',
            label: data.llm.followsDsh ? t('statusLlmDshLabel') : t('statusLlm'),
            value: data.llm.followsDsh
              ? (dshName ? dshName.slice(dshName.indexOf('/') + 1) : t('statusLlmDshNone'))
              : data.llm.configured ? data.llm.model ?? 'OK' : data.llm.error ?? t('statusLlmMissing'),
            ...(dshName ? { title: template(t('statusLlmDsh'), { model: dshName }) } : {}),
          })
        }
        statusItems.push({
          key: 'key',
          label: t('statusKey'),
          value: data.apiKeyConfigured ? t('keySet') : t('keyUnset'),
        })
      }

      const capture = data?.activity?.capture ?? null
      const recall = data?.activity?.recall ?? null
      const maintenance = data?.maintenance ?? null
      const lastReport = maintenance?.lastReport ?? null
      const recentMemories = Array.isArray(data?.recentMemories) ? data.recentMemories : []
      const profileText = typeof data?.profileText === 'string' ? data.profileText.trim() : ''
      const profileMeta = []
      if (maintenance?.profile) {
        profileMeta.push(`${maintenance.profile.items ?? 0} ${t('profileSummaryItems')}`)
        if (maintenance.profile.tokens !== undefined) profileMeta.push(`${maintenance.profile.tokens} tok`)
        if (maintenance.profile.manual) profileMeta.push(t('profileManual'))
        if (maintenance.profile.sourcesChanged) profileMeta.push(t('profileSourcesChanged'))
        if (maintenance.profile.stale) profileMeta.push(t('profileStale'))
        if (maintenance.profile.updatedAt) {
          profileMeta.push(`${t('profileSummaryUpdated')} ${activityTime(maintenance.profile.updatedAt)}`)
        }
      }
      // Project summaries (partition L0): name, size, whether being rebuilt.
      const projectSummaryLine = Array.isArray(maintenance?.projectProfiles) && maintenance.projectProfiles.length > 0
        ? template(t('projectSummaries'), {
            list: maintenance.projectProfiles
              .map((item) => `${item.name || shortId(item.projectId)} (${item.items ?? 0} · ${item.tokens ?? 0} ${t('tokUnit')}${item.stale ? ` · ${t('projectSummaryStale')}` : ''})`)
              .join(', '),
          })
        : ''
      const maintenanceMeta = []
      if (maintenance?.lastRunAt) {
        maintenanceMeta.push(`${t('hygieneLastRun')} ${activityTime(maintenance.lastRunAt)}`)
      } else {
        maintenanceMeta.push(`${t('hygieneLastRun')} ${t('hygieneNever')}`)
      }
      if (maintenance?.nextRunAt) {
        maintenanceMeta.push(`${t('hygieneNextRun')} ${activityTime(maintenance.nextRunAt)}`)
      } else if (maintenance?.due) {
        maintenanceMeta.push(`${t('hygieneNextRun')} ${t('hygieneDue')}`)
      }
      if (maintenance?.pending > 0) {
        maintenanceMeta.push(template(t(maintenance.catchUp ? 'hygienePending' : 'hygienePendingSlow'), { count: maintenance.pending }))
      }
      if (maintenance?.profile) {
        maintenanceMeta.push(
          `${t('hygieneProfile')} ${maintenance.profile.items ?? 0} · ${maintenance.profile.tokens ?? 0} tok`,
        )
      }
      const captureMeta = []
      if (capture?.messages) captureMeta.push(`${capture.messages} ${t('activityMessages')}`)
      if (capture?.status === 'saved') captureMeta.push(`${capture.count ?? 0} ${t('activityWritten')}`)
      if (capture?.eventId) captureMeta.push(`${t('activityEvent')} ${String(capture.eventId).slice(0, 12)}`)
      if (capture?.at) captureMeta.push(activityTime(capture.at))
      const recallMeta = []
      if (recall?.count !== undefined) recallMeta.push(`${recall.count} ${t('activityReturned')}`)
      if (recall?.latencyMs !== undefined) recallMeta.push(`${recall.latencyMs} ms`)
      // Present only when dsh-strata's budget service took part (interop §2).
      if (Number.isFinite(recall?.budget?.allowance) && Number.isFinite(recall?.budget?.wanted)) {
        recallMeta.push(
          `${t('activityBudget')} ${recall.budget.allowance} / ${recall.budget.wanted}${recall.budget.stage ? ` (strata: ${recall.budget.stage})` : ''}`,
        )
      }
      if (recall?.at) recallMeta.push(activityTime(recall.at))

      const backendOptions = [
        { id: 'auto', label: t('backendAuto') },
        { id: 'platform', label: t('backendPlatform') },
        { id: 'server', label: t('backendServer') },
        { id: 'oss', label: t('backendOss') },
      ]
      const backendHint =
        draft.backend === 'platform'
          ? t('backendPlatformHint')
          : draft.backend === 'server'
            ? t('backendServerHint')
            : draft.backend === 'oss'
              ? t('backendOssHint')
              : t('backendAutoHint')

      const connectionFields = []
      if (draft.backend === 'auto' || draft.backend === 'platform' || draft.backend === 'server') {
        connectionFields.push(
          h(TextField, {
            key: 'apiKey',
            label: t('apiKey'),
            hint: keyConfigured ? t('apiKeySet') : t('apiKeyHint'),
            type: 'password',
            value: apiKey,
            autoComplete: 'off',
            placeholder: keyConfigured ? '••••••••' : t('apiKeyUnset'),
            onChange: setApiKey,
          }),
          h(TextField, {
            key: 'apiKeyEnv',
            label: t('apiKeyEnv'),
            hint: t('apiKeyEnvHint'),
            value: draft.apiKeyEnv,
            onChange: (value) => setField('apiKeyEnv', value),
          }),
        )
      }
      if (draft.backend === 'auto' || draft.backend === 'platform') {
        connectionFields.push(
          h(TextField, {
            key: 'baseUrl',
            label: t('baseUrl'),
            hint: draft.backend === 'platform' ? t('baseUrlPlatformHint') : undefined,
            value: draft.baseUrl,
            placeholder: 'https://api.mem0.ai',
            onChange: (value) => setField('baseUrl', value),
          }),
        )
      }
      if (draft.backend === 'server') {
        connectionFields.push(
          h(TextField, {
            key: 'baseUrl',
            label: t('baseUrl'),
            hint: t('baseUrlServerHint'),
            value: draft.baseUrl,
            placeholder: 'http://127.0.0.1:8888',
            onChange: (value) => setField('baseUrl', value),
          }),
          h(SelectField, {
            key: 'authType',
            label: t('authType'),
            value: draft.authType,
            onChange: (value) => setField('authType', value),
            options: [
              { value: 'apiKey', label: t('authApiKey') },
              { value: 'bearer', label: t('authBearer') },
              { value: 'token', label: t('authToken') },
              { value: 'none', label: t('authNone') },
            ],
          }),
        )
      }
      if (draft.backend === 'oss') {
        connectionFields.push(
          h(TextField, {
            key: 'storePath',
            label: t('storePath'),
            hint: t('storePathHint'),
            value: draft.storePath,
            placeholder: '~/.dsh/mem0/memory.sqlite',
            className: 'mem0-grid-single',
            onChange: (value) => setField('storePath', value),
          }),
          h('p', { key: 'ossConfigHint', className: 'mem0-hint mem0-grid-single' }, t('ossConfigHint')),
          h('div', { key: 'wizard', className: 'mem0-wz-row mem0-grid-single' },
            h('button', { type: 'button', className: 'mem0-secondary', onClick: () => setWizardOpen(true) }, t('wzOpen')),
          ),
        )
      }

      const renderProfilePreview = (value) => {
        const lines = String(value ?? '').split('\n')
        return h(
          'div',
          { className: 'mem0-profile-preview' },
          lines.map((line, index) => {
            const text = line.trim()
            if (!text) return null
            if (/^#{1,6}\s+/.test(text)) {
              return h('h4', { key: index, className: 'mem0-profile-heading' }, text.replace(/^#{1,6}\s+/, ''))
            }
            if (/^[-*]\s+/.test(text)) {
              return h('div', { key: index, className: 'mem0-profile-item' }, text.replace(/^[-*]\s+/, ''))
            }
            return h('p', { key: index, className: 'mem0-profile-paragraph' }, text)
          }),
        )
      }

      return h(
        'div',
        { className: 'mem0-page' },
        h(
          'div',
          { className: 'mem0-head' },
          h(
            'div',
            null,
            h('h2', { className: 'mem0-title' }, t('title')),
            h('p', { className: 'mem0-sub' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'mem0-head-actions' },
            dirty
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-primary',
                    onClick: () => void save(),
                    disabled: saveState === 'saving',
                  },
                  saveState === 'saving' ? t('saving') : t('save'),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'mem0-secondary',
                onClick: () => void refreshStatus(),
                disabled: status.phase === 'loading',
              },
              t('checkAgain'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'mem0-card' },
          h(
            'div',
            { className: 'mem0-status' },
            h(
              'div',
              { className: 'mem0-status-main' },
              h('span', { className: `mem0-dot${statusOk ? ' ok' : status.phase === 'error' ? ' error' : ''}` }),
              h(
                'span',
                { className: 'mem0-status-label' },
                status.phase === 'loading'
                  ? t('checking')
                  : statusOk
                    ? t('statusReady')
                    : t('statusDegraded'),
              ),
              testState === 'ok' ? h('span', { className: 'mem0-chip mem0-chip-ok' }, t('testOk')) : null,
            ),
            h(
              'div',
              { className: 'mem0-status-grid' },
              statusItems.map((item) =>
                h(
                  'div',
                  { className: 'mem0-stat', key: item.key },
                  h('span', { className: 'mem0-stat-label' }, item.label),
                  h('span', { className: 'mem0-stat-value', title: String(item.title ?? item.value) }, item.value),
                ),
              ),
            ),
          ),
          status.phase === 'error' || (data && data.ok === false)
            ? h('p', { className: 'mem0-error' }, data?.error ?? status.message)
            : null,
        ),
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h(
            'div',
            { className: 'mem0-section-head' },
            h('h3', { className: 'mem0-section-title' }, t('profileSummaryTitle')),
            profileMeta.length > 0 ? h('span', { className: 'mem0-hint' }, profileMeta.join(' · ')) : null,
          ),
          h('p', { className: 'mem0-section-hint' }, t('profileSummaryHint')),
          projectSummaryLine ? h('p', { className: 'mem0-hint' }, projectSummaryLine) : null,
          profileEditing
            ? h('textarea', {
                className: 'mem0-profile-edit',
                value: profileDraft ?? '',
                placeholder: draft.profileEnabled ? t('profileSummaryEmpty') : t('profileSummaryDisabled'),
                disabled: !draft.profileEnabled || profileState === 'saving',
                rows: 8,
                onChange: (event) => {
                  setProfileDraft(event.target.value)
                  setProfileState('editing')
                  setProfileMessage('')
                },
              })
            : (profileDraft ?? profileText).trim()
              ? renderProfilePreview(profileDraft ?? profileText)
              : h('p', { className: 'mem0-hint' }, draft.profileEnabled ? t('profileSummaryEmpty') : t('profileSummaryDisabled')),
          profileEditing ? h('p', { className: 'mem0-hint' }, t('profileEditHint')) : null,
          h(
            'div',
            { className: 'mem0-profile-actions' },
            profileEditing
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-primary',
                    disabled: !draft.profileEnabled || profileState === 'saving' || !String(profileDraft ?? '').trim(),
                    onClick: saveProfile,
                  },
                  profileState === 'saving' ? t('profileSaving') : t('profileSave'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-primary',
                    disabled: !draft.profileEnabled || profileState === 'saving',
                    onClick: () => {
                      setProfileEditing(true)
                      setProfileState('editing')
                      setProfileMessage('')
                    },
                  },
                  t('profileEdit'),
                ),
            profileEditing
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-secondary',
                    disabled: profileState === 'saving',
                    onClick: cancelProfileEdit,
                  },
                  t('profileCancel'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-secondary',
                    disabled: !draft.profileEnabled || profileState === 'saving',
                    onClick: resetProfile,
                  },
                  t('profileReset'),
                ),
            profileMessage
              ? h(
                  'span',
                  { className: profileState === 'error' ? 'mem0-error' : 'mem0-hint' },
                  profileMessage,
                )
              : null,
          ),
          h('p', { className: 'mem0-hint' }, t('profileResetHint')),
        ),
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h('h3', { className: 'mem0-section-title' }, t('activityTitle')),
          h(
            'div',
            { className: 'mem0-activity-grid' },
            h(
              'div',
              { className: 'mem0-activity' },
              h(
                'div',
                { className: 'mem0-activity-head' },
                h('span', { className: 'mem0-activity-title' }, t('activityCapture')),
                capture ? activityChip(t, capture) : null,
              ),
              h(
                'p',
                { className: 'mem0-activity-main' },
                capture ? t('activityCapture') : t('activityNever'),
              ),
              capture?.error ? h('p', { className: 'mem0-error' }, capture.error) : null,
              ...activityDetails(t, capture).map((line, index) => h('p', { className: 'mem0-activity-meta', key: `cd${index}` }, line)),
              captureMeta.length > 0 ? h('p', { className: 'mem0-activity-meta' }, captureMeta.join(' · ')) : null,
            ),
            h(
              'div',
              { className: 'mem0-activity' },
              h(
                'div',
                { className: 'mem0-activity-head' },
                h('span', { className: 'mem0-activity-title' }, t('activityRecall')),
                recall ? activityChip(t, recall) : null,
              ),
              h(
                'p',
                { className: 'mem0-activity-main' },
                recall ? t('activityRecall') : t('activityNever'),
              ),
              recall?.error ? h('p', { className: 'mem0-error' }, recall.error) : null,
              ...activityDetails(t, recall).map((line, index) => h('p', { className: 'mem0-activity-meta', key: `rd${index}` }, line)),
              recall?.query ? h('p', { className: 'mem0-activity-meta' }, recall.query) : null,
              recallMeta.length > 0 ? h('p', { className: 'mem0-activity-meta' }, recallMeta.join(' · ')) : null,
              recall?.preview?.length
                ? h(
                    'div',
                    { className: 'mem0-recall-preview' },
                    h('div', { className: 'mem0-activity-meta' }, t('recallPreviewTitle')),
                    recall.preview.map((item, index) =>
                      h(
                        'div',
                        { className: 'mem0-recall-item', key: item.id ?? index },
                        h('div', { className: 'mem0-recall-text' }, item.memory || '—'),
                        item.id
                          ? h('div', { className: 'mem0-recall-meta' }, `${t('memoryId')} ${item.id}`)
                          : null,
                      ),
                    ),
                  )
                : null,
            ),
          ),
          capture?.status === 'extracting' || capture?.status === 'queued'
            ? h('p', { className: 'mem0-hint' }, t('activityAsyncHint'))
            : null,
          !capture && !recall
            ? h(
                'p',
                { className: 'mem0-hint' },
                recentMemories.length > 0 ? t('activityScopeHint') : t('activityEmpty'),
              )
            : null,
          ...(Array.isArray(data?.upgradeNotices) ? data.upgradeNotices : []).map((notice) =>
            notice?.code === 'legacyQdrant' || notice?.code === 'noLocalConfig' || notice?.code === 'qdrantMigrated'
              ? h(
                  'div',
                  { className: 'mem0-wz-notice', key: `upgrade-${notice.code}` },
                  h('p', { className: 'mem0-hint' },
                    notice.code === 'legacyQdrant'
                      ? template(t('upgradeLegacyQdrant'), { endpoint: String(notice.endpoint ?? ''), collection: String(notice.collection ?? '') })
                      : notice.code === 'qdrantMigrated'
                        ? t('upgradeQdrantMigrated')
                        : t('upgradeNoLocalConfig')),
                  notice.code !== 'qdrantMigrated' && !wizardOpen
                    ? h('button', { type: 'button', className: 'mem0-secondary', onClick: () => setWizardOpen(true) }, t('wzOpen'))
                    : null,
                )
              : null,
          ),
          data?.configWarning?.missing?.length
            ? h(
                'div',
                { className: 'mem0-error' },
                h('p', null, template(t('configWarning'), { fields: data.configWarning.missing.join(', ') })),
                h('p', null, t('configWarningFix')),
              )
            : null,
          data?.store ? h(StoreStatus, { t, store: data.store }) : null,
          h(FailureList, { t, failures: data?.failures }),
        ),
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h(
            'div',
            { className: 'mem0-section-head' },
            h('h3', { className: 'mem0-section-title' }, t('recentTitle')),
            h(
              'div',
              { className: 'mem0-section-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mem0-secondary',
                  onClick: () => void refreshStatus(),
                  disabled: status.phase === 'loading',
                },
                t('refresh'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mem0-secondary',
                  onClick: toggleBrowser,
                },
                browserOpen ? t('memoryBrowserClose') : t('memoryBrowserOpen'),
              ),
            ),
          ),
          data?.recentMemoriesError
            ? h('p', { className: 'mem0-error' }, `${t('recentError')}: ${data.recentMemoriesError}`)
            : null,
          recentMemories.length > 0
            ? h(
                'div',
                { className: 'mem0-memory-list' },
                recentMemories.map((memory, index) =>
                  h(
                    'div',
                    { className: 'mem0-memory', key: memory.id ?? index },
                    h('div', { className: 'mem0-memory-text' }, memory.memory || '—'),
                    h(
                      'div',
                      { className: 'mem0-memory-meta' },
                      memory.id
                        ? h('span', { className: 'mem0-chip' }, `${t('memoryId')} ${memory.id}`)
                        : null,
                      memory.createdAt
                        ? h('span', { className: 'mem0-hint' }, activityTime(memory.createdAt))
                        : null,
                      typeof memory.score === 'number'
                        ? h('span', { className: 'mem0-hint' }, `${t('memoryScore')} ${memory.score.toFixed(3)}`)
                        : null,
                    ),
                  ),
                ),
              )
            : h('p', { className: 'mem0-empty' }, t('recentEmpty')),
        ),
        browserOpen
          ? h(
              'div',
              { className: 'mem0-card mem0-section' },
              h(
                'div',
                { className: 'mem0-section-head' },
                h('h3', { className: 'mem0-section-title' }, memoryTree?.partitioned ? t('memoryTreeTitle') : t('memoryBrowserTitle')),
                h(
                  'button',
                  { type: 'button', className: 'mem0-secondary', onClick: toggleBrowser },
                  t('memoryBrowserClose'),
                ),
              ),
              h('p', { className: 'mem0-section-hint' }, memoryTree?.partitioned ? t('memoryTreeHint') : t('memoryBrowserHint')),
              h(
                'div',
                { className: memoryTree?.partitioned ? 'mem0-explorer' : 'mem0-explorer mem0-explorer-flat' },
                memoryTree?.partitioned
                  ? h(
                      'nav',
                      { className: 'mem0-tree', 'aria-label': t('memoryTreeTitle') },
                      treeEntries(t, memoryTree).map((row, index) =>
                        row.header
                          ? h('div', { key: `head-${index}`, className: 'mem0-tree-head' }, row.label)
                          : h(
                              'button',
                              {
                                key: row.key || 'all',
                                type: 'button',
                                className: 'mem0-tree-row',
                                style: { paddingLeft: `${8 + row.depth * 12}px` },
                                'aria-current': memoryPartition === row.key ? 'true' : 'false',
                                onClick: () => selectPartition(row.key),
                              },
                              h('span', null, row.label),
                              h('span', { className: 'mem0-tree-count' }, String(row.count ?? 0)),
                            ),
                      ),
                    )
                  : null,
              h(
                'div',
                null,
              h(
                'div',
                { className: 'mem0-search-row' },
                h('input', {
                  className: 'mem0-input',
                  type: 'search',
                  value: memoryQuery,
                  placeholder: t('memorySearchPlaceholder'),
                  onChange: (event) => setMemoryQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void loadMemories(memoryQuery, memoryPartition)
                    }
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-primary',
                    onClick: () => void loadMemories(memoryQuery, memoryPartition),
                    disabled: memoryState.phase === 'loading',
                  },
                  t('memorySearch'),
                ),
              ),
              deleteState.message
                ? h(
                    'p',
                    { className: deleteState.outcome === 'error' ? 'mem0-error' : 'mem0-saved', role: 'status' },
                    deleteState.message,
                  )
                : null,
              memoryState.phase === 'loading'
                ? h('p', { className: 'mem0-hint' }, t('memoryLoading'))
                : memoryState.phase === 'error'
                  ? h('p', { className: 'mem0-error' }, `${t('memoryBrowserError')}: ${memoryState.message}`)
                  : memoryState.data?.ok === false
                    ? h('p', { className: 'mem0-error' }, `${t('memoryBrowserError')}: ${memoryState.data.error}`)
                    : memoryState.data
                      ? h(
                          'div',
                          null,
                          h(
                            'p',
                            { className: 'mem0-hint' },
                            memoryQuery.trim()
                              ? template(t('memoryCountFiltered'), {
                                  shown: memoryState.data.memories?.length ?? 0,
                                  total: memoryState.data.total ?? 0,
                                })
                              : template(t('memoryCount'), { count: memoryState.data.total ?? 0 }),
                          ),
                          (memoryState.data.memories ?? []).length > 0
                            ? h(
                                'div',
                                { className: 'mem0-memory-list' },
                                memoryState.data.memories.map((memory, index) =>
                                  h(
                                    'div',
                                    { className: 'mem0-memory', key: memory.id ?? index },
                                    h('div', { className: 'mem0-memory-text' }, memory.memory || '—'),
                                    h(
                                      'div',
                                      { className: 'mem0-memory-meta' },
                                      memory.id
                                        ? h('span', { className: 'mem0-chip' }, `${t('memoryId')} ${memory.id}`)
                                        : null,
                                      memory.createdAt
                                        ? h('span', { className: 'mem0-hint' }, activityTime(memory.createdAt))
                                        : null,
                                      typeof memory.score === 'number'
                                        ? h('span', { className: 'mem0-hint' }, `${t('memoryScore')} ${memory.score.toFixed(3)}`)
                                        : null,
                                      memoryTree?.partitioned ? h('span', { className: 'mem0-chip' }, scopeLabel(t, memory, memoryTree)) : null,
                                      memory.pinned ? h('span', { className: 'mem0-chip' }, t('memoryPinnedTag')) : null,
                                      Number.isInteger(memory.importance)
                                        ? h('span', { className: 'mem0-hint' }, template(t('memoryImportance'), { level: memory.importance }))
                                        : null,
                                      memory.source ? h('span', { className: 'mem0-hint' }, template(t('memorySource'), { source: memory.source })) : null,
                                      memory.id && memory.globalizable
                                        ? h(
                                            'button',
                                            { type: 'button', className: 'mem0-secondary', onClick: () => void makeGlobal(memory.id) },
                                            t('memoryMakeGlobal'),
                                          )
                                        : null,
                                      memory.id && memory.pinnable
                                        ? h(
                                            'button',
                                            { type: 'button', className: 'mem0-secondary', onClick: () => void pinMemory(memory.id, !memory.pinned) },
                                            memory.pinned ? t('memoryUnpin') : t('memoryPin'),
                                          )
                                        : null,
                                      // Only memories this plugin wrote; the server checks again.
                                      memory.id && memory.deletable
                                        ? h(
                                            'button',
                                            {
                                              type: 'button',
                                              className: 'mem0-secondary mem0-memory-delete',
                                              disabled: deleteState.outcome === 'deleting',
                                              onClick: () => void deleteMemory(memory.id),
                                            },
                                            deleteState.outcome === 'deleting' && deleteState.id === memory.id
                                              ? t('memoryDeleting')
                                              : t('memoryDelete'),
                                          )
                                        : null,
                                    ),
                                  ),
                                ),
                              )
                            : h('p', { className: 'mem0-empty' }, t('memoryEmpty')),
                        )
                      : h('p', { className: 'mem0-hint' }, t('memoryBrowserHint')),
              ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'mem0-section' },
          h(
            'div',
            { className: 'mem0-section-head' },
            h('h3', { className: 'mem0-section-title' }, t('backendSection')),
            dirty ? h('span', { className: 'mem0-chip mem0-chip-warn' }, t('unsaved')) : null,
          ),
          h(
            'div',
            { className: 'mem0-segments' },
            backendOptions.map((option) =>
              h(
                'button',
                {
                  key: option.id,
                  type: 'button',
                  className: 'mem0-segment',
                  'data-active': draft.backend === option.id ? 'true' : 'false',
                  onClick: () => void chooseBackend(option.id),
                },
                option.label,
              ),
            ),
          ),
          h('p', { className: 'mem0-section-hint' }, backendHint),
          switchPrompt
            ? h('div', { className: 'mem0-wz-prompt' },
                h('p', { className: 'mem0-error' }, template(t('wzSwitchMissing'), { missing: switchPrompt.missing.map((item) => t(item === 'llm' ? 'wzMissingLlm' : 'wzMissingEmbedder')).join(', ') })),
                h('div', { className: 'mem0-wz-row' },
                  h('button', { type: 'button', className: 'mem0-primary', onClick: () => { setSwitchPrompt(null); setWizardOpen(true) } }, t('wzSwitchOpen')),
                  h('button', { type: 'button', className: 'mem0-secondary', onClick: () => { setSwitchPrompt(null); setField('backend', 'oss') } }, t('wzSwitchAnyway')),
                ),
              )
            : null,
        ),
        wizardOpen
          ? h(SetupWizard, {
              t,
              backend: initial?.backend,
              onClose: () => {
                setWizardOpen(false)
                void refreshStatus({ translate: false })
              },
              onEnable: enableLocal,
            })
          : null,
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h('h3', { className: 'mem0-section-title' }, t('connectionSection')),
          h('div', { className: 'mem0-grid' }, connectionFields),
        ),
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h('h3', { className: 'mem0-section-title' }, t('identityTitle')),
          h(
            'div',
            { className: 'mem0-grid' },
            h(TextField, {
              label: t('userId'),
              value: draft.userId,
              onChange: (value) => setField('userId', value),
            }),
            h(TextField, {
              label: t('agentId'),
              value: draft.agentId,
              onChange: (value) => setField('agentId', value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h('h3', { className: 'mem0-section-title' }, t('behaviourTitle')),
          h(
            'div',
            { className: 'mem0-toggles' },
            h(ToggleRow, {
              label: t('autoRecall'),
              hint: t('autoRecallHint'),
              checked: draft.autoRecall,
              onChange: (value) => setField('autoRecall', value),
            }),
            h(ToggleRow, {
              label: t('autoCapture'),
              hint: t('autoCaptureHint'),
              checked: draft.autoCapture,
              onChange: (value) => setField('autoCapture', value),
            }),
            h(ToggleRow, {
              label: t('announceToAgent'),
              hint: t('announceToAgentHint'),
              checked: draft.announceToAgent,
              onChange: (value) => setField('announceToAgent', value),
            }),
            h(ToggleRow, {
              label: t('includeSubagents'),
              hint: t('includeSubagentsHint'),
              checked: draft.includeSubagents,
              onChange: (value) => setField('includeSubagents', value),
            }),
            h(ToggleRow, {
              label: t('translateMemories'),
              hint: t('translateMemoriesHint'),
              checked: draft.translateMemories,
              onChange: (value) => setField('translateMemories', value),
            }),
            h(ToggleRow, {
              label: t('captureStrataFolds'),
              hint: t('captureStrataFoldsHint'),
              checked: draft.captureStrataFolds,
              onChange: (value) => setField('captureStrataFolds', value),
            }),
            h(SelectField, {
              label: t('captureFilter'),
              hint: t('captureFilterHint'),
              value: draft.captureFilter,
              onChange: (value) => setField('captureFilter', value),
              options: [
                { value: 'heuristic', label: t('captureFilterHeuristic') },
                { value: 'off', label: t('captureFilterOff') },
              ],
            }),
            h(ToggleRow, {
              label: t('enabled'),
              hint: t('enabledHint'),
              checked: draft.enabled,
              onChange: (value) => setField('enabled', value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'mem0-card mem0-section' },
          h(
            'div',
            { className: 'mem0-section-head' },
            h('h3', { className: 'mem0-section-title' }, t('maintenanceTitle')),
            h(
              'button',
              {
                type: 'button',
                className: 'mem0-secondary',
                onClick: () => void runHygiene(),
                // Also while a scheduled pass runs: a manual preview would not
                // get its own plan (the plugin answers busy).
                disabled: hygieneState === 'running' || hygieneState === 'previewing' || !data || data?.maintenance?.running === true,
              },
              hygieneState === 'running'
                ? t('hygieneRunning')
                : hygieneState === 'previewing'
                  ? t('hygienePreviewing')
                  : t('hygieneRun'),
            ),
          ),
          h('p', { className: 'mem0-section-hint' }, t('maintenanceHint')),
          h(
            'div',
            { className: 'mem0-toggles' },
            h(ToggleRow, {
              label: t('profileEnabled'),
              hint: t('profileEnabledHint'),
              checked: draft.profileEnabled,
              onChange: (value) => setField('profileEnabled', value),
            }),
            h(ToggleRow, {
              label: t('hygieneEnabled'),
              hint: t('hygieneEnabledHint'),
              checked: draft.hygieneEnabled,
              onChange: (value) => setField('hygieneEnabled', value),
            }),
            h(ToggleRow, {
              label: t('modelHygiene'),
              hint: t('modelHygieneHint'),
              checked: draft.modelHygiene,
              onChange: (value) => setField('modelHygiene', value),
            }),
            h(ToggleRow, {
              label: t('projectPartitions'),
              hint: t('projectPartitionsHint'),
              checked: draft.projectPartitions,
              onChange: (value) => setField('projectPartitions', value),
            }),
          ),
          h(
            'div',
            { className: 'mem0-grid' },
            h(TextField, {
              label: t('profileBudgetTokens'),
              hint: t('profileBudgetTokensHint'),
              type: 'number',
              value: draft.profileBudgetTokens,
              onChange: (value) => setField('profileBudgetTokens', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('memoryBudgetTokens'),
              hint: t('memoryBudgetTokensHint'),
              type: 'number',
              value: draft.memoryBudgetTokens,
              onChange: (value) => setField('memoryBudgetTokens', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('storeSafetyLimit'),
              hint: t('storeSafetyLimitHint'),
              type: 'number',
              value: draft.storeSafetyLimit,
              onChange: (value) => setField('storeSafetyLimit', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('importanceWeight'),
              hint: t('importanceWeightHint'),
              type: 'number',
              value: draft.importanceWeight,
              onChange: (value) => setField('importanceWeight', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('projectRecallBoost'),
              hint: t('projectRecallBoostHint'),
              type: 'number',
              value: draft.projectRecallBoost,
              onChange: (value) => setField('projectRecallBoost', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('hygieneIntervalDays'),
              hint: t('hygieneIntervalDaysHint'),
              type: 'number',
              value: draft.hygieneIntervalDays,
              onChange: (value) => setField('hygieneIntervalDays', value === '' ? '' : Number(value)),
            }),
          ),
          maintenanceMeta.length > 0
            ? h('p', { className: 'mem0-activity-meta' }, maintenanceMeta.join(' · '))
            : null,
          lastReport
            ? h(
                'p',
                { className: 'mem0-activity-meta' },
                `${t('hygieneLastReport')} · ${hygieneReason(t, lastReport.reason)}${
                  lastReport.finishedAt ? ` · ${activityTime(lastReport.finishedAt)}` : ''
                } · ${formatHygieneReport(t, lastReport)}`,
              )
            : null,
          lastReport
            ? h(
                'details',
                { className: 'mem0-details mem0-report-details' },
                h('summary', null, t('hygieneDetails')),
                h(
                  'div',
                  { className: 'mem0-report-grid' },
                  h('span', null, `${t('hygieneReportWindow')}: ${activityTime(lastReport.startedAt)} → ${activityTime(lastReport.finishedAt)}`),
                  h('span', null, `${t('hygieneReportDuration')}: ${lastReport.durationMs ?? '—'} ms`),
                  h('span', null, `${t('hygieneReportStore')}: ${lastReport.storeBefore ?? lastReport.scanned ?? 0} → ${lastReport.storeCount ?? 0}`),
                  h('span', null, `${t('hygieneReportStoreTokens')}: ${lastReport.storeTokensBefore ?? 0} → ${lastReport.storeTokens ?? 0}`),
                  h('span', null, `${t('hygieneReportProfile')}: ${lastReport.profileItems ?? 0} · ${lastReport.profileTokens ?? 0} tok`),
                ),
                ['duplicateDetails', 'mergedDetails', 'deletedDetails', 'failedDetails', 'prunedDetails'].some((key) => Array.isArray(lastReport[key]))
                  ? h(
                      'div',
                      { className: 'mem0-report-details-list' },
                      lastReport.dryRun
                        ? reportDetail(t, `${t('hygienePlannedDetails')} (${lastReport.planned ?? 0})`, lastReport.plannedDetails, (item) => reportItem(t, item))
                        : null,
                      reportDetail(t, t('hygieneDuplicateDetails'), lastReport.duplicateDetails, (item) => reportItem(t, item)),
                      Array.isArray(lastReport.prunedDetails) ? reportDetail(t, t('hygienePrunedDetails'), lastReport.prunedDetails, (item) => reportItem(t, item)) : null,
                      reportDetail(t, t('hygieneMergeDetails'), lastReport.dryRun ? lastReport.mergePlan : lastReport.mergedDetails, (item) => mergeLine(t, reportTexts, item)),
                      reportDetail(t, t('hygieneImportanceDetails'), lastReport.reviewDetails, (item) => importanceLine(t, reportTexts, item)),
                      reportDetail(t, t('hygieneDeletedDetails'), lastReport.deletedDetails, (item) => reportItem(t, item)),
                      reportDetail(t, t('hygieneFailedDetails'), lastReport.failedDetails, (item) => `${item.id}: ${item.error}`),
                    )
                  : h('p', { className: 'mem0-hint' }, t('hygieneLegacyDetails')),
              )
            : null,
          maintenance?.lastError
            ? h('p', { className: 'mem0-error' }, `${t('hygieneFailed')}: ${maintenance.lastError}`)
            : null,
          hygieneMessage
            ? h(
                'p',
                { className: hygieneState === 'error' ? 'mem0-error' : 'mem0-hint' },
                hygieneState === 'error'
                  ? `${t('hygieneFailed')}: ${hygieneMessage}`
                  : hygieneState === 'cancelled'
                    ? hygieneMessage
                    : `${t('hygieneOk')}: ${hygieneMessage}`,
              )
            : null,
        ),
        h(
          'details',
          { className: 'mem0-details' },
          h('summary', null, t('advanced')),
          h(
            'div',
            { className: 'mem0-grid' },
            h(TextField, {
              label: t('captureMaxChars'),
              hint: t('captureMaxCharsHint'),
              type: 'number',
              value: draft.captureMaxChars,
              onChange: (value) => setField('captureMaxChars', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('recallTopK'),
              hint: t('recallTopKHint'),
              type: 'number',
              value: draft.recallTopK,
              onChange: (value) => setField('recallTopK', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('timeoutMs'),
              hint: t('timeoutMsHint'),
              type: 'number',
              value: draft.timeoutMs,
              onChange: (value) => setField('timeoutMs', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('recallTimeoutMs'),
              hint: t('recallTimeoutMsHint'),
              type: 'number',
              value: draft.recallTimeoutMs,
              onChange: (value) => setField('recallTimeoutMs', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('addTimeoutMs'),
              hint: t('addTimeoutMsHint'),
              type: 'number',
              value: draft.addTimeoutMs,
              onChange: (value) => setField('addTimeoutMs', value === '' ? '' : Number(value)),
            }),
            draft.backend === 'oss'
              ? h(TextField, {
                  label: t('captureTurnDedupThreshold'),
                  hint: t('captureTurnDedupThresholdHint'),
                  type: 'number',
                  value: draft.captureTurnDedupThreshold,
                  onChange: (value) => setField('captureTurnDedupThreshold', value === '' ? '' : Number(value)),
                })
              : null,
            draft.backend === 'oss'
              ? h(TextField, {
                  label: t('embedderKeepAlive'),
                  hint: t('embedderKeepAliveHint'),
                  value: draft.embedderKeepAlive,
                  onChange: (value) => setField('embedderKeepAlive', value.trim()),
                })
              : null,
          ),
        ),
        h(
          'div',
          { className: 'mem0-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'mem0-primary',
              onClick: () => void save(),
              disabled: !snapshot.writable || saveState === 'saving' || !dirty,
            },
            saveState === 'saving' ? t('saving') : t('save'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mem0-secondary',
              onClick: () => void test(),
              disabled: saveState === 'saving' || testState === 'testing',
            },
            testState === 'testing' ? t('testing') : t('test'),
          ),
          dirty
            ? h('button', { type: 'button', className: 'mem0-secondary', onClick: discard }, t('reset'))
            : null,
          dirty ? h('span', { className: 'mem0-actions-note' }, t('unsaved')) : null,
          saveState === 'saved' ? h('span', { className: 'mem0-saved' }, t('saved')) : null,
          saveState === 'error' ? h('span', { className: 'mem0-error' }, saveMessage) : null,
          testState === 'ok' ? h('span', { className: 'mem0-saved' }, t('testOk')) : null,
          testState === 'error' ? h('span', { className: 'mem0-error' }, t('testFailed')) : null,
        ),
        h('p', { className: 'mem0-sub' }, t('whatNext')),
        !snapshot.writable ? h('p', { className: 'mem0-error' }, t('readOnly')) : null,
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () => ctx.locale.register(NS, { en, zh }),
        'dsh-mem0: settings dictionaries',
      )
      ctx.effect(() => {
        const tagId = 'dsh-mem0/settings.css'
        if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-mem0'
          tag.dataset.pluginCss = tagId
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
        return () => {
          if (typeof document !== 'undefined') {
            document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)?.remove()
            // dissolve's ThinkingOrb adds its base stylesheet once per document.
            document.getElementById('dissolve-thinking-orb')?.remove()
          }
        }
      }, 'dsh-mem0: settings styles')
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-mem0',
            locale: NS,
          },
          () => h(ConfigPage, { t, ctx }),
        ),
      )
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'dsh-mem0-status',
            order: -1,
            locale: NS,
          },
          // A session-scoped slot: DSH passes the conversation's sessionId.
          (props) => h(MemoryDockStatus, { ctx, t, sessionId: props?.sessionId }),
        ),
      )
    }

    return { inject: ['slots', 'locale', 'configForms'], apply, __test__: { en, zh, pageLanguage, dockView, captureWritten, chipState, activityChipSpec, deleteMemoryFlow, deleteErrorText, failureSummary, activityDetails, storeLines, formatDuration, emptyWizardDraft, wizardPayload, storeCheckText, llmAdvice, llmTestView, recallTimingLine, missingLocalSetup, migrationText, storedKeyApplies, wizardError, failureText, probeLineText, probeAutofill, omlxActionText, SuggestedUrl, wizardStepName, reportMemoryIds, reportBody, mergeLine, importanceLine, treeEntries, scopeLabel, projectName, sessionLabel, makeGlobalReason, scopeChipView, numericDraft } }
  },
})

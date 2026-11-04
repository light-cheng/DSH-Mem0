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
      statusCollection: 'Collection',
      statusUser: 'User',
      statusAgent: 'Agent',
      statusPython: 'Python',
      statusMem0: 'Mem0',
      statusQdrant: 'Qdrant',
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
      backendOssHint: 'Run the local Mem0 Python sidecar with your Qdrant and embedding model.',
      apiKey: 'API key',
      apiKeyHint: 'Stored as a secret. Leave blank to keep the current key.',
      apiKeySet: 'A key is configured. Leave blank to keep it.',
      apiKeyUnset: 'No key configured.',
      clearKey: 'Clear saved key',
      apiKeyEnv: 'API key environment variable',
      apiKeyEnvHint: 'Used when the API key field is empty.',
      baseUrl: 'Base URL',
      baseUrlPlatformHint: 'Leave blank for https://api.mem0.ai.',
      baseUrlServerHint: 'Example: http://127.0.0.1:8888',
      authType: 'Authentication',
      authApiKey: 'X-API-Key',
      authBearer: 'Bearer token',
      authToken: 'Token',
      authNone: 'No authentication',
      mem0ConfigPath: 'Mem0 OSS config file',
      mem0ConfigPathHint: 'Example: ~/.dsh/mem0/oss.json',
      pythonPath: 'Python executable',
      pythonPathHint: 'Leave blank to auto-discover the local Mem0 environment.',
      collectionName: 'Collection name',
      historyDbPath: 'History database',
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
      memoryBudgetTokensHint: 'Upper bound for raw recalled memories, 128–20000.',
      storeMaxMemories: 'Maximum stored memories',
      storeMaxMemoriesHint: 'Hygiene prunes the lowest-value facts above this count, 20–5000.',
      storeMaxTokens: 'Maximum stored tokens',
      storeMaxTokensHint: 'Hygiene prunes the lowest-value facts above this estimate, 500–200000.',
      hygieneEnabled: 'Weekly memory hygiene',
      hygieneEnabledHint: 'Runs at startup when due and hourly checks afterwards. Automatic passes only preview until you confirm a manual run.',
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
      hygieneReport: 'Scanned {scanned}, duplicates {duplicates}, pruned {pruned}, deleted {deleted}, failed {failed}.',
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
      hygieneConfirm: 'Hygiene will permanently delete {planned} memories written by this plugin (memories from other apps are never deleted). This cannot be undone. Continue?',
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
      timeoutMsHint: 'Timeout for a single backend request, 1–300000.',
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
      activityExtracting: 'Extracting',
      activitySkipped: 'Skipped',
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
      dockCaptureSkipped: 'Capture skipped',
      dockRecallSearching: 'Recalling memory',
      dockRecallOk: 'Memory recalled',
      dockError: 'Memory error',
      dockOpen: 'Open Mem0 settings',

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
      recallPreviewTitle: 'Last recalled memories',
      profileSummaryTitle: 'Memory summary',
      profileSummaryHint: 'Editable memory summary, injected before relevant memories during recall.',
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
      statusCollection: '集合',
      statusUser: '用户',
      statusAgent: 'Agent',
      statusPython: 'Python',
      statusMem0: 'Mem0',
      statusQdrant: 'Qdrant',
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
      backendOssHint: '通过本地 Mem0 Python sidecar 使用你的 Qdrant 和 embedding 模型。',
      apiKey: 'API Key',
      apiKeyHint: '作为密钥保存。留空表示保持当前 Key。',
      apiKeySet: '已配置 Key，留空保持不变。',
      apiKeyUnset: '尚未配置 Key。',
      clearKey: '清除已保存的 Key',
      apiKeyEnv: 'API Key 环境变量名',
      apiKeyEnvHint: 'API Key 输入框为空时使用该环境变量。',
      baseUrl: 'Base URL',
      baseUrlPlatformHint: '留空使用 https://api.mem0.ai。',
      baseUrlServerHint: '例如 http://127.0.0.1:8888',
      authType: '认证方式',
      authApiKey: 'X-API-Key',
      authBearer: 'Bearer token',
      authToken: 'Token',
      authNone: '无认证',
      mem0ConfigPath: 'Mem0 OSS 配置文件',
      mem0ConfigPathHint: '例如 ~/.dsh/mem0/oss.json',
      pythonPath: 'Python 解释器',
      pythonPathHint: '留空自动发现本地 Mem0 环境。',
      collectionName: '集合名称',
      historyDbPath: '历史数据库',
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
      memoryBudgetTokensHint: '注入原始召回记忆的上限，128–20000。',
      storeMaxMemories: '最大记忆条数',
      storeMaxMemoriesHint: '超过后按价值清理最低的记忆，20–5000。',
      storeMaxTokens: '最大存储 tokens',
      storeMaxTokensHint: '超过估算上限后按价值清理最低的记忆，500–200000。',
      hygieneEnabled: '每周记忆卫生巡检',
      hygieneEnabledHint: '到期时在启动后运行，之后每小时检查。确认过一次手动巡检之前，自动巡检只出预览、不删除。',
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
      hygieneReport: '扫描 {scanned}，重复 {duplicates}，预算清理 {pruned}，删除 {deleted}，失败 {failed}。',
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
      hygieneConfirm: '巡检将永久删除 {planned} 条本插件写入的记忆（其他应用写入的记忆不会被删除），无法恢复。继续吗？',
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
      timeoutMsHint: '单次后端请求超时，1–300000。',
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
      activityExtracting: '后台抽取中',
      activitySkipped: '已跳过',
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
      dockCaptureSkipped: '保存已跳过',
      dockRecallSearching: '召回记忆中',
      dockRecallOk: '已召回记忆',
      dockError: '记忆失败',
      dockOpen: '打开 Mem0 设置',

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
      recallPreviewTitle: '上次召回的记忆',
      profileSummaryTitle: '记忆摘要',
      profileSummaryHint: '可编辑的记忆摘要，召回时优先注入。',
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
      .mem0-section-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .mem0-search-row{display:flex;align-items:center;gap:8px;margin:10px 0}
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
      .mem0-globe{width:18px;height:18px;flex:none;color:var(--dsw-alias-label-primary);overflow:visible;transition:color .25s ease,filter .25s ease}
      .mem0-globe.is-success{color:#7dd3fc;filter:drop-shadow(0 0 2px color-mix(in srgb, #7dd3fc 65%, transparent))}
      .mem0-globe.is-error{color:var(--dsw-alias-state-error-primary)}
      .mem0-globe-static,.mem0-globe-roll{transition:opacity .22s ease}
      .mem0-globe-roll{opacity:0}
      .mem0-globe.is-active .mem0-globe-static,.mem0-globe.is-success .mem0-globe-static{opacity:0}
      .mem0-globe.is-active .mem0-globe-roll,.mem0-globe.is-success .mem0-globe-roll{opacity:1}
      .mem0-dock-text{overflow:hidden;text-overflow:ellipsis}
      @media (prefers-reduced-motion:reduce){
        .mem0-globe.is-active .mem0-globe-static,.mem0-globe.is-success .mem0-globe-static{opacity:1}
        .mem0-globe.is-active .mem0-globe-roll,.mem0-globe.is-success .mem0-globe-roll{opacity:0}
      }
      @media (max-width:640px){.mem0-segments{grid-template-columns:1fr 1fr}.mem0-grid{grid-template-columns:1fr}.mem0-status-grid{grid-template-columns:1fr 1fr}}
    `

    const NUMERIC_FIELDS = new Set([
      'captureMaxChars',
      'recallTopK',
      'timeoutMs',
      'profileBudgetTokens',
      'memoryBudgetTokens',
      'storeMaxMemories',
      'storeMaxTokens',
      'hygieneIntervalDays',
    ])
    const FIELD_ORDER = [
      'backend',
      'apiKey',
      'apiKeyEnv',
      'baseUrl',
      'authType',
      'pythonPath',
      'mem0ConfigPath',
      'collectionName',
      'historyDbPath',
      'userId',
      'agentId',
      'autoRecall',
      'autoCapture',
      'announceToAgent',
      'includeSubagents',
      'captureMaxChars',
      'recallTopK',
      'timeoutMs',
      'captureFilter',
      'profileEnabled',
      'profileBudgetTokens',
      'memoryBudgetTokens',
      'storeMaxMemories',
      'storeMaxTokens',
      'hygieneEnabled',
      'hygieneIntervalDays',
      'enabled',
    ]

    function normalise(value) {
      return {
        backend: value?.backend ?? 'auto',
        apiKeyEnv: value?.apiKeyEnv ?? 'MEM0_API_KEY',
        baseUrl: value?.baseUrl ?? '',
        authType: value?.authType ?? 'apiKey',
        pythonPath: value?.pythonPath ?? '',
        mem0ConfigPath: value?.mem0ConfigPath ?? '',
        collectionName: value?.collectionName ?? 'dsh_mem0',
        historyDbPath: value?.historyDbPath ?? '',
        userId: value?.userId ?? 'dsh-user',
        agentId: value?.agentId ?? 'dsh',
        autoRecall: value?.autoRecall !== false,
        autoCapture: value?.autoCapture !== false,
        announceToAgent: value?.announceToAgent !== false,
        includeSubagents: value?.includeSubagents === true,
        captureMaxChars: Number(value?.captureMaxChars ?? 450),
        recallTopK: Number(value?.recallTopK ?? 5),
        timeoutMs: Number(value?.timeoutMs ?? 30000),
        captureFilter: value?.captureFilter === 'off' ? 'off' : 'heuristic',
        profileEnabled: value?.profileEnabled !== false,
        profileBudgetTokens: Number(value?.profileBudgetTokens ?? 1375),
        memoryBudgetTokens: Number(value?.memoryBudgetTokens ?? 2200),
        storeMaxMemories: Number(value?.storeMaxMemories ?? 500),
        storeMaxTokens: Number(value?.storeMaxTokens ?? 20000),
        hygieneEnabled: value?.hygieneEnabled !== false,
        hygieneIntervalDays: Number(value?.hygieneIntervalDays ?? 7),
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

    async function fetchJson(path, options, attempt = 0) {
      let response
      try {
        response = await fetch(route(path), {
          credentials: 'same-origin',
          headers: { accept: 'application/json', ...(options?.headers ?? {}) },
          ...options,
        })
      } catch (error) {
        if (attempt < 5) {
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
        if (attempt < 5 && [404, 502, 503].includes(response.status)) {
          await delay(300)
          return fetchJson(path, options, attempt + 1)
        }
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return payload
    }

    function pageLanguage(t) {
      return t?.('memoryScore') === '相关度' ? 'zh' : 'en'
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

    function activityChip(t, state) {
      const map = {
        queued: ['activityQueued', 'mem0-state-warn'],
        saving: ['activitySaving', 'mem0-state-warn'],
        saved: ['activitySaved', 'mem0-state-ok'],
        extracting: ['activityExtracting', 'mem0-state-warn'],
        skipped: ['activitySkipped', ''],
        searching: ['activitySearching', 'mem0-state-warn'],
        ok: ['activityOk', 'mem0-state-ok'],
        error: ['activityError', 'mem0-state-error'],
      }
      const [key, className] = map[state] ?? ['activityNever', '']
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

    function formatHygieneReport(t, report) {
      const value = report ?? {}
      const base = t('hygieneReport')
        .replace('{scanned}', String(value.scanned ?? 0))
        .replace('{duplicates}', String(value.duplicates ?? 0))
        .replace('{pruned}', String(value.pruned ?? 0))
        .replace('{deleted}', String(value.deleted ?? 0))
        .replace('{failed}', String(value.failed ?? 0))
      const parts = [base]
      if (value.foreign > 0) parts.push(template(t('hygieneForeign'), value))
      if (value.dryRun) parts.unshift(`[${t('hygienePreviewTag')}]`)
      return parts.join(' ')
    }

    function hygieneReason(t, reason) {
      if (reason === 'manual') return t('hygieneReasonManual')
      if (reason === 'startup') return t('hygieneReasonStartup')
      return t('hygieneReasonSchedule')
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

    const GLOBE_DOTS = [
      [18.71, 28.2, 0.79], [12.58, 27.61, 0.95], [16.52, 27.01, 0.91], [20.2, 26.42, 0.91],
      [8.39, 25.82, 0.82], [23.12, 25.23, 0.87], [13.65, 24.63, 1.03], [11.59, 24.04, 0.75],
      [25.43, 23.44, 1.0], [6.33, 22.85, 0.84], [20.59, 22.25, 0.75], [19.34, 21.65, 1.0],
      [6.11, 21.06, 0.68], [27.4, 20.46, 0.81], [9.16, 19.87, 0.95], [14.45, 19.27, 0.68],
      [25.34, 18.68, 1.06], [3.69, 18.08, 0.72], [24.8, 17.49, 0.69], [15.42, 16.89, 1.37],
      [7.99, 16.3, 0.61], [28.38, 15.7, 0.85], [5.77, 15.11, 0.82], [18.72, 14.51, 0.64],
      [22.13, 13.92, 1.16], [4.37, 13.32, 0.63], [26.95, 12.73, 0.7], [11.41, 12.13, 1.22],
      [12.05, 11.54, 0.6], [26.12, 10.94, 0.93], [5.22, 10.35, 0.97], [21.85, 9.75, 0.64],
      [17.77, 9.15, 1.21], [8.06, 8.56, 0.6], [25.54, 7.96, 0.78], [9.86, 7.37, 1.08],
      [16.04, 6.77, 0.67], [21.2, 6.18, 1.0], [9.12, 5.58, 0.95], [20.71, 4.99, 0.74],
      [15.17, 4.39, 1.08], [14.56, 3.8, 1.03],
    ]
    const GLOBE_RADII = GLOBE_DOTS.map(([, , radius]) => radius)
    const GLOBE_SCALE = 0.88
    const GLOBE_ROLL_PERIOD = 2600
    const GLOBE_AXIS = (() => {
      const x = -0.55
      const y = 1
      const length = Math.hypot(x, y)
      return { x: x / length, y: y / length, z: 0 }
    })()
    const GLOBE_POINTS = (() => {
      const golden = Math.PI * (3 - Math.sqrt(5))
      return GLOBE_RADII.map((radius, index) => {
        const y = 1 - (2 * (index + 0.5)) / GLOBE_RADII.length
        const ring = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = golden * index
        return {
          x: Math.cos(theta) * ring * GLOBE_SCALE,
          y: y * GLOBE_SCALE,
          z: Math.sin(theta) * ring * GLOBE_SCALE,
          r: radius,
        }
      })
    })()

    function rotateGlobePoint(point, angle) {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const axis = GLOBE_AXIS
      const dot = axis.x * point.x + axis.y * point.y + axis.z * point.z
      return {
        x: point.x * cos + (axis.y * point.z - axis.z * point.y) * sin + axis.x * dot * (1 - cos),
        y: point.y * cos + (axis.z * point.x - axis.x * point.z) * sin + axis.y * dot * (1 - cos),
        z: point.z * cos + (axis.x * point.y - axis.y * point.x) * sin + axis.z * dot * (1 - cos),
      }
    }

    function GlobeStatus({ state }) {
      const rolling = state === 'active' || state === 'success'
      const rollRefs = useRef([])
      const angleRef = useRef(0)

      useLayoutEffect(() => {
        const paint = (angle) => {
          for (let index = 0; index < GLOBE_POINTS.length; index += 1) {
            const element = rollRefs.current[index]
            if (!element) continue
            const point = rotateGlobePoint(GLOBE_POINTS[index], angle)
            const depth = (point.z + 1) / 2
            element.setAttribute('cx', (16 + point.x * 16).toFixed(2))
            element.setAttribute('cy', (16 + point.y * 16).toFixed(2))
            element.setAttribute('r', (GLOBE_POINTS[index].r * (0.8 + 0.2 * depth)).toFixed(2))
            element.setAttribute('opacity', (0.55 + 0.45 * depth).toFixed(2))
          }
        }

        paint(angleRef.current)
        if (!rolling) return
        const reduced =
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        if (reduced) return

        let last = 0
        let frame = 0
        const tick = (now) => {
          if (!last) last = now
          const delta = Math.min(64, now - last)
          last = now
          angleRef.current += (delta / GLOBE_ROLL_PERIOD) * Math.PI * 2
          paint(angleRef.current)
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(frame)
      }, [rolling])

      const classes = ['mem0-globe']
      if (state === 'active') classes.push('is-active')
      if (state === 'success') classes.push('is-success')
      if (state === 'error') classes.push('is-error')
      return h(
        'svg',
        {
          className: classes.join(' '),
          viewBox: '0 0 32 32',
          width: 18,
          height: 18,
          'aria-hidden': 'true',
        },
        h(
          'g',
          { className: 'mem0-globe-static', fill: 'currentColor' },
          GLOBE_DOTS.map(([cx, cy, r], index) =>
            h('circle', { key: `static-${index}`, cx, cy, r }),
          ),
        ),
        h(
          'g',
          { className: 'mem0-globe-roll', fill: 'currentColor' },
          GLOBE_POINTS.map((point, index) =>
            h('circle', {
              key: `roll-${index}`,
              ref: (element) => {
                rollRefs.current[index] = element
              },
              r: point.r,
            }),
          ),
        ),
      )
    }

    function MemoryDockStatus({ ctx, t }) {
      const [data, setData] = useState(null)
      const [failed, setFailed] = useState(false)

      useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const next = await fetchJson(`${ACTIVITY_PATH}?lang=${pageLanguage(t)}&translate=0`)
            if (live) {
              setData(next)
              setFailed(false)
            }
          } catch {
            if (live) setFailed(true)
          }
        }
        void load()
        const timer = setInterval(() => void load(), 2000)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])

      const capture = data?.activity?.capture ?? null
      const recall = data?.activity?.recall ?? null
      let state = 'idle'
      let label = t('dockIdle')

      if (failed) {
        state = 'error'
        label = t('dockError')
      } else if (data && data.enabled === false) {
        label = t('dockDisabled')
      } else if (capture?.status === 'saving') {
        state = 'active'
        label = t('dockCaptureSaving')
      } else if (capture?.status === 'queued') {
        state = 'active'
        label = t('dockCaptureQueued')
      } else if (capture?.status === 'extracting') {
        state = 'active'
        label = t('dockCaptureExtracting')
      } else if (capture?.status === 'error' || recall?.status === 'error') {
        state = 'error'
        label = t('dockError')
      } else if (recall?.status === 'searching') {
        state = 'active'
        label = t('dockRecallSearching')
      } else {
        const recent = (at) => {
          const value = Date.parse(at)
          return Number.isFinite(value) && Date.now() - value < 10 * 60 * 1000
        }
        const items = []
        if (capture?.status === 'saved' && recent(capture.at)) {
          items.push({
            at: Date.parse(capture.at),
            label: `${t('dockCaptureSaved')}${capture.count ? ` ${capture.count}` : ''}`,
          })
        }
        if (recall?.status === 'ok' && recent(recall.at)) {
          items.push({
            at: Date.parse(recall.at),
            label: `${t('dockRecallOk')}${recall.count !== undefined ? ` ${recall.count}` : ''}`,
          })
        }
        const latest = items.sort((left, right) => right.at - left.at)[0]
        if (latest) {
          state = 'success'
          label = latest.label
        } else if (capture?.status === 'skipped') {
          label = t('dockCaptureSkipped')
        }
      }

      const openSettings = () => {
        try {
          ctx.get('pluginNavigation')?.openBundle?.(PKG)
        } catch {
          // Navigation is optional; the indicator still works without it.
        }
      }

      return h(
        'button',
        {
          type: 'button',
          className: 'mem0-dock',
          title: t('dockOpen'),
          onClick: openSettings,
        },
        h(GlobeStatus, { state }),
        h('span', { className: 'mem0-dock-text' }, label),
      )
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
      const [memoryState, setMemoryState] = useState({ phase: 'idle', data: null, message: '' })
      const [profileDraft, setProfileDraft] = useState(null)
      const [profileEditing, setProfileEditing] = useState(false)
      const [profileState, setProfileState] = useState('idle')
      const [profileMessage, setProfileMessage] = useState('')

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
            `${STATUS_PATH}?lang=${pageLanguage(t)}&translate=${translate ? '1' : '0'}`,
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

      const loadMemories = useCallback(async (query) => {
        const q = String(query ?? '').trim()
        setMemoryState((current) => ({ phase: 'loading', data: current.data, message: '' }))
        try {
          const data = await fetchJson(`${MEMORIES_PATH}?q=${encodeURIComponent(q)}&limit=500&lang=${pageLanguage(t)}`)
          setMemoryState({ phase: 'ready', data, message: '' })
        } catch (error) {
          setMemoryState({ phase: 'error', data: null, message: error.message })
        }
      }, [])

      const toggleBrowser = () => {
        if (!browserOpen) void loadMemories(memoryQuery)
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
        const next = { ...draft }
        for (const key of NUMERIC_FIELDS) {
          const number = Number(next[key])
          if (!Number.isInteger(number)) {
            setSaveState('error')
            setSaveMessage(t('invalidNumber'))
            return false
          }
          next[key] = number
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
        if (!response?.ok) throw new Error(response?.error || t('hygieneFailed'))
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
          if (planned > 0 && !window.confirm(template(t('hygieneConfirm'), { planned }))) {
            setHygieneState('cancelled')
            setHygieneMessage(t('hygieneCancelled'))
            return
          }
          setHygieneState('running')
          const report = applyHygieneResponse(
            await fetchJson(HYGIENE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dryRun: false }),
            }),
          )
          setHygieneState('ok')
          setHygieneMessage(
            planned > 0 ? formatHygieneReport(t, report) : `${t('hygieneNothingToDelete')} ${formatHygieneReport(t, report)}`,
          )
          await refreshStatus()
        } catch (error) {
          setHygieneState('error')
          setHygieneMessage(error.message || t('hygieneFailed'))
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
        if (data.pythonVersion) statusItems.push({ key: 'python', label: t('statusPython'), value: data.pythonVersion })
        if (data.mem0Version) statusItems.push({ key: 'mem0', label: t('statusMem0'), value: data.mem0Version })
        if (data.qdrant) {
          statusItems.push({
            key: 'qdrant',
            label: t('statusQdrant'),
            value: data.qdrant.ok ? 'OK' : data.qdrant.error ?? '—',
          })
        }
        if (data.embedder) {
          statusItems.push({
            key: 'embedder',
            label: t('statusEmbedder'),
            value: data.embedder.ok ? `${data.embedder.dimensions ?? '?'} dims` : data.embedder.error ?? '—',
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
        if (maintenance.profile.updatedAt) {
          profileMeta.push(`${t('profileSummaryUpdated')} ${activityTime(maintenance.profile.updatedAt)}`)
        }
      }
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
            key: 'mem0ConfigPath',
            label: t('mem0ConfigPath'),
            hint: t('mem0ConfigPathHint'),
            value: draft.mem0ConfigPath,
            placeholder: '~/.dsh/mem0/oss.json',
            className: 'mem0-grid-single',
            onChange: (value) => setField('mem0ConfigPath', value),
          }),
          h(TextField, {
            key: 'pythonPath',
            label: t('pythonPath'),
            hint: t('pythonPathHint'),
            value: draft.pythonPath,
            placeholder: '~/.dsh/mem0/venv/bin/python',
            className: 'mem0-grid-single',
            onChange: (value) => setField('pythonPath', value),
          }),
          h(TextField, {
            key: 'collectionName',
            label: t('collectionName'),
            value: draft.collectionName,
            onChange: (value) => setField('collectionName', value),
          }),
          h(TextField, {
            key: 'historyDbPath',
            label: t('historyDbPath'),
            value: draft.historyDbPath,
            placeholder: '~/.dsh/mem0/history.db',
            onChange: (value) => setField('historyDbPath', value),
          }),
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
                  h('span', { className: 'mem0-stat-value', title: String(item.value) }, item.value),
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
                capture ? activityChip(t, capture.status) : null,
              ),
              h(
                'p',
                { className: 'mem0-activity-main' },
                capture ? t('activityCapture') : t('activityNever'),
              ),
              capture?.error ? h('p', { className: 'mem0-error' }, capture.error) : null,
              captureMeta.length > 0 ? h('p', { className: 'mem0-activity-meta' }, captureMeta.join(' · ')) : null,
            ),
            h(
              'div',
              { className: 'mem0-activity' },
              h(
                'div',
                { className: 'mem0-activity-head' },
                h('span', { className: 'mem0-activity-title' }, t('activityRecall')),
                recall ? activityChip(t, recall.status) : null,
              ),
              h(
                'p',
                { className: 'mem0-activity-main' },
                recall ? t('activityRecall') : t('activityNever'),
              ),
              recall?.error ? h('p', { className: 'mem0-error' }, recall.error) : null,
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
                h('h3', { className: 'mem0-section-title' }, t('memoryBrowserTitle')),
                h(
                  'button',
                  { type: 'button', className: 'mem0-secondary', onClick: toggleBrowser },
                  t('memoryBrowserClose'),
                ),
              ),
              h('p', { className: 'mem0-section-hint' }, t('memoryBrowserHint')),
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
                      void loadMemories(memoryQuery)
                    }
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem0-primary',
                    onClick: () => void loadMemories(memoryQuery),
                    disabled: memoryState.phase === 'loading',
                  },
                  t('memorySearch'),
                ),
              ),
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
                                    ),
                                  ),
                                ),
                              )
                            : h('p', { className: 'mem0-empty' }, t('memoryEmpty')),
                        )
                      : h('p', { className: 'mem0-hint' }, t('memoryBrowserHint')),
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
                  onClick: () => setField('backend', option.id),
                },
                option.label,
              ),
            ),
          ),
          h('p', { className: 'mem0-section-hint' }, backendHint),
        ),
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
                disabled: hygieneState === 'running' || hygieneState === 'previewing' || !data,
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
              label: t('storeMaxMemories'),
              hint: t('storeMaxMemoriesHint'),
              type: 'number',
              value: draft.storeMaxMemories,
              onChange: (value) => setField('storeMaxMemories', value === '' ? '' : Number(value)),
            }),
            h(TextField, {
              label: t('storeMaxTokens'),
              hint: t('storeMaxTokensHint'),
              type: 'number',
              value: draft.storeMaxTokens,
              onChange: (value) => setField('storeMaxTokens', value === '' ? '' : Number(value)),
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
                ['duplicateDetails', 'prunedDetails', 'deletedDetails', 'failedDetails'].some((key) => Array.isArray(lastReport[key]))
                  ? h(
                      'div',
                      { className: 'mem0-report-details-list' },
                      lastReport.dryRun
                        ? reportDetail(t, `${t('hygienePlannedDetails')} (${lastReport.planned ?? 0})`, lastReport.plannedDetails, (item) => item.preview || item.id)
                        : null,
                      reportDetail(t, t('hygieneDuplicateDetails'), lastReport.duplicateDetails, (item) => item.preview || item.id),
                      reportDetail(t, t('hygienePrunedDetails'), lastReport.prunedDetails, (item) => item.preview || item.id),
                      reportDetail(t, t('hygieneDeletedDetails'), lastReport.deletedDetails, (item) => item.preview || item.id),
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
          () => h(MemoryDockStatus, { ctx, t }),
        ),
      )
    }

    return { inject: ['slots', 'locale', 'configForms'], apply }
  },
})

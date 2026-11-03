# Release notes

English is the default; the Chinese version follows below.

## English

### v0.2.0 — first public release

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
- Local-only `link:` installs show the checkout path as DSH install metadata; npm packages contain no local paths.

Verification: 58 Node tests and 4 Python tests pass; `npm run check` and `npm pack` pass.

## 简体中文

### v0.2.0 — 首个公开版本

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
- 本地 `link:` 安装会在 DSH 插件详情中显示本机路径，这是安装元数据；npm 发布包不包含本机路径。

验证：58 个 Node 测试和 4 个 Python 测试通过；`npm run check` 与 `npm pack` 通过。

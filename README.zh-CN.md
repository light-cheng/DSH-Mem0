# DSH-Mem0

[English](README.md) | **简体中文**

<p align="center"><img src="assets/icon.png" width="96" height="96" alt="Mem0 Memory icon"></p>

给 DeepSeek Harness（DSH）使用的通用 Mem0 长期记忆插件。

仓库：<https://github.com/light-cheng/DSH-Mem0>

支持三种后端：

- **Mem0 Platform**：使用 Mem0 托管 API，只需 API Key，适合大多数用户。
- **Self-hosted server**：连接自建 Mem0 REST 服务。
- **OSS Python sidecar**：复用本地 Mem0 Python SDK / Qdrant / embedding 服务，适合本地 bge-m3、Qdrant 等自托管环境。

## 能力

- **自动召回**：每个回合用最近一条真实用户消息搜索相关记忆，以 `<mem0-relevant-memories>` 数据块注入模型上下文；失败或超时不会阻塞模型请求。
- **自动保存与过滤**：回合正常完成后，把本轮的用户消息和助手的最终回复（不含工具调用之间的中间叙述）交给 Mem0 做事实抽取并写入，工具调用很多的长回合也会被保存；中断、失败、被拒绝的回合不会保存。默认的启发式过滤会跳过问候、简短确认和纯命令回合，减少无价值记忆。
- **可编辑的记忆摘要**：从已存记忆中按重要度和新鲜度提取一份结构化摘要，在相关记忆之前注入；它有独立 token 预算，可以直接在设置页编辑，也可以由 agent 通过 `mem0_profile_get` / `mem0_profile_update` / `mem0_profile_reset` 读取或改写。手动编辑不会被周巡检覆盖；「从记忆重建」可恢复自动生成版本。
- **记忆预算与周巡检**：召回记忆和画像各有 token 预算；默认每 7 天做一次记忆卫生巡检，去重并按价值清理超预算的记忆，也可以在设置页手动触发。
- **显式工具**：`mem0_search`、`mem0_add`、`mem0_get`、`mem0_update`、`mem0_delete`、`mem0_status`，以及记忆摘要的 `mem0_profile_get`、`mem0_profile_update`、`mem0_profile_reset`。
- **后端可切换**：Platform、自托管 server、本地 OSS sidecar 共用同一套工具与自动记忆逻辑。
- **可验证的记忆活动**：设置页显示自动保存 / 自动召回的最后状态，列出最近写入的记忆（文本、ID、时间），并可打开「记忆库」搜索当前用户的全部记忆；「上次召回的记忆」显示最近一次召回实际命中的文本。
- **前台状态图标**：对话输入框下方有一个由大小不一的圆点组成的镂空地球仪；自动保存/召回时沿倾斜方向滚动，成功后变成浅蓝色并继续滚动，失败显示红色。滚动时球体轮廓保持圆形，不会压扁。浅色主题下是黑点，深色主题自动用浅色点保证可见。
- **中英双语界面与记忆内容**：文案跟随 DSH 的语言设置；已存记忆文本会用当前 DSH 模型翻译成页面语言，带缓存，没有可用模型时回退原文。
- **安全边界**：sidecar 只监听 `127.0.0.1` 的随机端口并使用随机 token；写入/召回前做常见密钥脱敏；`mem0_status` 不输出 API key。

## 界面

安装后打开 DSH 侧栏的「插件」页，在「已安装插件」中打开「Mem0 长期记忆」，即可直接在 Bundle 详情里选择后端、查看实时连接状态并保存设置：

![插件管理页](assets/screenshots/01-plugin-page.png)

![自动检测与连接状态](assets/screenshots/02-settings-auto.png)

支持三种后端，每种都有对应的字段和引导：

![Mem0 Platform 配置](assets/screenshots/03-settings-platform.png)

![本地 OSS 配置](assets/screenshots/04-settings-oss.png)

页面里的「测试连接」会调用 `mem0_status` 同源的只读健康检查，显示当前后端、集合、Python/Mem0/Qdrant/Embedder 状态，不会显示 API Key。

「记忆摘要」是召回时优先注入的可编辑摘要，按主题分节显示；点「编辑摘要」修改并保存，下一轮对话即可使用；「从记忆重建」会丢弃手动编辑，按已存记忆重新生成。

![记忆摘要](assets/screenshots/12-memory-summary.png)

「记忆活动」会记录最近一次自动保存和自动召回的结果；「最近写入的记忆」直接读取后端，显示真实记忆文本、ID 和时间。这样不需要猜自动保存有没有生效：

「查看全部记忆」会打开「记忆库」，可按记忆内容或 ID 搜索当前用户存储的全部记忆；「上次召回的记忆」显示最近一次自动召回实际命中的文本、ID、条数和延迟：

![记忆库](assets/screenshots/10-memory-library.png)

![上次召回的记忆](assets/screenshots/11-recall-preview.png)

「记忆维护」区域可以调整记忆摘要预算、召回预算、存储上限和巡检间隔，并查看上次/下次巡检时间、最近一次巡检报告（扫描、重复、预算清理、删除、失败数量，以及运行时间和触发方式）和当前记忆摘要规模；「立即巡检」会清理重复项与超预算记忆，但不会覆盖手动编辑的记忆摘要：

![记忆维护](assets/screenshots/09-maintenance.png)

对话输入框下方还会显示点阵地球仪：待命时静止，记录中沿倾斜方向滚动，成功后变成浅蓝色并继续滚动。滚动使用三维投影，点阵球体的轮廓保持圆形，不会压扁或变形；系统开启「减少动态效果」时保持静止。

![点阵地球仪状态](assets/globe-states.png)

实际会话底部的状态条（截取）：

![前台状态](assets/screenshots/08-foreground-status.png)

![记忆活动与最近写入](assets/screenshots/06-activity.png)

「测试连接」成功时，状态卡会显示绿色的「连接成功」：

![测试连接成功](assets/screenshots/05-test-success.png)

英文界面（跟随 DSH 语言设置）：

![English settings](assets/screenshots/en/02-settings-auto.png)

## 记忆维护

设置页的「记忆维护」区域把几个容易混淆的预算分开：

- **记忆摘要预算**：`<mem0-user-profile>` 数据块的上限，默认 1375 tokens。
- **召回记忆预算**：`<mem0-relevant-memories>` 数据块的上限，默认 2200 tokens。
- **存储上限**：巡检后保留的最大记忆条数（默认 500）和估算 tokens（默认 20000）。

巡检默认每 7 天一次，可改成 1–90 天；插件启动时若已到期会跑一次，之后每小时检查一次。巡检只删除重复项和超预算的低价值记忆，不会清空整个库；画像和巡检历史保存在当前 DSH profile 的 `dsh-mem0/maintenance.json`，不写回 Mem0。最近一次报告会持续显示在「记忆维护」卡片中，包括扫描、重复、预算清理、删除和失败数量、运行时间与触发方式；手动「立即巡检」也会返回同一组数量。

自动生成的记忆摘要由本地确定性逻辑生成，不额外调用模型；你可以随时手动编辑，内容保存在 `maintenance.json`，不会被巡检覆盖。点「从记忆重建」可恢复自动生成版本。

## 架构

```text
DSH Agent
  ├─ system-prompt/assemble ──┐
  ├─ session/event            ├─> Node 插件（index.js + lib/）
  ├─ mem0_* tools            ─┘        │
  │                                     ▼
  │                          后端适配器（二选一）
  │                          ├─ Mem0RestClient（platform / server）
  │                          └─ Mem0SidecarClient（oss）
  │                                     │
  │                                     ▼
  │                          Mem0 Platform / 自建 server / 本地 Python Mem0
```

## 安装

通过 DSH Plugin Manager 安装本目录（开发/本地安装）：

```text
plugin_manager action: install_bundle
target: <本目录的绝对路径>
```

也可以用 DSH CLI：

```bash
dsh plugin --profile desktop add link:"$(pwd)"
```

发布到 npm 后可以按包名安装：

```bash
dsh plugin --profile desktop add dsh-mem0
```

安装后如果提示 `restart-required`，重启 DSH 后再验证。

> 本地 `link:` 安装时，DSH 插件详情页的「代码来源」会显示本机 checkout 路径。这是本地 profile 的安装元数据，不是插件包内容；`npm pack` 和从 npm 安装的包不包含本机路径，从 npm 安装会显示包来源。发布用的截图已避开这一行。

## 配置

安装后可以直接在 DSH 侧栏「插件」页的「Mem0 长期记忆」Bundle 详情中可视化配置（推荐）；也可以手写 profile 的 `cordis.patch.yml`。完整 YAML 示例：

```yaml
- id: dsh-mem0
  name: dsh-mem0
  config:
    backend: platform
    apiKey: "your-platform-api-key"
    userId: "your-user-id"
    agentId: "dsh"
```

### 后端模式

#### Platform（最简单，推荐新用户）

```yaml
config:
  backend: platform
  apiKey: "your-platform-api-key"
  userId: "your-user-id"
```

API Key 也可以不放配置里，改为使用环境变量：

```yaml
config:
  backend: platform
  apiKeyEnv: MEM0_API_KEY
```

#### Self-hosted Mem0 server

```yaml
config:
  backend: server
  baseUrl: "http://127.0.0.1:8888"
  authType: apiKey
  apiKey: "your-server-key"
  userId: "your-user-id"
```

`authType` 支持 `apiKey`（`X-API-Key`）、`bearer`、`token` 和 `none`（`AUTH_DISABLED=true` 的本地服务）。

#### OSS Python sidecar（本地 Qdrant / bge-m3）

先准备一个 Mem0 OSS 配置文件，例如 `~/.dsh/mem0/oss.json`，格式见 [examples/oss-config.example.json](examples/oss-config.example.json)。

```yaml
config:
  backend: oss
  pythonPath: "~/.dsh/mem0/venv/bin/python"
  mem0ConfigPath: "~/.dsh/mem0/oss.json"
  collectionName: "dsh_mem0"
  userId: "your-user-id"
```

Python 环境需要：

```bash
python3 -m venv ~/.dsh/mem0/venv
~/.dsh/mem0/venv/bin/pip install "mem0ai>=2.0.10,<3" qdrant-client openai
```

当前版本**不会在插件加载时静默安装** Python 或 Qdrant，也不会修改系统 Python。设置页会显示连接错误；建议优先使用 Platform，或按上面的命令手动准备本地环境。后续更合适的做法是在设置页做「环境检测 + 用户点击后一键创建 venv」的引导安装，而不是安装插件时自动执行。

sidecar 会读取 `mem0ConfigPath` 中的 `oss.llm`、`oss.embedder`、`oss.vector_store`，并把集合名覆盖为 `collectionName`；其他 Mem0 客户端可以继续使用自己的集合。

### 全部配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `backend` | `auto` | `auto` / `platform` / `server` / `oss` |
| `apiKey` | 空 | Platform 或 server 的 API Key |
| `apiKeyEnv` | `MEM0_API_KEY` | API Key 环境变量名 |
| `baseUrl` | Platform 为 `https://api.mem0.ai`，server 为 `http://127.0.0.1:8888` | API 地址 |
| `authType` | `apiKey`（platform 固定 token） | `apiKey` / `bearer` / `token` / `none` |
| `pythonPath` | 自动发现 | OSS 模式 Python 解释器 |
| `mem0ConfigPath` | `~/.dsh/mem0/oss.json` | OSS 模式 Mem0 配置文件 |
| `collectionName` | `dsh_mem0` | OSS 模式 Qdrant 集合 |
| `historyDbPath` | `~/.dsh/mem0/history.db` | OSS sidecar 本地历史库 |
| `userId` | `dsh-user` | 记忆归属用户 |
| `agentId` | `dsh` | DSH 写入时附加的 agent 标识；当前召回只按 `userId` 过滤，不按 `agentId` 隔离 |
| `autoRecall` | `true` | 自动召回 |
| `autoCapture` | `true` | 自动保存完成回合 |
| `announceToAgent` | `true` | 向模型宣告记忆能力 |
| `includeSubagents` | `false` | 是否对子代理启用自动记忆 |
| `captureMaxChars` | `450` | 自动保存时每条消息截断上限 |
| `captureFilter` | `heuristic` | `heuristic` 跳过低价值回合；`off` 保存每个完成回合 |
| `recallTopK` | `5` | 自动召回结果数 |
| `memoryBudgetTokens` | `2200` | 召回记忆注入的 token 预算 |
| `profileEnabled` | `true` | 是否生成并注入精简用户画像 |
| `profileBudgetTokens` | `1375` | 画像注入的 token 预算 |
| `storeMaxMemories` | `500` | 巡检后保留的最大记忆条数 |
| `storeMaxTokens` | `20000` | 巡检后保留的记忆估算 token 上限 |
| `hygieneEnabled` | `true` | 是否启用记忆卫生巡检 |
| `hygieneIntervalDays` | `7` | 巡检间隔天数，1–90 |
| `timeoutMs` | `30000` | REST 后端单请求超时 |
| `enabled` | `true` | 总开关 |

修改配置后重新加载插件或重启 DSH。

## 工具

| 工具 | 用途 |
|---|---|
| `mem0_search` | 语义搜索，返回 `[mem0:<id>]` 和相关度 |
| `mem0_add` | 原样存储一条持久事实（`infer:false`） |
| `mem0_get` | 按 id 读取，或按配置用户列出 |
| `mem0_update` | 按 id 更新文本；会校验归属 |
| `mem0_delete` | 按 id 删除单条；不提供批量删除/reset |
| `mem0_status` | 检查后端连接和存储状态 |
| `mem0_profile_get` | 读取可编辑的记忆摘要 |
| `mem0_profile_update` | 替换记忆摘要文本；空字符串表示清空 |
| `mem0_profile_reset` | 按已存事实重建记忆摘要 |

## 测试

```bash
pnpm install --ignore-scripts
node --check index.js
node --test

# OSS 模式 Python 测试（使用你的 Mem0 Python 环境）
PYTHONPYCACHEPREFIX="$PWD/.pycache" \
  python3 -m unittest discover -s python/tests -v

# 本地 OSS 真实服务 smoke test（会创建并删除临时 Qdrant 集合）
node scripts/smoke-sidecar.mjs
```

## 隐私与数据

- Platform/server 模式的记忆由对应服务保存；请阅读服务方的隐私和保留策略。
- OSS 模式的记忆保存在你配置的 Qdrant/embedder/LLM 服务中。
- `autoCapture` 默认开启；如果不希望自动保存，请显式设为 `false`。默认的 `captureFilter: heuristic` 只跳过明显的低价值回合；写入前仍会做常见密钥脱敏，但正则表达式不能替代完整的 secret 管理。
- 周巡检会删除重复项和超预算的记忆。删除是真实删除，不会进入回收站；如果希望完全手动控制，可设 `hygieneEnabled: false`，此时仍会在画像缺失时构建画像，但不会自动删除记忆。
- sidecar 只监听 loopback，随机端口 + 随机 token；`mem0_status` 不返回 API key。

## 上架相关

- 包名：`dsh-mem0`，`private: false`，已带 `dsh.bundle` 与 `dsh-plugin` 关键词。
- 市场收录需要公开 GitHub 仓库、`dsh-plugin` topic、仓库创建满 1 天，并在 `awesome-dsh-plugin` 提交一个 `data/plugins/<owner>__<repo>.yml`，分类选 `memory`。
- 仓库已绑定 `repository` / `homepage`：`https://github.com/light-cheng/DSH-Mem0`。仓库根目录的 `screenshots.json` 提供 8 张市场截图，另有 `assets/screenshots/`（中文）和 `assets/screenshots/en/`（英文）两套界面图。市场直接读取本仓库的 `screenshots.json`；提交到 awesome-dsh-plugin 的只有插件 YAML。
- 插件自带可视化配置页（`dsh.client` + `plugins.bundle.config`），上架不要求 GUI，但本插件已提供，便于用户安装后直接配置三种后端并测试连接。
- OSS 模式依赖外部 Python/Qdrant/embedding 服务，README 已明确声明，不应描述成“零依赖”插件。

## 发布说明

发布说明为双语，英文在前：[RELEASE.md](RELEASE.md)。

## License

MIT。

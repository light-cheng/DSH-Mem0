# Mem0 长期记忆

为 DeepSeek Harness 提供由 [Mem0](https://mem0.ai) 驱动的长期记忆：每轮开始前召回相关事实，每轮结束后保存新事实，并在系统提示词里维护一份可编辑的记忆摘要。

支持三种后端：

- **Mem0 Platform**：Mem0 托管 API，只需 API Key，适合大多数用户。
- **自托管 server**：连接你自建的 Mem0 REST 服务。
- **本地（OSS）**：记忆存在本机的 SQLite 文件里，使用你自己的 embedding 模型和抽取 LLM（例如本地 bge-m3）。Mem0 2.2.1 的原生移植：不需要 Python，也不需要 Qdrant。设置页的配置向导负责配置，并迁移旧版的记忆。

源码、问题反馈和发布说明：https://github.com/light-cheng/DSH-Mem0

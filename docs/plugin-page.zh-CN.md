# Mem0 长期记忆

为 DeepSeek Harness 提供由 [Mem0](https://mem0.ai) 驱动的长期记忆：每轮开始前召回相关事实，每轮结束后保存新事实，并在系统提示词里维护一份可编辑的记忆摘要。

支持三种后端：

- **Mem0 Platform**：Mem0 托管 API，只需 API Key，适合大多数用户。
- **自托管 server**：连接你自建的 Mem0 REST 服务。
- **OSS Python sidecar**：使用本地 Mem0 Python SDK，配合你自己的 Qdrant、embedder 和 LLM（例如本地 bge-m3）。

源码、问题反馈和发布说明：https://github.com/light-cheng/DSH-Mem0

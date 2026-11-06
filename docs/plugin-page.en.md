# Mem0 Memory

Long-term memory for DeepSeek Harness, powered by [Mem0](https://mem0.ai). It recalls relevant facts before each turn, saves new facts after each turn, and keeps an editable memory summary in the system prompt.

Three backends are supported:

- **Mem0 Platform**: the managed Mem0 API. Only an API key is needed; the best fit for most users.
- **Self-hosted server**: your own Mem0 REST service.
- **OSS Python sidecar**: a local Mem0 Python SDK with your own Qdrant, embedder and LLM (for example local bge-m3).

Source code, issues and release notes: https://github.com/light-cheng/DSH-Mem0

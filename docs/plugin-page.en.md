# Mem0 Memory

Long-term memory for DeepSeek Harness, powered by [Mem0](https://mem0.ai). It recalls relevant facts before each turn, saves new facts after each turn, and keeps an editable memory summary in the system prompt.

Three backends are supported:

- **Mem0 Platform**: the managed Mem0 API. Only an API key is needed; the best fit for most users.
- **Self-hosted server**: your own Mem0 REST service.
- **Local (OSS)**: memories in a SQLite file on this machine, with your own embedding model and extraction LLM (for example local bge-m3). A native port of Mem0 2.2.1: no Python, no Qdrant.

Source code, issues and release notes: https://github.com/light-cheng/DSH-Mem0

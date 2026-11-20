# Mem0 Memory

Long-term memory for DeepSeek Harness, powered by [Mem0](https://mem0.ai). It recalls relevant facts before each turn, saves new facts after each turn, and keeps an editable memory summary in the system prompt. On the local backend memories are kept per project (by git repository or folder) plus global ones, and each part has its own summary.

A weekly hygiene pass removes exact duplicates, and your current DSH model reviews new memories to merge or drop stale ones and rate importance. Only this plugin's own, unpinned memories are changed, and only after you confirm one manual pass. The model calls are billed to your provider; every report shows the tokens, and one switch turns the model review off.

Three backends are supported:

- **Mem0 Platform**: the managed Mem0 API. Only an API key is needed; the best fit for most users.
- **Self-hosted server**: your own Mem0 REST service.
- **Local (OSS)**: memories in a SQLite file on this machine, with your own embedding model and extraction LLM (for example local bge-m3). A native port of Mem0 2.2.1: no Python, no Qdrant. A setup wizard on the settings page configures it and moves memories from earlier versions.

Source code, issues and release notes: https://github.com/light-cheng/DSH-Mem0

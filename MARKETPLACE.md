# Marketplace Handoff

This file is the remaining checklist for publishing the universal build.

## Package

- npm name: `dsh-mem0`
- version: `0.3.1`
- `private: false`
- `dsh.bundle.patch` is present in `package.json`.
- `dsh-plugin` keyword is present.
- License: MIT.

## Before publishing

1. Repository metadata now points at `https://github.com/light-cheng/DSH-Mem0`:
   `repository`, `homepage` and `bugs`.
2. The public GitHub repository is `light-cheng/DSH-Mem0`; the `dsh-plugin`
   topic is set (plus `dsh`, `deepseek`, `mem0`, `memory`).
3. The repository was created on 2026-11-03 00:22 UTC; wait until it is at
   least one day old before submitting. The current awesome-dsh-plugin rules
   have **no commit-count bar**.
4. Run:
   ```bash
   pnpm install --ignore-scripts --frozen-lockfile
   npm test
   npm run check
   pnpm pack
   ```
5. Publish to npm (optional, but recommended for market install/update):
   ```bash
   npm publish --access public
   ```
6. Screenshots are optional but recommended:
   - the repository already contains localized screenshot sets in
     `assets/screenshots/` (Chinese) and `assets/screenshots/en/` (English):
     plugin page, auto settings, test success, memory activity/recent
     memories, maintenance, memory library, foreground status, and the
     editable memory summary;
   - declare 1-8 image paths in `screenshots.json` at the repository root.
     The market reads this file from your own repository; only the plugin
     YAML is submitted to awesome-dsh-plugin. The current manifest keeps
     eight images.

## awesome-dsh-plugin entry

Create `data/plugins/<owner>__<repo>.yml` in the
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
repository:

```yaml
url: https://github.com/light-cheng/DSH-Mem0
name: light-cheng/DSH-Mem0
category: memory
description:
  en: "Mem0-backed long-term memory for DeepSeek Harness with managed Platform, self-hosted server and local OSS backends; visual settings, automatic recall and capture, editable memory summary, token budgets and weekly memory hygiene."
  zh: "为 DeepSeek Harness 提供基于 Mem0 的长期记忆，支持 Platform、自建 Server 和本地 OSS 后端，带可视化设置、自动召回与保存、可编辑记忆摘要、Token 预算和每周记忆巡检。"
icon: https://raw.githubusercontent.com/light-cheng/DSH-Mem0/main/assets/icon.png
```

`category: memory` is the intended category. `icon` is optional; if omitted,
the storefront uses the owner avatar. The catalog prefers a raster PNG/JPEG/WebP
icon; this repository's `assets/icon.png` is the 512×512 raster icon, and the
package also uses it for the DSH Plugin Manager tile. No `tarball` is
provided: release `.tgz` assets are no longer uploaded, so the marketplace
installs from npm or from the GitHub repository.

## Market behavior

The `dshmarket` catalog is driven by the awesome-dsh-plugin registry. It does
not require an npm package, but publishing to npm improves install/update UX.
The repository itself must declare `dsh.bundle` in `package.json`; this repo
does.

A plugin-provided GUI is **not** a listing requirement. This plugin ships both
halves: the Host bundle plus a browser settings page registered at
`plugins.bundle.config`, so users can configure it in the DSH Plugins page or
in the profile patch. The repository's `screenshots.json` exposes eight
marketplace screenshots; the market reads that file from this repository.

## Configuration for users

- GUI: Plugins → Mem0 Memory → backend tabs, connection fields, Test connection.
- Platform: `backend: platform` + `apiKey` or `MEM0_API_KEY`.
- Self-hosted server: `backend: server` + `baseUrl` + `authType` + `apiKey`.
- Local OSS: `backend: oss`; embedder and extraction LLM in the `dsh_mem0`
  block of `~/.dsh/mem0/oss.json` (keys by credential name); memories in
  `~/.dsh/mem0/memory.sqlite`. See `examples/oss-config.example.json`.

## Current verification

- Node unit tests: all passing on Windows, macOS and Linux (CI, Node 24),
  with the SQLite tests never skipped; no Python tests any more.
- Extraction prompts and answer parsing: byte for byte equal to mem0 2.2.1's
  own helpers (fixtures generated from the 2.2.1 wheel).
- Real endpoint smoke test of the native backend (`scripts/smoke-native.mjs`,
  temporary HOME and test user): a 1024-dimensional OpenAI-compatible
  embedder and an OpenAI-compatible extraction LLM; health, add with
  inference, search, cleanup passed.
- Not yet verified with the native backend: an install into a DSH profile,
  Windows on real hardware (CI only), Ollama. The DSH results below are from
  the earlier Python sidecar versions.
- DSH tool round-trip `mem0_add` → `mem0_search` → `mem0_delete`: passed.
- DSH settings page smoke test: rendered in the Plugins page; auto mode showed
  `已连接`/local OSS; saving a Platform override persisted to `cordis.patch.yml`
  and restarted the plugin; the test endpoint reported the expected safe error.
- Memory activity smoke test: the page listed real memories written to the
  configured collection with IDs and timestamps; the English UI rendered from
  the same code with DSH's locale set to `en`.
- Foreground composer dock rendered in a real session (`Mem0 ready` with the
  dotted globe, since replaced by dissolve's ThinkingOrb); active/success states were exercised in the browser with a
  synthetic activity payload and show the tilted 3D rolling sphere (light blue
  on success); the activity route itself is covered by tests. The rolling
  silhouette was checked across frames and stays circular without squashing.
- Maintenance card rendered in the real Plugins page with all budget fields,
  toggles and the manual run button; startup hygiene scanned the configured
  store, built an 11-item/738-token profile, and persisted state to the active
  profile's `dsh-mem0/maintenance.json`. Manual “立即巡检” was exercised
  against the configured collection: 11 scanned, 0 duplicates, 0 budget
  removals, 0 deleted, 0 failed.
- Memory library rendered in the real Plugins page: “查看全部记忆” opened a
  searchable list of all 14 real OSS memories; searching `Node` returned
  `显示 1 / 共 1 条`. The published screenshot uses synthetic demo memories to
  avoid exposing personal data. The recall preview was exercised with a
  synthetic activity payload and rendered the recalled texts, IDs, count and
  latency in Chinese.
- Screenshots in `assets/screenshots/` were captured from the real DSH Plugins
  page at 1440×1100 (the maintenance crop is 1440×957; the recall card is
  820×303).

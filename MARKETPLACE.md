# Marketplace Handoff

This file is the remaining checklist for publishing the universal build.

## Package

- npm name: `dsh-mem0`
- version: `0.2.0`
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
   node --test
   python3 -m unittest discover -s python/tests -v
   pnpm pack
   ```
5. Publish to npm (optional, but recommended for market install/update):
   ```bash
   npm publish --access public
   ```
6. Add screenshots if desired (optional, recommended):
   - the repository already contains localized screenshot sets in
     `assets/screenshots/` (Chinese) and `assets/screenshots/en/` (English):
     plugin page, auto/platform/OSS settings, test success, memory
     activity/recent memories, maintenance, memory library, recall preview,
     and editable memory summary;
   - add 1-9 GitHub-hosted raster image URLs to `data/screenshots.json` in the
     awesome-dsh-plugin repository, keyed by this repository's GitHub URL;
   - without curated screenshots, the market falls back to images extracted
     from the README.

## awesome-dsh-plugin entry

Create `data/plugins/<owner>__<repo>.yml` in the
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
repository:

```yaml
url: https://github.com/OWNER/REPO
name: OWNER/REPO
category: memory
description:
  en: Long-term Mem0 memory for DSH with Platform, self-hosted server or local OSS backends, automatic recall and capture, editable memory summary, and nine memory tools.
  zh: 为 DSH 提供 Mem0 长期记忆，支持 Platform、自托管 server 或本地 OSS，包含自动召回、自动保存和九个记忆工具。
icon: https://raw.githubusercontent.com/OWNER/REPO/main/assets/icon.png
```

`category: memory` is the intended category. `icon` is optional; if omitted,
the storefront uses the owner avatar. The catalog prefers a raster PNG/JPEG/WebP
icon; this repository's `assets/icon.png` is the 512×512 raster icon, and the
package also uses it for the DSH Plugin Manager tile.

## Market behavior

The `dshmarket` catalog is driven by the awesome-dsh-plugin registry. It does
not require an npm package, but publishing to npm improves install/update UX.
The repository itself must declare `dsh.bundle` in `package.json`; this repo
does.

A plugin-provided GUI is **not** a listing requirement. This plugin ships both
halves: the Host bundle plus a browser settings page registered at
`plugins.bundle.config`, so users can configure it in the DSH Plugins page or
in the profile patch. Screenshots are optional and fall back to README images.

## Configuration for users

- GUI: Plugins → Mem0 Memory → backend tabs, connection fields, Test connection.
- Platform: `backend: platform` + `apiKey` or `MEM0_API_KEY`.
- Self-hosted server: `backend: server` + `baseUrl` + `authType` + `apiKey`.
- Local OSS: `backend: oss` + `mem0ConfigPath` + `pythonPath` + optional
  `collectionName`; see `examples/oss-config.example.json`.

## Current verification

- Node unit tests: 57 passing.
- Python unit tests: 4 passing.
- Real local OSS smoke test: passed (add/search/get/update/delete).
- DSH `mem0_status` on the installed universal plugin: `backend: oss`,
  `status: ready`, Qdrant and 1024-dimensional embedder OK.
- DSH tool round-trip `mem0_add` → `mem0_search` → `mem0_delete`: passed.
- DSH settings page smoke test: rendered in the Plugins page; auto mode showed
  `已连接`/local OSS; saving a Platform override persisted to `cordis.patch.yml`
  and restarted the plugin; the test endpoint reported the expected safe error.
- Memory activity smoke test: the page listed real memories written to the
  configured collection with IDs and timestamps; the English UI rendered from
  the same code with DSH's locale set to `en`.
- Foreground composer dock rendered in a real session (`Mem0 ready` with the
  dotted globe); active/success states were exercised in the browser with a
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

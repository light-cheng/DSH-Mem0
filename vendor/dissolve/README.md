# dissolve ThinkingOrb (vendored)

The composer status icon is the ThinkingOrb from
[dissolve](https://github.com/rs-4/dissolve) by Rayan Selmi, MIT License
([LICENSE](LICENSE)), pinned at commit
`06eddec11725e5874eafce69e97d10cca0f7f882` (2026-11-19, dissolve-ui 0.0.6).

- `src/thinking-orb.core.ts`, `src/kit.ts`: `registry/web/` at that commit,
  unchanged (sha256 `ce860bea…` and `a3ffdc69…`).
- `src/engine.head.ts`: the first 20 lines of `registry/web/engine.ts`; only
  `DPR` is used.
- `thinking-orb.js`: generated, do not edit. `node scripts/vendor-dissolve.mjs`
  rebuilds it from `src/` and inlines it into `client.js` (the DSH client
  loads one script, so the orb cannot be imported at run time). Nothing is
  loaded from a CDN or npm. `--check` reports a stale copy; the tests compare
  both.

Conversion: keep the kit.ts declarations the orb imports and what they use,
keep `DPR` from engine.ts, drop imports and `export`, strip the types with
`node:module` `stripTypeScriptTypes` (mode `strip`, erasure only), wrap in
`function dissolveThinkingOrb()` returning `{ createThinkingOrb }`.

To update: clone dissolve into an empty folder, check out the new commit, read
the diff of these three files, copy them into `src/`, change `COMMIT` in the
script, NOTICE and this file, run the script and the tests.

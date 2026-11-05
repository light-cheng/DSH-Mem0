#!/usr/bin/env node
/**
 * `npm run check`: syntax-check every .js/.mjs/.cjs file in the repository
 * with `node --check`, skipping node_modules, .git and other tool folders, so
 * new files are covered without editing package.json.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.cache', '.pnpm-home', '.npm-cache', 'deliverables'])
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(path.join(dir, entry.name), out)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

const files = collect(ROOT, []).sort()
let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    process.stderr.write(`✖ ${path.relative(ROOT, file)}\n${result.stderr}`)
  }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`)
process.exit(failed > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * Builds vendor/dissolve/thinking-orb.js from the TypeScript sources in
 * vendor/dissolve/src (dissolve's registry/web files, copied verbatim) and
 * inlines it into client.js between the `<dissolve-thinking-orb>` markers.
 *
 * The plugin client is one script loaded by DSH's module loader, so the orb
 * cannot be imported from another file at run time; nothing is fetched from a
 * CDN or npm. The conversion is mechanical:
 * 1. kit.ts: keep only the top-level declarations thinking-orb.core.ts imports
 *    and what they use (blocks separated by blank lines);
 * 2. engine.ts: keep only the `DPR` constant (engine.head.ts is its first 20
 *    lines);
 * 3. thinking-orb.core.ts: drop its import lines;
 * 4. strip the TypeScript types with node:module stripTypeScriptTypes (mode
 *    'strip': types are erased, no code is rewritten), drop the `export`
 *    keywords, wrap everything in `function dissolveThinkingOrb()` returning
 *    `{ createThinkingOrb }`.
 *
 *   node scripts/vendor-dissolve.mjs          write both files
 *   node scripts/vendor-dissolve.mjs --check  exit 1 when either is stale
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'vendor', 'dissolve', 'src')
const OUT = path.join(ROOT, 'vendor', 'dissolve', 'thinking-orb.js')
const CLIENT = path.join(ROOT, 'client.js')
export const COMMIT = '06eddec11725e5874eafce69e97d10cca0f7f882'
export const BEGIN = '// <dissolve-thinking-orb>'
export const END = '// </dissolve-thinking-orb>'
const INDENT = '    '

const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\r\n/g, '\n')

/** Top-level declaration names of a kit.ts block. */
function blockNames(block) {
  const names = []
  for (const match of block.matchAll(/^(?:export\s+)?(?:const|let|function|type)\s+([A-Za-z_$][\w$]*)/gm)) names.push(match[1])
  return names
}

/**
 * kit.ts as top-level blocks: one per declaration, with the comment right
 * above it. Section banners and blank lines are dropped.
 */
function kitBlocks(source) {
  const blocks = []
  let comment = []
  let current = null
  for (const line of source.split('\n')) {
    if (/^(?:export\s+)?(?:const|let|function|type)\s/.test(line)) {
      current = { lines: [...comment, line] }
      comment = []
      blocks.push(current)
    } else if (/^\/\*/.test(line) || (comment.length && /^ \*/.test(line))) {
      current = null
      comment.push(line)
      if (/^\/\* -+ .* -+ \*\/$/.test(line)) comment = []
    } else if (line.trim() === '') {
      if (!current) comment = []
    } else if (current) {
      current.lines.push(line)
    }
  }
  return blocks.map((block) => {
    while (block.lines.at(-1)?.trim() === '') block.lines.pop()
    const text = block.lines.join('\n')
    return { text, names: blockNames(text) }
  })
}

/** kit.ts reduced to `wanted` and the declarations they use. */
function kitSubset(source, wanted) {
  const blocks = kitBlocks(source)
  const keep = new Set()
  const queue = [...wanted]
  while (queue.length) {
    const name = queue.shift()
    const block = blocks.find((candidate) => candidate.names.includes(name))
    if (!block) throw new Error(`kit.ts has no declaration ${name}`)
    if (keep.has(block)) continue
    keep.add(block)
    // Code only: names in comments do not pull a declaration in.
    const code = block.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const other of blocks) {
      if (keep.has(other)) continue
      for (const otherName of other.names) {
        if (new RegExp(`\\b${otherName.replace(/\$/g, '\\$')}\\b`).test(code)) queue.push(otherName)
      }
    }
  }
  // Type-only declarations vanish when the types are stripped; drop their comments with them.
  const typeOnly = (block) => block.text.split('\n').some((line) => /^(?:export\s+)?type\s/.test(line))
  return blocks.filter((block) => keep.has(block) && !typeOnly(block)).map((block) => block.text).join('\n\n')
}

/**
 * stripTypeScriptTypes blanks each erased character with a space. Drop each
 * erased span (from the first to the last blanked character, whitespace
 * between them included) so `(pattern: number | number[])` reads `(pattern)`.
 */
function dropErased(ts, js) {
  if (ts.length !== js.length) throw new Error('stripTypeScriptTypes changed the length; cannot tidy')
  let out = ''
  let i = 0
  while (i < js.length) {
    if (js[i] !== ts[i]) {
      let end = i
      for (let j = i; j < js.length && /\s/.test(js[j]); j += 1) if (js[j] !== ts[j]) end = j
      i = end + 1
      continue
    }
    out += js[i]
    i += 1
  }
  return out
}

export async function build() {
  const { stripTypeScriptTypes } = await import('node:module')
  if (typeof stripTypeScriptTypes !== 'function') throw new Error('node:module stripTypeScriptTypes is not available in this Node.js')
  const core = read('thinking-orb.core.ts')
  const imports = [...core.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(kit|engine)';$/gm)]
  const fromKit = imports.filter((match) => match[2] === 'kit').flatMap((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean))
  const fromEngine = imports.filter((match) => match[2] === 'engine').flatMap((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean))
  if (fromEngine.join() !== 'DPR') throw new Error(`unexpected engine imports: ${fromEngine.join()}`)
  const dpr = read('engine.head.ts').split('\n').find((line) => line.startsWith('export const DPR ='))
  if (!dpr) throw new Error('engine.head.ts has no DPR')
  const ts = [
    `// kit.ts (subset: ${fromKit.join(', ')} and what they use)`,
    kitSubset(read('kit.ts'), fromKit),
    '// engine.ts (DPR only)',
    dpr,
    '// thinking-orb.core.ts',
    core.replace(/^import\s.*$\n/gm, ''),
  ].join('\n\n')
  let js = dropErased(ts, stripTypeScriptTypes(ts, { mode: 'strip' }))
  js = js
    .replace(/^export\s+(?=(?:const|let|function)\s)/gm, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const body = js.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n')
  return [
    `// Generated by scripts/vendor-dissolve.mjs from vendor/dissolve/src: ThinkingOrb from`,
    `// dissolve (https://github.com/rs-4/dissolve) commit ${COMMIT}, MIT License,`,
    `// Copyright (c) 2026 Rayan Selmi (vendor/dissolve/LICENSE). Do not edit by hand.`,
    `function dissolveThinkingOrb() {`,
    `  'use strict'`,
    body,
    `  return { createThinkingOrb }`,
    `}`,
    '',
  ].join('\n')
}

/** The marked block of client.js, indented as it sits in the factory. */
export function clientBlock(js) {
  const lines = js.trimEnd().split('\n').map((line) => (line ? INDENT + line : line))
  return [INDENT + BEGIN, ...lines, INDENT + END].join('\n')
}

export function inlined(client, js) {
  const start = client.indexOf(INDENT + BEGIN)
  const end = client.indexOf(INDENT + END)
  if (start < 0 || end < start) throw new Error('client.js has no <dissolve-thinking-orb> markers')
  return client.slice(0, start) + clientBlock(js) + client.slice(end + (INDENT + END).length)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const js = await build()
  const client = fs.readFileSync(CLIENT, 'utf8')
  const next = inlined(client, js)
  if (process.argv.includes('--check')) {
    const stale = []
    if (fs.readFileSync(OUT, 'utf8') !== js) stale.push(path.relative(ROOT, OUT))
    if (client !== next) stale.push('client.js')
    if (stale.length) {
      console.error(`stale: ${stale.join(', ')} (run node scripts/vendor-dissolve.mjs)`)
      process.exit(1)
    }
    console.log('vendor/dissolve: up to date')
  } else {
    fs.writeFileSync(OUT, js)
    fs.writeFileSync(CLIENT, next)
    console.log(`wrote ${path.relative(ROOT, OUT)} and client.js`)
  }
}

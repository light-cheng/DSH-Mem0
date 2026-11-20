#!/usr/bin/env node
/**
 * Upstream tracking for the native Mem0 port (`npm run upstream`, and the
 * weekly .github/workflows/mem0-upstream.yml).
 *
 * Reads the latest mem0ai release from PyPI and compares it with the
 * reference in scripts/mem0-upstream.json: the version, and the SHA-256 of
 * the files the port follows (prompts.py with the extraction prompts,
 * main.py with the add/search pipeline, utils.py with the answer parser).
 * The wheel is downloaded into memory and unzipped here; nothing of it is
 * run or installed.
 *
 *   node scripts/mem0-upstream.mjs [--report report.md]
 *
 * Exit code 0 either way; prints `changed=true|false` (and writes it to
 * $GITHUB_OUTPUT when set). The report says what to re-check in
 * lib/mem0-prompts.js and lib/extraction.js.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'mem0-upstream.json'), 'utf8'))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** The named entries of a zip archive (stored or deflated), as Buffers. */
export function unzipEntries(archive, names) {
  const wanted = new Set(names)
  const out = new Map()
  let eocd = -1
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = archive.readUInt16LE(eocd + 10)
  let pointer = archive.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(pointer) !== 0x02014b50) throw new Error('bad zip central directory')
    const method = archive.readUInt16LE(pointer + 10)
    const compressedSize = archive.readUInt32LE(pointer + 20)
    const nameLength = archive.readUInt16LE(pointer + 28)
    const extraLength = archive.readUInt16LE(pointer + 30)
    const commentLength = archive.readUInt16LE(pointer + 32)
    const localOffset = archive.readUInt32LE(pointer + 42)
    const name = archive.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    pointer += 46 + nameLength + extraLength + commentLength
    if (!wanted.has(name)) continue
    const localName = archive.readUInt16LE(localOffset + 26)
    const localExtra = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const data = archive.subarray(start, start + compressedSize)
    if (method === 0) out.set(name, Buffer.from(data))
    else if (method === 8) out.set(name, zlib.inflateRawSync(data))
    else throw new Error(`unsupported zip method ${method} for ${name}`)
  }
  return out
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-mem0-upstream-check' } })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
}

async function main() {
  const info = await fetchJson(`https://pypi.org/pypi/${reference.package}/json`)
  const latest = String(info?.info?.version ?? '')
  const lines = [`Reference: ${reference.package} ${reference.version}`, `Latest on PyPI: ${latest || '?'}`]
  let changed = false
  const report = []
  if (latest && latest !== reference.version) {
    changed = true
    const release = await fetchJson(`https://pypi.org/pypi/${reference.package}/${latest}/json`)
    const wheel = (release.urls ?? []).find((item) => item.packagetype === 'bdist_wheel')
    report.push(`## ${reference.package} ${latest} is out (the port follows ${reference.version})`, '')
    if (!wheel) {
      report.push('No wheel was published for this release; compare the sources by hand.')
    } else {
      const response = await fetch(wheel.url, { headers: { 'user-agent': 'dsh-mem0-upstream-check' } })
      if (!response.ok) throw new Error(`wheel download answered HTTP ${response.status}`)
      const archive = Buffer.from(await response.arrayBuffer())
      if (wheel.digests?.sha256 && sha256(archive) !== wheel.digests.sha256) throw new Error('wheel SHA-256 does not match PyPI')
      const files = unzipEntries(archive, Object.keys(reference.files))
      report.push('| file | 2.2.1 reference | latest | |', '| --- | --- | --- | --- |')
      for (const [name, expected] of Object.entries(reference.files)) {
        const actual = files.has(name) ? sha256(files.get(name)) : 'missing'
        report.push(`| \`${name}\` | \`${expected.slice(0, 12)}\` | \`${actual.slice(0, 12)}\` | ${actual === expected ? 'same' : '**changed**'} |`)
      }
      report.push(
        '',
        'What to check when a file changed:',
        '- `mem0/configs/prompts.py`: the prompt texts in `lib/mem0-prompts.js` (copied verbatim) and `generate_additive_extraction_prompt` (ported in `lib/extraction.js`); regenerate `test/fixtures/mem0-2.2.1-extraction.json` with `scripts/mem0-extraction-fixture.py`;',
        '- `mem0/memory/main.py`: the add/search pipeline in `lib/native-client.js` and `lib/store-sqlite.js` (session scope, top-10 similar memories, md5 dedup, search threshold and candidate count);',
        '- `mem0/memory/utils.py`: `parse_messages`, `remove_code_blocks`, `extract_json` in `lib/extraction.js`.',
        '',
        'Then update `scripts/mem0-upstream.json` and `MEM0_REFERENCE_VERSION`.',
      )
    }
  }
  console.log(lines.join('\n'))
  console.log(`changed=${changed}`)
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nlatest=${latest}\n`)
  }
  const reportPath = argValue('--report')
  if (reportPath) fs.writeFileSync(reportPath, `${report.join('\n')}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`mem0 upstream check failed: ${error.message}`)
    process.exitCode = 1
  })
}

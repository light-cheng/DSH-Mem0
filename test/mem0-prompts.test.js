// The extraction prompts are verbatim copies of mem0ai 2.2.1: their SHA-256
// must match scripts/mem0-upstream.json (which the weekly upstream workflow
// compares against new mem0ai releases).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import * as prompts from '../lib/mem0-prompts.js'
import { unzipEntries } from '../scripts/mem0-upstream.mjs'
import zlib from 'node:zlib'

const reference = JSON.parse(fs.readFileSync(new URL('../scripts/mem0-upstream.json', import.meta.url), 'utf8'))
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

test('prompt texts are byte for byte those of the reference mem0ai release', () => {
  assert.equal(prompts.MEM0_REFERENCE_VERSION, reference.version)
  for (const [name, hash] of Object.entries(reference.prompts)) {
    assert.equal(typeof prompts[name], 'string', name)
    assert.equal(sha256(prompts[name]), hash, `${name} differs from mem0ai ${reference.version}`)
  }
  assert.ok(prompts.LANGUAGE_REQUIREMENT.startsWith('## Language Requirement\nCRITICAL: Respond in the SAME LANGUAGE'))
})

test('NOTICE credits mem0 (Apache-2.0) and ships in the package', () => {
  const notice = fs.readFileSync(new URL('../NOTICE', import.meta.url), 'utf8')
  assert.match(notice, /mem0/i)
  assert.match(notice, /Apache License, Version 2\.0/)
  assert.match(notice, new RegExp(reference.version.replace(/\./g, '\\.')))
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('NOTICE'))
  assert.equal(pkg.files.includes('python'), false)
  assert.equal(pkg.engines.node, '>=24.9')
})

test('the upstream checker unzips stored and deflated wheel entries', () => {
  const entries = [
    { name: 'mem0/configs/prompts.py', data: Buffer.from('PROMPT = "x"\n'), method: 8 },
    { name: 'mem0/memory/main.py', data: Buffer.from('def add(): pass\n'), method: 0 },
  ]
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const body = entry.method === 8 ? zlib.deflateRawSync(entry.data) : entry.data
    const name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    locals.push(local, name, body)
    offset += local.length + name.length + body.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  const archive = Buffer.concat([...locals, centralBuffer, end])
  const files = unzipEntries(archive, ['mem0/configs/prompts.py', 'mem0/memory/main.py', 'missing.py'])
  assert.equal(files.get('mem0/configs/prompts.py').toString(), 'PROMPT = "x"\n')
  assert.equal(files.get('mem0/memory/main.py').toString(), 'def add(): pass\n')
  assert.equal(files.has('missing.py'), false)
})

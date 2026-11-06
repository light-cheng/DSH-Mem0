// The DSH plugin page shows the Markdown file named by `meta.detail` in the locale file for the display language
// (falling back along zh-CN → zh → en), and only then README.md. These checks keep that page self-contained.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const pkg = JSON.parse(read('package.json'))

for (const [locale, expected] of [['en', 'docs/plugin-page.en.md'], ['zh', 'docs/plugin-page.zh-CN.md']]) {
  test(`locale/${locale}.json meta.detail names a shipped plugin page`, () => {
    const detail = JSON.parse(read(`locale/${locale}.json`)).meta.detail
    assert.equal(detail, expected)
    // The rules DSH applies to meta.detail: relative, inside the package, a Markdown file.
    assert.ok(!detail.includes('\\') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(detail))
    assert.ok(detail.split('/').every((s) => s !== '' && s !== '.' && s !== '..'))
    assert.match(detail, /\.md$/)
    assert.ok(existsSync(new URL(detail, root)), `${detail} exists`)
    assert.ok(pkg.files.includes(detail), `${detail} is listed in package.json files`)
  })

  test(`${expected} has no GitHub-only markup`, () => {
    const text = read(expected)
    assert.doesNotMatch(text, /README(\.zh-CN)?\.md/, 'no link to the GitHub READMEs')
    assert.doesNotMatch(text, /<(p|img|div|br|a)\b/i, 'no raw HTML')
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (target.startsWith('/')) {
        // Package-root image paths: DSH resolves these inside the installed package.
        const path = target.slice(1)
        assert.ok(existsSync(new URL(path, root)), `${target} exists`)
        assert.ok(pkg.files.some((f) => path === f || path.startsWith(posix.join(f, '/'))), `${target} is shipped`)
      } else {
        assert.match(target, /^https:\/\//, `link ${target} is absolute`)
      }
    }
  })
}

/**
 * `/dsh-mem0/gui/diagnose`: what the settings page needs for "Ask DSH to
 * diagnose" and "Copy diagnosis" (client.js).
 *
 * POST, JSON only, same-origin (setupPostRefusal):
 *   { action: 'prepare', failure, lang }
 *     → { ok, text, copyText, fingerprint, sessionId, cwd, title }
 *     `text` is the draft for a diagnosis session (`/plan` + facts + rules),
 *     `copyText` the same without `/plan`, `sessionId` the diagnosis session
 *     already opened for this problem (or null), `cwd` the directory new
 *     diagnosis sessions run in.
 *   { action: 'register', sessionId, fingerprint } → { ok }
 *     Called before the session is opened: from then on the tool gate and
 *     the automatic-memory skip apply to it.
 *   { action: 'unmap', sessionId } → { ok }   the session is gone or archived
 *   { action: 'forget', sessionId } → { ok }  set-up failed; not a diagnosis session
 *
 * Diagnosis sessions run in `<profile>/dsh-mem0/diagnose`, an empty folder
 * that belongs to no DSH workspace: DSH's New Session reuses an unsent blank
 * session of the workspace, and it must never hand out a diagnosis session.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDiagnosisPrompt, diagnosisFingerprint } from './diagnose-report.js'
import { DIAGNOSE_ASKED_TOOLS, DIAGNOSE_DENIED_TOOLS } from './diagnose-sessions.js'
import { sanitizeFailureMessage } from './failure-history.js'
import { setupPostRefusal } from './gui-routes.js'
import { redactSecrets } from './redact.js'

export const GUI_DIAGNOSE_PATH = '/dsh-mem0/gui/diagnose'
export const PLUGIN_NAME = 'dsh-mem0'

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return undefined
  }
})()

const CAUSE_TITLE = {
  zh: { timeout: '超时', connection: '连接失败', auth: '认证或额度', circuit: '熔断', extraction: 'LLM 抽取失败', startup: '本地后端启动失败', config: '配置错误', other: '其他错误' },
  en: { timeout: 'timeout', connection: 'connection failed', auth: 'auth or quota', circuit: 'circuit breaker', extraction: 'LLM extraction failed', startup: 'local backend failed to start', config: 'configuration error', other: 'other error' },
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req, limit = 32 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be JSON')
  }
}

/** The stored copy of a failure the page shows, else the page's copy. */
function storedFailure(runtime, failure) {
  const list = typeof runtime?.failures?.list === 'function' ? runtime.failures.list() : []
  return (
    list.find((entry) => entry.at === failure?.at && entry.kind === failure?.kind && entry.cause === failure?.cause) ??
    (failure && typeof failure === 'object' ? failure : null)
  )
}

/** The folder diagnosis sessions run in (created on demand). */
export function diagnoseDirectory(runtime) {
  const base = runtime?.profileDir ? path.join(runtime.profileDir, 'dsh-mem0') : path.join(os.tmpdir(), 'dsh-mem0')
  const dir = path.join(base, 'diagnose')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** The prompt, fingerprint and existing session for one failure. Pure apart from the folder. */
export function prepareDiagnosis(runtime, { failure, lang } = {}) {
  const entry = storedFailure(runtime, failure)
  if (!entry) return { status: 400, body: { ok: false, reason: 'bad-request', error: 'failure is required' } }
  const language = lang === 'zh' ? 'zh' : 'en'
  const sanitize = (text) => sanitizeFailureMessage(text)
  const tools = { forbidden: [...DIAGNOSE_DENIED_TOOLS], ask: [...DIAGNOSE_ASKED_TOOLS], status: 'mem0_status' }
  const options = { plugin: PLUGIN_NAME, version: VERSION, lang: language, tools, sanitize }
  const draft = buildDiagnosisPrompt(entry, { ...options, plan: true })
  const copy = buildDiagnosisPrompt(entry, { ...options, plan: false })
  const fingerprint = diagnosisFingerprint(entry, { plugin: PLUGIN_NAME, sanitize })
  const cause = CAUSE_TITLE[language][entry.cause] ?? CAUSE_TITLE[language].other
  const title = language === 'zh' ? `Mem0 诊断：${cause}` : `Mem0 diagnosis: ${cause}`
  let cwd = null
  try {
    cwd = diagnoseDirectory(runtime)
  } catch (error) {
    runtime?.logger?.debug?.(`dsh-mem0: could not create the diagnosis folder: ${error.message}`)
  }
  return {
    status: 200,
    body: { ok: true, text: draft.text, copyText: copy.text, fingerprint, sessionId: runtime?.diagnoseSessions?.sessionFor(fingerprint) ?? null, cwd, title },
  }
}

export function handleDiagnoseAction(runtime, body) {
  const store = runtime?.diagnoseSessions
  switch (body?.action) {
    case 'prepare':
      return prepareDiagnosis(runtime, body)
    case 'register':
      if (!store) return { status: 503, body: { ok: false, reason: 'unavailable', error: 'the plugin is not running' } }
      return store.register({ sessionId: body.sessionId, fingerprint: body.fingerprint })
        ? { status: 200, body: { ok: true } }
        : { status: 400, body: { ok: false, reason: 'bad-request', error: 'could not record the diagnosis session' } }
    case 'unmap':
      store?.unmap(body.sessionId)
      return { status: 200, body: { ok: true } }
    case 'forget':
      store?.forget(body.sessionId)
      return { status: 200, body: { ok: true } }
    default:
      return { status: 400, body: { ok: false, reason: 'bad-request', error: 'unknown action' } }
  }
}

export function registerDiagnoseRoutes(ctx, getRuntime) {
  ctx.inject(['webServer', 'connection'], (child) => {
    const handler = async (req, res) => {
      const connection = child.get('connection')
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 503
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const refused = setupPostRefusal(req)
      if (refused) return sendJson(res, refused.status, { ok: false, error: refused.error })
      try {
        const outcome = handleDiagnoseAction(getRuntime(), await readJsonBody(req))
        sendJson(res, outcome.status, outcome.body)
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: 'bad-request', error: redactSecrets(error instanceof Error ? error.message : String(error)) })
      }
    }
    child.effect(() => child.webServer.register({ kind: 'exact', path: GUI_DIAGNOSE_PATH, handler }), `dsh-mem0: POST ${GUI_DIAGNOSE_PATH}`)
  })
}

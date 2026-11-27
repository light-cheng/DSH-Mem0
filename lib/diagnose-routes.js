/**
 * `/dsh-mem0/gui/diagnose`: what the settings page needs for "Ask DSH to
 * diagnose", "AI troubleshoot" and "Copy diagnosis" (client.js).
 *
 * POST, JSON only, same-origin (setupPostRefusal):
 *   { action: 'prepare', failure?, lang }
 *     → { ok, texts: { each, skip }, copyText, fingerprint, sessionId, cwd,
 *         title, workspaceTitle, keepsDefaultModel }
 *     With `failure`, one failure's prompt; without, the general "AI
 *     troubleshoot" prompt with the plugin's redacted state. `texts` holds
 *     the prompt for each answer to "no confirmation for each change"
 *     (lib/diagnose-report.js diagnosisFixRules), `copyText` the text for
 *     the clipboard (failures only), `sessionId` the diagnosis session
 *     already opened for this problem (or for the general entry, its latest
 *     one), `cwd` the folder of the default "Mem0 diagnosis" workspace,
 *     `title` the session's and `workspaceTitle` that workspace's title.
 *     `keepsDefaultModel`: whether the plugin can put DSH's default model
 *     back after the page picks another model for the session (DSH saves a
 *     session's model selection as the default too).
 *   { action: 'register', sessionId, fingerprint, skipConfirm } → { ok }
 *     Called before the first prompt: from then on the tool gate, the skill
 *     and the automatic-memory skip apply to it.
 *   { action: 'unmap', sessionId } → { ok }   the session is gone or archived
 *   { action: 'forget', sessionId } → { ok }  set-up failed; not a diagnosis session
 *   { action: 'default-model', op: 'remember' | 'restore' } → { ok }
 *     Around the page's session.selectModel call: remember DSH's default
 *     model, then save it back.
 *
 * Diagnosis sessions run by default in a DSH workspace of their own, on the
 * empty folder `<profile>/dsh-mem0/mem0-diagnosis`; the page may pick one
 * of the user's workspaces instead. The prompt is sent at once, so the
 * session is never an unsent blank one that DSH's New Session would reuse.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checklistFor, DIAGNOSE_FEATURE, DIAGNOSE_SKILL, DIAGNOSE_SYMPTOMS, diagnoseToolRules, sectionFor } from './diagnose-kb.js'
import { buildGeneralPrompt, generalState, GENERAL_FINGERPRINT, hostVersion } from './diagnose-general.js'
import { buildDiagnosisPrompt, diagnosisFingerprint } from './diagnose-report.js'
import { DIAGNOSE_ALWAYS_CONFIRM, DIAGNOSE_WRITE_TOOLS } from './diagnose-sessions.js'
import { CHECK_TOOL, SETTING_TOOL } from './diagnose-tools.js'
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

/** The path of the folder diagnosis sessions run in. Pure. */
export function diagnoseDirectoryPath(runtime) {
  const base = runtime?.profileDir ? path.join(runtime.profileDir, 'dsh-mem0') : path.join(os.tmpdir(), 'dsh-mem0')
  return path.join(base, 'mem0-diagnosis')
}

/** The folder diagnosis sessions run in (created on demand). */
export function diagnoseDirectory(runtime) {
  const dir = diagnoseDirectoryPath(runtime)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const SETTINGS_FILE = 'cordis.patch.yml'
// A diagnosis session has mem0_check and mem0_setting_set
// (lib/diagnose-tools.js); copied text, pasted anywhere, has neither.
const TOOLS = Object.freeze({ write: [...DIAGNOSE_WRITE_TOOLS], alwaysConfirm: [...DIAGNOSE_ALWAYS_CONFIRM], status: CHECK_TOOL, set: SETTING_TOOL })
const COPY_TOOLS = Object.freeze({ write: [...DIAGNOSE_WRITE_TOOLS], alwaysConfirm: DIAGNOSE_ALWAYS_CONFIRM.filter((name) => name !== SETTING_TOOL), status: 'mem0_status' })

function folder(runtime) {
  try {
    return diagnoseDirectory(runtime)
  } catch (error) {
    runtime?.logger?.debug?.(`dsh-mem0: could not create the diagnosis folder: ${error.message}`)
    return null
  }
}

function keepsDefaultModel(runtime) {
  const model = runtime?.llmServices?.current?.agentDefaultModel
  return typeof model?.currentSelection === 'function' && typeof model?.saveSelection === 'function'
}

/**
 * The prompts, fingerprint and existing session for one failure, or for
 * the general entry when `failure` is absent. Pure apart from the folder.
 */
export function prepareDiagnosis(runtime, { failure, lang } = {}) {
  const language = lang === 'zh' ? 'zh' : 'en'
  if (runtime?.diagnoseSkill) runtime.diagnoseSkill.lang = language
  const skill = runtime?.diagnoseSkill?.ready === true
  const workspaceTitle = language === 'zh' ? 'Mem0 诊断' : 'Mem0 diagnosis'
  const common = { cwd: folder(runtime), workspaceTitle, keepsDefaultModel: keepsDefaultModel(runtime) }
  if (failure === undefined || failure === null) {
    const state = generalState(runtime, { pluginVersion: VERSION, dshVersion: runtime?.dshVersion ?? hostVersion() })
    const options = { lang: language, tools: TOOLS, settingsFile: SETTINGS_FILE }
    return {
      status: 200,
      body: {
        ok: true,
        texts: { each: buildGeneralPrompt(state, { ...options, confirm: 'each' }), skip: buildGeneralPrompt(state, { ...options, confirm: 'skip' }) },
        copyText: null,
        fingerprint: GENERAL_FINGERPRINT,
        sessionId: runtime?.diagnoseSessions?.sessionFor(GENERAL_FINGERPRINT) ?? null,
        title: language === 'zh' ? 'Mem0 AI 排查' : 'Mem0 AI troubleshoot',
        ...common,
      },
    }
  }
  const entry = storedFailure(runtime, failure)
  if (!entry || (!entry.cause && !entry.at)) return { status: 400, body: { ok: false, reason: 'bad-request', error: 'failure is required' } }
  const sanitize = (text) => sanitizeFailureMessage(text)
  const questions = { feature: DIAGNOSE_FEATURE[language], symptoms: DIAGNOSE_SYMPTOMS[language] }
  const options = { plugin: PLUGIN_NAME, version: VERSION, lang: language, tools: TOOLS, settingsFile: SETTINGS_FILE, questions, sanitize, rules: diagnoseToolRules({ lang: language }) }
  // The checklist of this failure's type: a session the plugin opened gets
  // the skill when DSH offers it (lib/diagnose-kb.js); copied text, which
  // may be pasted anywhere, carries that one section itself.
  const section = sectionFor(entry)
  // In a diagnosis session the checks go through mem0_check (no file to
  // read); copied text keeps the plain checks.
  const inline = { section, checklist: checklistFor(entry, { lang: language, tools: true }) }
  const knowledge = skill ? { section, skill: DIAGNOSE_SKILL } : inline
  const each = buildDiagnosisPrompt(entry, { ...options, confirm: 'each', knowledge }).text
  const skip = buildDiagnosisPrompt(entry, { ...options, confirm: 'skip', knowledge }).text
  const plain = { section, checklist: checklistFor(entry, { lang: language, tools: false }) }
  const copy = buildDiagnosisPrompt(entry, { ...options, tools: COPY_TOOLS, rules: [], knowledge: plain })
  const fingerprint = diagnosisFingerprint(entry, { plugin: PLUGIN_NAME, sanitize })
  const cause = CAUSE_TITLE[language][entry.cause] ?? CAUSE_TITLE[language].other
  return {
    status: 200,
    body: {
      ok: true,
      texts: { each, skip },
      copyText: copy.text,
      fingerprint,
      sessionId: runtime?.diagnoseSessions?.sessionFor(fingerprint) ?? null,
      title: language === 'zh' ? `Mem0 诊断：${cause}` : `Mem0 diagnosis: ${cause}`,
      ...common,
    },
  }
}

/**
 * DSH saves a session's model selection as its default too
 * (session-controller selectModel → agentDefaultModel.saveSelection). The
 * page remembers the default before choosing a model for a diagnosis
 * session and restores it after; saves run in order, so this one lands
 * last.
 */
async function defaultModel(runtime, op) {
  const model = runtime?.llmServices?.current?.agentDefaultModel
  if (!keepsDefaultModel(runtime)) return { status: 503, body: { ok: false, reason: 'unavailable', error: 'DSH default model is not available' } }
  if (op === 'remember') {
    runtime.diagnoseDefaultModel = model.currentSelection()
    return { status: 200, body: { ok: true } }
  }
  if (op === 'restore') {
    const saved = runtime.diagnoseDefaultModel
    runtime.diagnoseDefaultModel = undefined
    if (saved) await model.saveSelection(saved)
    return { status: 200, body: { ok: true, restored: Boolean(saved) } }
  }
  return { status: 400, body: { ok: false, reason: 'bad-request', error: 'unknown op' } }
}

export async function handleDiagnoseAction(runtime, body) {
  const store = runtime?.diagnoseSessions
  switch (body?.action) {
    case 'prepare':
      return prepareDiagnosis(runtime, body)
    case 'register':
      if (!store) return { status: 503, body: { ok: false, reason: 'unavailable', error: 'the plugin is not running' } }
      return store.register({ sessionId: body.sessionId, fingerprint: body.fingerprint, skipConfirm: body.skipConfirm === true })
        ? { status: 200, body: { ok: true } }
        : { status: 400, body: { ok: false, reason: 'bad-request', error: 'could not record the diagnosis session' } }
    case 'unmap':
      store?.unmap(body.sessionId)
      return { status: 200, body: { ok: true } }
    case 'forget':
      store?.forget(body.sessionId)
      return { status: 200, body: { ok: true } }
    case 'default-model':
      return defaultModel(runtime, body.op)
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
        const outcome = await handleDiagnoseAction(getRuntime(), await readJsonBody(req))
        sendJson(res, outcome.status, outcome.body)
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: 'bad-request', error: redactSecrets(error instanceof Error ? error.message : String(error)) })
      }
    }
    child.effect(() => child.webServer.register({ kind: 'exact', path: GUI_DIAGNOSE_PATH, handler }), `dsh-mem0: POST ${GUI_DIAGNOSE_PATH}`)
  })
}

/**
 * API key lookup through the host credential service (`ctx.credentials`, from
 * @deepseek-ai/dsh-credentials), the way other DSH plugins resolve keys.
 *
 * `apiKeyEnv` (default `MEM0_API_KEY`) is the credential reference. DSH's
 * local store (`~/.dsh/.credentials.yaml`) answers first, then the launching
 * environment and `.env` files. A literal `apiKey` in the plugin config still
 * wins, and without a credential service the plugin reads `process.env`
 * directly as before.
 *
 * The local backend's embedder and LLM keys use the same store: oss.json
 * names them (`embedderApiKeyRef`, `llmApiKeyRef`) and `resolveSecret`
 * reads them per request, so a rotated key applies at once.
 *
 * The service is read with `ctx.get('credentials')` instead of a hard
 * `inject`, so the plugin still loads in compositions that have none.
 */
import { unwrapConfig } from './config.js'

const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000

/** The credential reference named by a raw plugin config. */
export function apiKeyRef(raw) {
  const value = unwrapConfig(raw)
  const name = typeof value?.apiKeyEnv === 'string' ? value.apiKeyEnv.trim() : ''
  return name || 'MEM0_API_KEY'
}

/** Whether the raw config carries a literal `apiKey`, which skips the lookup. */
export function hasLiteralApiKey(raw) {
  const value = unwrapConfig(raw)
  return typeof value?.apiKey === 'string' && value.apiKey.trim().length > 0
}

function credentialService(ctx) {
  try {
    const service = ctx?.get?.('credentials')
    return service && typeof service.resolve === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve one credential reference through `ctx.credentials` (the local
 * backend's `embedderApiKeyRef` / `llmApiKeyRef`, or `apiKeyEnv`).
 * @returns {Promise<{ value: string, source: string } | undefined>} the hit
 *   (`source` is the provider's: `file`, `env`, …), or undefined when there is
 *   no service, no value, or the lookup failed or timed out.
 */
export async function lookupCredential(ctx, ref, { timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS, logger } = {}) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return undefined
  const service = credentialService(ctx)
  if (!service) return undefined
  let timer
  try {
    const hit = await Promise.race([
      Promise.resolve(service.resolve(ref)),
      new Promise((resolve) => {
        // Not unref'd: startup awaits this, and it is always cleared below.
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
    const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
    return value ? { value, source: String(hit.source ?? 'credentials') } : undefined
  } catch (error) {
    logger?.warn?.(`dsh-mem0: credential lookup for ${ref} failed: ${error?.message ?? error}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A key for a credential reference: DSH credentials first, then the
 * environment variable of the same name. Undefined when neither has one.
 */
export async function resolveSecret(ctx, ref, options) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return undefined
  const hit = await lookupCredential(ctx, ref, options)
  if (hit?.value) return hit.value
  const env = process.env[ref]
  return typeof env === 'string' && env.trim() ? env.trim() : undefined
}

/**
 * Resolve the API key reference (`apiKeyEnv`) through `ctx.credentials`.
 * @returns {Promise<{ value: string, source: string } | undefined>}
 */
export async function lookupApiKey(ctx, raw, options = {}) {
  if (hasLiteralApiKey(raw)) return undefined
  return lookupCredential(ctx, apiKeyRef(raw), options)
}

/** Whether a credential hit came from the environment rather than a store. */
export function isEnvironmentSource(source) {
  return source === 'env'
}

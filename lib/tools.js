/**
 * Model-facing Mem0 tools.
 *
 * Definitions are plain objects rather than `defineTool(...)` results on
 * purpose: importing @deepseek-ai/dsh-tools at runtime can resolve a second
 * npm copy in a profile and split the tool scheduler Symbol.
 */
import { formatMemoryLine, redactSecrets } from './redact.js'

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
}

function errorText(tool, error) {
  const message = error instanceof Error ? error.message : String(error)
  return `${tool} failed: ${message}`
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function renderMemories(results) {
  if (!Array.isArray(results) || results.length === 0) return 'No memories found.'
  return results.map((memory, index) => formatMemoryLine(memory, index)).join('\n')
}

async function assertOwned(client, memoryId, userId, signal) {
  const memory = await client.get(memoryId, { signal })
  if (!memory) throw new Error(`memory not found: ${memoryId}`)
  if (memory.user_id && memory.user_id !== userId) {
    throw new Error(`memory ${memoryId} does not belong to user ${userId}`)
  }
  return memory
}

export function createMem0Tools(client, config, { maintenance } = {}) {
  return [
    {
      name: 'mem0_search',
      description:
        'Search the user’s Mem0 long-term memory by meaning. Use before answering questions that may depend on remembered preferences, facts, people, projects, or past decisions. Returns memory IDs for update/delete.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          top_k: {
            type: 'integer',
            description: 'Maximum results to return (default 10, max 50).',
          },
        },
        required: ['query'],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const query = requireString(args.query, 'query')
          const topK = clampInteger(args.top_k, 10, 1, 50)
          const result = await client.search(
            query,
            { user_id: config.userId },
            { topK, signal: exec?.signal },
          )
          return renderMemories(result?.results ?? [])
        } catch (error) {
          return errorText('mem0_search', error)
        }
      },
    },
    {
      name: 'mem0_add',
      description:
        'Store a durable fact in the user’s Mem0 long-term memory verbatim. Use when the user states a lasting preference, correction, decision, or personal detail worth recalling later. Do not store secrets, transient chit-chat, or duplicates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: 'The fact to remember.' },
          metadata: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional metadata to attach to the memory.',
          },
        },
        required: ['content'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const content = redactSecrets(requireString(args.content, 'content')).trim()
          if (!content) throw new Error('content is empty after redaction')
          const metadata =
            args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
              ? { ...args.metadata, source: 'dsh', channel: 'dsh' }
              : { source: 'dsh', channel: 'dsh' }
          const result = await client.add(
            [{ role: 'user', content }],
            {
              userId: config.userId,
              agentId: config.agentId,
              metadata,
              infer: false,
              signal: exec?.signal,
            },
          )
          const rows = result?.results ?? []
          if (result?.queued) {
            return `Memory queued for background extraction${result.eventId ? ` (event ${result.eventId})` : ''}; it will be searchable shortly.`
          }
          if (rows.length === 0) return 'Memory stored.'
          return `Stored ${rows.length} ${rows.length === 1 ? 'memory' : 'memories'}:\n${renderMemories(rows)}`
        } catch (error) {
          return errorText('mem0_add', error)
        }
      },
    },
    {
      name: 'mem0_get',
      description:
        'Read a Mem0 memory by ID, or list memories belonging to the configured user. Use after mem0_search when the full record or ID list is needed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', description: 'A specific memory ID.' },
          top_k: { type: 'integer', description: 'Maximum rows when listing (default 20, max 100).' },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          if (args.memory_id !== undefined) {
            const memoryId = requireString(args.memory_id, 'memory_id')
            const memory = await client.get(memoryId, { signal: exec?.signal })
            if (!memory) return `Memory not found: ${memoryId}`
            return formatMemoryLine(memory)
          }
          const topK = clampInteger(args.top_k, 20, 1, 100)
          const result = await client.list(
            { user_id: config.userId },
            { topK, signal: exec?.signal },
          )
          return renderMemories(result?.results ?? [])
        } catch (error) {
          return errorText('mem0_get', error)
        }
      },
    },
    {
      name: 'mem0_update',
      description:
        'Replace the text of an existing Mem0 memory by ID. Use when a stored fact changed or was wrong; do not add a duplicate. The memory must belong to the configured user.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', description: 'Memory ID from mem0_search or mem0_get.' },
          text: { type: 'string', description: 'New memory text.' },
          metadata: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional metadata to merge into the memory.',
          },
        },
        required: ['memory_id', 'text'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const memoryId = requireString(args.memory_id, 'memory_id')
          const text = redactSecrets(requireString(args.text, 'text')).trim()
          await assertOwned(client, memoryId, config.userId, exec?.signal)
          const payload = { text }
          if (args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)) {
            payload.metadata = args.metadata
          }
          const result = await client.update(memoryId, payload, { signal: exec?.signal })
          return `Updated memory ${memoryId}: ${result?.message ?? 'ok'}`
        } catch (error) {
          return errorText('mem0_update', error)
        }
      },
    },
    {
      name: 'mem0_delete',
      description:
        'Delete one Mem0 memory by ID. Use when a stored fact is obsolete or the user asks to forget it. This tool cannot delete a whole collection or reset the store.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', description: 'Memory ID from mem0_search or mem0_get.' },
        },
        required: ['memory_id'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const memoryId = requireString(args.memory_id, 'memory_id')
          await assertOwned(client, memoryId, config.userId, exec?.signal)
          const result = await client.remove(memoryId, { signal: exec?.signal })
          return `Deleted memory ${memoryId}: ${result?.message ?? 'ok'}`
        } catch (error) {
          return errorText('mem0_delete', error)
        }
      },
    },
    {
      name: 'mem0_profile_get',
      description:
        'Read the user’s editable memory summary. This summary is injected before relevant memories during recall.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute() {
        try {
          if (!maintenance) throw new Error('memory summary is not available')
          const text = maintenance.profileBlock()
          return text || 'No memory summary yet.'
        } catch (error) {
          return errorText('mem0_profile_get', error)
        }
      },
    },
    {
      name: 'mem0_profile_update',
      description:
        'Replace the user’s editable memory summary with new text. Use this when the user asks you to remember, correct, or rewrite their memory summary. Pass an empty string to clear the manual profile; it will be regenerated from memories later.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            description: 'New memory summary text. Use Markdown headings and bullet lines. Empty clears it.',
          },
        },
        required: ['text'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          if (!maintenance) throw new Error('memory summary is not available')
          if (typeof args?.text !== 'string') throw new Error('text must be a string')
          const status = maintenance.setProfileText(args.text)
          const profile = status?.profile ?? {}
          if (!args.text.trim()) return 'Memory summary cleared.'
          return `Updated memory summary (${profile.items ?? 0} lines, ${profile.tokens ?? 0} tokens).`
        } catch (error) {
          return errorText('mem0_profile_update', error)
        }
      },
    },
    {
      name: 'mem0_profile_reset',
      description:
        'Regenerate the editable memory summary from the stored memories, discarding manual edits. Use only when the user asks to reset or rebuild it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute() {
        try {
          if (!maintenance) throw new Error('memory summary is not available')
          const status = await maintenance.resetProfile()
          const profile = status?.profile ?? {}
          return `Rebuilt memory summary (${profile.items ?? 0} lines, ${profile.tokens ?? 0} tokens).`
        } catch (error) {
          return errorText('mem0_profile_reset', error)
        }
      },
    },
    {
      name: 'mem0_status',
      description:
        'Check the configured Mem0 backend and storage status: backend mode, connection, collection/endpoint and embedding availability. API keys are never printed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        try {
          const status = await client.health({ signal: exec?.signal, timeoutMs: 8_000 })
          const lines = [
            `backend: ${status?.backend ?? config.backend}`,
            `status: ${status?.ok ? 'ready' : 'degraded'}`,
            `endpoint: ${status?.baseUrl ?? (config.baseUrl || '(local OSS)')}`,
            `collection: ${status?.collection ?? config.collectionName}`,
            `user: ${status?.userId ?? config.userId}`,
            `agent: ${status?.agentId ?? config.agentId}`,
          ]
          if (status?.pythonVersion || status?.mem0Version) {
            lines.push(`python: ${status?.pythonVersion ?? 'unknown'}`)
            lines.push(`mem0: ${status?.mem0Version ?? 'unknown'}`)
          }
          if (status?.qdrant) {
            lines.push(`qdrant: ${status.qdrant.ok ? 'ok' : `error: ${status.qdrant.error ?? 'unknown'}`}`)
          }
          if (status?.embedder) {
            lines.push(`embedder: ${status.embedder.ok ? `ok (${status.embedder.dimensions} dims)` : `error: ${status.embedder.error ?? 'unknown'}`}`)
          }
          return lines.join('\n')
        } catch (error) {
          return errorText('mem0_status', error)
        }
      },
    },
  ]
}

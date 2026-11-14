/**
 * Host half of dsh-session-studio.
 *
 * Wires six pieces and nothing else:
 *   store        — plugin-owned JSON document (tags, suggested tags, notes, title locks, rules)
 *   sessions     — Session corpus + head/tail facts + rename/archive primitives
 *   status       — log-tail indexer (blocked/failed statuses, cached by revision)
 *   tags/rules/ai/trash — user-facing capabilities
 *   jobs         — background task runner for the slow batch operations (PRD §8.1)
 *   api          — same-origin HTTP routes the browser half talks to (PRD §8)
 *   tools        — two model-facing tools so an agent can list and tag Sessions
 *
 * Every optional service is read through ctx.get() instead of inject: a
 * deployment without an LLM route still loads, the AI routes answer 503.
 */

import { StateStore, resolveDataDir, DEFAULT_SETTINGS } from './host/store.js'
import { createSessionSource } from './host/sessions.js'
import { createApi, createJobHandlers, API_PREFIX } from './host/api.js'

/** Cordis function-plugin name. */
export const name = 'session-studio'

/** Route carrier, trust fence, and tool registry. */
export const inject = ['webServer', 'connection', 'tools']

export const VERSION = '1.1.0'

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** Merge the profile config onto the persisted defaults, group by group. */
function mergeSettings(base, override) {
  const merged = JSON.parse(JSON.stringify(base))
  const patch = asRecord(override)
  for (const group of Object.keys(merged)) {
    const values = asRecord(patch[group])
    for (const key of Object.keys(merged[group])) {
      const value = values[key]
      if (value === undefined || value === null) continue
      if (typeof value === typeof merged[group][key]) merged[group][key] = value
    }
  }
  return merged
}

async function optional(modulePath, exportName, args, logger, label) {
  try {
    const module = await import(modulePath)
    const factory = module?.[exportName]
    if (typeof factory !== 'function') return null
    const value = factory(args)
    return value && typeof value.then === 'function' ? await value : value
  } catch (error) {
    logger.warn?.('session-studio: ' + label + ' unavailable: ' + String(error?.message ?? error))
    return null
  }
}

export async function apply(ctx, config = {}) {
  const settings = asRecord(config)
  const logger = ctx.logger ?? console

  const store = new StateStore({ dataDir: resolveDataDir(settings), logger })
  store.loadSync()

  const merged = mergeSettings(store.settings ?? DEFAULT_SETTINGS, settings)
  const sessions = createSessionSource({ ctx, logger, settings: merged })

  const statusIndex = await optional('./host/status.js', 'createStatusIndexer', { store, sessions, logger, settings: merged }, logger, 'status indexer')
  const tags = await optional('./host/tags.js', 'createTagService', { store, logger, sessions, statusIndex }, logger, 'tag service')
  const rules = await optional('./host/rules.js', 'createRuleService', { store, sessions, tags, statusIndex, settings: merged }, logger, 'rule service')
  const trash = await optional('./host/trash.js', 'createTrashService', { store, sessions, logger, dataDir: store.dataDir }, logger, 'trash service')

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  const agentDefaultModel = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  const ai = await optional('./host/ai.js', 'createAiService', {
    store,
    sessions,
    statusIndex,
    settings: merged,
    logger,
    llm,
    agentDefaultModel,
  }, logger, 'AI service')

  // Background jobs: the AI previews, the apply pass and the tag sweep are slow
  // enough that a single request would time out or block the panel. The runner
  // owns the queue, the progress accounting and jobs.json; handlers wrap the
  // services the sync endpoints used to call directly.
  const jobs = await optional(
    './host/jobs.js',
    'createJobRunner',
    { store, logger, handlers: createJobHandlers({ ai, tags, store }) },
    logger,
    'job runner',
  )
  try {
    jobs?.recover?.()
  } catch (error) {
    logger.warn?.('session-studio: job recovery failed: ' + String(error?.message ?? error))
  }

  // Workspace display labels: longest canonical-path prefix wins. Read lazily;
  // the registry is cheap to list and the map is not worth caching across calls.
  const pathModule = await import('node:path')
  const sep = pathModule.sep
  function workspaceLabel(cwd) {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const list = typeof registry?.list === 'function' ? registry.list() : []
    if (typeof cwd !== 'string' || !cwd) return null
    let best = null
    for (const workspace of list) {
      const path = workspace?.path
      if (typeof path !== 'string' || !path) continue
      if (cwd === path || cwd.startsWith(path.endsWith(sep) ? path : path + sep)) {
        if (!best || path.length > best.path.length) best = { path, title: workspace.title }
      }
    }
    return best ? best.title : null
  }

  const api = createApi({
    store,
    sessions,
    statusIndex,
    tags,
    rules,
    ai,
    trash,
    jobs,
    meta: { version: VERSION },
    workspaceLabel,
    logger,
  })

  const connectionOf = () => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
  function rejected(req, res) {
    const rejection = connectionOf()?.requestRejection?.(req)
    if (rejection === undefined || rejection === null) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          await api.handle(req, res)
        },
      }),
    'session-studio: ' + API_PREFIX,
  )

  // Agent tools: listing rows and batch tagging. Small, typed, no writes beyond
  // the same tag service the UI uses.
  const toolService = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (toolService && typeof toolService.register === 'function') {
    const definitions = [
      {
        name: 'session_studio_list',
        description: 'List DSH sessions with derived status, tags, notes and title locks. Reads the plugin status index; does not modify anything.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            includeArchived: { type: 'boolean', description: 'Include archived sessions (default true).' },
            includeSubagents: { type: 'boolean', description: 'Include subagent sessions (default false).' },
            limit: { type: 'number', description: 'Maximum rows to return (default 50, max 500).' },
          },
        },
        execute: async (args) => {
          const built = await api.buildRows({
            includeArchived: args?.includeArchived !== false,
            includeSubagents: Boolean(args?.includeSubagents),
          })
          const limit = Math.max(1, Math.min(500, Number(args?.limit) || 50))
          return {
            rows: built.rows.slice(0, limit),
            total: built.rows.length,
            indexing: built.indexing,
          }
        },
      },
      {
        name: 'session_studio_tags',
        description: 'Append, replace or clear tags on one or more DSH sessions. Writes the plugin tag store only; never touches the session log.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionIds', 'op'],
          properties: {
            sessionIds: { type: 'array', items: { type: 'string' }, description: 'Session ids to update.' },
            op: { type: 'string', enum: ['append', 'replace', 'clear'], description: 'Tag operation.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags for append/replace; ignored by clear.' },
          },
        },
        execute: async (args) => {
          if (!tags) return { error: 'tag service is unavailable' }
          const ids = Array.isArray(args?.sessionIds) ? args.sessionIds.filter((id) => typeof id === 'string') : []
          const op = String(args?.op ?? '')
          if (ids.length === 0) return { error: 'sessionIds must not be empty' }
          if (!['append', 'replace', 'clear'].includes(op)) return { error: 'op must be append, replace or clear' }
          const list = Array.isArray(args?.tags) ? args.tags : []
          const result = tags.apply({ sessionIds: ids, op, tags: list })
          await store.persistNow()
          return result
        },
      },
    ]
    for (const definition of definitions) {
      try {
        ctx.effect(() => toolService.register(definition), 'session-studio: tool ' + definition.name)
      } catch (error) {
        logger.error?.('session-studio: tool ' + definition.name + ' failed to register: ' + String(error?.message ?? error))
      }
    }
  }

  // A disposed plugin must not keep reading logs in the background.
  ctx.effect(() => () => {
    try {
      statusIndex?.stop?.()
    } catch {
      /* shutdown is best effort */
    }
    try {
      jobs?.stop?.()
    } catch {
      /* shutdown is best effort */
    }
  }, 'session-studio: stop background work')

  // Kick the incremental index once at load: newest Sessions first so the panel
  // has titles almost immediately.
  try {
    statusIndex?.start?.({ force: false })
  } catch (error) {
    logger.warn?.('session-studio: could not start status index: ' + String(error?.message ?? error))
  }

  logger.info?.(
    'session-studio ' + VERSION + ': data in ' + store.dataDir + ', API at ' + API_PREFIX +
      ', services ' + [statusIndex && 'status', tags && 'tags', rules && 'rules', ai && 'ai', trash && 'trash', jobs && 'jobs'].filter(Boolean).join('/'),
  )
}

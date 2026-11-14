/**
 * HTTP surface of the session manager (PRD §8).
 *
 * The browser half cannot reach the host plugin through the typed RPC channel,
 * so all client↔host traffic uses same-origin routes registered on the harness
 * web server. Routing is a pure function of {method, pathname, query, body} so it
 * is testable without a socket; handle() is the thin Node req/res adapter.
 */

export const API_PREFIX = '/api/dsh-session-studio'
const MAX_BODY = 2 * 1024 * 1024
/** Sessions per AI job (PRD §6 batch cap). */
const AI_JOB_LIMIT = 50
const JOB_LIST_LIMIT = 50
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const badRequest = (message, details) => new HttpError(400, 'invalid', message, details)
const notFound = (message) => new HttpError(404, 'not_found', message)
const unavailable = (message) => new HttpError(503, 'unavailable', message)

function asObject(value, field = 'body') {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('"' + field + '" must be a JSON object')
  return value
}

function asStringArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badRequest('"' + field + '" must be an array of strings')
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') throw badRequest('"' + field + '" must be an array of strings')
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  return out
}

function queryFlag(query, key, fallback = false) {
  const raw = query?.[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === '1' || value === 'true' || value === true
}

function queryValue(query, key) {
  const raw = query?.[key]
  if (raw === undefined || raw === null) return undefined
  return Array.isArray(raw) ? raw[0] : raw
}

/** Reduce a thrown value to the wire envelope. */
export function toResponse(error) {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } } }
  }
  const code = error?.code
  if (typeof code === 'string' && typeof error?.message === 'string') {
    const status = code === 'not_found' ? 404 : code === 'invalid' || code === 'invalid_rule' || code === 'invalid_input' ? 400 : code === 'conflict' || code === 'running' ? 409 : code === 'unavailable' || code === 'llm_unavailable' ? 503 : 500
    return { status, body: { error: { code, message: error.message } } }
  }
  return { status: 500, body: { error: { code: 'internal', message: String(error?.message ?? error) } } }
}

/** Job types the host can run (PRD §8.1). */
export const JOB_TYPES = ['ai.rename', 'rename.apply', 'ai.tags', 'tags.fillMissing']

/** Reduce an llm availability probe to a thrown StateError-compatible failure. */
function requireLlm(ai) {
  const availability = ai?.available?.() ?? { ok: true }
  if (availability.ok === false) {
    throw new HttpError(503, 'llm_unavailable', availability.reason ?? 'Model route is unavailable')
  }
}

/**
 * Job handlers for the background runner. Each handler reports per-item
 * progress through the runner's report/addItem face, so the client sees a
 * moving bar while the AI batches or the tag sweep run.
 */
export function createJobHandlers({ ai, tags, store } = {}) {
  const previewItems = (items) => (Array.isArray(items) ? items : [])
  return {
    async 'ai.rename'(job) {
      requireLlm(ai)
      const ids = Array.isArray(job.params.sessionIds) ? job.params.sessionIds : []
      job.report({ total: ids.length })
      const result = await ai.previewRename({
        sessionIds: ids,
        readContent: job.params.readContent,
        hooks: { onItem: (item) => job.addItem({ key: item.sessionId, state: item.skipReason ? 'skipped' : 'done', message: item.skipReason ?? null, data: item }) },
      })
      const items = previewItems(result.items)
      const skipped = items.filter((item) => item.skipReason).length
      job.report({ done: items.length - skipped, skipped })
      return result
    },
    async 'rename.apply'(job) {
      const items = previewItems(job.params.items)
      job.report({ total: items.length })
      const result = await ai.applyRename({
        items,
        hooks: { onItem: (item) => job.addItem({ key: item.sessionId, state: item.code ? 'failed' : 'done', message: item.code ?? null, data: item }) },
      })
      await store?.persistNow?.()
      job.report({ done: previewItems(result.applied).length, failed: previewItems(result.failed).length })
      return result
    },
    async 'ai.tags'(job) {
      requireLlm(ai)
      const ids = Array.isArray(job.params.sessionIds) ? job.params.sessionIds : []
      job.report({ total: ids.length })
      const result = await ai.previewTags({
        sessionIds: ids,
        mode: job.params.mode,
        hooks: { onItem: (item) => job.addItem({ key: item.sessionId, state: 'done', message: null, data: item }) },
      })
      await store?.persistNow?.()
      const items = previewItems(result.items)
      job.report({ done: items.length })
      return result
    },
    async 'tags.fillMissing'(job) {
      const dryRun = job.params.dryRun !== false
      const result = await tags.fillMissing({
        dryRun,
        hooks: {
          onTotal: (total) => job.report({ total }),
          onItem: (item) => job.addItem({ key: item.sessionId, state: item.updated ? 'done' : 'skipped', message: item.reason ?? null, data: item }),
        },
      })
      await store?.persistNow?.()
      job.report({ done: result.updated ?? 0 })
      return result
    },
  }
}

export function createApi({ store, sessions, statusIndex, tags, rules, ai, trash, jobs, meta = {}, workspaceLabel, logger } = {}) {
  const need = (module, name) => {
    if (!module) throw unavailable(name + ' service is not available in this build')
    return module
  }

  /** Enqueue a background job and answer 202 with it (PRD §8.1). */
  const enqueue = (type, params) => ({ __httpStatus: 202, job: need(jobs, 'job').start({ type, params }) })

  /** Row assembly: cheap corpus + cached facts + plugin-owned user data. */
  async function buildRows(options = {}) {
    const includeArchived = options.includeArchived === true
    const includeSubagents = Boolean(options.includeSubagents)
    const corpus = await sessions.list()
    rememberCorpus(corpus)
    const trashed = new Set()
    try {
      for (const entry of trash?.list?.() ?? []) {
        if (entry && typeof entry.sessionId === 'string') trashed.add(entry.sessionId)
      }
    } catch {
      /* the trash index is optional here */
    }
    const rows = []
    const missing = []
    for (const item of corpus) {
      const subagent = item.origin === 'subagent' || Boolean(item.parentSessionId)
      if (subagent && !includeSubagents) continue
      if (item.archived && !includeArchived) continue
      if (trashed.has(item.id)) continue

      const cached = statusIndex?.rowOf?.(item.id) ?? null
      // Blank Sessions have no turn to fold and are deliberately not indexed; asking
      // again on every list would restart the pass forever.
      if (!cached && !item.blank) missing.push(item.id)
      const record = store.sessionOf(item.id)
      rows.push({
        id: item.id,
        title: typeof cached?.title === 'string' ? cached.title : '',
        cwd: item.cwd ?? null,
        workspaceTitle: typeof workspaceLabel === 'function' && item.cwd ? workspaceLabel(item.cwd) : null,
        updatedAt: item.updatedAt || 0,
        createdAt: null,
        running: Boolean(item.running),
        blank: Boolean(item.blank),
        subagent,
        archived: Boolean(item.archived),
        pinned: Boolean(item.pinned),
        tags: record.tags,
        suggestedTags: record.suggestedTags,
        note: record.note,
        titleLocked: Boolean(record.titleLocked),
        titleSource: record.titleSource ?? null,
        intent: record.intent ?? null,
        lastTurnEnd: cached?.lastTurnEnd ?? null,
        lastTurnEndAt: cached?.lastTurnEndAt ?? null,
        indexedAt: cached?.indexedAt ?? null,
      })
    }
    if (missing.length > 0 && statusIndex?.start) {
      try {
        statusIndex.start({ force: false })
      } catch {
        /* indexing is best effort */
      }
    }
    return { rows, indexing: statusIndex?.status?.() ?? { running: false, processed: 0, total: 0 } }
  }

  /** Small id→corpus-facts map so the value route can answer without a second list(). */
  const corpusFacts = new Map()

  function rememberCorpus(corpus) {
    corpusFacts.clear()
    for (const item of Array.isArray(corpus) ? corpus : []) {
      corpusFacts.set(item.id, { cwd: item.cwd ?? null, updatedAt: item.updatedAt || 0 })
    }
  }

  function sessionValue(id) {
    const cached = statusIndex?.rowOf?.(id)
    const facts = corpusFacts.get(id)
    return {
      id: id,
      title: cached?.title ?? '',
      firstMessage: cached?.firstMessage ?? '',
      cwd: facts?.cwd ?? null,
      updatedAt: facts?.updatedAt ?? 0,
      tags: store.sessionOf(id).tags,
      note: store.sessionOf(id).note,
    }
  }

  async function route(request) {
    const method = String(request?.method ?? 'GET').toUpperCase()
    const pathname = String(request?.pathname ?? '/')
    const query = request?.query ?? {}
    const body = request?.body

    if (!pathname.startsWith(API_PREFIX)) throw notFound('unknown route: ' + pathname)
    const tail = pathname.slice(API_PREFIX.length) || '/'

    const expect = (...methods) => {
      if (!methods.includes(method)) throw new HttpError(405, 'method_not_allowed', method + ' is not allowed on ' + tail)
    }

    if (tail === '/' || tail === '') {
      expect('GET')
      return {
        meta: { prefix: API_PREFIX, version: meta.version ?? '1.0.0', ...meta },
      }
    }

    if (tail === '/state') {
      expect('GET')
      return {
        schema: store.state.schema,
        version: store.version,
        tagDefs: store.tagDefs(),
        rules: store.rules(),
        settings: store.settings,
        indexing: statusIndex?.status?.() ?? { running: false, processed: 0, total: 0 },
        ai: ai?.available?.() ?? { ok: false, reason: 'unavailable' },
        jobs: { active: jobs?.activeCount?.() ?? 0 },
      }
    }

    if (tail === '/sessions') {
      expect('GET')
      const includeArchived = queryFlag(query, 'includeArchived', false)
      const includeSubagents = queryFlag(query, 'includeSubagents', false)
      const built = await buildRows({ includeArchived, includeSubagents })
      return { ...built, version: store.version, generatedAt: Date.now() }
    }

    if (tail.startsWith('/sessions/') && tail.endsWith('/value')) {
      expect('GET')
      const id = decodeURIComponent(tail.slice('/sessions/'.length, -'/value'.length))
      if (!id) throw badRequest('missing session id')
      return sessionValue(id)
    }

    /**
     * v0.3 P2: the batch probe the native sidebar rows use for their ambient
     * decorations. Cheap by construction: one corpus read plus cached facts.
     */
    if (tail === '/session-meta') {
      expect('GET')
      const ids = String(query.ids ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      if (ids.length === 0) throw badRequest('"ids" must list at least one Session id')
      if (ids.length > 300) throw badRequest('"ids" accepts at most 300 Session ids')
      const wanted = new Set(ids)
      const corpus = await sessions.list()
      const items = {}
      for (const item of corpus) {
        if (!wanted.has(item.id)) continue
        const cached = statusIndex?.rowOf?.(item.id) ?? null
        const record = store.sessionOf(item.id)
        items[item.id] = {
          id: item.id,
          lastTurnEnd: cached?.lastTurnEnd ?? null,
          running: Boolean(item.running),
          archived: Boolean(item.archived),
          updatedAt: item.updatedAt || 0,
          tags: record.tags ?? [],
          note: record.note ?? '',
        }
      }
      return { items, version: store.version, generatedAt: Date.now() }
    }

    /**
     * v0.3.2: the tag vocabulary is user data too, so it gets its own CRUD
     * surface instead of only growing as a side effect of tagging a Session.
     */
    if (tail === '/tag-defs') {
      expect('GET', 'POST')
      if (method === 'GET') {
        return { tagDefs: need(tags, 'tag').vocabulary(), version: store.version }
      }
      const payload = asObject(body)
      const op = String(payload.op ?? '').trim().toLowerCase()
      const name = String(payload.name ?? '').trim()
      if (!op) throw badRequest('"op" must be create, rename or remove')
      if (!name) throw badRequest('"name" is required')
      let result
      if (op === 'create') result = { tagDef: need(tags, 'tag').createDef(name) }
      else if (op === 'rename') {
        const to = String(payload.to ?? '').trim()
        if (!to) throw badRequest('"to" is required when renaming a tag')
        result = need(tags, 'tag').renameDef(name, to)
      } else if (op === 'remove') result = need(tags, 'tag').removeDef(name)
      else throw badRequest('"op" must be create, rename or remove')
      await store.persistNow()
      return { ...result, tagDefs: need(tags, 'tag').vocabulary(), version: store.version }
    }

    if (tail === '/tags') {
      expect('POST')
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      if (ids.length === 0) throw badRequest('"sessionIds" must not be empty')
      const op = String(payload.op ?? 'append')
      if (!['append', 'replace', 'clear'].includes(op)) throw badRequest('"op" must be append, replace or clear')
      const result = await need(tags, 'tag').apply({ sessionIds: ids, op, tags: asStringArray(payload.tags, 'tags') })
      await store.persistNow()
      return { ...result, version: store.version }
    }

    if (tail === '/notes') {
      expect('POST')
      const payload = asObject(body)
      const id = String(payload.sessionId ?? '')
      if (!id) throw badRequest('"sessionId" is required')
      const note = String(payload.note ?? '')
      const record = store.patchSession(id, { note })
      await store.persistNow()
      return { session: { id, note: record.note }, version: store.version }
    }

    if (tail === '/rename') {
      expect('POST')
      const payload = asObject(body)
      const id = String(payload.sessionId ?? '')
      const title = String(payload.title ?? '').trim()
      if (!id) throw badRequest('"sessionId" is required')
      if (!title) throw badRequest('"title" must not be empty')
      const accepted = await sessions.rename(id, title)
      store.patchSession(id, { titleSource: 'manual', titleLocked: true })
      // The Session log changed; fold it again so the very next list shows the new title.
      if (statusIndex?.ensure) {
        try {
          Promise.resolve(statusIndex.ensure([id])).catch(() => {})
        } catch {
          /* the next index pass will pick it up anyway */
        }
      }
      await store.persistNow()
      return {
        sessionId: id,
        title: typeof accepted?.title === 'string' ? accepted.title : title,
        titleLocked: true,
        version: store.version,
      }
    }

    if (tail === '/rules') {
      expect('GET', 'POST')
      if (method === 'GET') return { rules: store.rules() }
      const payload = asObject(body)
      const rule = await need(rules, 'rule').save(payload)
      await store.persistNow()
      return { rules: store.rules(), rule, version: store.version }
    }

    if (tail.startsWith('/rules/') && tail.endsWith('/preview')) {
      expect('POST')
      const payload = asObject(body)
      return await need(rules, 'rule').preview({ rule: payload.rule ?? payload, limit: payload.limit })
    }

    if (tail === '/rules/preview') {
      expect('POST')
      const payload = asObject(body)
      return await need(rules, 'rule').preview({ rule: payload.rule ?? payload, limit: payload.limit })
    }

    if (tail === '/rules/apply') {
      expect('POST')
      const payload = asObject(body)
      const ruleId = String(payload.ruleId ?? '')
      if (!ruleId) throw badRequest('"ruleId" is required')
      const result = await need(rules, 'rule').apply({ ruleId, mode: payload.mode })
      await store.persistNow()
      return { ...result, version: store.version }
    }

    if (tail.startsWith('/rules/')) {
      expect('DELETE')
      const id = decodeURIComponent(tail.slice('/rules/'.length))
      if (!id) throw badRequest('missing rule id')
      const removed = await need(rules, 'rule').remove(id)
      await store.persistNow()
      return { removed, rules: store.rules(), version: store.version }
    }

    if (tail === '/tags/fill-missing') {
      expect('POST')
      const payload = asObject(body)
      const dryRun = payload.dryRun === undefined ? true : Boolean(payload.dryRun)
      need(tags, 'tag')
      return enqueue('tags.fillMissing', { dryRun })
    }

    if (tail === '/archive') {
      expect('POST')
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      if (ids.length === 0) throw badRequest('"sessionIds" must not be empty')
      return { ...(await sessions.archive(ids, { stopActivity: payload.stopActivity !== false })), version: store.version }
    }

    if (tail === '/unarchive') {
      expect('POST')
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      if (ids.length === 0) throw badRequest('"sessionIds" must not be empty')
      return { ...(await sessions.unarchive(ids)), version: store.version }
    }

    if (tail === '/trash') {
      expect('GET', 'POST')
      if (method === 'GET') return { items: need(trash, 'trash').list() }
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      if (ids.length === 0) throw badRequest('"sessionIds" must not be empty')
      return { ...(await need(trash, 'trash').move(ids)), version: store.version }
    }

    if (tail === '/trash/restore') {
      expect('POST')
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      if (ids.length === 0) throw badRequest('"sessionIds" must not be empty')
      return { ...(await need(trash, 'trash').restore(ids)), version: store.version }
    }

    if (tail === '/ai/rename/preview') {
      expect('POST')
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      if (ids.length === 0) throw badRequest('"sessionIds" must not be empty')
      const service = need(ai, 'AI')
      requireLlm(service)
      if (ids.length > AI_JOB_LIMIT) throw badRequest('"sessionIds" must contain at most ' + AI_JOB_LIMIT + ' sessions')
      return enqueue('ai.rename', { sessionIds: ids, readContent: payload.readContent !== false })
    }

    if (tail === '/ai/rename/apply') {
      expect('POST')
      const payload = asObject(body)
      const items = Array.isArray(payload.items) ? payload.items : []
      if (items.length === 0) throw badRequest('"items" must not be empty')
      need(ai, 'AI')
      return enqueue('rename.apply', { items })
    }

    if (tail === '/ai/tags/preview' || tail === '/ai/tags/preview-fill') {
      expect('POST')
      const payload = asObject(body)
      const ids = asStringArray(payload.sessionIds, 'sessionIds')
      const mode = payload.mode === 'fillMissing' ? 'fillMissing' : 'suggest'
      if (ids.length === 0 && mode !== 'fillMissing') throw badRequest('"sessionIds" must not be empty')
      const service = need(ai, 'AI')
      requireLlm(service)
      return enqueue('ai.tags', { sessionIds: ids, mode })
    }

    if (tail === '/ai/tags/apply') {
      expect('POST')
      const payload = asObject(body)
      const items = Array.isArray(payload.items) ? payload.items : []
      if (items.length === 0) throw badRequest('"items" must not be empty')
      const result = await need(ai, 'AI').applyTags({ items })
      await store.persistNow()
      return { ...result, version: store.version }
    }

    if (tail === '/jobs') {
      const service = need(jobs, 'job')
      if (method === 'GET') {
        const active = queryFlag(query, 'active', false)
        const limit = Math.min(JOB_LIST_LIMIT, Math.max(1, Number(queryValue(query, 'limit') ?? 20) || 20))
        return { jobs: service.list({ active, limit }) }
      }
      expect('POST')
      const payload = asObject(body)
      const type = String(payload.type ?? '')
      if (!JOB_TYPES.includes(type)) throw badRequest('"type" must be one of ' + JOB_TYPES.join(', '))
      const params = asObject(payload.params, 'params')
      return enqueue(type, params)
    }

    if (tail.startsWith('/jobs/') && tail.endsWith('/cancel')) {
      expect('POST')
      const id = decodeURIComponent(tail.slice('/jobs/'.length, -'/cancel'.length))
      if (!id) throw badRequest('missing job id')
      const job = need(jobs, 'job').cancel(id)
      if (!job) throw notFound('unknown job: ' + id)
      return { job }
    }

    if (tail.startsWith('/jobs/')) {
      expect('GET')
      const id = decodeURIComponent(tail.slice('/jobs/'.length))
      if (!id) throw badRequest('missing job id')
      const job = need(jobs, 'job').get(id)
      if (!job) throw notFound('unknown job: ' + id)
      if (queryFlag(query, 'items', true) === false) {
        const { items, ...rest } = job
        return { job: rest }
      }
      return { job }
    }

    if (tail === '/status/refresh') {
      expect('POST')
      const payload = asObject(body)
      const started = statusIndex?.start?.({ force: payload.force !== false }) ?? { started: false, running: false }
      return { ...started, indexing: statusIndex?.status?.() ?? null }
    }

    throw notFound('unknown route: ' + pathname)
  }

  async function routeSafe(request) {
    try {
      const value = await route(request)
      if (value && typeof value === 'object' && '__httpStatus' in value) {
        const { __httpStatus, ...body } = value
        return { status: Number(__httpStatus) || 200, body }
      }
      return { status: 200, body: value }
    } catch (error) {
      const response = toResponse(error)
      if (response.status >= 500) logger?.error?.('session-studio: ' + request?.method + ' ' + request?.pathname + ' → ' + String(error?.message ?? error))
      return response
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'too_large', 'request body exceeds ' + MAX_BODY + ' bytes'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function send(res, status, body) {
    res.statusCode = status
    for (const [key, value] of Object.entries(JSON_HEADERS)) res.setHeader(key, value)
    res.end(JSON.stringify(body))
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = String(req.method ?? 'GET').toUpperCase()
      let body
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const raw = await readBody(req)
        if (raw) {
          try {
            body = JSON.parse(raw)
          } catch {
            throw badRequest('request body is not valid JSON')
          }
        }
      }
      const query = Object.fromEntries(url.searchParams.entries())
      const response = await routeSafe({ method, pathname: url.pathname, query, body })
      send(res, response.status, response.body)
    } catch (error) {
      const response = toResponse(error)
      send(res, response.status, response.body)
    }
  }

  return { prefix: API_PREFIX, route, routeSafe, handle, buildRows }
}

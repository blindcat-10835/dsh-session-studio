/**
 * Status index: the only place that reads a Session's log tail to derive the
 * "blocked" and "failed" states (ADR-0002), and the only place that caches the
 * Session title / first human message so the row list never reads the log twice.
 *
 * The corpus is cheap, the facts are not: every entry is stored under the
 * persistence revision it was read at and is re-read only when that revision
 * changes. Reads are bounded by factsOf (head + tail slices), never a full
 * replay, and a pass is a small worker pool so the UI can show progress and
 * stop it. The cache itself is an auxiliary atomic-write document.
 */

export const STATUS_INDEX_FILE = 'status-index.json'
export const STATUS_INDEX_SCHEMA = 1

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 8
const FLUSH_EVERY = 25
const FIRST_MESSAGE_MAX = 400

function messageOf(error) {
  return String(error?.message ?? error)
}

function clampConcurrency(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_CONCURRENCY
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.trunc(number)))
}

function isRevision(value) {
  return typeof value === 'string' || typeof value === 'number'
}

function entryOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    revision: isRevision(raw.revision) ? raw.revision : null,
    lastTurnEnd: typeof raw.lastTurnEnd === 'string' ? raw.lastTurnEnd : null,
    lastTurnEndAt: typeof raw.lastTurnEndAt === 'number' ? raw.lastTurnEndAt : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    titleSource: typeof raw.titleSource === 'string' ? raw.titleSource : null,
    firstMessage: typeof raw.firstMessage === 'string' ? raw.firstMessage.slice(0, FIRST_MESSAGE_MAX) : '',
    indexedAt: typeof raw.indexedAt === 'number' ? raw.indexedAt : null,
  }
}

/**
 * @param {object} options
 * @param {object} options.store      StateStore (readDoc / writeDoc are atomic)
 * @param {object} options.sessions   createSessionSource() result
 * @param {object} [options.logger]
 * @param {object|function} [options.settings]  settings object or getter
 */
export function createStatusIndexer({ store, sessions, logger, settings } = {}) {
  const log = logger || console
  const state = {
    running: false,
    processed: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  }

  /** @type {{schema:number, sessions:Record<string, object>}} */
  const doc = loadDoc()

  /** Session ids waiting for a worker; one entry per id (dedupe). */
  const queue = []
  const pending = new Map()
  let activeWorkers = 0
  let passToken = 0
  let currentPass = 0
  let cancelled = false
  let stopping = false
  let docDirty = false

  function loadDoc() {
    const fallback = { schema: STATUS_INDEX_SCHEMA, sessions: {} }
    let parsed = null
    try {
      parsed = store?.readDoc?.(STATUS_INDEX_FILE, fallback)
    } catch (error) {
      log.warn?.('session-studio: could not read ' + STATUS_INDEX_FILE + ': ' + messageOf(error))
    }
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== STATUS_INDEX_SCHEMA) return fallback
    if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) return fallback
    const cached = {}
    for (const [id, raw] of Object.entries(parsed.sessions)) {
      const entry = entryOf(raw)
      if (entry) cached[id] = entry
    }
    return { schema: STATUS_INDEX_SCHEMA, sessions: cached }
  }

  function readSettings() {
    if (typeof settings === 'function') {
      try {
        return settings()
      } catch (error) {
        log.warn?.('session-studio: settings getter failed: ' + messageOf(error))
        return null
      }
    }
    if (settings && typeof settings === 'object') return settings
    return store?.settings ?? null
  }

  function concurrency() {
    return clampConcurrency(readSettings()?.status?.concurrency)
  }

  function indexingEnabled() {
    return readSettings()?.status?.enabled !== false
  }

  /** Atomic write of the whole cache document; failures are reported, never thrown. */
  function flush() {
    if (!docDirty) return true
    if (typeof store?.writeDoc !== 'function') {
      state.lastError = 'cannot persist the status index: store.writeDoc is unavailable'
      return false
    }
    let ok = false
    try {
      ok = store.writeDoc(STATUS_INDEX_FILE, doc) !== false
    } catch (error) {
      state.lastError = 'failed to persist the status index: ' + messageOf(error)
      ok = false
    }
    if (ok) {
      docDirty = false
    } else {
      state.lastError = state.lastError || 'failed to persist the status index'
    }
    return ok
  }

  function syncRunning() {
    // A stopped indexer reports idle immediately, even while the last in-flight
    // read drains: nothing new will be scheduled for it.
    state.running = !stopping && (currentPass !== 0 || activeWorkers > 0 || queue.length > 0)
    if (!state.running && state.startedAt !== null && state.finishedAt === null) {
      state.finishedAt = Date.now()
    }
  }

  /**
   * Bring one entry up to date. Returns true when the log was read again.
   * Reads only statOf + factsOf (head/tail slices) — never the full log.
   */
  async function refresh(id, force) {
    if (!sessions || typeof sessions.factsOf !== 'function') {
      throw new Error('the session source is unavailable')
    }
    const cached = doc.sessions[id]
    let stat = null

    if (!force) {
      if (typeof sessions.statOf === 'function') {
        try {
          stat = await sessions.statOf(id)
        } catch (error) {
          throw new Error('could not stat session ' + id + ': ' + messageOf(error))
        }
        if (
          cached &&
          cached.revision !== null &&
          stat &&
          isRevision(stat.revision) &&
          cached.revision === stat.revision
        ) {
          return false
        }
      } else if (cached) {
        return false
      }
    }

    const facts = await sessions.factsOf(id, { tailEvents: readSettings()?.status?.tailEvents })
    if (facts && facts.error) throw new Error('could not read session ' + id + ': ' + facts.error)
    if (cancelled) return false

    const revision = isRevision(facts?.revision) ? facts.revision : isRevision(stat?.revision) ? stat.revision : null
    doc.sessions[id] = {
      revision,
      lastTurnEnd: typeof facts?.lastTurnEnd === 'string' ? facts.lastTurnEnd : null,
      lastTurnEndAt: typeof facts?.lastTurnEndAt === 'number' ? facts.lastTurnEndAt : null,
      title: typeof facts?.title === 'string' ? facts.title : '',
      titleSource: typeof facts?.titleSource === 'string' ? facts.titleSource : null,
      firstMessage: typeof facts?.firstMessage === 'string' ? facts.firstMessage.slice(0, FIRST_MESSAGE_MAX) : '',
      indexedAt: Date.now(),
    }
    docDirty = true
    return true
  }

  async function processOne(id, force) {
    try {
      await refresh(id, force)
      return true
    } catch (error) {
      state.lastError = messageOf(error)
      log.warn?.('session-studio: status index skipped ' + id + ': ' + state.lastError)
      return false
    }
  }

  function pump() {
    const limit = concurrency()
    while (activeWorkers < limit && queue.length > 0) {
      const item = queue.shift()
      activeWorkers += 1
      runItem(item).catch((error) => {
        log.error?.('session-studio: status index worker failed: ' + messageOf(error))
      })
    }
    syncRunning()
  }

  async function runItem(item) {
    try {
      await processOne(item.id, item.force)
    } finally {
      pending.delete(item.id)
      activeWorkers -= 1
      if (item.counted) state.processed += 1
      if (item.counted && state.processed % FLUSH_EVERY === 0) flush()
      if (activeWorkers === 0 && queue.length === 0) {
        stopping = false
        // A running pass flushes in finishPass(); out-of-band work flushes here.
        if (currentPass === 0) flush()
      }
      item.resolve()
      pump()
    }
  }

  /** Queue one session id; repeated requests for the same id share one promise. */
  function enqueue(id, counted, force) {
    const existing = pending.get(id)
    if (existing) {
      if (counted) existing.counted = true
      if (force) existing.force = true
      return existing.promise
    }
    const item = { id, counted: Boolean(counted), force: Boolean(force), resolve: null, promise: null }
    item.promise = new Promise((resolve) => {
      item.resolve = resolve
    })
    pending.set(id, item)
    queue.push(item)
    return item.promise
  }

  function prune(keepIds) {
    let removed = 0
    for (const id of Object.keys(doc.sessions)) {
      if (keepIds.has(id)) continue
      delete doc.sessions[id]
      removed += 1
    }
    if (removed > 0) docDirty = true
  }

  function finishPass(token, complete, keepIds) {
    if (complete && token === currentPass && !cancelled && keepIds && keepIds.size > 0) prune(keepIds)
    flush()
    if (token === currentPass) currentPass = 0
    syncRunning()
  }

  async function runPass(token, force) {
    let rows = []
    try {
      rows = (await sessions?.list?.()) ?? []
    } catch (error) {
      state.lastError = 'could not list sessions: ' + messageOf(error)
      log.warn?.('session-studio: ' + state.lastError)
      rows = []
    }
    if (token !== currentPass || cancelled) return finishPass(token, false, null)

    const ids = []
    const keep = new Set()
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.id !== 'string' || !row.id) continue
      keep.add(row.id)
      // A blank Session has no turns to fold; indexing it would only cost a read.
      if (row.blank) continue
      ids.push(row.id)
    }

    state.total = ids.length
    const waits = ids.map((id) => enqueue(id, true, force))
    pump()
    await Promise.allSettled(waits)
    return finishPass(token, true, keep)
  }

  // --- public surface -------------------------------------------------------

  function start(options = {}) {
    const force = Boolean(options?.force)
    if (!indexingEnabled()) return { started: false, running: state.running }
    if (currentPass !== 0) return { started: false, running: true }
    currentPass = ++passToken
    cancelled = false
    stopping = false
    state.startedAt = Date.now()
    state.finishedAt = null
    state.processed = 0
    state.total = 0
    state.lastError = null
    state.running = true
    const token = currentPass
    runPass(token, force).catch((error) => {
      state.lastError = 'status index pass failed: ' + messageOf(error)
      log.error?.('session-studio: ' + state.lastError)
      if (token === currentPass) currentPass = 0
      syncRunning()
    })
    return { started: true, running: true }
  }

  function status() {
    return {
      running: state.running,
      processed: state.processed,
      total: state.total,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      lastError: state.lastError,
    }
  }

  function rowOf(id) {
    if (typeof id !== 'string' || !id) return null
    const entry = doc.sessions[id]
    if (!entry) return null
    return {
      revision: entry.revision,
      lastTurnEnd: entry.lastTurnEnd,
      lastTurnEndAt: entry.lastTurnEndAt,
      title: entry.title,
      titleSource: entry.titleSource,
      firstMessage: entry.firstMessage,
      indexedAt: entry.indexedAt,
    }
  }

  /** Wait until these ids have been indexed (AI / rule previews call this first). */
  async function ensure(ids) {
    const values = Array.isArray(ids) ? ids : []
    const targets = []
    const seen = new Set()
    for (const raw of values) {
      if (typeof raw !== 'string') continue
      const id = raw.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      targets.push(id)
    }
    if (targets.length === 0) return
    if (!sessions || typeof sessions.factsOf !== 'function') return
    cancelled = false
    stopping = false
    // Explicit request work is never counted against a pass' progress.
    const waits = targets.map((id) => enqueue(id, false, false))
    pump()
    await Promise.allSettled(waits)
  }

  function stop() {
    cancelled = true
    stopping = true
    currentPass = 0
    passToken += 1
    const dropped = queue.splice(0, queue.length)
    for (const item of dropped) {
      pending.delete(item.id)
      item.resolve()
    }
    flush()
    syncRunning()
  }

  return { start, status, rowOf, ensure, stop }
}

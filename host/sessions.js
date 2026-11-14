/**
 * Session corpus and per-Session facts.
 *
 * The corpus (list) is cheap: the Session controller's list plus the Workspace
 * registry's archive/pin sets. The facts (title, first human message, last turn
 * end reason) need the log; we read only the head and the tail through the
 * persistence handle, which keeps one pass per changed Session (see ADR-0002 and
 * the status indexer that owns the cache).
 */

const TITLE_EVENT = 'session/title'
const TURN_END_EVENT = 'turn/end'
const USER_MESSAGE_EVENT = 'user/message'

function abortSignal(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  return controller.signal
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function isHumanMessage(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return false
  return data.source?.kind === 'user'
}

export function emptyFacts() {
  return {
    title: '',
    titleSource: null,
    firstMessage: '',
    lastTurnEnd: null,
    lastTurnEndAt: null,
    messageCount: 0,
  }
}

/** Fold title/first-message/last-turn-end out of the head and tail slices we already have. */
export function foldFacts(headEvents, tailEvents) {
  const facts = emptyFacts()
  const head = Array.isArray(headEvents) ? headEvents : []
  const tail = Array.isArray(tailEvents) ? tailEvents : []

  for (const event of head) {
    if (!event || event.type !== USER_MESSAGE_EVENT) continue
    facts.messageCount += 1
    if (!facts.firstMessage && isHumanMessage(event)) {
      const text = textOfContent(event.data?.content).trim()
      if (text) facts.firstMessage = text.slice(0, 4000)
    }
    if (facts.messageCount >= 50) break
  }

  const scan = (events) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event) continue
      if (event.type === TITLE_EVENT) {
        const title = event.data?.title
        if (typeof title === 'string' && title.trim()) {
          facts.title = title.trim()
          facts.titleSource = event.data?.source ?? null
        }
      }
      if (event.type === TURN_END_EVENT && facts.lastTurnEnd === null) {
        facts.lastTurnEnd = event.data?.reason?.kind ?? null
        facts.lastTurnEndAt = typeof event.time === 'number' ? event.time : null
      }
      if (facts.title && facts.lastTurnEnd !== null && event.type !== TITLE_EVENT) break
    }
  }
  scan(tail)
  if (!facts.title) scan(head)
  return facts
}

export function createSessionSource({ ctx, logger, settings }) {
  const warn = (message) => logger?.warn?.('session-manager: ' + message)

  const controller = () => ctx.get('sessionController')
  const registry = () => ctx.get('workspaceRegistry')
  const persistence = () => ctx.get('sessionPersistence')
  const query = () => ctx.get('sessionQuery')

  /** Cheap corpus: controller list merged with archive/pin membership. */
  async function list() {
    const archived = new Set(registry()?.archivedSessionIds ?? [])
    const pinned = new Set(registry()?.pinnedSessionIds ?? [])
    const summary = new Map()

    const source = controller()
    if (source && typeof source.list === 'function') {
      try {
        const value = await source.list({}, abortSignal(30000))
        for (const item of value?.items ?? []) {
          if (!item || typeof item.sessionId !== 'string') continue
          summary.set(item.sessionId, item)
        }
      } catch (error) {
        warn('session list failed: ' + String(error?.message ?? error))
      }
    }

    if (summary.size === 0) {
      const store = persistence()
      if (store && typeof store.list === 'function') {
        try {
          for (const snapshot of await store.list({})) {
            const header = snapshot?.header
            if (!header || typeof header.id !== 'string') continue
            summary.set(header.id, {
              sessionId: header.id,
              updatedAt: 0,
              running: false,
              blank: false,
              cwd: header.cwd,
              parentSessionId: header.parentSessionId,
              origin: header.origin,
            })
          }
        } catch (error) {
          warn('persistence list failed: ' + String(error?.message ?? error))
        }
      }
    }

    const rows = []
    for (const [id, item] of summary) {
      rows.push({
        id,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        running: Boolean(item.running),
        blank: Boolean(item.blank),
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
        origin: item.origin,
        archived: archived.has(id),
        pinned: pinned.has(id),
      })
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1))
    return rows
  }

  /** Whether a Session still exists in this deployment's persistence. */
  async function exists(id) {
    const store = persistence()
    if (!store || typeof store.stat !== 'function') return false
    try {
      await store.stat(id, { signal: abortSignal(8000) })
      return true
    } catch {
      return false
    }
  }

  /** Storage snapshot for one Session: revision, logical event count, artifact location. */
  async function statOf(id) {
    const store = persistence()
    if (!store || typeof store.stat !== 'function') return null
    const snapshot = await store.stat(id, { signal: abortSignal(15000) })
    return {
      revision: snapshot?.revision,
      eventCount: typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : null,
      location: snapshot?.location,
      header: snapshot?.header,
    }
  }

  /** Head+tail facts for one Session; falls back to a full validated read when slices are unavailable. */
  async function factsOf(id, options = {}) {
    const tailEvents = Math.max(20, Math.min(1000, options.tailEvents ?? settings?.status?.tailEvents ?? 120))
    const store = persistence()
    let stat = null
    try {
      stat = await statOf(id)
    } catch (error) {
      return { ...emptyFacts(), error: String(error?.message ?? error) }
    }

    if (store && typeof store.open === 'function' && stat && typeof stat.eventCount === 'number') {
      let handle = null
      try {
        handle = await store.open(id, { signal: abortSignal(20000) })
        const total = stat.eventCount
        const headLength = Math.min(60, total)
        const head = await handle.read(0, headLength, { signal: abortSignal(20000) })
        let tail = head
        if (total > headLength) {
          const start = Math.max(headLength, total - tailEvents)
          tail = await handle.read(start, total - start, { signal: abortSignal(30000) })
        }
        const facts = foldFacts(head?.events ?? [], tail?.events ?? [])
        return { ...facts, revision: stat.revision, eventCount: total }
      } catch (error) {
        warn('slice read failed for ' + id + ': ' + String(error?.message ?? error))
      } finally {
        try {
          await handle?.close?.()
        } catch {
          /* ignore */
        }
      }
    }

    try {
      const snap = await query()?.readSession?.(id)
      const events = snap?.events ?? []
      return { ...foldFacts(events, events), revision: stat?.revision, eventCount: events.length }
    } catch (error) {
      return { ...emptyFacts(), ...(stat ? { revision: stat.revision } : {}), error: String(error?.message ?? error) }
    }
  }

  async function rename(id, title) {
    const source = controller()
    if (!source || typeof source.rename !== 'function') {
      throw new Error('session controller is unavailable')
    }
    return source.rename({ sessionId: id, title })
  }

  async function archive(ids, options = {}) {
    const reg = registry()
    if (!reg) throw new Error('workspace registry is unavailable')
    const accepted = []
    const refused = []
    for (const id of ids) {
      try {
        await reg.archiveSession(id, { stopActivity: options.stopActivity !== false })
        accepted.push(id)
      } catch (error) {
        refused.push({ sessionId: id, code: error?.code ?? 'archive_failed', message: String(error?.message ?? error) })
      }
    }
    return { archived: accepted, refused }
  }

  async function unarchive(ids) {
    const reg = registry()
    if (!reg) throw new Error('workspace registry is unavailable')
    const accepted = []
    const refused = []
    for (const id of ids) {
      try {
        await reg.unarchiveSession(id)
        accepted.push(id)
      } catch (error) {
        refused.push({ sessionId: id, code: error?.code ?? 'unarchive_failed', message: String(error?.message ?? error) })
      }
    }
    return { unarchived: accepted, refused }
  }

  /** Directory holding one Session's persisted artifact (the unit the trash moves). */
  async function artifactDir(id) {
    const stat = await statOf(id)
    const artifact = stat?.location?.path
    if (typeof artifact !== 'string' || !artifact) return null
    const path = await import('node:path')
    return path.dirname(artifact)
  }

  return { list, exists, statOf, factsOf, rename, archive, unarchive, artifactDir }
}

/**
 * Trash: DSH has no "delete a Session" API, so deleting means moving the
 * Session's artifact directory aside into the plugin's trash and remembering
 * where it came from, so it can be moved back (PRD D1). The move is a single
 * directory rename when the two paths share a filesystem; across filesystems it
 * degrades to a staged copy that never leaves the original directory truncated.
 * The trash index is written with the store's atomic write after the directory
 * has moved, and the move is rolled back if that write fails.
 *
 * A Session whose artifact directory is already gone (storage moved, manual
 * cleanup) still has to be deletable (US18), so it becomes a tombstone record:
 * no directory moves, and restoring only drops the entry.
 */

import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { StateError } from './store.js'

export const TRASH_INDEX_FILE = 'trash.json'
export const TRASH_INDEX_SCHEMA = 1

function messageOf(error) {
  return String(error?.message ?? error)
}

function describe(error) {
  const code = error?.code ? String(error.code) + ': ' : ''
  return code + messageOf(error)
}

function uniqueIds(raw) {
  const out = []
  const seen = new Set()
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** True when child is parent itself or lives below it. */
function isInside(parent, child) {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * @param {object} options
 * @param {object} options.store      StateStore (readDoc / writeDoc are atomic)
 * @param {object} options.sessions   createSessionSource() result
 * @param {object} [options.logger]
 * @param {string} options.dataDir    plugin data directory
 * @param {object} [options.fs]       fs implementation (tests inject a proxy)
 */
export function createTrashService({ store, sessions, logger, dataDir, fs: fsOption } = {}) {
  const log = logger || console
  const fs = fsOption || nodeFs
  const root = resolveRoot()
  const trashRoot = path.join(root, 'trash')

  /** @type {{schema:number, items:Record<string, object>}|null} */
  let doc = null
  let tail = Promise.resolve()

  function resolveRoot() {
    const explicit =
      typeof dataDir === 'string' && dataDir.trim()
        ? dataDir
        : typeof store?.dataDir === 'string' && store.dataDir.trim()
          ? store.dataDir
          : ''
    if (!explicit) throw new StateError('invalid_data_dir', 'the trash service needs a plugin data directory')
    return path.resolve(explicit)
  }

  function normalizeDoc(parsed) {
    const next = { schema: TRASH_INDEX_SCHEMA, items: {} }
    if (!parsed || typeof parsed !== 'object') return next
    const items = parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items) ? parsed.items : {}
    for (const [id, record] of Object.entries(items)) {
      if (!record || typeof record !== 'object') continue
      // `source` is the pre-tombstone field name; keep reading it so an older
      // trash.json still restores. A record with no directory is a tombstone.
      const rawDir =
        typeof record.sourceDir === 'string' && record.sourceDir
          ? record.sourceDir
          : typeof record.source === 'string' && record.source
            ? record.source
            : ''
      const tombstone = rawDir === ''
      if (tombstone && record.tombstone !== true) continue
      next.items[id] = {
        sessionId: id,
        title: typeof record.title === 'string' ? record.title : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        sourceDir: tombstone ? null : path.resolve(rawDir),
        deletedAt: typeof record.deletedAt === 'string' ? record.deletedAt : null,
        tombstone,
      }
    }
    return next
  }

  function index() {
    if (doc) return doc
    const fallback = { schema: TRASH_INDEX_SCHEMA, items: {} }
    let parsed = null
    try {
      parsed = store?.readDoc?.(TRASH_INDEX_FILE, fallback)
    } catch (error) {
      log.warn?.('session-studio: could not read ' + TRASH_INDEX_FILE + ': ' + messageOf(error))
    }
    doc = normalizeDoc(parsed)
    return doc
  }

  /** Atomic write; returns false instead of throwing so callers can roll back. */
  function persist() {
    if (!store || typeof store.writeDoc !== 'function') return false
    try {
      return store.writeDoc(TRASH_INDEX_FILE, index()) !== false
    } catch (error) {
      log.error?.('session-studio: could not write ' + TRASH_INDEX_FILE + ': ' + messageOf(error))
      return false
    }
  }

  /** Serialize mutations so two requests cannot interleave index writes. */
  function withLock(work) {
    const run = tail.then(work, work)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function assertId(raw) {
    if (typeof raw !== 'string') throw new StateError('invalid_session', 'sessionId must be a string')
    const value = raw.trim()
    if (!value) throw new StateError('invalid_session', 'sessionId is required')
    if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || path.isAbsolute(value)) {
      throw new StateError('invalid_session', 'sessionId is not a safe directory name: ' + raw)
    }
    return value
  }

  async function listRows() {
    if (!sessions || typeof sessions.list !== 'function') return []
    try {
      return (await sessions.list()) ?? []
    } catch (error) {
      log.warn?.('session-studio: could not list sessions: ' + messageOf(error))
      return []
    }
  }

  async function titleOf(id) {
    if (!sessions || typeof sessions.factsOf !== 'function') return ''
    try {
      const facts = await sessions.factsOf(id)
      return typeof facts?.title === 'string' ? facts.title : ''
    } catch (error) {
      log.warn?.('session-studio: could not read the title of ' + id + ': ' + messageOf(error))
      return ''
    }
  }

  function copyTree(from, to) {
    if (typeof fs.cpSync !== 'function') {
      throw new Error('this Node.js build cannot copy directories (fs.cpSync is missing)')
    }
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
  }

  function removeTree(target) {
    fs.rmSync(target, { recursive: true, force: true })
  }

  /**
   * Move one directory. Same filesystem: one rename. Otherwise: copy next to the
   * destination, publish it, then remove the original — the data is complete at
   * the destination before anything is deleted from the source.
   */
  async function moveDir(from, to) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (error?.code !== 'EXDEV') {
        throw new StateError('move_failed', 'could not move ' + from + ' to ' + to + ': ' + describe(error))
      }
    }

    const staging = to + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    try {
      copyTree(from, staging)
    } catch (error) {
      removeTree(staging)
      throw new StateError(
        'cross_device_copy_failed',
        'could not copy ' + from + ' across filesystems: ' + describe(error) + ' (the original directory is untouched)',
      )
    }
    try {
      fs.renameSync(staging, to)
    } catch (error) {
      removeTree(staging)
      throw new StateError(
        'cross_device_publish_failed',
        'copied ' + from + ' to ' + staging + ' but could not publish it as ' + to + ': ' + describe(error) + ' (the original directory is untouched)',
      )
    }
    try {
      removeTree(from)
    } catch (error) {
      throw new StateError(
        'cross_device_delete_failed',
        'copied ' + from + ' to ' + to + ' but could not remove the original directory: ' + describe(error) + ' (the complete copy is kept at ' + to + ')',
      )
    }
  }

  function refusal(sessionId, error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'move_failed'
    return { sessionId, code, message: messageOf(error) }
  }

  async function moveOne(id, row) {
    const sessionId = assertId(id)
    const idx = index()
    if (idx.items[sessionId]) {
      throw new StateError('already_trashed', 'the session is already in the trash: ' + sessionId)
    }
    if (row?.running) {
      throw new StateError('running', 'the session is running; stop its work before deleting it: ' + sessionId)
    }
    if (!row) {
      const exists = typeof sessions?.exists === 'function' ? await sessions.exists(sessionId) : false
      if (!exists) throw new StateError('not_found', 'the session no longer exists: ' + sessionId)
    }

    let source = null
    try {
      source = await sessions?.artifactDir?.(sessionId)
    } catch (error) {
      throw new StateError('artifact_unavailable', 'could not locate the session artifact directory: ' + describe(error))
    }
    if (typeof source === 'string' && source) source = path.resolve(source)

    // The Session exists but its artifact directory does not (the DSH storage
    // moved, or somebody cleaned the directory by hand). There is nothing to
    // move, so record a tombstone instead of refusing: refusing would leave such
    // a Session impossible to remove from the list at all (US18).
    const artifactMissing = typeof source !== 'string' || !source || !fs.existsSync(source)
    if (!artifactMissing && isInside(trashRoot, source)) {
      throw new StateError('invalid_source', 'the session artifact already lives inside the trash: ' + source)
    }

    const target = path.join(trashRoot, sessionId)
    if (fs.existsSync(target)) {
      throw new StateError('trash_exists', 'the trash already holds a directory for ' + sessionId)
    }

    const title = await titleOf(sessionId)
    const record = {
      sessionId,
      title,
      cwd: typeof row?.cwd === 'string' ? row.cwd : '',
      sourceDir: artifactMissing ? null : source,
      deletedAt: new Date().toISOString(),
      tombstone: artifactMissing,
    }

    if (artifactMissing) {
      idx.items[sessionId] = record
      if (!persist()) {
        delete idx.items[sessionId]
        throw new StateError(
          'index_write_failed',
          TRASH_INDEX_FILE + ' could not be written; no directory was moved and the session is unchanged',
        )
      }
      return { tombstone: true }
    }

    fs.mkdirSync(trashRoot, { recursive: true })
    await moveDir(source, target)

    idx.items[sessionId] = record
    if (!persist()) {
      let rollbackError = null
      try {
        await moveDir(target, source)
      } catch (error) {
        rollbackError = error
      }
      if (rollbackError) {
        // The directory did move. Keep the record so this process can still list
        // and restore it, and say exactly where the data is.
        log.error?.('session-studio: could not roll back ' + target + ' to ' + source + ': ' + messageOf(rollbackError))
        throw new StateError(
          'index_write_failed',
          'the session directory is in the trash at ' + target + ' but ' + TRASH_INDEX_FILE + ' could not be written and the move could not be rolled back: ' + describe(rollbackError),
        )
      }
      delete idx.items[sessionId]
      throw new StateError('index_write_failed', TRASH_INDEX_FILE + ' could not be written; the move was rolled back and the session is intact')
    }
    return { tombstone: false }
  }

  async function restoreOne(id) {
    const sessionId = assertId(id)
    const idx = index()
    const record = idx.items[sessionId]
    if (!record) throw new StateError('not_found', 'the session is not in the trash: ' + sessionId)

    if (record.tombstone || !record.sourceDir) {
      // A tombstone never moved a directory, so there is nothing to move back:
      // restoring only drops the entry and the Session is visible again.
      delete idx.items[sessionId]
      if (!persist()) {
        idx.items[sessionId] = record
        throw new StateError(
          'index_write_failed',
          TRASH_INDEX_FILE + ' could not be written; the tombstone was kept and nothing was moved',
        )
      }
      return { tombstone: true }
    }

    const source = path.join(trashRoot, sessionId)
    const target = path.resolve(record.sourceDir)
    if (fs.existsSync(target)) {
      throw new StateError('target_exists', 'a session directory already exists at ' + target)
    }
    if (!fs.existsSync(source)) {
      throw new StateError('missing_data', 'the trash directory is missing for ' + sessionId)
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    await moveDir(source, target)
    delete idx.items[sessionId]
    if (!persist()) {
      idx.items[sessionId] = record
      try {
        await moveDir(target, source)
      } catch (error) {
        throw new StateError(
          'index_write_failed',
          'the session directory was restored to ' + target + ' but ' + TRASH_INDEX_FILE + ' could not be written and the move could not be rolled back: ' + describe(error),
        )
      }
      throw new StateError('index_write_failed', TRASH_INDEX_FILE + ' could not be written; the restore was rolled back')
    }
    return { tombstone: false }
  }

  // --- public surface -------------------------------------------------------

  async function move(ids) {
    const values = uniqueIds(ids)
    const trashed = []
    const refused = []
    const tombstones = []
    if (values.length === 0) return { trashed, refused, tombstones }
    const rows = await listRows()
    const byId = new Map()
    for (const row of rows) {
      if (row && typeof row.id === 'string') byId.set(row.id, row)
    }
    await withLock(async () => {
      for (const id of values) {
        try {
          const outcome = await moveOne(id, byId.get(id))
          trashed.push(id)
          if (outcome?.tombstone) tombstones.push(id)
        } catch (error) {
          refused.push(refusal(id, error))
        }
      }
    })
    return { trashed, refused, tombstones }
  }

  async function restore(ids) {
    const values = uniqueIds(ids)
    const restored = []
    const refused = []
    const tombstones = []
    if (values.length === 0) return { restored, refused, tombstones }
    await withLock(async () => {
      for (const id of values) {
        try {
          const outcome = await restoreOne(id)
          restored.push(id)
          if (outcome?.tombstone) tombstones.push(id)
        } catch (error) {
          refused.push({ sessionId: id, code: typeof error?.code === 'string' && error.code ? error.code : 'restore_failed', message: messageOf(error) })
        }
      }
    })
    return { restored, refused, tombstones }
  }

  /**
   * Trash listing, newest first. Real entries whose directory disappeared are
   * not advertised; tombstones have no directory by design and are always shown
   * with `tombstone: true` so the UI can say the original data is gone.
   */
  function list() {
    const idx = index()
    const items = []
    for (const [id, record] of Object.entries(idx.items)) {
      if (!record) continue
      const tombstone = record.tombstone === true || !record.sourceDir
      if (!tombstone && !fs.existsSync(path.join(trashRoot, id))) continue
      items.push({
        sessionId: id,
        title: record.title,
        cwd: record.cwd,
        deletedAt: record.deletedAt,
        tombstone,
      })
    }
    items.sort((left, right) => {
      const a = String(left.deletedAt ?? '')
      const b = String(right.deletedAt ?? '')
      if (a !== b) return b.localeCompare(a)
      return left.sessionId < right.sessionId ? -1 : 1
    })
    return items
  }

  return { list, move, restore }
}

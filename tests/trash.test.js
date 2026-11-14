import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { StateStore } from '../host/store.js'
import { createTrashService, TRASH_INDEX_FILE } from '../host/trash.js'

const silent = { warn() {}, error() {}, debug() {}, info() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-manager-trash-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'data')
  const sessionsRoot = path.join(base, 'sessions')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(sessionsRoot, { recursive: true })

  const store = new StateStore({ dataDir, logger: silent })
  store.loadSync()

  const artifacts = new Map()
  const rows = []
  const sessions = {
    rows,
    async list() {
      return rows.map((row) => ({ ...row }))
    },
    async exists(id) {
      return rows.some((row) => row.id === id)
    },
    async factsOf(id) {
      return { title: 'title ' + id }
    },
    async artifactDir(id) {
      return artifacts.get(id) ?? null
    },
  }

  function addSession(id, content = 'log line') {
    const dir = path.join(sessionsRoot, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.log'), content)
    fs.writeFileSync(path.join(dir, 'session.lock'), 'lock')
    artifacts.set(id, dir)
    rows.push({ id, cwd: '/work/' + id })
    return dir
  }

  function makeTrash(options = {}) {
    return createTrashService({ store, sessions, logger: silent, dataDir, ...options })
  }

  return {
    base,
    dataDir,
    sessionsRoot,
    trashRoot: path.join(dataDir, 'trash'),
    store,
    sessions,
    artifacts,
    addSession,
    makeTrash,
  }
}

function readIndex(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, TRASH_INDEX_FILE), 'utf8'))
}

/** fs proxy whose renameSync fails with EXDEV for moves that start below the sessions root. */
function crossDeviceFs(sessionsRoot, overrides = {}) {
  return new Proxy(fs, {
    get(target, key) {
      if (overrides[key]) return overrides[key]
      if (key === 'renameSync') {
        return (from, to) => {
          if (String(from).startsWith(sessionsRoot)) {
            const error = new Error('EXDEV: cross-device link not permitted')
            error.code = 'EXDEV'
            throw error
          }
          return target.renameSync(from, to)
        }
      }
      return Reflect.get(target, key)
    },
  })
}

test('move relocates the artifact directory into the trash and records it atomically', async (t) => {
  const { dataDir, trashRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'hello world')
  const trash = makeTrash()

  const result = await trash.move(['s1'])
  assert.deepEqual(result.trashed, ['s1'])
  assert.deepEqual(result.refused, [])
  assert.equal(fs.existsSync(dir), false, 'the session directory left the corpus')
  assert.equal(fs.readFileSync(path.join(trashRoot, 's1', 'session.log'), 'utf8'), 'hello world')
  assert.equal(fs.readFileSync(path.join(trashRoot, 's1', 'session.lock'), 'utf8'), 'lock')

  const doc = readIndex(dataDir)
  assert.equal(doc.schema, 1)
  assert.equal(doc.items.s1.sourceDir, dir)
  assert.equal(doc.items.s1.tombstone, false)
  assert.equal(doc.items.s1.title, 'title s1')
  assert.equal(doc.items.s1.cwd, '/work/s1')
  assert.ok(doc.items.s1.deletedAt)

  const items = trash.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, 's1')
  assert.equal(items[0].title, 'title s1')
  assert.equal(items[0].cwd, '/work/s1')
})

test('move refuses a running session and leaves it untouched', async (t) => {
  const { sessions, store, trashRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1')
  sessions.rows[0].running = true
  const trash = makeTrash()

  const result = await trash.move(['s1'])
  assert.deepEqual(result.trashed, [])
  assert.equal(result.refused.length, 1)
  assert.equal(result.refused[0].sessionId, 's1')
  assert.equal(result.refused[0].code, 'running')
  assert.equal(fs.existsSync(dir), true)
  assert.equal(fs.existsSync(trashRoot), false)
  assert.equal(store.version, 0, 'a refusal writes no plugin state')
})

test('move refuses unknown, unsafe and already trashed sessions', async (t) => {
  const { addSession, makeTrash } = setup(t)
  addSession('s1')
  const trash = makeTrash()

  const unknown = await trash.move(['nope'])
  assert.equal(unknown.refused[0].code, 'not_found')

  const unsafe = await trash.move(['../escape'])
  assert.equal(unsafe.refused[0].code, 'invalid_session')

  assert.deepEqual(await trash.move(['s1']), { trashed: ['s1'], refused: [], tombstones: [] })
  const again = await trash.move(['s1'])
  assert.equal(again.refused[0].code, 'already_trashed')
  assert.equal(trash.list().length, 1)
})

test('move records a tombstone when the artifact directory is gone', async (t) => {
  const { dataDir, trashRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  fs.rmSync(dir, { recursive: true, force: true })
  const trash = makeTrash()

  const result = await trash.move(['s1'])
  assert.deepEqual(result.trashed, ['s1'])
  assert.deepEqual(result.tombstones, ['s1'])
  assert.deepEqual(result.refused, [])
  assert.equal(fs.existsSync(path.join(trashRoot, 's1')), false, 'nothing is moved for a tombstone')

  const doc = readIndex(dataDir)
  assert.equal(doc.items.s1.tombstone, true)
  assert.equal(doc.items.s1.sourceDir, null)
  assert.equal(doc.items.s1.title, 'title s1')
  assert.equal(doc.items.s1.cwd, '/work/s1')

  const items = trash.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, 's1')
  assert.equal(items[0].tombstone, true)

  const running = await trash.move(['s1'])
  assert.equal(running.refused[0].code, 'already_trashed')
})

test('move tombstones a session whose source reports no artifact directory', async (t) => {
  const { artifacts, trashRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  artifacts.delete('s1')
  const trash = makeTrash()

  const result = await trash.move(['s1'])
  assert.deepEqual(result.trashed, ['s1'])
  assert.deepEqual(result.tombstones, ['s1'])
  assert.equal(fs.existsSync(dir), true, 'an artifact the source cannot locate is left alone')
  assert.equal(fs.existsSync(path.join(trashRoot, 's1')), false)
  assert.equal(trash.list()[0].tombstone, true)
})

test('restore of a tombstone only drops the index entry', async (t) => {
  const { dataDir, addSession, makeTrash } = setup(t)
  const dir = addSession('s1')
  fs.rmSync(dir, { recursive: true, force: true })
  const trash = makeTrash()
  await trash.move(['s1'])
  assert.equal(trash.list().length, 1)

  const result = await trash.restore(['s1'])
  assert.deepEqual(result.restored, ['s1'])
  assert.deepEqual(result.tombstones, ['s1'])
  assert.deepEqual(result.refused, [])
  assert.deepEqual(trash.list(), [])
  assert.deepEqual(readIndex(dataDir).items, {})

  const again = await trash.restore(['s1'])
  assert.equal(again.refused[0].code, 'not_found')
})

test('a failed trash.json write rolls a tombstone operation back', async (t) => {
  const { dataDir, store, artifacts, addSession, makeTrash, sessions } = setup(t)
  const dir = addSession('s1', 'payload')
  artifacts.delete('s1')
  const original = store.writeDoc.bind(store)
  let failing = true
  store.writeDoc = (name, value) => (failing ? false : original(name, value))
  const trash = makeTrash()

  const moved = await trash.move(['s1'])
  assert.deepEqual(moved.trashed, [])
  assert.equal(moved.refused[0].code, 'index_write_failed')
  assert.match(moved.refused[0].message, /no directory was moved/)
  assert.deepEqual(trash.list(), [], 'no tombstone survives the failed write')
  assert.equal(fs.existsSync(dir), true, 'whatever is left on disk is untouched')
  assert.deepEqual(sessions.rows.map((row) => row.id), ['s1'], 'the session itself is untouched')

  failing = false
  const retried = await trash.move(['s1'])
  assert.deepEqual(retried.trashed, ['s1'], 'a retry succeeds once the write works')
  failing = true
  const restored = await trash.restore(['s1'])
  assert.deepEqual(restored.restored, [])
  assert.equal(restored.refused[0].code, 'index_write_failed')
  assert.equal(trash.list().length, 1, 'the tombstone is kept when the restore write fails')

  failing = false
  assert.deepEqual((await trash.restore(['s1'])).restored, ['s1'])
  assert.deepEqual(readIndex(dataDir).items, {})
})

test('restore moves the directory back and clears the index entry', async (t) => {
  const { dataDir, trashRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'content')
  const trash = makeTrash()

  await trash.move(['s1'])
  const result = await trash.restore(['s1'])
  assert.deepEqual(result.restored, ['s1'])
  assert.deepEqual(result.refused, [])
  assert.equal(fs.readFileSync(path.join(dir, 'session.log'), 'utf8'), 'content')
  assert.equal(fs.existsSync(path.join(trashRoot, 's1')), false)
  assert.deepEqual(readIndex(dataDir).items, {})
  assert.deepEqual(trash.list(), [])

  const again = await trash.restore(['s1'])
  assert.equal(again.refused[0].code, 'not_found')
})

test('restore refuses to overwrite a directory that reappeared', async (t) => {
  const { trashRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1')
  const trash = makeTrash()
  await trash.move(['s1'])

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.log'), 'new data')
  const result = await trash.restore(['s1'])
  assert.equal(result.refused[0].code, 'target_exists')
  assert.equal(fs.readFileSync(path.join(dir, 'session.log'), 'utf8'), 'new data')
  assert.equal(fs.existsSync(path.join(trashRoot, 's1')), true)
  assert.equal(trash.list().length, 1)
})

test('list reports the newest deletion first and hides data that vanished', async (t) => {
  const { trashRoot, addSession, makeTrash } = setup(t)
  addSession('s1')
  addSession('s2')
  const trash = makeTrash()
  await trash.move(['s1'])
  await sleep(5)
  await trash.move(['s2'])

  assert.deepEqual(trash.list().map((item) => item.sessionId), ['s2', 's1'])

  fs.rmSync(path.join(trashRoot, 's1'), { recursive: true, force: true })
  assert.deepEqual(trash.list().map((item) => item.sessionId), ['s2'], 'a missing directory is not advertised')
})

test('a cross-device move falls back to copy, publish, then delete', async (t) => {
  const { dataDir, trashRoot, sessionsRoot, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  const trash = makeTrash({ fs: crossDeviceFs(sessionsRoot) })

  const result = await trash.move(['s1'])
  assert.deepEqual(result.trashed, ['s1'])
  assert.deepEqual(result.refused, [])
  assert.equal(fs.existsSync(dir), false, 'the original directory was removed only after the copy was published')
  assert.equal(fs.readFileSync(path.join(trashRoot, 's1', 'session.log'), 'utf8'), 'payload')
  assert.deepEqual(fs.readdirSync(trashRoot), ['s1'], 'no staging directory is left behind')
  assert.equal(readIndex(dataDir).items.s1.sourceDir, dir)
})

test('a failing cross-device copy refuses the move and keeps the original intact', async (t) => {
  const { addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  const sessionsRoot = path.dirname(dir)
  const fsImpl = crossDeviceFs(sessionsRoot, {
    cpSync() {
      const error = new Error('ENOSPC: no space left on device')
      error.code = 'ENOSPC'
      throw error
    },
  })
  const trash = makeTrash({ fs: fsImpl })

  const result = await trash.move(['s1'])
  assert.deepEqual(result.trashed, [])
  assert.equal(result.refused[0].code, 'cross_device_copy_failed')
  assert.match(result.refused[0].message, /untouched/)
  assert.equal(fs.readFileSync(path.join(dir, 'session.log'), 'utf8'), 'payload')
  assert.equal(trash.list().length, 0)
})

test('a failed trash.json write rolls the directory move back', async (t) => {
  const { dataDir, trashRoot, store, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  const trash = makeTrash()

  const original = store.writeDoc.bind(store)
  let attempts = 0
  store.writeDoc = (name, value) => {
    if (name === TRASH_INDEX_FILE && attempts === 0) {
      attempts += 1
      return false
    }
    return original(name, value)
  }

  const result = await trash.move(['s1'])
  assert.equal(result.refused[0].code, 'index_write_failed')
  assert.match(result.refused[0].message, /rolled back/)
  assert.equal(fs.readFileSync(path.join(dir, 'session.log'), 'utf8'), 'payload', 'the session is back where it was')
  assert.equal(fs.existsSync(path.join(trashRoot, 's1')), false)
  assert.equal(fs.existsSync(path.join(dataDir, TRASH_INDEX_FILE)), false)
  assert.deepEqual(trash.list(), [])
})

test('a failed rollback keeps the moved directory reachable from the trash', async (t) => {
  const { dataDir, trashRoot, store, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  const original = store.writeDoc.bind(store)
  let attempts = 0
  store.writeDoc = (name, value) => {
    if (name === TRASH_INDEX_FILE && attempts === 0) {
      attempts += 1
      return false
    }
    return original(name, value)
  }
  const fsImpl = new Proxy(fs, {
    get(target, key) {
      if (key === 'renameSync') {
        return (from, to) => {
          if (String(from).startsWith(trashRoot)) {
            const error = new Error('EACCES: permission denied')
            error.code = 'EACCES'
            throw error
          }
          return target.renameSync(from, to)
        }
      }
      return Reflect.get(target, key)
    },
  })
  const trash = makeTrash({ fs: fsImpl })

  const result = await trash.move(['s1'])
  assert.equal(result.refused[0].code, 'index_write_failed')
  assert.ok(result.refused[0].message.includes(path.join(trashRoot, 's1')), 'the message says where the data is')
  assert.equal(fs.existsSync(dir), false)
  assert.equal(fs.existsSync(path.join(trashRoot, 's1')), true)
  assert.deepEqual(trash.list().map((item) => item.sessionId), ['s1'], 'the in-memory record keeps the data reachable')
  assert.equal(fs.existsSync(path.join(dataDir, TRASH_INDEX_FILE)), false, 'the index was never written to disk')
})

test('a failed trash.json write rolls a restore back', async (t) => {
  const { trashRoot, store, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'payload')
  const trash = makeTrash()
  await trash.move(['s1'])

  const original = store.writeDoc.bind(store)
  let attempts = 0
  store.writeDoc = (name, value) => {
    if (name === TRASH_INDEX_FILE && attempts === 0) {
      attempts += 1
      return false
    }
    return original(name, value)
  }

  const result = await trash.restore(['s1'])
  assert.equal(result.refused[0].code, 'index_write_failed')
  assert.equal(fs.existsSync(dir), false, 'the restore was rolled back into the trash')
  assert.equal(fs.readFileSync(path.join(trashRoot, 's1', 'session.log'), 'utf8'), 'payload')
  assert.equal(trash.list().length, 1)
})

test('a legacy trash.json written with the source field still restores', async (t) => {
  const { dataDir, addSession, makeTrash } = setup(t)
  const dir = addSession('s1', 'legacy payload')
  const trashRoot = path.join(dataDir, 'trash')
  fs.mkdirSync(trashRoot, { recursive: true })
  fs.renameSync(dir, path.join(trashRoot, 's1'))
  fs.writeFileSync(
    path.join(dataDir, TRASH_INDEX_FILE),
    JSON.stringify({
      schema: 1,
      items: { s1: { sessionId: 's1', title: 'old', cwd: '/work/s1', source: dir, deletedAt: new Date().toISOString() } },
    }),
  )
  const trash = makeTrash()

  assert.equal(trash.list()[0].tombstone, false, 'a legacy entry is a real entry, not a tombstone')
  const restored = await trash.restore(['s1'])
  assert.deepEqual(restored.restored, ['s1'])
  assert.equal(fs.readFileSync(path.join(dir, 'session.log'), 'utf8'), 'legacy payload')
})

test('the trash index survives a service restart', async (t) => {
  const { addSession, makeTrash } = setup(t)
  addSession('s1')
  const first = makeTrash()
  await first.move(['s1'])

  const second = makeTrash()
  assert.deepEqual(second.list().map((item) => item.sessionId), ['s1'])
  assert.equal(second.list()[0].title, 'title s1')
})

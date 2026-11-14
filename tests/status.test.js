import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatusIndexer, STATUS_INDEX_FILE, STATUS_INDEX_SCHEMA } from '../host/status.js'

const silent = { warn() {}, error() {}, debug() {}, info() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeStore(initialDocs = {}) {
  const docs = new Map()
  for (const [name, value] of Object.entries(initialDocs)) docs.set(name, JSON.parse(JSON.stringify(value)))
  const writes = []
  const store = {
    dataDir: '/nonexistent/session-manager-status-test',
    docs,
    writes,
    failNextWrites: 0,
    readDoc(name, fallback) {
      return docs.has(name) ? JSON.parse(JSON.stringify(docs.get(name))) : fallback
    },
    writeDoc(name, value) {
      if (store.failNextWrites > 0) {
        store.failNextWrites -= 1
        writes.push({ name, failed: true })
        return false
      }
      const copy = JSON.parse(JSON.stringify(value))
      docs.set(name, copy)
      writes.push({ name, value: copy })
      return true
    },
  }
  return store
}

function fakeSessions(rows, options = {}) {
  const revisions = new Map()
  const delay = options.delay ?? 5
  const factsCalls = []
  let active = 0
  let peak = 0
  const sessions = {
    revisions,
    factsCalls,
    get peak() {
      return peak
    },
    setRevision(id, revision) {
      revisions.set(id, revision)
    },
    async list() {
      if (options.listError) throw new Error(options.listError)
      return rows.map((row) => ({ ...row }))
    },
    async exists(id) {
      return rows.some((row) => row.id === id)
    },
    async statOf(id) {
      await sleep(1)
      return { revision: revisions.get(id) ?? 1, eventCount: 30, location: { path: '/data/' + id + '/session.log' } }
    },
    async factsOf(id, opts) {
      factsCalls.push({ id, tailEvents: opts?.tailEvents })
      active += 1
      peak = Math.max(peak, active)
      try {
        await sleep(delay)
      } finally {
        active -= 1
      }
      if (options.factsError === id) return { error: 'unreadable log' }
      return {
        title: 'title ' + id,
        titleSource: 'ai',
        firstMessage: 'first message of ' + id + ' ' + 'x'.repeat(600),
        lastTurnEnd: id === 'broken' ? 'error' : 'completed',
        lastTurnEndAt: 111,
        revision: revisions.get(id) ?? 1,
      }
    },
  }
  return sessions
}

async function waitIdle(indexer, timeout = 5000) {
  const started = Date.now()
  while (indexer.status().running) {
    if (Date.now() - started > timeout) throw new Error('the indexer never became idle')
    await sleep(5)
  }
}

test('the first pass indexes every non-blank session and caches its facts', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([
    { id: 'a', updatedAt: 3 },
    { id: 'b', updatedAt: 2 },
    { id: 'blank', blank: true, updatedAt: 1 },
  ])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2, tailEvents: 80 } } })

  const started = indexer.start()
  assert.equal(started.started, true)
  await waitIdle(indexer)

  const state = indexer.status()
  assert.equal(state.running, false)
  assert.equal(state.total, 2)
  assert.equal(state.processed, 2)
  assert.equal(state.lastError, null)
  assert.ok(typeof state.startedAt === 'number')
  assert.ok(typeof state.finishedAt === 'number')

  assert.deepEqual(sessions.factsCalls.map((call) => call.id).sort(), ['a', 'b'])
  assert.deepEqual(
    sessions.factsCalls.map((call) => call.tailEvents),
    [80, 80],
    'the tail bound comes from settings.status.tailEvents',
  )

  const row = indexer.rowOf('a')
  assert.equal(row.title, 'title a')
  assert.equal(row.titleSource, 'ai')
  assert.equal(row.lastTurnEnd, 'completed')
  assert.equal(row.lastTurnEndAt, 111)
  assert.equal(row.revision, 1)
  assert.equal(row.firstMessage.length, 400, 'only the first 400 characters of the first message are cached')
  assert.ok(Number.isFinite(row.indexedAt))
  assert.equal(indexer.rowOf('blank'), null, 'a blank session has no facts to index')
  assert.equal(indexer.rowOf('missing'), null)
  assert.equal(indexer.rowOf(undefined), null)

  const cached = store.docs.get(STATUS_INDEX_FILE)
  assert.equal(cached.schema, STATUS_INDEX_SCHEMA)
  assert.deepEqual(Object.keys(cached.sessions).sort(), ['a', 'b'])
  assert.equal(cached.sessions.a.title, 'title a')
})

test('unchanged revisions are served from the cache; only changed ones are re-read', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })

  indexer.start()
  await waitIdle(indexer)
  assert.equal(sessions.factsCalls.length, 3)

  const startedAgain = indexer.start()
  assert.equal(startedAgain.started, true)
  await waitIdle(indexer)
  assert.equal(sessions.factsCalls.length, 3, 'a second pass re-reads nothing when no revision moved')

  sessions.setRevision('b', 99)
  indexer.start()
  await waitIdle(indexer)
  assert.deepEqual(sessions.factsCalls.slice(3).map((call) => call.id), ['b'])
})

test('force re-reads every session even when the revisions match', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }, { id: 'b' }])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })

  indexer.start()
  await waitIdle(indexer)
  const before = sessions.factsCalls.length

  indexer.start({ force: true })
  await waitIdle(indexer)
  assert.equal(sessions.factsCalls.length - before, 2)
})

test('the cache survives a restart: a fresh indexer reads no log at all', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }, { id: 'b' }])
  const first = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })
  first.start()
  await waitIdle(first)

  const second = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })
  assert.equal(second.rowOf('a').title, 'title a', 'cached rows are readable before any pass runs')
  assert.equal(second.rowOf('a').lastTurnEnd, 'completed')
  await second.ensure(['a', 'b'])
  assert.equal(sessions.factsCalls.length, 2, 'ensure() trusts the cached revision')
})

test('a pass never exceeds settings.status.concurrency reads in flight', async () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: 's' + index }))
  const store = fakeStore()
  const sessions = fakeSessions(rows, { delay: 10 })
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 3 } } })

  indexer.start()
  await waitIdle(indexer)
  assert.equal(sessions.factsCalls.length, 9)
  assert.equal(sessions.peak, 3)

  const serialStore = fakeStore()
  const serialSessions = fakeSessions(rows, { delay: 5 })
  const serial = createStatusIndexer({ store: serialStore, sessions: serialSessions, logger: silent, settings: { status: { concurrency: 1 } } })
  serial.start()
  await waitIdle(serial)
  assert.equal(serialSessions.peak, 1)
})

test('stop() halts the pass, drops the queue and reports idle at once', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: 's' + index }))
  const store = fakeStore()
  const sessions = fakeSessions(rows, { delay: 20 })
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 1 } } })

  indexer.start()
  await sleep(30)
  indexer.stop()

  assert.equal(indexer.status().running, false, 'a stopped indexer reports idle immediately')
  assert.ok(indexer.status().processed < indexer.status().total, 'the pass did not finish')

  const callsAtStop = sessions.factsCalls.length
  await sleep(80)
  assert.equal(sessions.factsCalls.length, callsAtStop, 'queued sessions are never read after stop()')
  assert.equal(indexer.rowOf('s9'), null)
})

test('a failed index write is reported by lastError and recovered on the next pass', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }, { id: 'b' }])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })

  store.failNextWrites = 1
  indexer.start()
  await waitIdle(indexer)
  assert.match(String(indexer.status().lastError), /status index/i)
  assert.equal(store.docs.has(STATUS_INDEX_FILE), false, 'nothing was persisted')
  assert.equal(indexer.rowOf('a').title, 'title a', 'the in-memory row still answers')

  indexer.start()
  await waitIdle(indexer)
  assert.equal(indexer.status().lastError, null)
  assert.equal(store.docs.has(STATUS_INDEX_FILE), true, 'the retry persisted the cache')
})

test('one unreadable session is skipped without failing the whole pass', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }, { id: 'bad' }, { id: 'b' }], { factsError: 'bad' })
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })

  indexer.start()
  await waitIdle(indexer)
  assert.match(String(indexer.status().lastError), /unreadable log/i)
  assert.equal(indexer.status().processed, 3)
  assert.equal(indexer.rowOf('bad'), null)
  assert.equal(indexer.rowOf('a').title, 'title a')
  assert.equal(indexer.rowOf('b').title, 'title b')
})

test('a completed pass prunes entries for sessions that disappeared', async () => {
  const store = fakeStore({
    [STATUS_INDEX_FILE]: {
      schema: STATUS_INDEX_SCHEMA,
      sessions: {
        gone: { revision: 1, lastTurnEnd: 'error', lastTurnEndAt: 1, title: 'old', titleSource: null, firstMessage: '', indexedAt: 1 },
        a: { revision: 0, lastTurnEnd: null, lastTurnEndAt: null, title: 'stale', titleSource: null, firstMessage: '', indexedAt: 1 },
      },
    },
  })
  const sessions = fakeSessions([{ id: 'a' }])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 1 } } })

  indexer.start()
  await waitIdle(indexer)
  assert.equal(indexer.rowOf('gone'), null)
  assert.equal(indexer.rowOf('a').title, 'title a')
  assert.deepEqual(Object.keys(store.docs.get(STATUS_INDEX_FILE).sessions), ['a'])
})

test('a failing session list is reported and leaves the cache untouched', async () => {
  const store = fakeStore({
    [STATUS_INDEX_FILE]: {
      schema: STATUS_INDEX_SCHEMA,
      sessions: { a: { revision: 1, lastTurnEnd: 'completed', lastTurnEndAt: 2, title: 'kept', titleSource: null, firstMessage: '', indexedAt: 3 } },
    },
  })
  const sessions = fakeSessions([], { listError: 'boom' })
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 1 } } })

  indexer.start()
  await waitIdle(indexer)
  assert.match(String(indexer.status().lastError), /boom/)
  assert.equal(indexer.rowOf('a').title, 'kept', 'an empty corpus never wipes the index')
  assert.equal(indexer.status().total, 0)
})

test('ensure() indexes the requested ids on demand, dedupes and counts no pass progress', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }, { id: 'b' }], { delay: 20 })
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 2 } } })

  await Promise.all([indexer.ensure(['a', 'a', 'b']), indexer.ensure(['b'])])
  assert.equal(sessions.factsCalls.length, 2)
  assert.equal(indexer.rowOf('a').title, 'title a')
  assert.equal(indexer.status().running, false)
  assert.equal(indexer.status().total, 0, 'ensure() is not a pass')
  assert.equal(indexer.status().processed, 0)

  await indexer.ensure([])
  await indexer.ensure(undefined)
  assert.equal(sessions.factsCalls.length, 2)
})

test('a disabled indexer refuses background passes but still answers ensure()', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { enabled: false, concurrency: 2 } } })

  assert.deepEqual(indexer.start(), { started: false, running: false })
  assert.equal(sessions.factsCalls.length, 0)

  await indexer.ensure(['a'])
  assert.equal(indexer.rowOf('a').title, 'title a')
})

test('start() while a pass is running is a no-op that reports running', async () => {
  const store = fakeStore()
  const sessions = fakeSessions([{ id: 'a' }, { id: 'b' }], { delay: 30 })
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 1 } } })

  assert.equal(indexer.start().started, true)
  assert.deepEqual(indexer.start(), { started: false, running: true })
  await waitIdle(indexer)
  assert.equal(indexer.start().started, true)
  await waitIdle(indexer)
})

test('a corrupt or foreign cache document is ignored, not trusted', async () => {
  const store = fakeStore({
    [STATUS_INDEX_FILE]: { schema: 99, sessions: { a: { revision: 1, lastTurnEnd: 'error', title: 'wrong' } } },
  })
  const sessions = fakeSessions([{ id: 'a' }])
  const indexer = createStatusIndexer({ store, sessions, logger: silent, settings: { status: { concurrency: 1 } } })

  assert.equal(indexer.rowOf('a'), null)
  indexer.start()
  await waitIdle(indexer)
  assert.equal(sessions.factsCalls.length, 1)
  assert.equal(indexer.rowOf('a').title, 'title a')
  assert.equal(store.docs.get(STATUS_INDEX_FILE).schema, STATUS_INDEX_SCHEMA)
})

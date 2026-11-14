import assert from 'node:assert/strict'
import test from 'node:test'

import { createApi, createJobHandlers, API_PREFIX, HttpError, toResponse } from '../host/api.js'
import { emptySession, normalizeTags } from '../host/store.js'
import { createFakeJobs } from './helpers/fake-jobs.js'

function fakeStore() {
  const records = new Map()
  const store = {
    state: { schema: 1 },
    version: 7,
    settings: { ai: { batchSize: 8 }, status: { tailEvents: 120 } },
    sessionOf(id) {
      if (!records.has(id)) records.set(id, emptySession())
      return records.get(id)
    },
    patchSession(id, patch) {
      const next = { ...store.sessionOf(id), ...patch }
      records.set(id, next)
      store.version += 1
      return next
    },
    tagDefs: () => [{ name: 'bug', source: 'manual' }],
    rules: () => [{ id: 'r-1', name: 'rule' }],
    persisted: 0,
    async persistNow() {
      store.persisted += 1
    },
    records,
  }
  return store
}

function fakeSessions(rows) {
  const renamed = []
  const archived = []
  return {
    renamed,
    archived,
    async list() {
      return rows
    },
    async rename(id, title) {
      renamed.push({ id, title })
      return { sessionId: id, title }
    },
    async archive(ids, options) {
      archived.push({ ids, options })
      return { archived: ids, refused: [] }
    },
    async unarchive(ids) {
      return { unarchived: ids, refused: [] }
    },
  }
}

const rows = [
  { id: 's1', updatedAt: 300, running: false, blank: false, cwd: '/repo/a', archived: false, pinned: false, origin: 'user' },
  { id: 's2', updatedAt: 200, running: true, blank: false, cwd: '/repo/a', archived: true, pinned: false, origin: 'user' },
  { id: 's3', updatedAt: 100, running: false, blank: false, cwd: '/repo/a', archived: false, pinned: false, origin: 'subagent', parentSessionId: 's1' },
  // A fork carries parentSessionId too, but the native sidebar lists it: only
  // origin === 'subagent' hides a Session (AIDEV-161).
  { id: 's4', updatedAt: 400, running: false, blank: false, cwd: '/repo/a', archived: false, pinned: false, parentSessionId: 's1' },
]

/** AI service stub whose hooks drive job progress the way host/ai.js does. */
function fakeAi() {
  const calls = { previewRename: [], applyRename: [], previewTags: [] }
  return {
    calls,
    available: () => ({ ok: true, model: 'test/model' }),
    async previewRename({ sessionIds, hooks }) {
      calls.previewRename.push([...sessionIds])
      hooks?.onTotal?.(sessionIds.length)
      const items = sessionIds.map((id) => ({ sessionId: id, currentTitle: '旧', proposed: '新 ' + id, reason: '依据', skipReason: null }))
      for (const item of items) hooks?.onItem?.(item)
      return { items, model: 'test/model' }
    },
    async applyRename({ items, hooks }) {
      calls.applyRename.push(items)
      const applied = items.map((item) => ({ sessionId: item.sessionId, title: item.title }))
      for (const item of applied) hooks?.onItem?.({ ...item, code: null })
      return { applied, failed: [] }
    },
    async previewTags({ sessionIds, hooks }) {
      calls.previewTags.push([...sessionIds])
      hooks?.onTotal?.(sessionIds.length)
      const items = sessionIds.map((id) => ({ sessionId: id, suggestions: ['bug'], intent: '开发', reason: null, skipReason: null }))
      for (const item of items) hooks?.onItem?.(item)
      return { items, vocabulary: ['bug'], model: 'test/model' }
    },
    async applyTags({ items }) {
      return { applied: items.map((item) => ({ ...item })), failed: [] }
    },
  }
}

function build(overrides = {}) {
  const store = overrides.store ?? fakeStore()
  const sessions = overrides.sessions ?? fakeSessions(rows)
  const statusIndex = {
    started: [],
    start(options) {
      this.started.push(options)
      return { started: true, running: true }
    },
    status: () => ({ running: false, processed: 1, total: 3 }),
    rowOf: (id) => (id === 's1' ? { lastTurnEnd: 'blocked', lastTurnEndAt: 1, title: '会话一', firstMessage: 'hi', indexedAt: 2 } : null),
  }
  const tagService = overrides.tags ?? {
    apply: ({ sessionIds, op, tags }) => ({ updated: sessionIds.length, tagDefs: [{ name: tags[0] ?? '', op }] }),
    fillMissing: ({ dryRun, hooks }) => {
      hooks?.onTotal?.(1)
      hooks?.onItem?.({ sessionId: 's1', title: '会话一', tags: ['bug'], updated: !dryRun, reason: dryRun ? 'dry_run' : null })
      return { candidates: [{ sessionId: 's1', title: '会话一', tags: ['bug'] }], updated: dryRun ? 0 : 1, dryRun }
    },
  }
  const aiService = overrides.ai ?? { available: () => ({ ok: false, reason: 'no model route' }) }
  const jobs = overrides.jobs ?? createFakeJobs(createJobHandlers({ ai: aiService, tags: tagService, store }))
  const api = createApi({
    store,
    sessions,
    statusIndex,
    tags: tagService,
    rules: {
      save: (input) => ({ id: input.id ?? 'r-new', ...input }),
      preview: () => ({ matches: [], scanned: 0 }),
      apply: () => ({ suggested: 0, updated: 0, sessions: [] }),
      remove: () => true,
    },
    ai: aiService,
    trash: { list: () => [], move: (ids) => ({ trashed: ids, refused: [] }), restore: (ids) => ({ restored: ids, refused: [] }) },
    jobs,
    meta: { version: '9.9.9' },
    workspaceLabel: (cwd) => (cwd === '/repo/a' ? '仓库 A' : null),
  })
  return { api, store, sessions, statusIndex, jobs, ai: aiService }
}

/** Call through the wire adapter so the status code (202 for jobs) is visible. */
const callSafe = (api, method, tail, body, query = {}) =>
  api.routeSafe({ method, pathname: API_PREFIX + tail, body, query })

const settle = (job) => job.__done ?? Promise.resolve(job)

const call = (api, method, tail, body, query = {}) =>
  api.route({ method, pathname: API_PREFIX + tail, body, query })

test('root reports prefix and version', async () => {
  const { api } = build()
  const value = await call(api, 'GET', '/')
  assert.equal(value.meta.prefix, API_PREFIX)
  assert.equal(value.meta.version, '9.9.9')
})

test('state exposes settings, rules and indexing', async () => {
  const { api } = build()
  const value = await call(api, 'GET', '/state')
  assert.equal(value.version, 7)
  assert.equal(value.rules.length, 1)
  assert.equal(value.indexing.total, 3)
  assert.equal(value.ai.ok, false)
})

test('sessions hides archived and subagent rows by default and decorates titles', async () => {
  const { api } = build()
  const value = await call(api, 'GET', '/sessions')
  assert.deepEqual(value.rows.map((row) => row.id), ['s1', 's4'], 'the fork is listed; the origin-subagent is not')
  assert.equal(value.rows[0].title, '会话一')
  assert.equal(value.rows[0].workspaceTitle, '仓库 A')
  assert.equal(value.rows[0].lastTurnEnd, 'blocked')
})

test('sessions can include archived and subagent rows', async () => {
  const { api } = build()
  const value = await call(api, 'GET', '/sessions', undefined, { includeArchived: '1', includeSubagents: 'true' })
  assert.deepEqual(value.rows.map((row) => row.id), ['s1', 's2', 's3', 's4'])
  assert.equal(value.rows[2].subagent, true)
  assert.equal(value.rows[3].subagent, false, 'a forked Session is a first-class row')
})

test('a forked Session is listed even without subagents (AIDEV-161)', async () => {
  const { api } = build()
  const value = await call(api, 'GET', '/sessions')
  assert.ok(value.rows.some((row) => row.id === 's4'), 'the fork must not be dropped as a subagent')
  assert.ok(!value.rows.some((row) => row.id === 's3'), 'origin subagent stays behind the toggle')
})

test('session-meta answers the batch probe the native rows use', async () => {
  const { api, store } = build()
  store.patchSession('s1', { tags: ['bug'], note: '备注' })
  const value = await call(api, 'GET', '/session-meta', undefined, { ids: 's1,s2,missing' })
  assert.equal(value.items.s1.lastTurnEnd, 'blocked')
  assert.deepEqual(value.items.s1.tags, ['bug'])
  assert.equal(value.items.s1.note, '备注')
  assert.equal(value.items.s2.running, true)
  assert.equal(value.items.s2.archived, true)
  assert.equal(value.items.missing, undefined, 'unknown ids are simply absent')
})

test('session-meta validates its ids', async () => {
  const { api } = build()
  await assert.rejects(() => call(api, 'GET', '/session-meta', undefined, {}), (error) => error.status === 400)
  await assert.rejects(() => call(api, 'GET', '/session-meta', undefined, { ids: ',' }), (error) => error.status === 400)
  const many = Array.from({ length: 301 }, (_, index) => 'id-' + index).join(',')
  await assert.rejects(() => call(api, 'GET', '/session-meta', undefined, { ids: many }), (error) => error.status === 400)
})

test('unindexed sessions start the indexer without blocking the response', async () => {
  const { api, statusIndex } = build()
  await call(api, 'GET', '/sessions', undefined, { includeArchived: '1', includeSubagents: '1' })
  assert.equal(statusIndex.started.length, 1)
})

test('tag endpoint validates the operation and normalizes input', async () => {
  const { api } = build()
  await assert.rejects(() => call(api, 'POST', '/tags', { sessionIds: [], op: 'append', tags: ['x'] }), (error) => error.status === 400)
  await assert.rejects(() => call(api, 'POST', '/tags', { sessionIds: ['s1'], op: 'nope' }), (error) => error.status === 400)
  const value = await call(api, 'POST', '/tags', { sessionIds: ['s1'], op: 'append', tags: [' bug '] })
  assert.equal(value.updated, 1)
})

test('manual rename pins the title and records titleSource', async () => {
  const { api, sessions, store } = build()
  const value = await call(api, 'POST', '/rename', { sessionId: 's1', title: '新标题' })
  assert.equal(value.title, '新标题')
  assert.equal(value.titleLocked, true)
  assert.deepEqual(sessions.renamed, [{ id: 's1', title: '新标题' }])
  assert.equal(store.records.get('s1').titleLocked, true)
  assert.equal(store.records.get('s1').titleSource, 'manual')
})

test('notes are capped and stored', async () => {
  const { api, store } = build()
  await call(api, 'POST', '/notes', { sessionId: 's1', note: '记得回看' })
  assert.equal(store.records.get('s1').note, '记得回看')
})

test('archive defaults to stopping activity and can refuse to stop', async () => {
  const { api, sessions } = build()
  await call(api, 'POST', '/archive', { sessionIds: ['s2'] })
  await call(api, 'POST', '/archive', { sessionIds: ['s2'], stopActivity: false })
  assert.equal(sessions.archived[0].options.stopActivity, true)
  assert.equal(sessions.archived[1].options.stopActivity, false)
})

test('ai routes answer 503 llm_unavailable when no model route exists', async () => {
  const { api } = build()
  await assert.rejects(
    () => call(api, 'POST', '/ai/rename/preview', { sessionIds: ['s1'] }),
    (error) => error.status === 503 && error.code === 'llm_unavailable',
  )
})

test('unknown routes and wrong methods are rejected', async () => {
  const { api } = build()
  await assert.rejects(() => call(api, 'GET', '/nope'), (error) => error.status === 404)
  await assert.rejects(() => call(api, 'DELETE', '/state'), (error) => error.status === 405)
  await assert.rejects(() => api.route({ method: 'GET', pathname: '/elsewhere' }), (error) => error.status === 404)
})

test('toResponse maps http and domain errors onto the wire envelope', () => {
  assert.deepEqual(toResponse(new HttpError(400, 'invalid', 'nope')), { status: 400, body: { error: { code: 'invalid', message: 'nope' } } })
  const conflict = toResponse(Object.assign(new Error('busy'), { code: 'running' }))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'running')
  const internal = toResponse(new Error('boom'))
  assert.equal(internal.status, 500)
  assert.equal(internal.body.error.code, 'internal')
})

test('normalizeTags keeps the first spelling and drops duplicates', () => {
  assert.deepEqual(normalizeTags([' Bug ', 'bug', '#华为', '']), ['Bug', '华为'])
})

test('slower operations answer 202 with a job instead of blocking the request', async () => {
  const { api } = build()
  const response = await callSafe(api, 'POST', '/tags/fill-missing', { dryRun: true })
  assert.equal(response.status, 202)
  assert.equal(response.body.job.type, 'tags.fillMissing')
  assert.equal(response.body.job.state, 'running')
})

test('fill-missing job reports per-session progress and its result', async () => {
  const { api } = build()
  const created = await callSafe(api, 'POST', '/tags/fill-missing', { dryRun: false })
  const job = await settle(created.body.job)
  assert.equal(job.state, 'succeeded')
  assert.equal(job.percent, 100)
  assert.equal(job.total, 1)
  assert.equal(job.done, 1)
  assert.equal(job.items.length, 1)
  assert.equal(job.items[0].key, 's1')
  assert.equal(job.items[0].state, 'done')
  assert.equal(job.result.updated, 1)
  assert.equal(job.result.dryRun, false)
})

test('AI preview creates a job whose items mirror the preview', async () => {
  const ai = fakeAi()
  const { api, jobs } = build({ ai })
  const created = await callSafe(api, 'POST', '/ai/rename/preview', { sessionIds: ['s1'], readContent: true })
  assert.equal(created.status, 202)
  const job = await settle(created.body.job)
  assert.equal(job.type, 'ai.rename')
  assert.equal(job.state, 'succeeded')
  assert.equal(job.result.items[0].proposed, '新 s1')
  assert.deepEqual(job.params, { sessionIds: ['s1'], readContent: true })
  assert.equal(job.items[0].data.sessionId, 's1')
  assert.equal(jobs.activeCount(), 0)
})

test('rename apply runs as a job and keeps the applied items on the result', async () => {
  const ai = fakeAi()
  const { api, store } = build({ ai })
  const created = await callSafe(api, 'POST', '/ai/rename/apply', { items: [{ sessionId: 's1', title: '新标题' }] })
  assert.equal(created.status, 202)
  const job = await settle(created.body.job)
  assert.equal(job.type, 'rename.apply')
  assert.deepEqual(job.result.applied, [{ sessionId: 's1', title: '新标题' }])
  assert.equal(ai.calls.applyRename.length, 1)
  assert.ok(store.persisted >= 1, 'the apply job persisted the store')
})

test('job routes list, fetch and cancel by id', async () => {
  const { api } = build()
  const created = await callSafe(api, 'POST', '/tags/fill-missing', { dryRun: true })
  const id = created.body.job.id
  await settle(created.body.job)

  const fetched = await callSafe(api, 'GET', '/jobs/' + id)
  assert.equal(fetched.status, 200)
  assert.equal(fetched.body.job.id, id)
  assert.ok(Array.isArray(fetched.body.job.items))

  const withoutItems = await callSafe(api, 'GET', '/jobs/' + id, undefined, { items: '0' })
  assert.equal(withoutItems.body.job.items, undefined)

  const listed = await callSafe(api, 'GET', '/jobs')
  assert.equal(listed.body.jobs.length, 1)
  const active = await callSafe(api, 'GET', '/jobs', undefined, { active: '1' })
  assert.deepEqual(active.body.jobs, [], 'a settled job is not active')

  const cancelled = await callSafe(api, 'POST', '/jobs/' + id + '/cancel')
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.job.id, id)
})

test('job routes reject unknown ids and unsupported types', async () => {
  const { api } = build()
  const missing = await callSafe(api, 'GET', '/jobs/job-missing')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not_found')
  const missingCancel = await callSafe(api, 'POST', '/jobs/job-missing/cancel')
  assert.equal(missingCancel.status, 404)
  const badType = await callSafe(api, 'POST', '/jobs', { type: 'nope', params: {} })
  assert.equal(badType.status, 400)
  assert.equal(badType.body.error.code, 'invalid')
})

test('POST /jobs is the generic entry point for the four supported types', async () => {
  const ai = fakeAi()
  const { api } = build({ ai })
  const created = await callSafe(api, 'POST', '/jobs', { type: 'ai.tags', params: { sessionIds: ['s1'], mode: 'suggest' } })
  assert.equal(created.status, 202)
  const job = await settle(created.body.job)
  assert.equal(job.type, 'ai.tags')
  assert.equal(job.result.items[0].intent, '开发')
})

test('state advertises active jobs so the panel can badge without polling', async () => {
  const { api } = build()
  const state = await callSafe(api, 'GET', '/state')
  assert.equal(state.body.jobs.active, 0)
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { StateStore } from '../host/store.js'
import { createTagService } from '../host/tags.js'
import { createApi, API_PREFIX } from '../host/api.js'

const silent = { warn() {}, error() {}, debug() {}, info() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-studio-tags-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore({ dataDir: dir, logger: silent })
  store.loadSync()
  return store
}

function fakeSessions(rows, facts = {}) {
  const calls = []
  let active = 0
  let peak = 0
  return {
    calls,
    get peak() {
      return peak
    },
    async list() {
      return rows.map((row) => ({ ...row }))
    },
    async factsOf(id) {
      calls.push(id)
      active += 1
      peak = Math.max(peak, active)
      try {
        await sleep(4)
      } finally {
        active -= 1
      }
      const value = facts[id] ?? {}
      return {
        title: value.title ?? '',
        firstMessage: value.firstMessage ?? '',
        lastTurnEnd: 'completed',
      }
    },
  }
}

test('the /tag-defs route lists, creates, renames and removes vocabulary words', async (t) => {
  const store = makeStore(t)
  store.ensureTagDef('DTS', 'manual')
  store.patchSession('a', { tags: ['DTS'] })
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })
  const api = createApi({
    store, tags, meta: { version: '9.9.9' }, jobs: { active: () => [], rowOf: () => null },
  })
  const call = (method, tail, body) =>
    api.route({ method, pathname: API_PREFIX + tail, body, query: {} })

  const listed = await call('GET', '/tag-defs')
  assert.deepEqual(listed.tagDefs.map((def) => def.name), ['DTS'])
  assert.equal(listed.tagDefs[0].sessions, 1)

  const created = await call('POST', '/tag-defs', { op: 'create', name: '紫霄V3.5' })
  assert.deepEqual(created.tagDefs.map((def) => def.name).sort(), ['DTS', '紫霄V3.5'])

  const renamed = await call('POST', '/tag-defs', { op: 'rename', name: 'DTS', to: 'DTS问题单' })
  assert.equal(renamed.renamed, true)
  assert.equal(renamed.sessions, 1)
  assert.deepEqual(store.sessionOf('a').tags, ['DTS问题单'])

  const removed = await call('POST', '/tag-defs', { op: 'remove', name: '紫霄V3.5' })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.tagDefs.map((def) => def.name), ['DTS问题单'])
  assert.equal(store.dirty, false, 'every write flushes the debounce before the response')

  const statuses = []
  for (const [body, needle] of [
    [{ op: 'nope', name: 'x' }, '"op" must be create, rename or remove'],
    [{ name: 'x' }, '"op" must be create, rename or remove'],
    [{ op: 'create' }, '"name" is required'],
    [{ op: 'rename', name: 'DTS问题单' }, '"to" is required when renaming a tag'],
  ]) {
    await assert.rejects(
      () => call('POST', '/tag-defs', body),
      (error) => { statuses.push(error.status); return error.status === 400 && error.message === needle },
      needle
    )
  }
  assert.deepEqual(statuses, [400, 400, 400, 400])
})

test('append merges per session, dedupes case-insensitively and keeps the first spelling', (t) => {
  const store = makeStore(t)
  store.patchSession('a', { tags: ['Bug'] })
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })

  const result = tags.apply({ sessionIds: ['a', 'b', 'a'], op: 'append', tags: ['bug', ' #华为 ', '华为'] })
  assert.equal(result.updated, 2)
  assert.deepEqual(store.sessionOf('a').tags, ['Bug', '华为'])
  assert.deepEqual(store.sessionOf('b').tags, ['bug', '华为'])
  assert.deepEqual(result.tagDefs.map((def) => def.name).sort(), ['Bug', '华为'])
})

test('replace and clear rewrite plugin state only and count real changes', (t) => {
  const store = makeStore(t)
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })
  store.patchSession('a', { tags: ['x', 'y'] })

  assert.equal(tags.apply({ sessionIds: ['a'], op: 'replace', tags: ['z', 'Z'] }).updated, 1)
  assert.deepEqual(store.sessionOf('a').tags, ['z'])
  assert.equal(tags.apply({ sessionIds: ['a'], op: 'replace', tags: ['z'] }).updated, 0)
  assert.equal(tags.apply({ sessionIds: ['a'], op: 'clear' }).updated, 1)
  assert.deepEqual(store.sessionOf('a').tags, [])
  assert.equal(tags.apply({ sessionIds: ['a'], op: 'clear' }).updated, 0)
  assert.equal(tags.apply({ sessionIds: [], op: 'clear' }).updated, 0)
  assert.equal(tags.apply({ sessionIds: ['a'], op: 'append', tags: [] }).updated, 0)
  assert.deepEqual(store.sessionOf('a').tags, [], 'an empty append never invents tags')
})

test('an unknown operation and a missing store are rejected as StateError', (t) => {
  const store = makeStore(t)
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })
  assert.throws(
    () => tags.apply({ sessionIds: ['a'], op: 'merge', tags: [] }),
    (error) => error.name === 'StateError' && error.code === 'invalid_op',
  )
  assert.throws(
    () => tags.apply({ sessionIds: ['a'], tags: [] }),
    (error) => error.code === 'invalid_op',
  )

  const broken = createTagService({ store: null, sessions: fakeSessions([]), logger: silent })
  assert.throws(() => broken.apply({ sessionIds: ['a'], op: 'append', tags: ['x'] }), (error) => error.code === 'store_unavailable')
})

test('addSuggestions only writes suggestedTags: no tag is created, none is removed', (t) => {
  const store = makeStore(t)
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })
  store.patchSession('a', { tags: ['bug'] })

  assert.deepEqual(tags.addSuggestions('a', ['排查', 'BUG'], 'rule'), ['排查'], 'a suggestion equal to an accepted tag is dropped')
  assert.deepEqual(tags.addSuggestions('a', ['排查', '文档'], 'ai'), ['排查', '文档'])
  assert.deepEqual(store.sessionOf('a').tags, ['bug'])
  assert.deepEqual(store.sessionOf('a').suggestedTags, ['排查', '文档'])

  const many = Array.from({ length: 20 }, (_, index) => 'tag' + index)
  assert.equal(tags.addSuggestions('a', many, 'ai').length, 12, 'suggestions respect the per-session cap')
  assert.throws(() => tags.addSuggestions('', ['x'], 'ai'), (error) => error.code === 'invalid_session')
})

test('replace drops a suggestion that just became a real tag (v0.3.2 double-chip fix)', (t) => {
  const store = makeStore(t)
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })
  store.patchSession('a', { tags: [], suggestedTags: ['华为', '文档'] })

  tags.apply({ sessionIds: ['a'], op: 'replace', tags: ['华为'] })
  assert.deepEqual(store.sessionOf('a').tags, ['华为'])
  assert.deepEqual(store.sessionOf('a').suggestedTags, ['文档'], 'the accepted word leaves the suggestion list')

  tags.apply({ sessionIds: ['a'], op: 'append', tags: ['DTS'] })
  assert.deepEqual(store.sessionOf('a').tags, ['华为', 'DTS'])
  assert.deepEqual(store.sessionOf('a').suggestedTags, ['文档'])
})

test('legacy state files lose their duplicate suggestions on read (v0.3.2)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-studio-tags-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // A file written before v0.3.2: op:'replace' left the accepted word in both lists.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schema: 1,
    sessions: { a: { tags: ['dsh插件'], suggestedTags: ['dsh插件', 'DTS'], note: '', titleLocked: false } },
    tagDefs: { 'dsh插件': { name: 'dsh插件', source: 'manual', createdAt: '2026-11-01T00:00:00.000Z' } },
    rules: [],
  }))
  const store = new StateStore({ dataDir: dir, logger: silent })
  store.loadSync()

  const record = store.sessionOf('a')
  assert.deepEqual(record.tags, ['dsh插件'])
  assert.deepEqual(record.suggestedTags, ['DTS'], 'the greyed-out twin is gone, the unrelated suggestion survives')
  // The read side must not mutate what is on disk.
  assert.deepEqual(store.state.sessions.a.suggestedTags, ['dsh插件', 'DTS'])
})

test('vocabulary reports definitions with their usage counts, most used first', (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')
  store.ensureTagDef('bug', 'rule')
  store.ensureTagDef('闲置', 'ai')
  store.patchSession('a', { tags: ['华为', 'bug'] })
  store.patchSession('b', { tags: ['华为'], suggestedTags: ['bug'] })
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })

  const list = tags.vocabulary()
  assert.deepEqual(list.map((entry) => entry.name), ['华为', 'bug', '闲置'])
  assert.deepEqual(list.map((entry) => entry.sessions), [2, 1, 0])
  assert.deepEqual(list.map((entry) => entry.suggested), [0, 1, 0])
  assert.equal(list[1].source, 'rule')
  assert.equal(list[2].source, 'ai')
})

test('createDef only touches the vocabulary', (t) => {
  const store = makeStore(t)
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })
  assert.equal(tags.createDef('  紫霄V3.5  ').name, '紫霄V3.5')
  assert.deepEqual(store.tagDefs().map((def) => def.name), ['紫霄V3.5'])
  assert.throws(() => tags.createDef('   '), (error) => error.code === 'invalid_tag')
  assert.deepEqual(store.tagDefs().map((def) => def.name), ['紫霄V3.5'], 'a rejected create adds nothing')
})

test('renameDef rewrites sessions, suggestions and rules, and merges onto an existing word', (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')
  store.ensureTagDef('DTS', 'manual')
  store.patchSession('a', { tags: ['华为'], suggestedTags: ['DTS'] })
  store.patchSession('b', { tags: ['dts', '其他'] })
  store.putRule({ id: 'r-1', name: '华为项目', match: { keywords: ['x'], fields: ['title'] }, action: { tags: ['DTS'], mode: 'suggest' } })
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })

  const merged = tags.renameDef('DTS', '华为')
  assert.equal(merged.renamed, true)
  assert.equal(merged.sessions, 2)
  assert.equal(merged.rules, 1)
  assert.deepEqual(store.tagDefs().map((def) => def.name), ['华为'], 'renaming onto an existing word merges the definitions')
  assert.deepEqual(store.sessionOf('a').tags, ['华为'], 'no duplicate tag appears after the merge')
  assert.deepEqual(store.sessionOf('a').suggestedTags, [], 'a suggestion that becomes a tag is dropped')
  assert.deepEqual(store.sessionOf('b').tags, ['华为', '其他'], 'the old spelling is replaced')
  assert.deepEqual(store.rules()[0].action.tags, ['华为'])

  const same = tags.renameDef('华为', '华为')
  assert.equal(same.renamed, false)
  assert.throws(() => tags.renameDef('nope', 'x'), (error) => error.code === 'not_found')
  assert.throws(() => tags.renameDef('华为', '  '), (error) => error.code === 'invalid_tag')
})

test('removeDef deletes the word everywhere and drops rules nothing else would match', (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')
  store.ensureTagDef('保留', 'manual')
  store.patchSession('a', { tags: ['华为', '保留'], suggestedTags: ['华为'] })
  store.putRule({ id: 'r-1', name: 'only huawei', match: { keywords: ['x'], fields: ['title'] }, action: { tags: ['华为'], mode: 'suggest' } })
  store.putRule({ id: 'r-2', name: 'both', match: { keywords: ['y'], fields: ['title'] }, action: { tags: ['华为', '保留'], mode: 'suggest' } })
  const tags = createTagService({ store, sessions: fakeSessions([]), logger: silent })

  const result = tags.removeDef('华为')
  assert.equal(result.removed, true)
  assert.equal(result.sessions, 1)
  assert.equal(result.rules, 2)
  assert.deepEqual(store.tagDefs().map((def) => def.name), ['保留'])
  assert.deepEqual(store.sessionOf('a').tags, ['保留'])
  assert.deepEqual(store.sessionOf('a').suggestedTags, [])
  assert.deepEqual(store.rules().map((rule) => rule.id), ['r-2'], 'a rule with no action tags left is deleted')
  assert.deepEqual(store.rules()[0].action.tags, ['保留'])
  assert.throws(() => tags.removeDef('华为'), (error) => error.code === 'not_found')
})

test('fillMissing dry-run proposes vocabulary tags for untagged sessions and writes nothing', async (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')
  store.ensureTagDef('bug', 'manual')
  store.patchSession('tagged', { tags: ['keep'] })

  const rows = [
    { id: 'a', cwd: '/repo/huawei-bts' },
    { id: 'tagged', cwd: '/repo/huawei' },
    { id: 'blank', blank: true, cwd: '/repo/huawei' },
    { id: 'child', origin: 'subagent', parentSessionId: 'a', cwd: '/repo/huawei' },
    { id: 'archived', archived: true, cwd: '/repo/huawei' },
    { id: 'quiet', cwd: '/repo/other' },
  ]
  const facts = {
    a: { title: '华为 基站 bug 排查', firstMessage: '华为 问题' },
    quiet: { title: '无关话题' },
  }
  const sessions = fakeSessions(rows, facts)
  const tags = createTagService({ store, sessions, logger: silent })

  const result = await tags.fillMissing({ dryRun: true })
  assert.deepEqual(result.candidates.map((candidate) => candidate.sessionId), ['a'])
  assert.deepEqual(result.candidates[0].tags, ['华为', 'bug'])
  assert.equal(result.candidates[0].title, '华为 基站 bug 排查')
  assert.equal(result.updated, 0)
  assert.deepEqual(store.sessionOf('a').suggestedTags, [])
  assert.deepEqual(store.sessionOf('a').tags, [])
  assert.deepEqual(store.sessionOf('tagged').suggestedTags, [])
  assert.deepEqual(store.sessionOf('tagged').tags, ['keep'])
  assert.deepEqual(sessions.calls, ['a', 'quiet'], 'blank, subagent, archived and already-tagged sessions are not read')

  const implicit = await tags.fillMissing()
  assert.equal(implicit.updated, 0)
  assert.deepEqual(implicit.candidates.map((candidate) => candidate.sessionId), ['a'])
  assert.deepEqual(store.sessionOf('a').suggestedTags, [], 'dry-run is the default')
})

test('fillMissing treats a forked Session as first-class, not a subagent (AIDEV-161)', async (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')

  const rows = [
    { id: 'fork', parentSessionId: 'parent', cwd: '/repo/huawei' },
    { id: 'child', origin: 'subagent', parentSessionId: 'parent', cwd: '/repo/huawei' },
  ]
  const sessions = fakeSessions(rows, { fork: { title: '华为 分支排查', firstMessage: '华为 问题' } })
  const tags = createTagService({ store, sessions, logger: silent })

  const result = await tags.fillMissing({ dryRun: true })
  assert.deepEqual(result.candidates.map((candidate) => candidate.sessionId), ['fork'], 'a fork joins the sweep; an origin-subagent does not')
  assert.deepEqual(sessions.calls, ['fork'])
})

test('fillMissing apply writes only suggestedTags, never tags, and is idempotent', async (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')
  store.patchSession('tagged', { tags: ['keep'] })
  const rows = [
    { id: 'a', cwd: '/repo/huawei' },
    { id: 'tagged', cwd: '/repo/huawei' },
  ]
  const sessions = fakeSessions(rows, { a: { title: '华为 排查' }, tagged: { title: '华为' } })
  const tags = createTagService({ store, sessions, logger: silent })

  const first = await tags.fillMissing({ dryRun: false })
  assert.equal(first.updated, 1)
  assert.deepEqual(store.sessionOf('a').suggestedTags, ['华为'])
  assert.deepEqual(store.sessionOf('a').tags, [])
  assert.deepEqual(store.sessionOf('tagged').tags, ['keep'])
  assert.deepEqual(store.sessionOf('tagged').suggestedTags, [], 'a session that already has tags is never touched')

  const second = await tags.fillMissing({ dryRun: false })
  assert.equal(second.updated, 0, 'an already suggested tag is not suggested twice')
  assert.deepEqual(second.candidates, [], 'a proposal that is already pending is not repeated')
  assert.deepEqual(store.sessionOf('a').tags, [])
})

test('fillMissing prefers the cached status index over reading the log again', async (t) => {
  const store = makeStore(t)
  store.ensureTagDef('华为', 'manual')
  const rows = [
    { id: 'indexed', cwd: '/repo' },
    { id: 'cold', cwd: '/repo' },
  ]
  const sessions = fakeSessions(rows, { indexed: { title: 'not used' }, cold: { title: '华为 排查' } })
  const statusIndex = {
    rowOf(id) {
      return id === 'indexed' ? { title: '华为 排查', firstMessage: '华为', lastTurnEnd: 'completed', indexedAt: 1 } : null
    },
  }
  const tags = createTagService({ store, sessions, statusIndex, logger: silent })

  const result = await tags.fillMissing({ dryRun: true })
  assert.deepEqual(result.candidates.map((candidate) => candidate.sessionId).sort(), ['cold', 'indexed'])
  const indexed = result.candidates.find((candidate) => candidate.sessionId === 'indexed')
  assert.equal(indexed.title, '华为 排查')
  assert.deepEqual(sessions.calls, ['cold'], 'only the session the index does not know costs a log read')
})

test('fillMissing with an empty vocabulary proposes nothing and reads no log', async (t) => {
  const store = makeStore(t)
  const rows = [{ id: 'a', cwd: '/repo/huawei' }]
  const sessions = fakeSessions(rows, { a: { title: '华为' } })
  const tags = createTagService({ store, sessions, logger: silent })

  assert.deepEqual(await tags.fillMissing({ dryRun: false }), { candidates: [], updated: 0 })
  assert.deepEqual(sessions.calls, [])
})

test('fillMissing reads facts with a bounded number in flight', async (t) => {
  const store = makeStore(t)
  store.ensureTagDef('bug', 'manual')
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: 's' + index, cwd: '/repo' }))
  const facts = {}
  for (const row of rows) facts[row.id] = { title: 'bug ' + row.id }
  const sessions = fakeSessions(rows, facts)
  const tags = createTagService({ store, sessions, logger: silent })

  const result = await tags.fillMissing({ dryRun: true })
  assert.equal(result.candidates.length, 8)
  assert.equal(sessions.peak, 4)
})

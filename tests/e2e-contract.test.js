/**
 * End-to-end contract gate for the host layer (PRD §8).
 *
 * Every route is exercised through the real router on top of a fake DSH
 * boundary: real store, session source, status index, tags, rules, trash and
 * api; fake session controller / persistence / workspace registry. The last
 * test re-applies the plugin through index.js on the same data directory, which
 * is the strongest "user data survives a restart" check we can run in-process.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import {
  API_PREFIX,
  createFakeCtx,
  createHarness,
  invokeHttp,
  silentLogger,
  waitFor,
  waitForTitles,
} from './helpers/fake-ctx.js'

function tempBase(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-e2e-' + label + '-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return base
}

test('GET /state publishes tag definitions, rules, settings, indexing and AI availability', async (t) => {
  const harness = await createHarness({
    sessions: [{ id: 's1', cwd: '/repo/a', title: '会话一', reason: 'completed', firstMessage: '你好' }],
  })
  t.after(() => harness.dispose())

  const response = await harness.call('GET', '/state')
  assert.equal(response.status, 200)
  const state = response.body
  assert.equal(state.schema, 1)
  assert.ok(Array.isArray(state.tagDefs))
  assert.ok(Array.isArray(state.rules))
  assert.equal(state.settings.status.tailEvents, 120)
  assert.equal(typeof state.indexing.running, 'boolean')
  assert.equal(typeof state.indexing.processed, 'number')
  assert.equal(typeof state.indexing.total, 'number')
  assert.equal(state.ai.ok, false, 'no llm service means AI is advertised as unavailable')

  const missing = await harness.call('GET', '/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not_found')
})

test('GET /sessions hides archived and subagent rows by default and renders indexed facts', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a/child', title: '修登录重试', reason: 'blocked', firstMessage: '登录老是失败' },
      { id: 's2', cwd: '/repo/a', title: '整理文档', reason: 'completed', firstMessage: '帮我整理文档' },
      { id: 's3', cwd: '/repo/b', title: '子任务', reason: 'completed', firstMessage: '内部协作', parentSessionId: 's1', origin: 'subagent' },
    ],
    archivedIds: ['s2'],
    pinnedIds: ['s1'],
  })
  t.after(() => harness.dispose())

  assert.equal(await waitForTitles(harness, ['s1', 's2', 's3']), true, 'the status index must fill every title')

  const plain = await harness.rows()
  assert.equal(plain.status, 200)
  assert.deepEqual(plain.body.rows.map((row) => row.id), ['s1'], 'archived and subagent rows are hidden by default')
  const row = plain.body.rows[0]
  assert.equal(row.title, '修登录重试')
  assert.equal(row.lastTurnEnd, 'blocked')
  assert.equal(row.workspaceTitle, '仓库 A')
  assert.equal(row.pinned, true)
  assert.equal(row.archived, false)
  assert.equal(row.subagent, false)
  assert.notEqual(row.indexedAt, null)
  assert.equal(typeof plain.body.generatedAt, 'number')
  assert.ok(harness.factsCalls.length >= 1, 'facts really came from the log reader')

  const withArchived = await harness.rows({ includeArchived: '1' })
  assert.deepEqual(withArchived.body.rows.map((row) => row.id), ['s1', 's2'])
  assert.equal(withArchived.body.rows[1].archived, true)

  const withSubagents = await harness.rows({ includeSubagents: 'true' })
  assert.deepEqual(withSubagents.body.rows.map((row) => row.id), ['s1', 's3'])
  assert.equal(withSubagents.body.rows[1].subagent, true)

  const all = await harness.rows({ includeArchived: '1', includeSubagents: '1' })
  assert.equal(all.body.rows.length, 3)

  const value = await harness.call('GET', '/sessions/s1/value')
  assert.equal(value.status, 200)
  assert.equal(value.body.id, 's1')
  assert.equal(value.body.title, '修登录重试')
  assert.equal(value.body.firstMessage, '登录老是失败')
})

test('POST /tags applies append, replace and clear, and rows follow the state file', async (t) => {
  const harness = await createHarness({
    sessions: [{ id: 's1', cwd: '/repo/a', title: '会话一', reason: 'completed', firstMessage: '你好' }],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1']), true)

  const append = await harness.call('POST', '/tags', {
    sessionIds: ['s1'],
    op: 'append',
    tags: [' bug ', '#华为', 'BUG'],
  })
  assert.equal(append.status, 200)
  assert.equal(append.body.updated, 1)
  assert.deepEqual(harness.store.sessionOf('s1').tags, ['bug', '华为'], 'tags are trimmed and deduped case-insensitively')
  let rows = await harness.rows()
  assert.deepEqual(rows.body.rows[0].tags, ['bug', '华为'])
  const state = await harness.call('GET', '/state')
  assert.ok(state.body.tagDefs.some((def) => def.name === 'bug'), 'writing a tag registers its definition')

  const replace = await harness.call('POST', '/tags', { sessionIds: ['s1'], op: 'replace', tags: ['文档'] })
  assert.equal(replace.body.updated, 1)
  rows = await harness.rows()
  assert.deepEqual(rows.body.rows[0].tags, ['文档'])

  const clear = await harness.call('POST', '/tags', { sessionIds: ['s1'], op: 'clear' })
  assert.equal(clear.body.updated, 1)
  rows = await harness.rows()
  assert.deepEqual(rows.body.rows[0].tags, [])

  const unknownOp = await harness.call('POST', '/tags', { sessionIds: ['s1'], op: 'merge', tags: ['x'] })
  assert.equal(unknownOp.status, 400)
  assert.equal(unknownOp.body.error.code, 'invalid')

  const noIds = await harness.call('POST', '/tags', { sessionIds: [], op: 'append', tags: ['x'] })
  assert.equal(noIds.status, 400)

  const badIds = await harness.call('POST', '/tags', { sessionIds: 's1', op: 'append', tags: ['x'] })
  assert.equal(badIds.status, 400)
})

test('tags and notes survive re-applying the plugin on the same data directory', async (t) => {
  const base = tempBase(t, 'persist')
  const sessions = [{ id: 's1', cwd: '/repo/a', title: '持久化会话', reason: 'completed', firstMessage: '落盘' }]
  const first = await createHarness({ baseDir: base, sessions })
  t.after(() => first.dispose())
  assert.equal(await waitForTitles(first, ['s1']), true)

  const tagged = await first.call('POST', '/tags', { sessionIds: ['s1'], op: 'append', tags: ['落盘标签'] })
  assert.equal(tagged.status, 200)
  const noted = await first.call('POST', '/notes', { sessionId: 's1', note: '记得回看' })
  assert.equal(noted.status, 200)
  assert.equal(noted.body.session.note, '记得回看')
  assert.equal(await first.waitIdle(), true, 'the index pass must finish so its cache is on disk')

  const rawState = JSON.parse(fs.readFileSync(path.join(first.dataDir, 'state.json'), 'utf8'))
  assert.deepEqual(rawState.sessions.s1.tags, ['落盘标签'], 'state.json holds the tag')
  assert.equal(rawState.sessions.s1.note, '记得回看', 'state.json holds the note')
  assert.equal(fs.existsSync(path.join(first.dataDir, 'status-index.json')), true, 'the index cache is on disk')

  // "Restart": a brand new plugin instance through the real index.js apply().
  const fake = createFakeCtx({ sessions, artifactsRoot: first.artifactsRoot })
  await apply(fake.ctx, { dataDir: first.dataDir, status: { concurrency: 1 } })
  assert.equal(fake.calls.routeRegistrations.length, 1)
  const route = fake.calls.routeRegistrations[0]
  assert.equal(route.path, API_PREFIX)

  const listed = await invokeHttp(route, { method: 'GET', path: '/sessions' })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.rows.length, 1)
  assert.equal(listed.body.rows[0].id, 's1')
  assert.deepEqual(listed.body.rows[0].tags, ['落盘标签'])
  assert.equal(listed.body.rows[0].note, '记得回看')
  assert.equal(listed.body.rows[0].title, '持久化会话', 'the persisted status cache restores the title')
  fake.disposeAll()
})

test('rules: save, preview without writes, apply, then delete', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a', title: '华为 基站 bug', reason: 'completed', firstMessage: '华为 登录失败' },
      { id: 's2', cwd: '/repo/b', title: '整理文档', reason: 'completed', firstMessage: '帮我整理文档' },
    ],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1', 's2']), true)

  const created = await harness.call('POST', '/rules', {
    name: '华为项目',
    match: { keywords: ['华为'], fields: ['title', 'firstMessage', 'cwd', 'note'], mode: 'any' },
    action: { tags: ['华为'], mode: 'suggest' },
  })
  assert.equal(created.status, 200)
  const ruleId = created.body.rule.id
  assert.match(ruleId, /^r-/)
  assert.equal(created.body.rules.length, 1)

  const preview = await harness.call('POST', '/rules/preview', { rule: created.body.rule })
  assert.equal(preview.status, 200)
  assert.deepEqual(preview.body.matches.map((match) => match.sessionId), ['s1'])
  assert.equal(preview.body.matches[0].title, '华为 基站 bug')
  assert.equal(preview.body.scanned, 2)
  assert.deepEqual(harness.store.sessionOf('s1').suggestedTags, [], 'preview writes no suggestions')
  assert.deepEqual(harness.store.sessionOf('s1').tags, [], 'preview writes no tags')

  const suggested = await harness.call('POST', '/rules/apply', { ruleId })
  assert.equal(suggested.status, 200)
  assert.equal(suggested.body.suggested, 1)
  assert.equal(suggested.body.updated, 0)
  assert.deepEqual(harness.store.sessionOf('s1').suggestedTags, ['华为'])
  assert.deepEqual(harness.store.sessionOf('s1').tags, [])
  assert.deepEqual((await harness.rows()).body.rows.find((row) => row.id === 's1').suggestedTags, ['华为'])

  const applied = await harness.call('POST', '/rules/apply', { ruleId, mode: 'apply' })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.updated, 1)
  assert.deepEqual(harness.store.sessionOf('s1').tags, ['华为'])

  const removed = await harness.call('DELETE', '/rules/' + ruleId)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.removed, true)
  assert.deepEqual(removed.body.rules, [])

  const invalid = await harness.call('POST', '/rules', { name: '坏规则', match: { keywords: [] }, action: { tags: ['x'] } })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_rule')
})

test('POST /tags/fill-missing previews, then fills only zero-tag sessions', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a', title: '华为 基站排查', reason: 'completed', firstMessage: '华为 问题' },
      { id: 's2', cwd: '/repo/a', title: '华为 文档', reason: 'completed', firstMessage: '华为 文档' },
      { id: 's3', cwd: '/repo/b', title: '华为 子任务', reason: 'completed', firstMessage: '华为 内部', parentSessionId: 's1', origin: 'subagent' },
      { id: 's4', cwd: '/repo/b', title: '华为 旧会话', reason: 'completed', firstMessage: '华为 归档' },
      { id: 's5', cwd: '/repo/b', title: '普通会话', reason: 'completed', firstMessage: '无关内容' },
    ],
    archivedIds: ['s4'],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1', 's2', 's3', 's4', 's5']), true)

  const seeded = await harness.call('POST', '/tags', { sessionIds: ['s2'], op: 'append', tags: ['华为'] })
  assert.equal(seeded.body.updated, 1)

  const dry = await harness.call('POST', '/tags/fill-missing', { dryRun: true })
  assert.equal(dry.status, 202, 'fill-missing is a background job now')
  assert.equal(dry.body.job.type, 'tags.fillMissing')
  const dryJob = await harness.waitJob(dry.body.job.id)
  assert.equal(dryJob.state, 'succeeded')
  const dryResult = dryJob.result
  assert.deepEqual(dryResult.candidates.map((candidate) => candidate.sessionId), ['s1'], 'subagents, archived and already-tagged sessions are skipped')
  assert.deepEqual(dryResult.candidates[0].tags, ['华为'])
  assert.equal(dryResult.updated, 0)
  assert.equal(dryJob.items.length, 2, 'the job records one outcome per zero-tag session')
  assert.equal(dryJob.items.find((item) => item.key === 's1').state, 'skipped', 'a dry run changes nothing')
  assert.equal(dryJob.items.find((item) => item.key === 's5').state, 'skipped')
  assert.deepEqual(harness.store.sessionOf('s1').suggestedTags, [], 'a dry run writes nothing')

  const applied = await harness.call('POST', '/tags/fill-missing', { dryRun: false })
  assert.equal(applied.status, 202)
  const appliedJob = await harness.waitJob(applied.body.job.id)
  assert.equal(appliedJob.state, 'succeeded')
  assert.equal(appliedJob.result.updated, 1)
  assert.deepEqual(harness.store.sessionOf('s1').suggestedTags, ['华为'])
  assert.deepEqual(harness.store.sessionOf('s1').tags, [], 'fill-missing never writes accepted tags')
  assert.deepEqual(harness.store.sessionOf('s2').tags, ['华为'], 'an already tagged session is untouched')
  assert.deepEqual(harness.store.sessionOf('s2').suggestedTags, [])
  assert.deepEqual(harness.store.sessionOf('s5').suggestedTags, [])

  const rows = (await harness.rows({ includeArchived: '1', includeSubagents: '1' })).body.rows
  const row = rows.find((entry) => entry.id === 's1')
  assert.deepEqual(row.suggestedTags, ['华为'])
  assert.deepEqual(row.tags, [])

  const again = await harness.call('POST', '/tags/fill-missing', { dryRun: true })
  const againJob = await harness.waitJob(again.body.job.id)
  assert.deepEqual(againJob.result.candidates, [], 'an already suggested tag is not proposed twice')
})

test('POST /rename renames through the controller and pins the title', async (t) => {
  const harness = await createHarness({
    sessions: [{ id: 's1', cwd: '/repo/a', title: '旧标题', reason: 'completed', firstMessage: 'hi' }],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1']), true)

  const response = await harness.call('POST', '/rename', { sessionId: 's1', title: '  新标题  ' })
  assert.equal(response.status, 200)
  assert.equal(response.body.title, '新标题')
  assert.equal(response.body.titleLocked, true)
  assert.deepEqual(harness.calls.rename, [{ sessionId: 's1', title: '新标题' }], 'the rename reached the session controller')

  const record = harness.store.sessionOf('s1')
  assert.equal(record.titleLocked, true)
  assert.equal(record.titleSource, 'manual')
  const row = (await harness.rows()).body.rows[0]
  assert.equal(row.titleLocked, true)
  assert.equal(row.titleSource, 'manual')

  const empty = await harness.call('POST', '/rename', { sessionId: 's1', title: '   ' })
  assert.equal(empty.status, 400)
})

test('POST /archive and /unarchive move rows in and out of the default list', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a', title: '会话 A', reason: 'completed', firstMessage: 'a' },
      { id: 's2', cwd: '/repo/a', title: '会话 B', reason: 'completed', firstMessage: 'b' },
    ],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1', 's2']), true)

  const archived = await harness.call('POST', '/archive', { sessionIds: ['s2'] })
  assert.equal(archived.status, 200)
  assert.deepEqual(archived.body.archived, ['s2'])
  assert.deepEqual(harness.calls.archive[0], { id: 's2', options: { stopActivity: true } })
  assert.deepEqual((await harness.rows()).body.rows.map((row) => row.id), ['s1'])
  assert.deepEqual((await harness.rows({ includeArchived: '1' })).body.rows.map((row) => row.id), ['s1', 's2'])

  const keepActivity = await harness.call('POST', '/archive', { sessionIds: ['s2'], stopActivity: false })
  assert.equal(keepActivity.status, 200)
  assert.deepEqual(harness.calls.archive[1], { id: 's2', options: { stopActivity: false } })

  const restored = await harness.call('POST', '/unarchive', { sessionIds: ['s2'] })
  assert.equal(restored.status, 200)
  assert.deepEqual(restored.body.unarchived, ['s2'])
  assert.deepEqual((await harness.rows()).body.rows.map((row) => row.id), ['s1', 's2'])
})

test('trash moves the artifact directory aside, lists it and restores it', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a', title: '待删除会话', reason: 'completed', firstMessage: '删我' },
      { id: 's2', cwd: '/repo/a', title: '运行中会话', reason: null, firstMessage: '忙着', running: true },
    ],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1', 's2']), true)
  assert.equal(fs.existsSync(harness.artifactDir('s1')), true)

  const moved = await harness.call('POST', '/trash', { sessionIds: ['s1'] })
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.body.trashed, ['s1'])
  assert.deepEqual(moved.body.refused, [])
  assert.equal(fs.existsSync(harness.artifactDir('s1')), false, 'the artifact directory left the corpus')
  assert.equal(fs.existsSync(path.join(harness.dataDir, 'trash', 's1', 'session.log')), true)
  const index = JSON.parse(fs.readFileSync(path.join(harness.dataDir, 'trash.json'), 'utf8'))
  assert.equal(index.items.s1.sourceDir, harness.artifactDir('s1'))
  assert.equal(index.items.s1.tombstone, false)

  const listed = await harness.call('GET', '/trash')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].sessionId, 's1')
  assert.equal(listed.body.items[0].title, '待删除会话')
  assert.equal(listed.body.items[0].cwd, '/repo/a')
  assert.deepEqual((await harness.rows()).body.rows.map((row) => row.id), ['s2'], 'a trashed session is not listed')

  const refused = await harness.call('POST', '/trash', { sessionIds: ['s2'] })
  assert.equal(refused.status, 200)
  assert.deepEqual(refused.body.trashed, [])
  assert.equal(refused.body.refused[0].sessionId, 's2')
  assert.equal(refused.body.refused[0].code, 'running')
  assert.equal(fs.existsSync(harness.artifactDir('s2')), true, 'a running session keeps its data')

  const restored = await harness.call('POST', '/trash/restore', { sessionIds: ['s1'] })
  assert.equal(restored.status, 200)
  assert.deepEqual(restored.body.restored, ['s1'])
  assert.equal(fs.existsSync(harness.artifactDir('s1')), true)
  assert.deepEqual((await harness.call('GET', '/trash')).body.items, [])
  assert.deepEqual((await harness.rows()).body.rows.map((row) => row.id), ['s1', 's2'])
})

test('a session whose artifact directory is gone is tombstoned and can still be removed', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a', title: '丢了数据的会话', reason: 'completed', firstMessage: '删我' },
      { id: 's2', cwd: '/repo/a', title: '正常会话', reason: 'completed', firstMessage: '留下' },
    ],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1', 's2']), true)
  const tagged = await harness.call('POST', '/tags', { sessionIds: ['s1'], op: 'append', tags: ['保留我'] })
  assert.equal(tagged.body.updated, 1)
  fs.rmSync(harness.artifactDir('s1'), { recursive: true, force: true })

  const moved = await harness.call('POST', '/trash', { sessionIds: ['s1'] })
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.body.trashed, ['s1'])
  assert.deepEqual(moved.body.tombstones, ['s1'])
  assert.deepEqual(moved.body.refused, [])
  assert.equal(fs.existsSync(path.join(harness.dataDir, 'trash', 's1')), false, 'a tombstone moves no directory')
  assert.deepEqual((await harness.rows()).body.rows.map((row) => row.id), ['s2'], 'a tombstoned session leaves the list')

  const listed = await harness.call('GET', '/trash')
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].sessionId, 's1')
  assert.equal(listed.body.items[0].tombstone, true)
  assert.equal(listed.body.items[0].title, '丢了数据的会话')

  const restored = await harness.call('POST', '/trash/restore', { sessionIds: ['s1'] })
  assert.equal(restored.status, 200)
  assert.deepEqual(restored.body.restored, ['s1'])
  assert.deepEqual(restored.body.tombstones, ['s1'])
  const rows = (await harness.rows()).body.rows
  assert.deepEqual(rows.map((row) => row.id), ['s1', 's2'], 'the session becomes visible again')
  assert.deepEqual(rows.find((row) => row.id === 's1').tags, ['保留我'], 'the plugin-owned tags were never touched')
})

test('AI preview routes answer 503 while no model route is configured', async (t) => {
  const harness = await createHarness({
    sessions: [{ id: 's1', cwd: '/repo/a', title: '会话', reason: 'completed', firstMessage: 'hi' }],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1']), true)

  const state = await harness.call('GET', '/state')
  assert.equal(state.body.ai.ok, false)

  const rename = await harness.call('POST', '/ai/rename/preview', { sessionIds: ['s1'] })
  const tags = await harness.call('POST', '/ai/tags/preview', { sessionIds: ['s1'] })
  assert.equal(rename.status, 503)
  assert.equal(tags.status, 503)

  if (harness.ai) {
    assert.equal(harness.ai.available().ok, false, 'available() reports the missing model route')
    assert.equal(rename.body.error.code, 'llm_unavailable')
    assert.equal(tags.body.error.code, 'llm_unavailable')
  } else {
    // host/ai.js is owned by another task and may not be present yet.
    assert.equal(rename.body.error.code, 'unavailable')
    assert.equal(tags.body.error.code, 'unavailable')
  }
})

test('POST /status/refresh forces a pass and settles back to idle', async (t) => {
  const harness = await createHarness({
    sessions: [
      { id: 's1', cwd: '/repo/a', title: '会话 A', reason: 'error', firstMessage: 'a' },
      { id: 's2', cwd: '/repo/a', title: '会话 B', reason: 'blocked', firstMessage: 'b' },
    ],
  })
  t.after(() => harness.dispose())
  assert.equal(await waitForTitles(harness, ['s1', 's2']), true)
  assert.equal(await harness.waitIdle(), true)
  const before = harness.factsCalls.length

  harness.setRevision('s1', 'rev-s1-2')
  const response = await harness.call('POST', '/status/refresh', { force: true })
  assert.equal(response.status, 200)
  assert.equal(response.body.started, true)
  assert.ok(response.body.indexing, 'the refresh reports progress')

  assert.equal(await harness.waitIdle(), true)
  assert.equal(harness.statusIndex.status().running, false)
  assert.equal(harness.statusIndex.status().processed, 2)
  assert.equal(harness.statusIndex.status().total, 2)
  assert.equal(harness.factsCalls.length - before, 2, 'a forced pass re-reads every session')

  const rows = (await harness.rows()).body.rows
  assert.equal(rows.find((row) => row.id === 's1').lastTurnEnd, 'error')
  assert.equal(rows.find((row) => row.id === 's2').lastTurnEnd, 'blocked')
})

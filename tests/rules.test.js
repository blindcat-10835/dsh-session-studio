import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore, StateError } from '../host/store.js'
import { emptyFacts } from '../host/sessions.js'
import { createRuleService, evaluateRule, normalizeRule } from '../host/rules.js'

const silentLogger = { warn() {}, error() {}, info() {}, debug() {} }

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rules-'))
  const store = new StateStore({ dataDir: dir, logger: silentLogger })
  store.loadSync()
  return store
}

const ROWS = [
  { id: 's1', running: false, blank: false, cwd: '/home/u/huawei-project', archived: false },
  { id: 's2', running: false, blank: false, cwd: '/tmp/x', archived: false },
  { id: 's3', running: false, blank: true, cwd: '/home/u/huawei-project', archived: false },
  { id: 's4', running: false, blank: false, cwd: '/home/u/huawei-project', parentSessionId: 's1', archived: false },
  { id: 's5', running: false, blank: false, cwd: '/home/u/huawei-project', archived: true },
]

const FACTS = {
  s1: { title: 'Fix 华为 login', titleSource: 'user', firstMessage: '登录失败 in 华为 env', lastTurnEnd: null },
  s2: { title: 'other task', titleSource: 'auto', firstMessage: 'nothing here', lastTurnEnd: null },
  s3: { title: '', titleSource: null, firstMessage: '', lastTurnEnd: null },
  s4: { title: 'sub work', titleSource: null, firstMessage: 'sub', lastTurnEnd: null },
  s5: { title: 'archived 华为', titleSource: null, firstMessage: 'old', lastTurnEnd: null },
}

function makeSessions(overrides = {}) {
  const calls = { list: 0, facts: [] }
  const sessions = {
    calls,
    async list() {
      calls.list += 1
      return (overrides.rows ?? ROWS).map((row) => ({ ...row }))
    },
    async factsOf(id) {
      calls.facts.push(id)
      if (overrides.failFacts) throw new Error('facts boom')
      return { ...emptyFacts(), ...(overrides.facts ?? FACTS)[id] }
    },
  }
  return sessions
}

/** Minimal stand-in for createTagService (owned by another module, contract in CONTRACTS.md). */
function makeTags(store) {
  const calls = { apply: [], addSuggestions: [] }
  return {
    calls,
    apply({ sessionIds, op, tags }) {
      calls.apply.push({ sessionIds: [...sessionIds], op, tags: [...tags] })
      let updated = 0
      for (const id of sessionIds) {
        const record = store.sessionOf(id)
        let next = record.tags
        if (op === 'append') next = [...record.tags, ...tags]
        else if (op === 'replace') next = [...tags]
        else if (op === 'clear') next = []
        const changed = next.length !== record.tags.length || next.some((tag, index) => tag !== record.tags[index])
        store.patchSession(id, { tags: next })
        if (changed) updated += 1
      }
      return { updated, tagDefs: store.tagDefs() }
    },
    addSuggestions(id, tags) {
      calls.addSuggestions.push({ id, tags: [...tags] })
      const record = store.sessionOf(id)
      const merged = [...record.suggestedTags]
      for (const tag of tags) if (!merged.some((entry) => entry.toLowerCase() === tag.toLowerCase())) merged.push(tag)
      store.patchSession(id, { suggestedTags: merged })
      return merged
    },
  }
}

function serviceWith(overrides = {}) {
  const store = overrides.store ?? makeStore()
  const sessions = overrides.sessions ?? makeSessions(overrides)
  const tags = overrides.tags === null ? undefined : overrides.tags ?? makeTags(store)
  const service = createRuleService({ store, sessions, tags, logger: silentLogger })
  return { store, sessions, tags, service }
}

const baseRule = (patch = {}) => ({
  name: '华为项目',
  match: { keywords: ['华为'], fields: ['title', 'firstMessage', 'cwd', 'note'], mode: 'any' },
  action: { tags: ['华为'], mode: 'suggest' },
  ...patch,
})

test('validate rejects rules that cannot run', () => {
  assert.throws(() => normalizeRule(null), (error) => error instanceof StateError && error.code === 'invalid_rule')
  assert.throws(() => normalizeRule({ match: { keywords: [] }, action: { tags: ['x'] } }), /keyword/)
  assert.throws(() => normalizeRule({ match: { keywords: ['a'], fields: ['nope'] }, action: { tags: ['x'] } }), /unknown match field/)
  assert.throws(() => normalizeRule({ match: { keywords: ['a'], mode: 'some' }, action: { tags: ['x'] } }), /match mode/)
  assert.throws(() => normalizeRule({ match: { keywords: ['a'] }, action: { tags: [] } }), /action tag/)
  assert.throws(() => normalizeRule({ match: { keywords: ['a'] }, action: { tags: ['x'], mode: 'delete' } }), /action mode/)
})

test('validate normalizes keywords, fields, tags and defaults', () => {
  const rule = normalizeRule({
    match: { keywords: ['  华为  ', '华为', '#bug'], fields: ['note', 'title'] },
    action: { tags: ['  #华为 ', '华为', 'bug'] },
  })
  assert.deepEqual(rule.match.keywords, ['华为', '#bug'])
  assert.deepEqual(rule.match.fields, ['title', 'note'])
  assert.equal(rule.match.mode, 'any')
  assert.deepEqual(rule.action.tags, ['华为', 'bug'])
  assert.equal(rule.action.mode, 'suggest')
  assert.equal(rule.enabled, true)
  assert.equal(rule.id, null)
  assert.equal(rule.name, '华为 / bug')
})

test('save assigns an id, keeps createdAt, list and remove round-trip', () => {
  const { store, service } = serviceWith()
  const first = service.save(baseRule())
  assert.match(first.id, /^r-[0-9a-f]+$/)
  assert.equal(service.list().length, 1)

  const again = service.save({ ...baseRule(), id: first.id, name: '改名' })
  assert.equal(again.id, first.id)
  assert.equal(again.createdAt, first.createdAt)
  assert.equal(service.list().length, 1)
  assert.equal(service.list()[0].name, '改名')
  assert.equal(store.rules().length, 1)

  assert.equal(service.remove(first.id), true)
  assert.equal(service.remove(first.id), false)
  assert.equal(service.list().length, 0)
  assert.throws(() => service.remove('  '), (error) => error.code === 'invalid_rule')
})

test('preview matches title/firstMessage/cwd/note case-insensitively (any)', async () => {
  const { store, service } = serviceWith()
  store.patchSession('s2', { note: '华为 项目 备注' })
  const { matches, scanned, total, truncated } = await service.preview({ rule: baseRule() })
  assert.equal(scanned, 2, 'blank, subagent and archived Sessions are not scanned')
  assert.equal(total, 2)
  assert.equal(truncated, false)
  assert.deepEqual(matches.map((match) => match.sessionId).sort(), ['s1', 's2'])
  const s1 = matches.find((match) => match.sessionId === 's1')
  assert.equal(s1.title, 'Fix 华为 login')
  assert.deepEqual(s1.tags, [])
  assert.match(s1.evidence, /标题: 华为/)
  assert.match(s1.evidence, /首条消息: 华为/)
  assert.ok(s1.evidenceDetail.some((entry) => entry.field === 'title' && entry.keyword === '华为'))

  const cwdRule = service.validate({ match: { keywords: ['huawei-project'], fields: ['cwd'] }, action: { tags: ['cwd'] } })
  const cwdMatches = await service.preview({ rule: cwdRule })
  assert.deepEqual(cwdMatches.matches.map((match) => match.sessionId), ['s1'])

  const caseRule = service.validate({
    match: { keywords: ['LOGIN'], fields: ['title'] },
    action: { tags: ['auth'] },
  })
  const caseMatches = await service.preview({ rule: caseRule })
  assert.deepEqual(caseMatches.matches.map((match) => match.sessionId), ['s1'])
})

test('mode all requires every keyword to hit somewhere', async () => {
  const { service } = serviceWith()
  const all = service.validate({
    match: { keywords: ['华为', 'LOGIN'], fields: ['title', 'firstMessage', 'cwd', 'note'], mode: 'all' },
    action: { tags: ['t'] },
  })
  const { matches } = await service.preview({ rule: all })
  assert.deepEqual(matches.map((match) => match.sessionId), ['s1'])
})

test('preview is strictly read-only', async () => {
  const { store, service } = serviceWith()
  const before = JSON.stringify(store.state)
  const versionBefore = store.version
  await service.preview({ rule: baseRule() })
  await service.preview({ rule: baseRule({ action: { tags: ['x'], mode: 'apply' } }) })
  assert.equal(JSON.stringify(store.state), before)
  assert.equal(store.version, versionBefore)
})

test('preview limit caps how many Sessions are scanned', async () => {
  const { service } = serviceWith()
  const { matches, scanned, total, truncated } = await service.preview({ rule: baseRule(), limit: 1 })
  assert.equal(scanned, 1)
  assert.equal(total, 2)
  assert.equal(truncated, true)
  assert.ok(matches.length <= 1)
})

test('preview only reads the facts it needs for the selected fields', async () => {
  const { service, sessions } = serviceWith()
  await service.preview({ rule: baseRule({ match: { keywords: ['zzz-no-such-cwd'], fields: ['cwd'], mode: 'any' } }) })
  assert.deepEqual(sessions.calls.facts, [], 'cwd-only rules must not read the log')
  await service.preview({ rule: baseRule({ match: { keywords: ['login'], fields: ['title'], mode: 'any' } }) })
  assert.ok(sessions.calls.facts.length > 0)
})

test('apply in suggest mode only writes suggestedTags', async () => {
  const { store, service, tags } = serviceWith()
  store.patchSession('s1', { tags: ['keep'] })
  store.patchSession('s2', { note: '华为 项目 备注' })
  const rule = service.save(baseRule())
  const result = await service.apply({ ruleId: rule.id })
  assert.equal(result.mode, 'suggest')
  assert.equal(result.suggested, 2)
  assert.equal(result.updated, 0)
  assert.deepEqual(result.sessions.sort(), ['s1', 's2'])
  assert.deepEqual(store.sessionOf('s1').tags, ['keep'], 'tags are untouched in suggest mode')
  assert.deepEqual(store.sessionOf('s1').suggestedTags, ['华为'])
  assert.deepEqual(store.sessionOf('s2').suggestedTags, ['华为'])
  assert.equal(tags.calls.apply.length, 0)

  const again = await service.apply({ ruleId: rule.id })
  assert.equal(again.suggested, 0, 'applying twice adds no duplicate suggestions')
})

test('apply in apply mode appends tags and never deletes existing ones', async () => {
  const { store, service, tags } = serviceWith()
  store.patchSession('s1', { tags: ['keep'] })
  store.patchSession('s2', { note: '华为 项目 备注' })
  const rule = service.save(baseRule({ action: { tags: ['华为', 'bug'], mode: 'apply' } }))
  const result = await service.apply({ ruleId: rule.id })
  assert.equal(result.mode, 'apply')
  assert.equal(result.updated, 2)
  assert.deepEqual(result.sessions.sort(), ['s1', 's2'])
  assert.deepEqual(store.sessionOf('s1').tags, ['keep', '华为', 'bug'])
  assert.deepEqual(store.sessionOf('s2').tags, ['华为', 'bug'])
  assert.equal(store.sessionOf('s1').suggestedTags.length, 0)
  assert.equal(tags.calls.apply.length, 1)
  assert.equal(tags.calls.apply[0].op, 'append')

  const again = await service.apply({ ruleId: rule.id })
  assert.equal(again.updated, 0, 're-applying appends nothing new')
})

test('apply honours a caller-supplied mode override', async () => {
  const { store, service } = serviceWith()
  store.patchSession('s2', { note: '华为 项目 备注' })
  const rule = service.save(baseRule())
  const result = await service.apply({ ruleId: rule.id, mode: 'apply' })
  assert.equal(result.mode, 'apply')
  assert.deepEqual(store.sessionOf('s1').tags, ['华为'])
  assert.deepEqual(store.sessionOf('s2').tags, ['华为'])
})

test('apply refuses an unknown rule id', async () => {
  const { service } = serviceWith()
  await assert.rejects(service.apply({ ruleId: 'r-nope' }), (error) => error.code === 'not_found')
})

test('apply falls back to direct store writes without a tag service', async () => {
  const { store, service } = serviceWith({ tags: null })
  store.patchSession('s2', { note: '华为 项目 备注' })
  const rule = service.save(baseRule({ action: { tags: ['华为'], mode: 'apply' } }))
  const result = await service.apply({ ruleId: rule.id })
  assert.equal(result.updated, 2)
  assert.deepEqual(store.sessionOf('s1').tags, ['华为'])

  const suggestRule = service.save(baseRule({ id: 'r-suggest', action: { tags: ['sug'], mode: 'suggest' } }))
  const suggested = await service.apply({ ruleId: suggestRule.id })
  assert.equal(suggested.suggested, 2)
  assert.deepEqual(store.sessionOf('s2').suggestedTags, ['sug'])
})

test('suggestFor computes suggestions without writing', async () => {
  const { store, service } = serviceWith()
  store.patchSession('s1', { tags: ['华为'] })
  store.patchSession('s2', { note: '华为', suggestedTags: ['华为'] })
  service.save(baseRule())
  service.save({ ...baseRule({ name: 'cwd' }), match: { keywords: ['huawei'], fields: ['cwd'], mode: 'any' }, action: { tags: ['项目'] } })
  const before = JSON.stringify(store.state)
  const versionBefore = store.version
  const out = await service.suggestFor(['s1', 's2', 's3', 'nope'])
  assert.deepEqual(out.s1, ['项目'], 'existing tags and suggestions are not repeated')
  assert.deepEqual(out.s2, [], 'an already-suggested tag is not repeated')
  assert.deepEqual(out.s3, [], 'blank Sessions get no suggestion')
  assert.deepEqual(out.nope, [], 'unknown ids still get an entry')
  assert.equal(JSON.stringify(store.state), before)
  assert.equal(store.version, versionBefore)
})

test('suggestFor ignores disabled rules', async () => {
  const { service } = serviceWith()
  service.save(baseRule({ enabled: false }))
  const out = await service.suggestFor(['s1'])
  assert.deepEqual(out.s1, [])
})

test('evaluateRule reports evidence per field', () => {
  const rule = normalizeRule({
    match: { keywords: ['a', 'b'], fields: ['title', 'note'], mode: 'all' },
    action: { tags: ['t'] },
  })
  const evidence = evaluateRule(rule, { title: 'A and B', note: '' })
  assert.deepEqual(evidence, [{ field: 'title', keyword: 'a' }, { field: 'title', keyword: 'b' }])
  assert.equal(evaluateRule(rule, { title: 'a only', note: 'b' }) !== null, true)
  assert.equal(evaluateRule(rule, { title: 'a only', note: 'c' }), null)
})
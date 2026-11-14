import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore } from '../host/store.js'
import { emptyFacts } from '../host/sessions.js'
import { AI_LIMITS, createAiService, sanitizeTitle } from '../host/ai.js'

const NL = String.fromCharCode(10)
const silentLogger = { warn() {}, error() {}, info() {}, debug() {} }

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ai-'))
  const store = new StateStore({ dataDir: dir, logger: silentLogger })
  store.loadSync()
  return store
}

const BASE_ROWS = [
  { id: 'sess-ok-1', running: false, blank: false, cwd: '/home/u/alpha', archived: false },
  { id: 'sess-ok-2', running: false, blank: false, cwd: '/home/u/beta', archived: false },
  { id: 'sess-running', running: true, blank: false, cwd: '/home/u/alpha', archived: false },
  { id: 'sess-blank', running: false, blank: true, cwd: '/home/u/alpha', archived: false },
  { id: 'sess-sub', running: false, blank: false, cwd: '/home/u/alpha', origin: 'subagent', parentSessionId: 'sess-ok-1', archived: false },
  { id: 'sess-locked', running: false, blank: false, cwd: '/home/u/gamma', archived: false },
  { id: 'sess-archived', running: false, blank: false, cwd: '/home/u/delta', archived: true },
]

const idsOfPrompt = (prompt) => {
  const found = []
  const matcher = /id: (sess-[a-z0-9-]+)/g
  let match = matcher.exec(prompt)
  while (match) {
    found.push(match[1])
    match = matcher.exec(prompt)
  }
  return found
}

function makeEnv(options = {}) {
  const store = options.store ?? makeStore()
  const rows = (options.rows ?? BASE_ROWS).map((row) => ({ ...row }))
  const calls = { list: 0, facts: [], rename: [], prompts: [] }
  const renameFailures = options.renameFailures ?? {}
  const sessions = {
    calls,
    async list() {
      calls.list += 1
      return rows.map((row) => ({ ...row }))
    },
    async factsOf(id) {
      calls.facts.push(id)
      const template = options.facts ?? null
      const base = {
        ...emptyFacts(),
        title: 'old title ' + id,
        firstMessage: 'first message of ' + id,
      }
      return template ? { ...base, ...template[id] } : base
    },
    async rename(id, title) {
      calls.rename.push({ id, title })
      if (renameFailures[id]) {
        const error = new Error('rename refused')
        error.code = 'rename_failed'
        throw error
      }
      return { sessionId: id, title }
    },
  }

  const transport = options.transport ?? null
  if (transport) {
    const original = transport.complete.bind(transport)
    transport.complete = async (request) => {
      calls.prompts.push(request.prompt)
      return original(request)
    }
  }

  const service = createAiService({
    store,
    sessions,
    statusIndex: options.statusIndex ?? { async ensure() {} },
    settings: options.settings,
    logger: silentLogger,
    llm: options.llm ?? null,
    agentDefaultModel: options.agentDefaultModel ?? null,
    transport,
    timeoutMs: options.timeoutMs,
  })
  return { store, sessions, calls, rows, service, transport }
}

/** Reply with a well-formed rename batch for every id in the prompt. */
function echoRenameTransport(prefix = 'AI: ') {
  return {
    async complete(request) {
      const items = idsOfPrompt(request.prompt).map((id) => ({ id, title: prefix + id, reason: '依据 ' + id }))
      return JSON.stringify({ items })
    },
  }
}

const selectModel = (provider = 'prov', model = 'mod') => ({ currentSelection: () => ({ provider, model }) })

test('available() and previewRename report llm_unavailable without a model service', async () => {
  const { service } = makeEnv()
  assert.deepEqual(service.available(), { ok: false, reason: 'llm_unavailable' })
  await assert.rejects(service.previewRename({ sessionIds: ['sess-ok-1'] }), (error) => {
    assert.equal(error.name, 'StateError')
    assert.equal(error.code, 'llm_unavailable')
    assert.equal(error.status, 503)
    return true
  })
})

test('a model service without a default route is unavailable', async () => {
  const llm = { stream: () => {} }
  const { service } = makeEnv({ llm, transport: echoRenameTransport() })
  assert.deepEqual(service.available(), { ok: true, model: { provider: 'injected', model: 'transport' }, modelLabel: 'injected/transport' })
  const { service: withoutTransport } = makeEnv({ llm })
  assert.equal(withoutTransport.available().ok, false)
  assert.equal(withoutTransport.available().reason, 'no_default_model')
  await assert.rejects(withoutTransport.previewRename({ sessionIds: ['sess-ok-1'] }), (error) => error.code === 'llm_unavailable')
})

test('available() reports the agentDefaultModel route', async () => {
  const { service } = makeEnv({ llm: { stream() {} }, agentDefaultModel: selectModel('deepseek', 'v4') })
  const available = service.available()
  assert.equal(available.ok, true)
  assert.deepEqual(available.model, { provider: 'deepseek', model: 'v4' })
  assert.equal(available.modelLabel, 'deepseek/v4')
})

test('previewRename skips Sessions with a reason, never sends them, and writes nothing', async () => {
  const transport = echoRenameTransport()
  const { service, store, calls } = makeEnv({ transport, agentDefaultModel: selectModel() })
  store.patchSession('sess-locked', { titleLocked: true })
  const before = JSON.stringify(store.state)
  const versionBefore = store.version
  const requested = BASE_ROWS.map((row) => row.id).concat(['sess-missing'])

  const preview = await service.previewRename({ sessionIds: requested })
  const byId = new Map(preview.items.map((item) => [item.sessionId, item]))

  assert.equal(preview.total, 8)
  assert.equal(preview.truncated, false)
  assert.equal(preview.skipped, 6)
  assert.equal(preview.failed, 0)
  assert.equal(byId.get('sess-running').skipReason, 'running')
  assert.equal(byId.get('sess-blank').skipReason, 'blank')
  assert.equal(byId.get('sess-sub').skipReason, 'subagent')
  assert.equal(byId.get('sess-archived').skipReason, 'archived')
  assert.equal(byId.get('sess-locked').skipReason, 'titleLocked')
  assert.equal(byId.get('sess-missing').skipReason, 'missing')
  assert.equal(byId.get('sess-ok-1').skipReason, null)
  assert.equal(byId.get('sess-ok-1').proposed, 'AI: sess-ok-1')
  assert.equal(byId.get('sess-ok-1').currentTitle, 'old title sess-ok-1')
  assert.equal(byId.get('sess-ok-1').reason, '依据 sess-ok-1')

  assert.equal(calls.prompts.length, 1)
  const sent = idsOfPrompt(calls.prompts[0])
  assert.deepEqual(sent.sort(), ['sess-ok-1', 'sess-ok-2'])
  for (const skippedId of ['sess-running', 'sess-blank', 'sess-sub', 'sess-archived', 'sess-locked', 'sess-missing']) {
    assert.equal(calls.prompts[0].includes(skippedId), false, skippedId + ' must not reach the model')
  }
  assert.equal(JSON.stringify(store.state), before, 'preview must not write plugin state')
  assert.equal(store.version, versionBefore)
})

test('a forked Session joins the AI batch while an origin-subagent is skipped (AIDEV-161)', async () => {
  const transport = echoRenameTransport()
  const { service } = makeEnv({
    transport,
    agentDefaultModel: selectModel(),
    rows: [
      { id: 'sess-parent', running: false, blank: false, cwd: '/home/u/alpha', archived: false },
      { id: 'sess-fork', running: false, blank: false, cwd: '/home/u/alpha', parentSessionId: 'sess-parent', archived: false },
      { id: 'sess-child', running: false, blank: false, cwd: '/home/u/alpha', origin: 'subagent', parentSessionId: 'sess-parent', archived: false },
    ],
  })

  const preview = await service.previewRename({ sessionIds: ['sess-parent', 'sess-fork', 'sess-child'] })
  const byId = new Map(preview.items.map((item) => [item.sessionId, item]))
  assert.equal(byId.get('sess-fork').skipReason, null, 'a branch is a normal Session')
  assert.equal(byId.get('sess-child').skipReason, 'subagent')
})

test('previewRename preserves the requested order', async () => {
  const { service } = makeEnv({ transport: echoRenameTransport(), agentDefaultModel: selectModel() })
  const preview = await service.previewRename({ sessionIds: ['sess-ok-2', 'sess-ok-1'] })
  assert.deepEqual(preview.items.map((item) => item.sessionId), ['sess-ok-2', 'sess-ok-1'])
})

test('previewRename batches by batchSize and keeps concurrency at two', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: 'sess-batch-' + index,
    running: false,
    blank: false,
    cwd: '/tmp/w',
    archived: false,
  }))
  const seen = []
  let inFlight = 0
  let peak = 0
  const transport = {
    async complete(request) {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      seen.push(idsOfPrompt(request.prompt))
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return JSON.stringify({ items: idsOfPrompt(request.prompt).map((id) => ({ id, title: 'T ' + id })) })
    },
  }
  const { service } = makeEnv({
    rows,
    transport,
    agentDefaultModel: selectModel(),
    settings: { ai: { batchSize: 8, concurrency: 2, maxSessionsPerRun: 50, titleMaxChars: 48, readContent: true } },
  })
  const preview = await service.previewRename({ sessionIds: rows.map((row) => row.id) })
  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map((batch) => batch.length), [8, 8, 4])
  assert.ok(peak <= 2, 'expected concurrency <= 2, saw ' + peak)
  assert.equal(preview.items.filter((item) => item.proposed).length, 20)
})

test('one failing batch does not stop the other batches', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: 'sess-p-' + index,
    running: false,
    blank: false,
    cwd: '/tmp/w',
    archived: false,
  }))
  let call = 0
  const transport = {
    async complete(request) {
      call += 1
      if (call === 2) throw new Error('model exploded')
      return JSON.stringify({ items: idsOfPrompt(request.prompt).map((id) => ({ id, title: 'T ' + id })) })
    },
  }
  const { service } = makeEnv({
    rows,
    transport,
    agentDefaultModel: selectModel(),
    settings: { ai: { batchSize: 2, concurrency: 1, maxSessionsPerRun: 50, titleMaxChars: 48, readContent: true } },
  })
  const preview = await service.previewRename({ sessionIds: rows.map((row) => row.id) })
  assert.equal(preview.failed, 2)
  assert.equal(preview.items.filter((item) => item.proposed).length, 4)
  for (const item of preview.items.filter((entry) => entry.skipReason)) {
    assert.equal(item.skipReason, 'llm_failed')
    assert.match(item.detail, /model exploded/)
  }
})

test('unparsable model output marks only that batch as failed', async () => {
  const rows = [
    { id: 'sess-u-1', running: false, blank: false, cwd: '/tmp/w', archived: false },
    { id: 'sess-u-2', running: false, blank: false, cwd: '/tmp/w', archived: false },
  ]
  const transport = { async complete() { return 'sorry, I cannot do that' } }
  const { service } = makeEnv({ rows, transport, agentDefaultModel: selectModel() })
  const preview = await service.previewRename({ sessionIds: rows.map((row) => row.id) })
  assert.equal(preview.failed, 2)
  assert.deepEqual(preview.items.map((item) => item.skipReason), ['unparsable', 'unparsable'])
})

test('a transport that never answers hits the overall timeout', async () => {
  const transport = { complete: () => new Promise(() => {}) }
  const { service } = makeEnv({ transport, agentDefaultModel: selectModel(), timeoutMs: 150 })
  // The budget timer is unref'd so a job never keeps the process alive; the
  // test realm therefore needs a live timer of its own until the budget fires.
  const keepAlive = new Promise((done) => setTimeout(done, 400))
  const preview = await service.previewRename({ sessionIds: ['sess-ok-1'] })
  assert.equal(preview.items[0].skipReason, 'timeout')
  assert.equal(preview.failed, 1)
  await keepAlive
})

test('previewRename truncates at maxSessionsPerRun', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: 'sess-cap-' + index,
    running: false,
    blank: false,
    cwd: '/tmp/w',
    archived: false,
  }))
  const sent = []
  const transport = {
    async complete(request) {
      sent.push(...idsOfPrompt(request.prompt))
      return JSON.stringify({ items: idsOfPrompt(request.prompt).map((id) => ({ id, title: 'T ' + id })) })
    },
  }
  const { service } = makeEnv({ rows, transport, agentDefaultModel: selectModel(), settings: { ai: { maxSessionsPerRun: 50 } } })
  const preview = await service.previewRename({ sessionIds: rows.map((row) => row.id) })
  assert.equal(preview.total, 50)
  assert.equal(preview.dropped, 10)
  assert.equal(preview.truncated, true)
  assert.equal(sent.length, 50)
  assert.equal(sent.includes('sess-cap-55'), false)
})

test('readContent:false keeps the first message out of the prompt', async () => {
  const transport = echoRenameTransport()
  const { service, calls } = makeEnv({ transport, agentDefaultModel: selectModel() })
  await service.previewRename({ sessionIds: ['sess-ok-1'], readContent: false })
  assert.equal(calls.prompts[0].includes('first message of sess-ok-1'), false)
  await service.previewRename({ sessionIds: ['sess-ok-2'], readContent: true })
  assert.equal(calls.prompts[1].includes('first message of sess-ok-2'), true)
})

test('applyRename writes the title and records titleSource ai without locking', async () => {
  const { service, store, calls } = makeEnv({ transport: echoRenameTransport(), agentDefaultModel: selectModel() })
  const result = await service.applyRename({ items: [{ sessionId: 'sess-ok-1', title: '新标题' }] })
  assert.deepEqual(result.applied, [{ sessionId: 'sess-ok-1', title: '新标题' }])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(calls.rename, [{ id: 'sess-ok-1', title: '新标题' }])
  assert.equal(store.sessionOf('sess-ok-1').titleSource, 'ai')
  assert.equal(store.sessionOf('sess-ok-1').titleLocked, false)
  assert.ok(store.version > 0)
})

test('applyRename re-validates every skip rule at apply time', async () => {
  const { service, store, calls, rows } = makeEnv({ agentDefaultModel: selectModel() })
  store.patchSession('sess-locked', { titleLocked: true })
  const previewed = [
    { sessionId: 'sess-ok-1', title: '合法标题' },
    { sessionId: 'sess-running', title: '不该写' },
    { sessionId: 'sess-blank', title: '不该写' },
    { sessionId: 'sess-sub', title: '不该写' },
    { sessionId: 'sess-archived', title: '不该写' },
    { sessionId: 'sess-locked', title: '不该写' },
    { sessionId: 'sess-gone', title: '不该写' },
    { sessionId: 'sess-ok-2', title: '   ' },
  ]
  // The client may claim a Session is idle; the row says otherwise and must win.
  const result = await service.applyRename({ items: previewed })
  assert.deepEqual(result.applied, [{ sessionId: 'sess-ok-1', title: '合法标题' }])
  assert.deepEqual(calls.rename, [{ id: 'sess-ok-1', title: '合法标题' }])
  const codes = result.skipped.concat(result.failed).map((entry) => entry.code).sort()
  assert.deepEqual(codes, ['archived', 'blank', 'invalid_title', 'missing', 'running', 'subagent', 'titleLocked'])

  // A Session that became locked after the preview is refused on apply.
  rows.find((row) => row.id === 'sess-ok-2').running = true
  store.patchSession('sess-ok-2', { titleLocked: true })
  const again = await service.applyRename({ items: [{ sessionId: 'sess-ok-2', title: '另一个标题' }] })
  assert.deepEqual(again.applied, [])
  assert.deepEqual(again.skipped.map((entry) => entry.code), ['running'])
})

test('applyRename skips an unchanged title and reports rename failures', async () => {
  const { service, calls } = makeEnv({ agentDefaultModel: selectModel(), renameFailures: { 'sess-ok-2': true } })
  const result = await service.applyRename({
    items: [
      { sessionId: 'sess-ok-1', title: 'old title sess-ok-1' },
      { sessionId: 'sess-ok-2', title: 'brand new' },
      { sessionId: '', title: 'x' },
    ],
  })
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.skipped.map((entry) => [entry.sessionId, entry.code]), [['sess-ok-1', 'unchanged']])
  assert.equal(result.failed.length, 2)
  assert.equal(result.failed[0].code, 'rename_failed')
  assert.equal(result.failed[1].code, 'invalid_item')
})

test('applyRename normalizes titles and prefers title over proposed', async () => {
  const { service, calls } = makeEnv({ agentDefaultModel: selectModel() })
  await service.applyRename({
    items: [
      { sessionId: 'sess-ok-1', title: '  line one  ', proposed: 'ignored' },
      { sessionId: 'sess-ok-2', proposed: 'from preview' },
    ],
  })
  assert.deepEqual(calls.rename, [
    { id: 'sess-ok-1', title: 'line one' },
    { id: 'sess-ok-2', title: 'from preview' },
  ])
  assert.equal(sanitizeTitle('multi\nline', 48), 'multi line')
})

function tagTransport(reply) {
  return { async complete() { return JSON.stringify(reply) } }
}

test('previewTags prefers the closed vocabulary and caps new words', async () => {
  const store = makeStore()
  store.ensureTagDef('bug', 'manual')
  store.ensureTagDef('华为', 'manual')
  store.patchSession('sess-ok-1', { tags: ['bug'] })
  const transport = tagTransport({
    items: [
      { id: 'sess-ok-1', tags: ['bug', '新词A', '新词B', '新词C'], intent: '开发', reason: 'r1' },
      { id: 'sess-ok-2', tags: ['体力活'], intent: '不存在的意图', reason: 'r2' },
      { id: 'sess-running', tags: ['bug'], intent: '开发' },
    ],
  })
  const { service } = makeEnv({ store, transport, agentDefaultModel: selectModel() })
  const preview = await service.previewTags({ sessionIds: ['sess-ok-1', 'sess-ok-2', 'sess-running'] })
  assert.deepEqual(preview.vocabulary.sort(), ['bug', '华为'])
  assert.equal(preview.mode, 'suggest')
  const byId = new Map(preview.items.map((item) => [item.sessionId, item]))
  assert.deepEqual(byId.get('sess-ok-1').suggestions, ['新词A', '新词B'])
  assert.equal(byId.get('sess-ok-1').intent, '开发')
  assert.deepEqual(byId.get('sess-ok-2').suggestions, ['体力活'])
  assert.equal(byId.get('sess-ok-2').intent, null)
  assert.equal(byId.get('sess-running').skipReason, 'running')
})

test('previewTags in closed mode drops words outside the vocabulary', async () => {
  const store = makeStore()
  store.ensureTagDef('bug', 'manual')
  const transport = tagTransport({ items: [{ id: 'sess-ok-1', tags: ['bug', '新词'], intent: '排查' }] })
  const { service } = makeEnv({ store, transport, agentDefaultModel: selectModel() })
  const preview = await service.previewTags({ sessionIds: ['sess-ok-1'], mode: 'apply' })
  assert.equal(preview.mode, 'closed')
  assert.deepEqual(preview.items[0].suggestions, ['bug'])
})

test('previewTags is read-only', async () => {
  const store = makeStore()
  const transport = tagTransport({ items: [{ id: 'sess-ok-1', tags: ['x'], intent: '其它' }] })
  const { service } = makeEnv({ store, transport, agentDefaultModel: selectModel() })
  const before = JSON.stringify(store.state)
  const version = store.version
  await service.previewTags({ sessionIds: ['sess-ok-1'] })
  assert.equal(JSON.stringify(store.state), before)
  assert.equal(store.version, version)
})

test('applyTags appends tags, records the intent and creates tag definitions', async () => {
  const store = makeStore()
  const { service } = makeEnv({ store, agentDefaultModel: selectModel() })
  const result = await service.applyTags({
    items: [
      { sessionId: 'sess-ok-1', tags: ['bug', '新词'], intent: '排查' },
      { sessionId: 'sess-ok-2', tags: [], intent: '文档' },
    ],
  })
  assert.equal(result.applied.length, 2)
  assert.deepEqual(store.sessionOf('sess-ok-1').tags, ['bug', '新词'])
  assert.equal(store.sessionOf('sess-ok-1').intent, '排查')
  assert.equal(store.sessionOf('sess-ok-2').intent, '文档')
  assert.ok(store.tagDefs().some((def) => def.name === 'bug'))
  assert.ok(store.tagDefs().some((def) => def.name === '新词'))
})

test('applyTags re-validates the skip rules and ignores an unknown intent', async () => {
  const store = makeStore()
  const { service } = makeEnv({ store, agentDefaultModel: selectModel() })
  const result = await service.applyTags({
    items: [
      { sessionId: 'sess-running', tags: ['bug'] },
      { sessionId: 'sess-ok-1', tags: ['bug'], intent: '胡说' },
      { sessionId: 'sess-ok-2', tags: [], intent: null },
    ],
  })
  assert.deepEqual(result.skipped.map((entry) => [entry.sessionId, entry.code]), [
    ['sess-running', 'running'],
    ['sess-ok-2', 'empty'],
  ])
  assert.equal(result.applied.length, 1)
  assert.equal(store.sessionOf('sess-ok-1').intent, null)
  assert.equal(store.sessionOf('sess-running').tags.length, 0)
})

test('AI_LIMITS matches the product defaults', () => {
  assert.equal(AI_LIMITS.batchSize, 8)
  assert.equal(AI_LIMITS.concurrency, 2)
  assert.equal(AI_LIMITS.maxSessionsPerRun, 50)
  assert.equal(AI_LIMITS.timeoutMs, 120000)
  assert.equal(AI_LIMITS.titleMaxChars, 48)
  assert.equal(AI_LIMITS.contentChars, 800)
})
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore } from '../host/store.js'
import { emptyFacts } from '../host/sessions.js'
import {
  AI_LIMITS,
  INTENTS,
  RENAME_SYSTEM_PROMPT,
  TAGS_SYSTEM_PROMPT,
  buildRenamePrompt,
  buildRenameSystemPrompt,
  buildTagsPrompt,
  buildTagsSystemPrompt,
  createAiService,
  extractJson,
  parseRenameResult,
  parseTagsResult,
  sanitizeTitle,
  stripFence,
} from '../host/ai.js'

const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const CR = String.fromCharCode(13)
const BACKTICK = String.fromCharCode(96)
const silentLogger = { warn() {}, error() {}, info() {}, debug() {} }

const BATCH = [
  { id: 'sess-a', currentTitle: 'old a', firstMessage: 'first a', cwd: '/home/u/proj-alpha' },
  { id: 'sess-b', currentTitle: 'old b', firstMessage: 'first b', cwd: '/home/u/proj-beta' },
]

test('rename system prompt pins the JSON contract, the cap and one-line titles', () => {
  const prompt = RENAME_SYSTEM_PROMPT
  assert.ok(prompt.includes('{"items":['), 'must show the JSON envelope')
  assert.ok(prompt.includes('"id"') && prompt.includes('"title"') && prompt.includes('"reason"'))
  assert.ok(prompt.includes('单行'), 'must demand a single-line title')
  assert.ok(prompt.includes('换行'), 'must forbid newlines')
  assert.ok(prompt.includes(String(AI_LIMITS.titleMaxChars) + ' 个字符'), 'must state the title cap')
  assert.ok(prompt.includes('只输出 JSON'), 'must forbid prose around the JSON')
  assert.ok(prompt.includes('markdown'), 'must forbid markdown fences')
  assert.ok(prompt.split(NL).length > 3, 'is written as multiple instruction lines')
})

test('the title cap in the prompt follows the setting', () => {
  const tight = buildRenameSystemPrompt(24)
  assert.ok(tight.includes('24 个字符'))
  assert.equal(tight.includes('48 个字符'), false)
  assert.equal(buildRenameSystemPrompt(999).includes('120 个字符'), true, 'clamped to TITLE_MAX_LENGTH')
})

test('tag system prompt pins the closed intent set and the new-word budget', () => {
  const prompt = TAGS_SYSTEM_PROMPT
  for (const intent of INTENTS) assert.ok(prompt.includes(intent), 'missing intent ' + intent)
  assert.ok(prompt.includes('闭集'))
  assert.ok(prompt.includes(String(AI_LIMITS.maxNewTagsPerItem) + ' 个'), 'must state the new-word budget')
  assert.ok(prompt.includes('{"items":['))
  assert.ok(prompt.includes('"tags"') && prompt.includes('"intent"'))
  assert.ok(prompt.includes('优先只使用'), 'must prefer the existing vocabulary')
  assert.ok(prompt.includes('不带 # 前缀'))
})

test('buildRenamePrompt lists exactly the given batch with ids and titles', () => {
  const prompt = buildRenamePrompt(BATCH)
  assert.ok(prompt.includes('id: sess-a'))
  assert.ok(prompt.includes('id: sess-b'))
  assert.ok(prompt.includes('old a'))
  assert.ok(prompt.includes('工作目录：proj-alpha'))
  assert.ok(prompt.includes('共 2 条'))
  assert.equal(prompt.includes('sess-c'), false)
})

test('buildRenamePrompt truncates the first message and omits an empty one', () => {
  const longText = 'A'.repeat(900) + 'ZZZ'
  const prompt = buildRenamePrompt([{ id: 'sess-a', firstMessage: longText }])
  assert.equal(prompt.includes('ZZZ'), false, 'must cut at contentChars')
  assert.ok(prompt.includes('A'.repeat(100)))
  const empty = buildRenamePrompt([{ id: 'sess-a', firstMessage: '' }])
  assert.equal(empty.includes('首条人类消息'), false)
})

test('buildTagsPrompt switches between open and closed vocabulary wording', () => {
  const open = buildTagsPrompt(BATCH, { vocabulary: ['bug', '华为'], mode: 'suggest' })
  assert.ok(open.includes('优先只用这些'))
  assert.ok(open.includes('bug、华为'))
  assert.ok(open.includes('id: sess-a'))
  const closed = buildTagsPrompt(BATCH, { vocabulary: ['bug'], mode: 'closed' })
  assert.ok(closed.includes('不得引入新词'))
  assert.equal(closed.includes('优先只用这些'), false)
  const empty = buildTagsPrompt(BATCH, { vocabulary: [] })
  assert.ok(empty.includes('暂无已有标签'))
})

test('sanitizeTitle flattens, strips code marks and caps length', () => {
  assert.equal(sanitizeTitle('  hello   world  '), 'hello world')
  assert.equal(sanitizeTitle('line one' + NL + 'line two'), 'line one line two')
  assert.equal(sanitizeTitle('tab' + TAB + 'sep'), 'tab sep')
  assert.equal(sanitizeTitle('cr' + CR + 'sep'), 'cr sep')
  assert.equal(sanitizeTitle('# 标题'), '标题')
  assert.equal(sanitizeTitle('a ' + BACKTICK + 'b' + BACKTICK), 'a b')
  assert.equal(Array.from(sanitizeTitle('标'.repeat(60), 10)).length, 10)
  assert.equal(Array.from(sanitizeTitle('标'.repeat(60))).length, AI_LIMITS.titleMaxChars)
  assert.equal(sanitizeTitle('   '), '')
})

test('extractJson tolerates fences and surrounding prose', () => {
  const fenced = BACKTICK.repeat(3) + 'json' + NL + '{"items":[]}' + NL + BACKTICK.repeat(3)
  assert.deepEqual(extractJson(fenced), { items: [] })
  assert.deepEqual(extractJson('sure: ' + JSON.stringify({ items: [{ id: 'x' }] }) + ' thanks'), { items: [{ id: 'x' }] })
  assert.deepEqual(extractJson('[{"id":"x"}]'), [{ id: 'x' }])
  assert.equal(extractJson('no json here'), null)
  assert.equal(extractJson(''), null)
  assert.equal(stripFence('plain'), 'plain')
})

test('parseRenameResult accepts both envelopes and drops malformed entries', () => {
  const objects = parseRenameResult(JSON.stringify({ items: [{ id: 'a', title: 'T a', reason: 'r' }, { id: 'b', title: 'T b' }] }))
  assert.deepEqual(objects, [
    { id: 'a', title: 'T a', reason: 'r' },
    { id: 'b', title: 'T b', reason: '' },
  ])
  const bare = parseRenameResult(JSON.stringify([{ id: 'a', title: 'T a' }]))
  assert.deepEqual(bare, [{ id: 'a', title: 'T a', reason: '' }])
  const filtered = parseRenameResult(JSON.stringify([{ title: 'no id' }, { id: 'keep', title: 'ok' }, { id: 'empty', title: '  ' }, 'junk']))
  assert.deepEqual(filtered, [{ id: 'keep', title: 'ok', reason: '' }])
})

test('parseRenameResult enforces the one-line and length rules', () => {
  const parsed = parseRenameResult(
    JSON.stringify([{ id: 'a', title: 'multi' + NL + 'line' + TAB + 'title' }, { id: 'b', title: '标'.repeat(80) }]),
  )
  assert.equal(parsed[0].title, 'multi line title')
  assert.equal(Array.from(parsed[1].title).length, AI_LIMITS.titleMaxChars)
  const tight = parseRenameResult(JSON.stringify([{ id: 'b', title: '标'.repeat(80) }]), { titleMaxChars: 10 })
  assert.equal(Array.from(tight[0].title).length, 10)
})

test('parseRenameResult returns null for unusable payloads', () => {
  assert.equal(parseRenameResult('not json'), null)
  assert.equal(parseRenameResult('{"items":[]}'), null)
  assert.equal(parseRenameResult('{"items":[{"id":"a"}]}'), null)
})

test('parseTagsResult normalizes to the existing vocabulary casing', () => {
  const parsed = parseTagsResult(
    JSON.stringify({ items: [{ id: 'a', tags: ['BUG', 'bug', '华为'], intent: '开发' }] }),
    { vocabulary: ['bug', '华为'] },
  )
  assert.deepEqual(parsed, [{ id: 'a', tags: ['bug', '华为'], intent: '开发', reason: '' }])
})

test('parseTagsResult enforces the new-word budget in suggest mode', () => {
  const parsed = parseTagsResult(
    JSON.stringify({ items: [{ id: 'a', tags: ['新一', '新二', '新三', '新四'], intent: '其它' }] }),
    { vocabulary: ['bug'], maxNewTags: 2 },
  )
  assert.deepEqual(parsed[0].tags, ['新一', '新二'])
})

test('parseTagsResult drops every word outside a closed vocabulary', () => {
  const parsed = parseTagsResult(
    JSON.stringify({ items: [{ id: 'a', tags: ['新一', 'bug'], intent: '排查' }] }),
    { vocabulary: ['bug'], mode: 'closed' },
  )
  assert.deepEqual(parsed[0].tags, ['bug'])
})

test('parseTagsResult keeps only the closed intent set', () => {
  const parsed = parseTagsResult(
    JSON.stringify({ items: [{ id: 'a', tags: ['bug'], intent: '胡思乱想' }, { id: 'b', tags: ['bug'], intent: '文档' }] }),
    { vocabulary: ['bug'] },
  )
  assert.equal(parsed[0].intent, null)
  assert.equal(parsed[1].intent, '文档')
})

test('parseTagsResult returns null when nothing is usable', () => {
  assert.equal(parseTagsResult('nope'), null)
  assert.equal(parseTagsResult(JSON.stringify({ items: [{ id: 'a', tags: [], intent: '瞎猜' }] })), null)
})

test('the title cap setting reaches the prompt and the proposal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prompt-'))
  const store = new StateStore({ dataDir: dir, logger: silentLogger })
  store.loadSync()
  const prompts = []
  const transport = {
    async complete(request) {
      prompts.push((request.system ?? '') + NL + request.prompt)
      const ids = []
      const matcher = /id: (\S+)/g
      let match = matcher.exec(request.prompt)
      while (match) {
        ids.push(match[1])
        match = matcher.exec(request.prompt)
      }
      return JSON.stringify({ items: ids.map((id) => ({ id, title: '标'.repeat(60) })) })
    },
  }
  const service = createAiService({
    store,
    sessions: {
      async list() {
        return [{ id: 'sess-a', running: false, blank: false, cwd: '/tmp/x', archived: false }]
      },
      async factsOf(id) {
        return { ...emptyFacts(), title: 'old ' + id, firstMessage: 'first ' + id }
      },
    },
    settings: { ai: { titleMaxChars: 12 } },
    logger: silentLogger,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    transport,
  })
  const preview = await service.previewRename({ sessionIds: ['sess-a'] })
  assert.ok(prompts[0].includes('12 个字符'))
  assert.equal(Array.from(preview.items[0].proposed).length, 12)
})
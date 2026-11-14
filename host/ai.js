/**
 * AI batch pipeline: rename and tag Sessions, preview-then-apply (PRD §6).
 *
 * Two hard rules shape this module:
 *   1. Preview never writes. It only reads facts and asks the model; every
 *      excluded Session is reported with a machine-readable skipReason.
 *   2. Apply re-validates every item against the *current* corpus. A client
 *      posting an arbitrary item list can never bypass the skip rules or a
 *      title lock, and apply never invents data the preview did not produce.
 *
 * Model access is a single injected transport.complete({system, prompt, ...})
 * in tests; in the composition it is built from the host llm service with the
 * route taken from agentDefaultModel (no second credential source).
 */

import path from 'node:path'

import { StateError, TITLE_MAX_LENGTH, normalizeTag, normalizeTags } from './store.js'

/** Closed intent vocabulary (CONTEXT.md "意图"). */
export const INTENTS = Object.freeze(['开发', '排查', '调研', '文档', '运维', '其它'])

export const AI_LIMITS = Object.freeze({
  batchSize: 8,
  concurrency: 2,
  maxSessionsPerRun: 50,
  timeoutMs: 120000,
  maxTokens: 2048,
  /** First human message characters sent to the model. */
  contentChars: 800,
  /** New words a single tag suggestion may introduce (PRD §6). */
  maxNewTagsPerItem: 2,
  /** Suggestions kept per Session. */
  maxSuggestionsPerItem: 4,
  /** Existing tag vocabulary shown to the model. */
  vocabularyLimit: 60,
  titleMaxChars: 48,
  reasonChars: 120,
})

/** Why a Session was excluded from a batch operation. */
export const SKIP_REASONS = Object.freeze({
  missing: 'missing',
  running: 'running',
  blank: 'blank',
  subagent: 'subagent',
  archived: 'archived',
  titleLocked: 'titleLocked',
  empty: 'empty',
  unchanged: 'unchanged',
  invalidTitle: 'invalid_title',
  invalidItem: 'invalid_item',
  llmFailed: 'llm_failed',
  unparsable: 'unparsable',
  timeout: 'timeout',
  missingInResponse: 'missing_in_response',
})

const FAILURE_REASONS = new Set([
  SKIP_REASONS.llmFailed,
  SKIP_REASONS.unparsable,
  SKIP_REASONS.timeout,
  SKIP_REASONS.missingInResponse,
])

const SKIP_MESSAGES = {
  missing: 'this Session no longer exists',
  running: 'the Session is running',
  blank: 'the Session has no human input yet',
  subagent: 'subagent Sessions never take part in batch operations',
  archived: 'the Session is archived',
  titleLocked: 'the title was changed by hand and is locked',
  empty: 'nothing to apply',
  unchanged: 'the proposed title equals the current one',
  invalid_title: 'the title is empty after normalization',
  invalid_item: 'an item needs a sessionId',
}

const NL = String.fromCharCode(10)
const BACKTICK = String.fromCharCode(96)
const BACKSLASH = String.fromCharCode(92)
const SLASH = String.fromCharCode(47)

const asText = (value) => (typeof value === 'string' ? value : '')

const clampInt = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Slice by code points, collapse whitespace, drop newlines: titles stay one line. */
export function sanitizeTitle(raw, maxChars = AI_LIMITS.titleMaxChars) {
  const limit = clampInt(maxChars, 1, TITLE_MAX_LENGTH, AI_LIMITS.titleMaxChars)
  const flat = asText(raw).replace(/\s+/g, ' ').trim()
  const withoutMarkdown = flat.split(BACKTICK).join('').replace(/^#+\s*/, '').trim()
  return Array.from(withoutMarkdown).slice(0, limit).join('').trim()
}

const cut = (value, max) => Array.from(String(value ?? '')).slice(0, max).join('')

const labelOf = (model) => (model ? asText(model.provider) + '/' + asText(model.model) : null)

/** JSON envelopes used by the prompts; exported through the builders below. */
const RENAME_SCHEMA = '{"items":[{"id":"<会话 id 原样>","title":"<新标题>","reason":"<一句话依据>"}]}'
const TAGS_SCHEMA = '{"items":[{"id":"<会话 id 原样>","tags":["<标签>"],"intent":"<意图>","reason":"<一句话依据>"}]}'

/**
 * System prompt for batch rename. The title cap is interpolated because it is
 * a setting (settings.ai.titleMaxChars), not a constant.
 */
export function buildRenameSystemPrompt(titleMaxChars = AI_LIMITS.titleMaxChars) {
  const limit = clampInt(titleMaxChars, 1, TITLE_MAX_LENGTH, AI_LIMITS.titleMaxChars)
  return [
    '你是 DSH 会话命名助手。用户给你若干会话的现有标题、首条人类消息与工作目录，你为每个会话拟一个更准确、更具体的新标题。',
    '只输出 JSON，不要输出任何解释、markdown 代码围栏或多余文字。',
    '输出格式：' + RENAME_SCHEMA,
    '要求：',
    '- id 必须原样使用输入里给出的值；不得新增会话，也不得遗漏任何一条输入会话。',
    '- title 必须是单行纯文本：不得包含换行、制表符、代码围栏或 markdown 标记，也不要加引号。',
    '- title 不超过 ' + limit + ' 个字符（一个中文字符算 1 个字符），长度宁短勿长。',
    '- title 用用户的语种书写，描述这次会话实际在做什么，不要出现“会话”“对话”“新会话”这类空词。',
    '- reason 是一句不超过 60 字的中文依据，说明标题依据哪部分内容得出。',
    '- 不要猜测输入里没有的信息，不要输出输入以外的字段。',
  ].join(NL)
}

/** System prompt for tag + intent suggestions. */
export function buildTagsSystemPrompt(maxNewTags = AI_LIMITS.maxNewTagsPerItem) {
  const newLimit = clampInt(maxNewTags, 0, 4, AI_LIMITS.maxNewTagsPerItem)
  return [
    '你是 DSH 会话打标签助手。用户给你若干会话的标题、首条人类消息与现有标签词表，你为每个会话给出标签与意图。',
    '只输出 JSON，不要输出任何解释、markdown 代码围栏或多余文字。',
    '输出格式：' + TAGS_SCHEMA,
    '要求：',
    '- id 必须原样使用输入里给出的值；不得新增会话，也不得遗漏任何一条输入会话。',
    '- tags 每个都是单行短词，不带 # 前缀，不超过 24 个字符，不在词表里的新词每条最多 ' + newLimit + ' 个。',
    '- 优先只使用输入词表里已有的标签；词表里没有合适的词时才引入新词。',
    '- 每个会话最多给 ' + AI_LIMITS.maxSuggestionsPerItem + ' 个标签，宁缺勿滥。',
    '- intent 必须严格取以下闭集之一：' + INTENTS.join(' / ') + '。',
    '- reason 是一句不超过 60 字的依据。',
  ].join(NL)
}

export const RENAME_SYSTEM_PROMPT = buildRenameSystemPrompt(AI_LIMITS.titleMaxChars)
export const TAGS_SYSTEM_PROMPT = buildTagsSystemPrompt(AI_LIMITS.maxNewTagsPerItem)

const TRAILING_SEPARATORS = new RegExp('[' + BACKSLASH + BACKSLASH + SLASH + ']+$')

const cwdLabel = (cwd) => {
  const value = asText(cwd).trim()
  if (value === '') return ''
  return path.basename(value.replace(TRAILING_SEPARATORS, '')) || value
}

/**
 * User prompt for one rename batch.
 * @param {Array<{id: string, currentTitle?: string, firstMessage?: string, cwd?: string}>} batch
 */
export function buildRenamePrompt(batch) {
  const items = Array.isArray(batch) ? batch : []
  const lines = ['会话（共 ' + items.length + ' 条，逐条给出结果）：']
  items.forEach((item, index) => {
    lines.push('')
    lines.push('[' + (index + 1) + '] id: ' + asText(item?.id))
    lines.push('现有标题：' + (asText(item?.currentTitle) || '（无）'))
    if (asText(item?.firstMessage).trim() !== '') {
      lines.push('首条人类消息（截断 ' + AI_LIMITS.contentChars + ' 字）：' + cut(item.firstMessage, AI_LIMITS.contentChars))
    }
    const cwd = cwdLabel(item?.cwd)
    if (cwd !== '') lines.push('工作目录：' + cwd)
  })
  lines.push('')
  lines.push('请按上述 id 逐条输出新标题。')
  return lines.join(NL)
}

/**
 * User prompt for one tag batch. The vocabulary is a closed set: the model is
 * told to prefer it, and mode 'closed' forbids anything outside it entirely.
 * @param {Array<{id: string, currentTitle?: string, firstMessage?: string, cwd?: string}>} batch
 * @param {{vocabulary?: string[], mode?: 'suggest'|'closed'}} options
 */
export function buildTagsPrompt(batch, options = {}) {
  const items = Array.isArray(batch) ? batch : []
  const vocabulary = (Array.isArray(options.vocabulary) ? options.vocabulary : [])
    .map((tag) => asText(tag).trim())
    .filter((tag) => tag !== '')
    .slice(0, AI_LIMITS.vocabularyLimit)
  const closed = options.mode === 'closed'
  const lines = []
  lines.push(closed
    ? '标签词表（闭集：只能从这些标签里选，不得引入新词）：'
    : '标签词表（优先只用这些；都不合适时才可引入新词）：')
  lines.push(vocabulary.length > 0 ? vocabulary.join('、') : '（暂无已有标签）')
  lines.push('')
  lines.push('会话（共 ' + items.length + ' 条，逐条给出结果）：')
  items.forEach((item, index) => {
    lines.push('')
    lines.push('[' + (index + 1) + '] id: ' + asText(item?.id))
    lines.push('标题：' + (asText(item?.currentTitle) || '（无）'))
    if (asText(item?.firstMessage).trim() !== '') {
      lines.push('首条人类消息（截断 ' + AI_LIMITS.contentChars + ' 字）：' + cut(item.firstMessage, AI_LIMITS.contentChars))
    }
    const cwd = cwdLabel(item?.cwd)
    if (cwd !== '') lines.push('工作目录：' + cwd)
  })
  lines.push('')
  lines.push('请按上述 id 逐条输出标签与意图。')
  return lines.join(NL)
}

/** Strip a markdown code fence from a model answer (shared by both parsers). */
export function stripFence(raw) {
  const fence = BACKTICK + BACKTICK + BACKTICK
  let text = asText(raw).trim()
  if (text.startsWith(fence)) {
    text = text.slice(3)
    const breakIndex = text.indexOf(NL)
    text = breakIndex >= 0 ? text.slice(breakIndex + 1) : text
    if (text.endsWith(fence)) text = text.slice(0, -3)
    text = text.trim()
  }
  return text
}

/** Parse the first balanced JSON value, tolerating prose around it. */
export function extractJson(text) {
  const unfenced = stripFence(asText(text))
  if (unfenced === '') return null
  const candidates = [unfenced]
  const firstBrace = unfenced.indexOf('{')
  const lastBrace = unfenced.lastIndexOf('}')
  const braceSlice = firstBrace >= 0 && lastBrace > firstBrace ? unfenced.slice(firstBrace, lastBrace + 1) : null
  const firstBracket = unfenced.indexOf('[')
  const lastBracket = unfenced.lastIndexOf(']')
  const bracketSlice = firstBracket >= 0 && lastBracket > firstBracket ? unfenced.slice(firstBracket, lastBracket + 1) : null
  const slices = [
    ['brace', braceSlice, firstBrace],
    ['bracket', bracketSlice, firstBracket],
  ]
    .filter((entry) => Boolean(entry[1]))
    .sort((left, right) => left[2] - right[2])
  for (const entry of slices) if (entry[1] !== unfenced) candidates.push(entry[1])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

function itemListOf(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.items)) return parsed.items
  if (parsed && Array.isArray(parsed.results)) return parsed.results
  return null
}

const idOf = (entry) => asText(entry?.id ?? entry?.sessionId ?? entry?.session_id).trim()

/**
 * Strict parse of a rename batch. Returns null when the payload is unusable
 * (the whole batch is then reported as failed); individual malformed entries
 * are dropped rather than guessed at.
 * @returns {Array<{id: string, title: string, reason: string}>|null}
 */
export function parseRenameResult(text, options = {}) {
  const maxChars = clampInt(options.titleMaxChars, 1, TITLE_MAX_LENGTH, AI_LIMITS.titleMaxChars)
  const parsed = extractJson(text)
  if (parsed === null) return null
  const list = itemListOf(parsed)
  if (!list) return null
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const id = idOf(entry)
    const title = sanitizeTitle(entry.title ?? entry.name ?? entry.newTitle, maxChars)
    if (id === '' || title === '') continue
    out.push({
      id,
      title,
      reason: cut(asText(entry.reason ?? entry.why).replace(/\s+/g, ' ').trim(), AI_LIMITS.reasonChars),
    })
  }
  return out.length > 0 ? out : null
}

/**
 * Strict parse of a tag batch. Enforces the closed intent set and the
 * new-word budget; entries with no usable tag and no intent are dropped.
 * @returns {Array<{id: string, tags: string[], intent: string|null, reason: string}>|null}
 */
export function parseTagsResult(text, options = {}) {
  const vocabulary = (Array.isArray(options.vocabulary) ? options.vocabulary : [])
    .map((tag) => normalizeTag(tag))
    .filter((tag) => tag !== '')
  const vocabByKey = new Map(vocabulary.map((tag) => [tag.toLowerCase(), tag]))
  const closed = options.mode === 'closed'
  const maxNew = clampInt(options.maxNewTags, 0, 4, AI_LIMITS.maxNewTagsPerItem)
  const parsed = extractJson(text)
  if (parsed === null) return null
  const list = itemListOf(parsed)
  if (!list) return null
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const id = idOf(entry)
    if (id === '') continue
    const rawTags = Array.isArray(entry.tags) ? entry.tags : Array.isArray(entry.labels) ? entry.labels : []
    const tags = []
    const seen = new Set()
    let introduced = 0
    for (const raw of rawTags) {
      const tag = normalizeTag(raw)
      if (tag === '') continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      const known = vocabByKey.get(key)
      if (known) {
        seen.add(key)
        tags.push(known)
      } else {
        if (closed || introduced >= maxNew) continue
        introduced += 1
        seen.add(key)
        tags.push(tag)
      }
      if (tags.length >= AI_LIMITS.maxSuggestionsPerItem) break
    }
    const rawIntent = asText(entry.intent ?? entry.category).trim()
    const intent = INTENTS.includes(rawIntent) ? rawIntent : null
    if (tags.length === 0 && !intent) continue
    out.push({
      id,
      tags,
      intent,
      reason: cut(asText(entry.reason).replace(/\s+/g, ' ').trim(), AI_LIMITS.reasonChars),
    })
  }
  return out.length > 0 ? out : null
}

/** Reject as soon as the shared AbortController fires, even if the transport ignores signals. */
function abortRejection(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('the AI batch exceeded its overall time budget')
      error.code = 'timeout'
      reject(error)
    }
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  const size = Math.max(1, Math.min(items.length || 1, limit))
  let cursor = 0
  await Promise.all(new Array(size).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.sessions
 * @param {object} [deps.statusIndex]       ensure(ids) is called before a preview gathers facts
 * @param {object} [deps.settings]          defaults to store.settings
 * @param {object} [deps.logger]
 * @param {object} [deps.llm]               ctx.get('llm')
 * @param {object} [deps.agentDefaultModel] ctx.get('agentDefaultModel')
 * @param {{complete: Function}} [deps.transport] injected model transport (tests)
 * @param {number} [deps.timeoutMs]         overall budget override (tests)
 */
export function createAiService({
  store,
  sessions,
  statusIndex,
  settings,
  logger,
  llm,
  agentDefaultModel,
  transport = null,
  timeoutMs,
} = {}) {
  if (!store) throw new Error('createAiService needs a store')
  if (!sessions) throw new Error('createAiService needs a session source')

  const warn = (message) => logger?.warn?.('session-studio: ' + message)

  let builtTransport = null

  const aiSettings = () => {
    const ai = (settings && typeof settings === 'object' ? settings.ai : null) ?? store.settings?.ai ?? {}
    return {
      batchSize: clampInt(ai.batchSize, 1, 50, AI_LIMITS.batchSize),
      concurrency: clampInt(ai.concurrency, 1, 8, AI_LIMITS.concurrency),
      maxSessionsPerRun: clampInt(ai.maxSessionsPerRun, 1, 500, AI_LIMITS.maxSessionsPerRun),
      readContent: ai.readContent !== false,
      titleMaxChars: clampInt(ai.titleMaxChars, 1, TITLE_MAX_LENGTH, AI_LIMITS.titleMaxChars),
    }
  }

  const budgetMs = () => clampInt(timeoutMs ?? store.settings?.ai?.timeoutMs, 100, 600000, AI_LIMITS.timeoutMs)

  /** Route: agentDefaultModel's current selection; an injected transport overrides the call itself. */
  function resolveModel() {
    let selection = null
    try {
      selection = typeof agentDefaultModel?.currentSelection === 'function' ? agentDefaultModel.currentSelection() : null
    } catch {
      selection = null
    }
    const provider = asText(selection?.provider ?? selection?.providerId).trim()
    const model = asText(selection?.model ?? selection?.modelId).trim()
    if (provider !== '' && model !== '') {
      const effort = asText(selection?.reasoningEffort).trim()
      return { provider, model, ...(effort !== '' ? { reasoningEffort: effort } : {}) }
    }
    if (transport) return { provider: 'injected', model: 'transport' }
    return null
  }

  function llmUnavailable(message) {
    const error = new StateError('llm_unavailable', message)
    error.status = 503
    error.httpStatus = 503
    return error
  }

  function requireModel() {
    const model = resolveModel()
    if (!model) {
      if (!llm && !transport) throw llmUnavailable('this composition exposes no model service')
      throw llmUnavailable('no default model is configured; set one before using AI batch operations')
    }
    return model
  }

  function buildLlmTransport() {
    return {
      async complete({ system, prompt, maxTokens, signal, model }) {
        const stream = llm.stream({
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: maxTokens ?? AI_LIMITS.maxTokens,
          signal,
        })
        let text = ''
        for await (const chunk of stream) {
          if (chunk === null || typeof chunk !== 'object') continue
          if (chunk.type === 'text-delta') text += asText(chunk.text)
          else if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'error' || kind === 'aborted') {
              const failure = chunk.reason?.failure ?? {}
              const error = new Error(asText(failure.message) || 'model call finished with ' + String(kind))
              error.code = kind === 'aborted' ? 'timeout' : 'llm_failed'
              throw error
            }
          }
        }
        return { text }
      },
    }
  }

  function getTransport() {
    if (transport) return transport
    if (!builtTransport) builtTransport = buildLlmTransport()
    return builtTransport
  }

  function available() {
    const model = resolveModel()
    if (!model) return { ok: false, reason: !llm && !transport ? 'llm_unavailable' : 'no_default_model' }
    return { ok: true, model: { provider: model.provider, model: model.model }, modelLabel: labelOf(model) }
  }

  async function listRows() {
    try {
      const rows = await sessions.list()
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      warn('session list failed: ' + String(error?.message ?? error))
      return []
    }
  }

  async function warmStatus(ids) {
    if (!statusIndex || typeof statusIndex.ensure !== 'function' || ids.length === 0) return
    try {
      await statusIndex.ensure(ids)
    } catch (error) {
      warn('status ensure failed: ' + String(error?.message ?? error))
    }
  }

  /** Fetch facts for many Sessions through the bounded head+tail reader. */
  async function gatherFacts(ids, concurrency) {
    const out = new Map()
    await mapPool(ids, Math.max(1, concurrency), async (id) => {
      try {
        out.set(id, (await sessions.factsOf(id)) ?? {})
      } catch (error) {
        out.set(id, { error: String(error?.message ?? error) })
      }
    })
    return out
  }

  const isSubagentRow = (row) => Boolean(row?.parentSessionId) || row?.origin === 'subagent'

  /** Single source of truth for the skip rules; used by preview *and* apply. */
  function skipFor(row, record, { forRename, includeArchived = false }) {
    if (!row) return SKIP_REASONS.missing
    if (row.running) return SKIP_REASONS.running
    if (row.blank) return SKIP_REASONS.blank
    if (isSubagentRow(row)) return SKIP_REASONS.subagent
    if (row.archived && !includeArchived) return SKIP_REASONS.archived
    if (forRename && record?.titleLocked) return SKIP_REASONS.titleLocked
    return null
  }

  const normalizeIds = (value) => {
    const list = Array.isArray(value) ? value : []
    const seen = new Set()
    const out = []
    for (const raw of list) {
      const id = asText(raw).trim()
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }

  const currentTitleOf = (row, facts) => asText(facts?.title).trim() || asText(row?.title).trim() || ''

  function inputFor(id, row, facts, useContent) {
    return {
      id,
      currentTitle: currentTitleOf(row, facts),
      firstMessage: useContent ? cut(asText(facts?.firstMessage), AI_LIMITS.contentChars) : '',
      cwd: asText(row?.cwd),
    }
  }

  /**
   * Run the model over batches with bounded concurrency and one overall budget.
   * Batch failures never abort sibling batches: every id gets an outcome.
   * @returns {Promise<Map<string, {value?: object, code?: string, message?: string}>>}
   */
  async function runBatches(inputs, ai, { system, buildPrompt, parse, maxTokens }) {
    const results = new Map()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budgetMs())
    timer.unref?.()

    const chunks = []
    for (let index = 0; index < inputs.length; index += ai.batchSize) {
      chunks.push(inputs.slice(index, index + ai.batchSize))
    }

    const mark = (batch, code, message) => {
      for (const item of batch) results.set(item.id, { code, message })
    }

    try {
      await mapPool(chunks, ai.concurrency, async (batch) => {
        if (controller.signal.aborted) {
          mark(batch, SKIP_REASONS.timeout, 'the AI batch exceeded its overall time budget')
          return
        }
        const pending = getTransport().complete({
          system,
          prompt: buildPrompt(batch),
          maxTokens,
          signal: controller.signal,
          model: resolveModel(),
        })
        pending.catch(() => {})
        let text = ''
        try {
          const response = await Promise.race([pending, abortRejection(controller.signal)])
          text = typeof response === 'string' ? response : asText(response?.text)
        } catch (error) {
          const aborted = error?.code === 'timeout' || controller.signal.aborted
          mark(batch, aborted ? SKIP_REASONS.timeout : SKIP_REASONS.llmFailed, String(error?.message ?? error))
          return
        }
        let parsed = null
        try {
          parsed = parse(text, { titleMaxChars: ai.titleMaxChars })
        } catch (error) {
          warn('result parser threw: ' + String(error?.message ?? error))
        }
        if (!parsed) {
          mark(batch, SKIP_REASONS.unparsable, 'the model returned no parsable JSON for this batch')
          return
        }
        const byId = new Map(parsed.map((entry) => [entry.id, entry]))
        for (const item of batch) {
          const entry = byId.get(item.id)
          if (!entry) {
            results.set(item.id, { code: SKIP_REASONS.missingInResponse, message: 'the model omitted this Session' })
            continue
          }
          results.set(item.id, { value: entry })
        }
      })
    } finally {
      clearTimeout(timer)
    }
    return results
  }

  function vocabularyFromStore() {
    const names = []
    const seen = new Set()
    for (const def of store.tagDefs?.() ?? []) {
      const name = normalizeTag(def?.name)
      if (name === '' || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      names.push(name)
      if (names.length >= AI_LIMITS.vocabularyLimit) break
    }
    return names
  }

  /**
   * Rename preview. Zero writes; skipped and failed Sessions are both carried
   * in items with a skipReason so the dialog can explain every exclusion.
   */
  async function previewRename({ sessionIds, readContent, includeArchived = false, hooks } = {}) {
    const ai = aiSettings()
    const model = requireModel()
    const requested = normalizeIds(sessionIds)
    const meta = { model: labelOf(model), modelSelection: { provider: model.provider, model: model.model } }
    if (requested.length === 0) {
      return { items: [], skipped: 0, failed: 0, total: 0, truncated: false, dropped: 0, ...meta }
    }
    const dropped = Math.max(0, requested.length - ai.maxSessionsPerRun)
    const wanted = requested.slice(0, ai.maxSessionsPerRun)
    hooks?.onTotal?.(wanted.length)
    const useContent = readContent === undefined ? ai.readContent : Boolean(readContent)
    const rows = await listRows()
    const rowById = new Map(rows.map((row) => [row?.id, row]))
    await warmStatus(wanted)
    const factsById = await gatherFacts(wanted, ai.concurrency)

    const items = []
    const eligible = []
    for (const id of wanted) {
      const row = rowById.get(id)
      const facts = factsById.get(id) ?? {}
      const record = store.sessionOf(id)
      const skipReason = skipFor(row, record, { forRename: true, includeArchived })
      const currentTitle = currentTitleOf(row, facts)
      items.push({
        sessionId: id,
        title: currentTitle,
        currentTitle,
        proposed: null,
        reason: null,
        skipReason,
        detail: skipReason ? SKIP_MESSAGES[skipReason] ?? null : null,
      })
      if (!skipReason) eligible.push(inputFor(id, row, facts, useContent))
    }

    if (eligible.length > 0) {
      const outcomes = await runBatches(eligible, ai, {
        system: buildRenameSystemPrompt(ai.titleMaxChars),
        buildPrompt: buildRenamePrompt,
        parse: (text, options) => parseRenameResult(text, options),
        maxTokens: AI_LIMITS.maxTokens,
      })
      for (const item of items) {
        const outcome = outcomes.get(item.sessionId)
        if (!outcome || item.skipReason) continue
        if (outcome.value) {
          item.proposed = sanitizeTitle(outcome.value.title, ai.titleMaxChars)
          item.reason = asText(outcome.value.reason) || null
        } else {
          item.skipReason = outcome.code
          item.detail = outcome.message ?? null
        }
      }
    }

    for (const item of items) hooks?.onItem?.(item)
    const skipped = items.filter((item) => item.skipReason && !FAILURE_REASONS.has(item.skipReason)).length
    const failed = items.filter((item) => item.skipReason && FAILURE_REASONS.has(item.skipReason)).length
    return { items, skipped, failed, total: wanted.length, truncated: dropped > 0, dropped, ...meta }
  }

  /** Normalize posted apply items; title wins over the preview's proposed. */
  function normalizeRenameItems(rawItems, limit) {
    const list = Array.isArray(rawItems) ? rawItems : []
    const out = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      out.push({
        sessionId: asText(entry.sessionId ?? entry.id).trim(),
        title: asText(entry.title ?? entry.proposed).trim(),
      })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Apply rename items. Every item is re-checked against the live corpus;
   * nothing is written for a skipped, locked, missing, empty or unchanged title.
   */
  async function applyRename({ items: rawItems, hooks } = {}) {
    const ai = aiSettings()
    const list = normalizeRenameItems(rawItems, ai.maxSessionsPerRun)
    const rows = await listRows()
    const rowById = new Map(rows.map((row) => [row?.id, row]))
    const ids = list.map((entry) => entry.sessionId).filter((id) => id !== '')
    const factsById = ids.length > 0 ? await gatherFacts(ids, ai.concurrency) : new Map()
    const applied = []
    const failed = []
    const skipped = []

    for (const entry of list) {
      const id = entry.sessionId
      if (id === '') {
        failed.push({ sessionId: '', code: SKIP_REASONS.invalidItem, message: SKIP_MESSAGES.invalid_item })
        continue
      }
      const row = rowById.get(id)
      const record = store.sessionOf(id)
      const skipReason = skipFor(row, record, { forRename: true })
      if (skipReason) {
        const refusal = { sessionId: id, code: skipReason, message: SKIP_MESSAGES[skipReason] ?? skipReason }
        if (FAILURE_REASONS.has(skipReason)) failed.push(refusal)
        else skipped.push(refusal)
        continue
      }
      const title = sanitizeTitle(entry.title, ai.titleMaxChars)
      if (title === '') {
        failed.push({ sessionId: id, code: SKIP_REASONS.invalidTitle, message: SKIP_MESSAGES.invalid_title })
        continue
      }
      const current = currentTitleOf(row, factsById.get(id) ?? {})
      if (current !== '' && current === title) {
        skipped.push({ sessionId: id, code: SKIP_REASONS.unchanged, message: SKIP_MESSAGES.unchanged })
        continue
      }
      try {
        await sessions.rename(id, title)
        store.patchSession(id, { titleSource: 'ai', titleLocked: false })
        applied.push({ sessionId: id, title })
      } catch (error) {
        failed.push({
          sessionId: id,
          code: asText(error?.code) || 'rename_failed',
          message: String(error?.message ?? error),
        })
      }
    }

    for (const entry of applied) hooks?.onItem?.({ ...entry, code: null })
    for (const entry of failed) hooks?.onItem?.(entry)
    for (const entry of skipped) hooks?.onItem?.(entry)
    return { applied, failed, skipped }
  }

  const normalizeTagMode = (mode) => {
    const value = asText(mode).trim().toLowerCase()
    return value === 'closed' || value === 'apply' || value === 'strict' ? 'closed' : 'suggest'
  }

  /**
   * Tag/intent preview. Zero writes. Closed vocabulary is preferred; in
   * suggest mode a batch may introduce at most maxNewTagsPerItem new words per
   * Session, and those only land in suggestedTags after the user adopts them.
   */
  async function previewTags({ sessionIds, mode, includeArchived = false, hooks } = {}) {
    const ai = aiSettings()
    const model = requireModel()
    const requested = normalizeIds(sessionIds)
    const tagMode = normalizeTagMode(mode)
    const vocabulary = vocabularyFromStore()
    const meta = { vocabulary, mode: tagMode, model: labelOf(model), modelSelection: { provider: model.provider, model: model.model } }
    if (requested.length === 0) {
      return { items: [], skipped: 0, failed: 0, total: 0, truncated: false, dropped: 0, ...meta }
    }
    const dropped = Math.max(0, requested.length - ai.maxSessionsPerRun)
    const wanted = requested.slice(0, ai.maxSessionsPerRun)
    hooks?.onTotal?.(wanted.length)
    const rows = await listRows()
    const rowById = new Map(rows.map((row) => [row?.id, row]))
    await warmStatus(wanted)
    const factsById = await gatherFacts(wanted, ai.concurrency)

    const items = []
    const eligible = []
    for (const id of wanted) {
      const row = rowById.get(id)
      const facts = factsById.get(id) ?? {}
      const record = store.sessionOf(id)
      const skipReason = skipFor(row, record, { forRename: false, includeArchived })
      const currentTitle = currentTitleOf(row, facts)
      items.push({
        sessionId: id,
        title: currentTitle,
        currentTitle,
        suggestions: [],
        intent: null,
        reason: null,
        skipReason,
        detail: skipReason ? SKIP_MESSAGES[skipReason] ?? null : null,
      })
      if (!skipReason) eligible.push(inputFor(id, row, facts, ai.readContent))
    }

    if (eligible.length > 0) {
      const outcomes = await runBatches(eligible, ai, {
        system: buildTagsSystemPrompt(AI_LIMITS.maxNewTagsPerItem),
        buildPrompt: (batch) => buildTagsPrompt(batch, { vocabulary, mode: tagMode }),
        parse: (text) => parseTagsResult(text, { vocabulary, mode: tagMode, maxNewTags: AI_LIMITS.maxNewTagsPerItem }),
        maxTokens: AI_LIMITS.maxTokens,
      })
      for (const item of items) {
        const outcome = outcomes.get(item.sessionId)
        if (!outcome || item.skipReason) continue
        if (outcome.value) {
          const existing = new Set(store.sessionOf(item.sessionId).tags.map((tag) => tag.toLowerCase()))
          item.suggestions = normalizeTags(outcome.value.tags).filter((tag) => !existing.has(tag.toLowerCase()))
          item.intent = outcome.value.intent ?? null
          item.reason = asText(outcome.value.reason) || null
          if (item.suggestions.length === 0 && item.intent === null) {
            item.skipReason = SKIP_REASONS.empty
            item.detail = 'the model produced no usable tag or intent'
          }
        } else {
          item.skipReason = outcome.code
          item.detail = outcome.message ?? null
        }
      }
    }

    for (const item of items) hooks?.onItem?.(item)
    const skipped = items.filter((item) => item.skipReason && !FAILURE_REASONS.has(item.skipReason)).length
    const failed = items.filter((item) => item.skipReason && FAILURE_REASONS.has(item.skipReason)).length
    return { items, skipped, failed, total: wanted.length, truncated: dropped > 0, dropped, ...meta }
  }

  /**
   * Adopt tag/intent suggestions. Re-validates the skip rules first; appends
   * tags (never replaces or clears) and stores the intent in plugin state.
   */
  async function applyTags({ items: rawItems, hooks } = {}) {
    const ai = aiSettings()
    const list = Array.isArray(rawItems) ? rawItems.slice(0, ai.maxSessionsPerRun) : []
    const rows = await listRows()
    const rowById = new Map(rows.map((row) => [row?.id, row]))
    const applied = []
    const failed = []
    const skipped = []

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const id = asText(entry.sessionId ?? entry.id).trim()
      if (id === '') {
        failed.push({ sessionId: '', code: SKIP_REASONS.invalidItem, message: SKIP_MESSAGES.invalid_item })
        continue
      }
      const row = rowById.get(id)
      const record = store.sessionOf(id)
      const skipReason = skipFor(row, record, { forRename: false })
      if (skipReason) {
        const refusal = { sessionId: id, code: skipReason, message: SKIP_MESSAGES[skipReason] ?? skipReason }
        if (FAILURE_REASONS.has(skipReason)) failed.push(refusal)
        else skipped.push(refusal)
        continue
      }
      const tags = normalizeTags(Array.isArray(entry.tags) ? entry.tags : [])
      const rawIntent = asText(entry.intent).trim()
      const intent = INTENTS.includes(rawIntent) ? rawIntent : null
      if (tags.length === 0 && intent === null) {
        skipped.push({ sessionId: id, code: SKIP_REASONS.empty, message: SKIP_MESSAGES.empty })
        continue
      }
      try {
        if (tags.length > 0) {
          store.patchSession(id, { tags: normalizeTags([...record.tags, ...tags]) })
          for (const tag of tags) store.ensureTagDef(tag, 'ai')
        }
        if (intent !== null) store.patchSession(id, { intent })
        applied.push({ sessionId: id, tags, intent })
      } catch (error) {
        failed.push({ sessionId: id, code: asText(error?.code) || 'tag_apply_failed', message: String(error?.message ?? error) })
      }
    }

    for (const entry of applied) hooks?.onItem?.({ ...entry, code: null })
    for (const entry of failed) hooks?.onItem?.(entry)
    for (const entry of skipped) hooks?.onItem?.(entry)
    return { applied, failed, skipped }
  }

  return { available, previewRename, applyRename, previewTags, applyTags }
}
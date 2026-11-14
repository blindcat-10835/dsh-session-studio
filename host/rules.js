/**
 * Tag rules: condition → tag action (PRD §5).
 *
 * A rule matches Sessions on title / first human message / cwd / note with
 * case-insensitive substring keywords, then either *suggests* tags (default,
 * writes only `suggestedTags`) or appends tags (`apply`, never removes). All
 * evaluations are on demand: there is no background scanner, and `preview` is
 * strictly read-only.
 *
 * Facts (title / firstMessage) come from `sessions.factsOf`, which is the
 * cached head+tail read owned by the status indexer; we bound how many of those
 * reads are in flight because the corpus is ~200 Sessions.
 */

import crypto from 'node:crypto'

import { StateError, normalizeTags } from './store.js'
import { isSubagent } from './sessions.js'

/** Fields a rule may match on. Order is also the order used for evidence. */
export const RULE_FIELDS = Object.freeze(['title', 'firstMessage', 'cwd', 'note'])
/** `any`: one keyword hit is enough. `all`: every keyword must hit somewhere. */
export const RULE_MODES = Object.freeze(['any', 'all'])
/** `suggest` writes suggestedTags, `apply` appends to tags. Neither removes. */
export const RULE_ACTION_MODES = Object.freeze(['suggest', 'apply'])

export const RULE_LIMITS = Object.freeze({
  keywords: 20,
  tags: 8,
  keywordChars: 120,
  nameChars: 60,
  idChars: 80,
  previewConcurrency: 4,
  previewMaxConcurrency: 8,
})

const asText = (value) => (typeof value === 'string' ? value : '')

/** Slice by code points so a CJK keyword is never cut in half. */
const cut = (value, max) => Array.from(String(value ?? '')).slice(0, max).join('')

const clampInt = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

const invalid = (message) => new StateError('invalid_rule', message)

const keyOf = (value) => asText(value).toLowerCase()

/** Bounded-concurrency map that keeps input order in its result array. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  const size = Math.max(1, Math.min(items.length || 1, limit))
  let cursor = 0
  const runners = new Array(size).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function normalizeKeyword(raw) {
  return cut(asText(raw).replace(/\s+/g, ' ').trim(), RULE_LIMITS.keywordChars)
}

/**
 * Validate and normalize a rule body.
 *
 * Accepts both the nested `{match, action}` shape from the PRD and the flat
 * shape (`{keywords, fields, tags}`) the editor may send while drafting.
 * Throws `StateError('invalid_rule')` for anything a rule cannot run with.
 */
export function normalizeRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('a rule must be a plain object')
  }
  const match = input.match && typeof input.match === 'object' && !Array.isArray(input.match) ? input.match : input
  const action = input.action && typeof input.action === 'object' && !Array.isArray(input.action) ? input.action : input

  const rawKeywords = Array.isArray(match.keywords) ? match.keywords : []
  const seenKeywords = new Set()
  const keywords = []
  for (const raw of rawKeywords) {
    const keyword = normalizeKeyword(raw)
    if (keyword === '') continue
    const key = keyOf(keyword)
    if (seenKeywords.has(key)) continue
    seenKeywords.add(key)
    keywords.push(keyword)
    if (keywords.length >= RULE_LIMITS.keywords) break
  }
  if (keywords.length === 0) throw invalid('a rule needs at least one non-empty keyword')

  const requestedFields = Array.isArray(match.fields) && match.fields.length > 0
    ? match.fields.map((field) => asText(field).trim()).filter((field) => field !== '')
    : RULE_FIELDS.slice()
  const unknown = requestedFields.filter((field) => !RULE_FIELDS.includes(field))
  if (unknown.length > 0) throw invalid('unknown match field(s): ' + unknown.join(', '))
  const fields = RULE_FIELDS.filter((field) => requestedFields.includes(field))
  if (fields.length === 0) throw invalid('a rule needs at least one match field')

  const mode = asText(match.mode).trim().toLowerCase() || 'any'
  if (!RULE_MODES.includes(mode)) throw invalid('match mode must be one of ' + RULE_MODES.join(' or '))

  const tags = normalizeTags(Array.isArray(action.tags) ? action.tags : []).slice(0, RULE_LIMITS.tags)
  if (tags.length === 0) throw invalid('a rule needs at least one action tag')

  const actionMode = asText(action.mode).trim().toLowerCase() || 'suggest'
  if (!RULE_ACTION_MODES.includes(actionMode)) {
    throw invalid('action mode must be one of ' + RULE_ACTION_MODES.join(' or '))
  }

  const name = cut(asText(input.name).replace(/\s+/g, ' ').trim(), RULE_LIMITS.nameChars) || tags.join(' / ')
  const id = asText(input.id).trim() === '' ? null : cut(asText(input.id).trim(), RULE_LIMITS.idChars)
  const createdAt = asText(input.createdAt).trim() || new Date().toISOString()

  return {
    id,
    name,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    match: { keywords, fields, mode },
    action: { tags, mode: actionMode },
    createdAt,
    updatedAt: new Date().toISOString(),
  }
}

/** Same normalization but never throws: used when reading the stored list. */
function normalizeStored(rule) {
  try {
    return normalizeRule(rule)
  } catch {
    return null
  }
}

/** Human-readable evidence, ordered by field; the client renders it as text. */
const FIELD_LABELS = Object.freeze({ title: '标题', firstMessage: '首条消息', cwd: '工作目录', note: '备注' })

export function evidenceLabel(evidence) {
  const list = Array.isArray(evidence) ? evidence : []
  const lines = []
  for (const field of RULE_FIELDS) {
    const words = []
    for (const entry of list) {
      if (entry?.field !== field) continue
      if (!words.includes(entry.keyword)) words.push(entry.keyword)
    }
    if (words.length > 0) lines.push(FIELD_LABELS[field] + ': ' + words.join(' / '))
  }
  return lines.join('；')
}

/**
 * Evaluate one normalized rule against one Session's field texts.
 * @returns {Array<{field: string, keyword: string}>|null} evidence, or null when it does not match.
 */
export function evaluateRule(rule, sources) {
  const evidence = []
  const hit = new Set()
  for (const field of rule.match.fields) {
    const haystack = keyOf(sources?.[field])
    if (haystack === '') continue
    for (const keyword of rule.match.keywords) {
      const needle = keyOf(keyword)
      if (!haystack.includes(needle)) continue
      evidence.push({ field, keyword })
      hit.add(needle)
    }
  }
  const matched = rule.match.mode === 'all'
    ? hit.size === rule.match.keywords.length
    : hit.size > 0
  return matched && evidence.length > 0 ? evidence : null
}

/**
 * @param {object} deps
 * @param {object} deps.store      StateStore
 * @param {object} deps.sessions   createSessionSource(...)
 * @param {object} [deps.tags]     createTagService(...); falls back to direct store writes
 * @param {object} [deps.statusIndex] status indexer (only used to warm caches when present)
 * @param {object} [deps.logger]
 */
export function createRuleService({ store, sessions, tags, statusIndex, logger } = {}) {
  if (!store) throw new Error('createRuleService needs a store')
  if (!sessions) throw new Error('createRuleService needs a session source')

  const warn = (message) => logger?.warn?.('session-studio: ' + message)

  const concurrency = () => clampInt(store.settings?.status?.concurrency, 1, RULE_LIMITS.previewMaxConcurrency, RULE_LIMITS.previewConcurrency)

  const allRules = () => (Array.isArray(store.rules()) ? store.rules() : [])
  const enabledRules = () => allRules().map(normalizeStored).filter((rule) => rule && rule.enabled)

  /** Facts are cached per Session inside one evaluation pass, not across calls. */
  async function factsOf(id) {
    try {
      const facts = await sessions.factsOf(id)
      return facts ?? {}
    } catch (error) {
      warn('factsOf failed for ' + id + ': ' + String(error?.message ?? error))
      return {}
    }
  }

  function addSuggestions(id, list) {
    if (tags && typeof tags.addSuggestions === 'function') {
      return tags.addSuggestions(id, list, 'rule')
    }
    const record = store.sessionOf(id)
    const merged = normalizeTags([...record.suggestedTags, ...list])
    store.patchSession(id, { suggestedTags: merged })
    return merged
  }

  function appendTags(ids, list) {
    if (ids.length === 0) return 0
    if (tags && typeof tags.apply === 'function') {
      const result = tags.apply({ sessionIds: ids, op: 'append', tags: list })
      return Number(result?.updated ?? 0)
    }
    let updated = 0
    for (const id of ids) {
      const record = store.sessionOf(id)
      const merged = normalizeTags([...record.tags, ...list])
      const changed = merged.length !== record.tags.length
      store.patchSession(id, { tags: merged })
      if (changed) updated += 1
    }
    return updated
  }

  /**
   * Scan the corpus for one rule. Zero writes.
   * @param {{ rule: object, limit?: number, includeArchived?: boolean }} request
   * @returns {Promise<{matches: Array<{sessionId: string, title: string, tags: string[], evidence: string, evidenceDetail: Array<{field: string, keyword: string}>}>, scanned: number, total: number, truncated: boolean}>}
   *   `limit` caps how many candidate Sessions are scanned (default: all), so
   *   `scanned` can be smaller than `total`.
   */
  async function preview({ rule: input, limit, includeArchived = false } = {}) {
    const rule = normalizeRule(input)
    const rows = await sessions.list()
    const candidates = (Array.isArray(rows) ? rows : []).filter(
      (row) => row && typeof row.id === 'string' && !row.blank && !isSubagent(row) && (includeArchived || !row.archived),
    )
    const total = candidates.length
    const scanLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : null
    const targets = scanLimit ? candidates.slice(0, scanLimit) : candidates
    const needFacts = rule.match.fields.includes('title') || rule.match.fields.includes('firstMessage')

    const resolved = await mapPool(targets, concurrency(), async (row) => {
      let factsPromise = null
      const getFacts = () => {
        if (!needFacts) return null
        factsPromise ??= factsOf(row.id)
        return factsPromise
      }
      const record = store.sessionOf(row.id)
      const sources = { cwd: asText(row.cwd), note: asText(record.note) }
      const initialFacts = getFacts()
      if (initialFacts) {
        const facts = await initialFacts
        sources.title = asText(facts.title)
        sources.firstMessage = asText(facts.firstMessage)
      }
      let evidence = evaluateRule(rule, sources)
      if (!evidence) return null
      let title = sources.title
      if (title === undefined) {
        const facts = await factsOf(row.id)
        title = asText(facts.title)
      }
      return {
        sessionId: row.id,
        title,
        tags: record.tags.slice(),
        evidence: evidenceLabel(evidence),
        evidenceDetail: evidence,
      }
    })

    const matches = resolved.filter(Boolean)
    return { matches, scanned: targets.length, total, truncated: targets.length < total }
  }

  /**
   * Apply one stored rule now, re-evaluating against the current corpus.
   * `mode` may override `rule.action.mode`. Never deletes an existing tag.
   * @returns {Promise<{suggested: number, updated: number, sessions: string[], scanned: number, mode: string}>}
   *   `suggested` = Sessions that received at least one new suggested tag;
   *   `updated` = Sessions that received at least one new tag.
   */
  async function apply({ ruleId, mode } = {}) {
    const stored = typeof ruleId === 'string' ? store.ruleOf(ruleId) : null
    if (!stored) throw new StateError('not_found', 'unknown rule: ' + String(ruleId ?? '(none)'))
    const rule = normalizeRule(stored)
    const effectiveMode = asText(mode).trim().toLowerCase() || rule.action.mode
    if (!RULE_ACTION_MODES.includes(effectiveMode)) {
      throw invalid('action mode must be one of ' + RULE_ACTION_MODES.join(' or '))
    }

    const { matches, scanned } = await preview({ rule })
    const actionTags = rule.action.tags
    const affected = []
    let suggested = 0
    let updated = 0

    if (effectiveMode === 'suggest') {
      for (const match of matches) {
        const record = store.sessionOf(match.sessionId)
        const known = new Set([...record.tags, ...record.suggestedTags].map(keyOf))
        const fresh = actionTags.filter((tag) => !known.has(keyOf(tag)))
        if (fresh.length === 0) continue
        addSuggestions(match.sessionId, fresh)
        suggested += 1
        affected.push(match.sessionId)
      }
    } else {
      const needs = matches.filter((match) => {
        const known = new Set(store.sessionOf(match.sessionId).tags.map(keyOf))
        return actionTags.some((tag) => !known.has(keyOf(tag)))
      })
      if (needs.length > 0) {
        updated = appendTags(needs.map((match) => match.sessionId), actionTags)
        if (updated > 0) affected.push(...needs.map((match) => match.sessionId))
      }
    }

    return { suggested, updated, sessions: affected, scanned, mode: effectiveMode }
  }

  /**
   * Compute suggestions for given Sessions without writing anything.
   * @returns {Promise<Record<string, string[]>>} one entry per requested id.
   */
  async function suggestFor(ids) {
    const wanted = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id !== '')
    const out = {}
    for (const id of wanted) out[id] = []
    if (wanted.length === 0) return out
    const rules = enabledRules()
    if (rules.length === 0) return out

    const rows = await sessions.list()
    const rowById = new Map((Array.isArray(rows) ? rows : []).map((row) => [row?.id, row]))
    const needFacts = rules.some((rule) => rule.match.fields.includes('title') || rule.match.fields.includes('firstMessage'))

    await mapPool(wanted, concurrency(), async (id) => {
      const row = rowById.get(id)
      if (!row || row.blank || isSubagent(row)) return
      const record = store.sessionOf(id)
      const sources = { cwd: asText(row.cwd), note: asText(record.note) }
      if (needFacts) {
        const facts = await factsOf(id)
        sources.title = asText(facts.title)
        sources.firstMessage = asText(facts.firstMessage)
      }
      const existingTags = new Set(record.tags.map(keyOf))
      const existingSuggestions = new Set(record.suggestedTags.map(keyOf))
      const suggestion = []
      for (const rule of rules) {
        if (!evaluateRule(rule, sources)) continue
        for (const tag of rule.action.tags) {
          const key = keyOf(tag)
          if (existingTags.has(key) || existingSuggestions.has(key)) continue
          if (suggestion.some((entry) => keyOf(entry) === key)) continue
          suggestion.push(tag)
        }
      }
      out[id] = normalizeTags(suggestion)
    })
    return out
  }

  /** Stored rules, normalized for the client (invalid records are skipped). */
  function list() {
    return allRules().map(normalizeStored).filter(Boolean)
  }

  function save(input) {
    const rule = normalizeRule(input)
    if (!rule.id) rule.id = 'r-' + crypto.randomBytes(4).toString('hex')
    const previous = store.ruleOf(rule.id)
    if (previous && asText(previous.createdAt)) rule.createdAt = previous.createdAt
    store.putRule(rule)
    return rule
  }

  function remove(id) {
    if (typeof id !== 'string' || id.trim() === '') throw new StateError('invalid_rule', 'a rule id is required')
    return store.deleteRule(id.trim())
  }

  return { list, validate: normalizeRule, save, remove, preview, apply, suggestFor }
}
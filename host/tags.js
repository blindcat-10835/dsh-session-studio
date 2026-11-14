/**
 * Tag operations.
 *
 * Tags and suggested tags are user data that lives in the plugin's own state
 * document (ADR-0003): the Session log is append-only and has no tag event, so
 * "replace" and "clear" rewrite this plugin's record and never touch the log.
 * A suggestion is not a tag: it only becomes one once the user accepts it, so
 * suggestions are written to suggestedTags and never grow the vocabulary.
 */

import { StateError, normalizeTags } from './store.js'

export const TAG_OPERATIONS = ['append', 'replace', 'clear']

/** How many vocabulary words "fill missing" may propose per Session. */
const FILL_SUGGESTION_LIMIT = 3
const FACTS_CONCURRENCY = 4

function messageOf(error) {
  return String(error?.message ?? error)
}

function uniqueIds(raw) {
  const out = []
  const seen = new Set()
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Same tag list, case-insensitive (normalization keeps the first spelling). */
function sameTags(left, right) {
  const a = Array.isArray(left) ? left : []
  const b = Array.isArray(right) ? right : []
  if (a.length !== b.length) return false
  return a.every((tag, index) => tag.toLowerCase() === b[index].toLowerCase())
}

/** Run an async worker over items with a bounded number in flight, keeping order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = []
  const width = Math.max(1, Math.min(limit, items.length))
  for (let index = 0; index < width; index += 1) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const current = cursor
          cursor += 1
          results[current] = await worker(items[current], current)
        }
      })(),
    )
  }
  await Promise.all(runners)
  return results
}

/**
 * @param {object} options
 * @param {object} options.store        StateStore
 * @param {object} options.sessions     createSessionSource() result
 * @param {object} [options.logger]
 * @param {object} [options.statusIndex] status indexer; its cached title/first message
 *                                       saves the log read when the session is indexed
 */
export function createTagService({ store, sessions, logger, statusIndex } = {}) {
  const log = logger || console

  function requireStore() {
    if (!store || typeof store.patchSession !== 'function' || typeof store.sessionOf !== 'function') {
      throw new StateError('store_unavailable', 'the plugin state store is unavailable')
    }
  }

  function tagDefs() {
    return typeof store?.tagDefs === 'function' ? store.tagDefs() : []
  }

  /** Suggestions minus anything already accepted as a real tag (case-insensitive). */
  function withoutAccepted(suggestions, tags) {
    const accepted = new Set(normalizeTags(tags).map((tag) => tag.toLowerCase()))
    return normalizeTags(suggestions).filter((tag) => !accepted.has(tag.toLowerCase()))
  }

  /** Every Session id this plugin holds a record for (vocabulary bookkeeping). */
  function knownIds() {
    return typeof store?.knownSessionIds === 'function' ? store.knownSessionIds() : []
  }

  function ruleList() {
    return typeof store?.rules === 'function' && Array.isArray(store.rules()) ? store.rules() : []
  }

  /** Rewrite one rule's action tags; returns true when the rule changed. */
  function mapRuleTags(rule, mapper) {
    const before = Array.isArray(rule?.action?.tags) ? rule.action.tags : []
    const after = normalizeTags(mapper(before))
    if (sameTags(before, after)) return false
    if (after.length === 0) {
      // A rule without action tags cannot run; drop it instead of storing a dud.
      store.deleteRule?.(rule.id)
      return true
    }
    store.putRule?.({ ...rule, action: { ...rule.action, tags: after }, updatedAt: new Date().toISOString() })
    return true
  }

  /**
   * The vocabulary with usage counts: how many Sessions carry each tag.
   * Sorted by count desc, then by name, so the manager lists the useful words first.
   * @returns {Array<{name:string, source:string, createdAt:string|null, sessions:number, suggested:number}>}
   */
  function vocabulary() {
    const usage = new Map()
    const bump = (name, field) => {
      const key = String(name).toLowerCase()
      const entry = usage.get(key) ?? { sessions: 0, suggested: 0 }
      entry[field] += 1
      usage.set(key, entry)
    }
    for (const id of knownIds()) {
      const record = store.sessionOf(id)
      for (const tag of normalizeTags(record.tags ?? [])) bump(tag, 'sessions')
      for (const tag of normalizeTags(record.suggestedTags ?? [])) bump(tag, 'suggested')
    }
    const list = tagDefs().map((def) => {
      const key = String(def?.name ?? '').toLowerCase()
      const entry = usage.get(key) ?? { sessions: 0, suggested: 0 }
      return {
        name: typeof def?.name === 'string' ? def.name : '',
        source: typeof def?.source === 'string' ? def.source : 'manual',
        createdAt: typeof def?.createdAt === 'string' ? def.createdAt : null,
        sessions: entry.sessions,
        suggested: entry.suggested,
      }
    })
    return list
      .filter((entry) => entry.name !== '')
      .sort((left, right) => (right.sessions - left.sessions) || left.name.localeCompare(right.name, 'zh-Hans-CN'))
  }

  /**
   * Add one word to the vocabulary without touching any Session.
   * @returns {object|null} the definition
   */
  function createDef(name) {
    requireStore()
    const tag = normalizeTags([name])[0] ?? ''
    if (!tag) throw new StateError('invalid_tag', 'tag name must not be empty')
    return store.ensureTagDef(tag, 'manual')
  }

  /**
   * Rename a vocabulary word everywhere: the definition, every Session that uses
   * it (as a tag or as a suggestion) and every rule action. Renaming onto an
   * existing word merges the two vocabularies instead of failing.
   * @returns {{renamed:boolean, from:string, to:string, sessions:number, rules:number, tagDefs:Array<object>}}
   */
  function renameDef(from, to) {
    requireStore()
    const source = normalizeTags([from])[0] ?? ''
    const target = normalizeTags([to])[0] ?? ''
    if (!source) throw new StateError('invalid_tag', 'the current tag name must not be empty')
    if (!target) throw new StateError('invalid_tag', 'the new tag name must not be empty')
    if (source.toLowerCase() === target.toLowerCase() && source === target) {
      return { renamed: false, from: source, to: target, sessions: 0, rules: 0, tagDefs: tagDefs() }
    }
    const renamed = store.renameTagDef(source, target)
    if (!renamed) throw new StateError('not_found', 'unknown tag: ' + source)

    const swap = (list) => normalizeTags((list ?? []).map((tag) => (tag.toLowerCase() === source.toLowerCase() ? target : tag)))
    let sessions = 0
    for (const id of knownIds()) {
      const record = store.sessionOf(id)
      const tags = swap(record.tags)
      // A renamed suggestion can land on a word the Session already carries as a
      // real tag; keeping it would draw the same chip twice.
      const suggested = withoutAccepted(swap(record.suggestedTags), tags)
      if (sameTags(tags, record.tags) && sameTags(suggested, record.suggestedTags)) continue
      store.patchSession(id, { tags, suggestedTags: suggested })
      sessions += 1
    }
    let rules = 0
    for (const rule of ruleList()) {
      if (mapRuleTags(rule, swap)) rules += 1
    }
    log.debug?.('session-studio: renamed tag ' + source + ' -> ' + target + ' on ' + sessions + ' sessions')
    return { renamed: true, from: source, to: target, sessions, rules, tagDefs: tagDefs() }
  }

  /**
   * Drop a vocabulary word and every use of it: Session tags, suggestions and
   * rule actions that would be left without any tag are removed.
   * @returns {{removed:boolean, name:string, sessions:number, rules:number, tagDefs:Array<object>}}
   */
  function removeDef(name) {
    requireStore()
    const tag = normalizeTags([name])[0] ?? ''
    if (!tag) throw new StateError('invalid_tag', 'tag name must not be empty')
    const removed = store.removeTagDef(tag)
    if (!removed) throw new StateError('not_found', 'unknown tag: ' + tag)
    const drop = (list) => normalizeTags((list ?? []).filter((entry) => entry.toLowerCase() !== tag.toLowerCase()))
    let sessions = 0
    for (const id of knownIds()) {
      const record = store.sessionOf(id)
      const tags = drop(record.tags)
      const suggested = drop(record.suggestedTags)
      if (sameTags(tags, record.tags) && sameTags(suggested, record.suggestedTags)) continue
      store.patchSession(id, { tags, suggestedTags: suggested })
      sessions += 1
    }
    let rules = 0
    for (const rule of ruleList()) {
      if (mapRuleTags(rule, drop)) rules += 1
    }
    log.debug?.('session-studio: removed tag ' + tag + ' from ' + sessions + ' sessions')
    return { removed: true, name: tag, sessions, rules, tagDefs: tagDefs() }
  }

  /**
   * Apply one tag operation to a batch of Sessions.
   * @returns {{updated:number, tagDefs:Array<object>}}
   */
  function apply({ sessionIds, op, tags } = {}) {
    requireStore()
    const operation = typeof op === 'string' ? op.trim().toLowerCase() : ''
    if (!TAG_OPERATIONS.includes(operation)) {
      throw new StateError('invalid_op', 'unsupported tag operation: ' + String(op))
    }
    const ids = uniqueIds(sessionIds)
    const incoming = normalizeTags(tags)
    let updated = 0
    for (const id of ids) {
      const record = store.sessionOf(id)
      let next
      if (operation === 'clear') next = []
      else if (operation === 'replace') next = incoming
      else next = normalizeTags([...(record.tags ?? []), ...incoming])
      // An accepted tag must not survive as a suggestion of the same name: the
      // row would render the word twice, once solid and once muted.
      const suggestions = withoutAccepted(record.suggestedTags, next)
      const tagsChanged = !sameTags(next, record.tags)
      const suggestionsChanged = !sameTags(suggestions, record.suggestedTags)
      if (!tagsChanged && !suggestionsChanged) continue
      store.patchSession(id, suggestionsChanged ? { tags: next, suggestedTags: suggestions } : { tags: next })
      for (const name of next) store.ensureTagDef?.(name, 'manual')
      updated += 1
    }
    return { updated, tagDefs: tagDefs() }
  }

  /**
   * Add suggested tags to one Session; only suggestedTags is written.
   * Suggestions that duplicate an existing tag are dropped, and accepted tags
   * are never removed.
   * @returns {string[]} the Session's suggested tags after the write
   */
  function addSuggestions(id, tags, source) {
    requireStore()
    const sessionId = typeof id === 'string' ? id.trim() : ''
    if (!sessionId) throw new StateError('invalid_session', 'sessionId is required')
    const record = store.sessionOf(sessionId)
    const manual = new Set((record.tags ?? []).map((tag) => tag.toLowerCase()))
    const incoming = normalizeTags(tags).filter((tag) => !manual.has(tag.toLowerCase()))
    const merged = normalizeTags([...(record.suggestedTags ?? []), ...incoming])
    if (!sameTags(merged, record.suggestedTags)) {
      store.patchSession(sessionId, { suggestedTags: merged })
    }
    if (source) log.debug?.('session-studio: suggestions for ' + sessionId + ' from ' + String(source))
    return merged
  }

  async function safeList() {
    if (!sessions || typeof sessions.list !== 'function') return []
    try {
      return (await sessions.list()) ?? []
    } catch (error) {
      log.warn?.('session-studio: could not list sessions: ' + messageOf(error))
      return []
    }
  }

  async function safeFacts(id) {
    if (!sessions || typeof sessions.factsOf !== 'function') return { title: '', firstMessage: '' }
    try {
      const facts = await sessions.factsOf(id)
      if (!facts || facts.error) return { title: '', firstMessage: '' }
      return {
        title: typeof facts.title === 'string' ? facts.title : '',
        firstMessage: typeof facts.firstMessage === 'string' ? facts.firstMessage : '',
      }
    } catch (error) {
      log.warn?.('session-studio: could not read facts for ' + id + ': ' + messageOf(error))
      return { title: '', firstMessage: '' }
    }
  }

  /**
   * Propose tags for the Sessions that have none, using the existing vocabulary.
   * Only sessions with zero tags are considered, only suggestedTags is written,
   * and an existing tag is never overwritten or removed.
   * @returns {Promise<{candidates:Array<{sessionId:string,title:string,tags:string[]}>, updated:number}>}
   */
  async function fillMissing(options = {}) {
    requireStore()
    const dryRun = options?.dryRun !== false
    const rows = await safeList()

    const hooks = options?.hooks ?? {}
    const targets = []
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id) continue
      // A blank Session cannot carry tags; a subagent or archived Session never
      // joins a batch (PRD batch skip rules).
      if (row.blank) continue
      if (row.parentSessionId) continue
      if (row.archived) continue
      const record = store.sessionOf(row.id)
      if ((record.tags ?? []).length > 0) continue
      targets.push({
        id: row.id,
        cwd: typeof row.cwd === 'string' ? row.cwd : '',
        note: typeof record.note === 'string' ? record.note : '',
        suggested: record.suggestedTags ?? [],
      })
    }
    hooks.onTotal?.(targets.length)
    if (targets.length === 0) return { candidates: [], updated: 0 }

    const vocabulary = tagDefs()
      .map((def) => (typeof def?.name === 'string' ? def.name : ''))
      .filter(Boolean)
    if (vocabulary.length === 0) return { candidates: [], updated: 0 }

    const facts = await mapLimit(targets, FACTS_CONCURRENCY, (target) => {
      // The status index already holds the title and the first message; only a
      // session it has not indexed yet costs a log read.
      const cached = typeof statusIndex?.rowOf === 'function' ? statusIndex.rowOf(target.id) : null
      if (cached && (cached.title || cached.firstMessage)) {
        return { title: cached.title ?? '', firstMessage: cached.firstMessage ?? '' }
      }
      return safeFacts(target.id)
    })
    const candidates = []
    let updated = 0

    targets.forEach((target, index) => {
      const { title, firstMessage } = facts[index] || { title: '', firstMessage: '' }
      const haystack = [title, firstMessage, target.cwd, target.note].join('\n').toLowerCase()
      if (!haystack.trim()) return
      const already = new Set(target.suggested.map((tag) => tag.toLowerCase()))
      const pending = vocabulary
        .filter((name) => haystack.includes(name.toLowerCase()) && !already.has(name.toLowerCase()))
        .slice(0, FILL_SUGGESTION_LIMIT)
      if (pending.length === 0) {
        hooks.onItem?.({ sessionId: target.id, title, tags: [], updated: false, reason: 'no_match' })
        return
      }
      candidates.push({ sessionId: target.id, title, tags: pending })
      if (dryRun) {
        hooks.onItem?.({ sessionId: target.id, title, tags: pending, updated: false, reason: 'dry_run' })
        return
      }
      addSuggestions(target.id, pending, 'rule')
      updated += 1
      hooks.onItem?.({ sessionId: target.id, title, tags: pending, updated: true, reason: null })
    })

    return { candidates, updated }
  }

  return { apply, fillMissing, addSuggestions, vocabulary, createDef, renameDef, removeDef }
}

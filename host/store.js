/**
 * Plugin-owned durable state: tags, suggested tags, notes, title locks and intents
 * per Session, the tag vocabulary, tag rules, and settings.
 *
 * Nothing here writes the Session event log (ADR-0003): the log is append-only
 * and has no tag vocabulary, so user data lives in this plugin's own atomic
 * JSON document keyed by Session id.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const SCHEMA_VERSION = 1
export const TAG_MAX_LENGTH = 24
export const TAG_MAX_PER_SESSION = 12
export const NOTE_MAX_LENGTH = 2000
export const TITLE_MAX_LENGTH = 120

export const DEFAULT_SETTINGS = {
  ai: {
    batchSize: 8,
    concurrency: 2,
    maxSessionsPerRun: 50,
    readContent: true,
    titleMaxChars: 48,
  },
  status: {
    enabled: true,
    tailEvents: 120,
    concurrency: 2,
  },
}

export class StateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StateError'
    this.code = code
  }
}

/** Collapse whitespace, strip a leading '#', cap the length. */
export function normalizeTag(raw) {
  if (raw === undefined || raw === null) return ''
  let value = String(raw).replace(/\s+/g, ' ').trim()
  if (value.startsWith('#')) value = value.slice(1).trim()
  if (!value) return ''
  return Array.from(value).slice(0, TAG_MAX_LENGTH).join('')
}

/** Normalize and de-duplicate a tag list case-insensitively, keeping first spelling. */
export function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    const tag = normalizeTag(item)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= TAG_MAX_PER_SESSION) break
  }
  return out
}

/** Resolve the plugin data directory from config, environment, or DSH home. */
export function resolveDataDir(config) {
  const explicit = config?.dataDir
  if (typeof explicit === 'string' && explicit.trim()) return path.resolve(explicit)
  const env = process.env.DSH_SESSION_STUDIO_DIR ?? process.env.DSH_SESSION_MANAGER_DIR
  if (typeof env === 'string' && env.trim()) return path.resolve(env)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const next = path.join(home, 'storages', 'session-studio')
  const legacy = path.join(home, 'storages', 'session-manager')
  try {
    if (!fs.existsSync(next) && fs.existsSync(legacy)) fs.renameSync(legacy, next)
  } catch {
    /* keep writing to the new directory; the old one stays untouched */
  }
  return next
}

function emptyState() {
  return {
    schema: SCHEMA_VERSION,
    sessions: {},
    tagDefs: {},
    rules: [],
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  }
}

function mergeSettings(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  if (!raw || typeof raw !== 'object') return base
  for (const group of Object.keys(base)) {
    if (!raw[group] || typeof raw[group] !== 'object') continue
    for (const key of Object.keys(base[group])) {
      const value = raw[group][key]
      if (value === undefined || value === null) continue
      if (typeof value === typeof base[group][key]) base[group][key] = value
    }
  }
  return base
}

/** Default per-Session record. */
export function emptySession() {
  return {
    tags: [],
    suggestedTags: [],
    note: '',
    titleLocked: false,
    titleSource: null,
    intent: null,
    updatedAt: null,
  }
}

export class StateStore {
  constructor({ dataDir, logger } = {}) {
    this.dataDir = dataDir
    this.logger = logger || console
    this.state = emptyState()
    this.version = 0
    this.dirty = false
    this.timer = null
    this.writing = null
  }

  file(name) {
    return path.join(this.dataDir, name)
  }

  loadSync() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const file = this.file('state.json')
    if (!fs.existsSync(file)) return this
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const state = emptyState()
      if (parsed && typeof parsed === 'object') {
        if (parsed.sessions && typeof parsed.sessions === 'object') state.sessions = parsed.sessions
        if (parsed.tagDefs && typeof parsed.tagDefs === 'object') state.tagDefs = parsed.tagDefs
        if (Array.isArray(parsed.rules)) state.rules = parsed.rules
        state.settings = mergeSettings(parsed.settings)
      }
      this.state = state
      this.version += 1
    } catch (error) {
      this.logger.warn?.('session-studio: state.json is unreadable, starting empty: ' + String(error?.message ?? error))
      this.quarantine('state.json')
    }
    return this
  }

  quarantine(name) {
    try {
      const from = this.file(name)
      if (!fs.existsSync(from)) return
      const to = from + '.corrupt-' + Date.now()
      fs.renameSync(from, to)
      this.logger.warn?.('session-studio: moved unreadable ' + name + ' to ' + to)
    } catch {
      /* best effort */
    }
  }

  /** Read an auxiliary JSON document (status index, trash index) with the same atomic-write rules. */
  readDoc(name, fallback) {
    const file = this.file(name)
    if (!fs.existsSync(file)) return fallback
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return parsed ?? fallback
    } catch (error) {
      this.logger.warn?.('session-studio: ' + name + ' is unreadable, using defaults: ' + String(error?.message ?? error))
      this.quarantine(name)
      return fallback
    }
  }

  writeDocSync(name, value) {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const target = this.file(name)
    const tmp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    fs.writeFileSync(tmp, JSON.stringify(value))
    fs.renameSync(tmp, target)
  }

  writeDoc(name, value) {
    try {
      this.writeDocSync(name, value)
      return true
    } catch (error) {
      this.logger.error?.('session-studio: failed to write ' + name + ': ' + String(error?.message ?? error))
      return false
    }
  }

  get settings() {
    return this.state.settings
  }

  /** Bump the monotonic version the client polls against. */
  bump() {
    this.version += 1
    this.dirty = true
    this.schedulePersist()
  }

  schedulePersist() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.persistNow()
    }, 300)
    this.timer.unref?.()
  }

  async persistNow() {
    if (!this.dirty) return
    this.dirty = false
    try {
      this.writeDocSync('state.json', this.state)
    } catch (error) {
      this.dirty = true
      this.logger.error?.('session-studio: failed to persist state: ' + String(error?.message ?? error))
    }
  }

  sessionOf(id) {
    const existing = this.state.sessions[id]
    if (existing && typeof existing === 'object') {
      const tags = normalizeTags(existing.tags)
      // v0.3.2: a suggestion that is already a real tag carries no information and
      // renders as a second, greyed-out chip. Legacy files still hold those pairs,
      // so the read side strips them too — not just the write paths.
      const accepted = new Set(tags.map((tag) => tag.toLowerCase()))
      return {
        ...emptySession(),
        ...existing,
        tags,
        suggestedTags: normalizeTags(existing.suggestedTags).filter((tag) => !accepted.has(tag.toLowerCase())),
      }
    }
    return emptySession()
  }

  /** Write a patch onto one Session record; unknown fields are ignored. */
  patchSession(id, patch = {}) {
    const next = this.sessionOf(id)
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags)
    if (patch.suggestedTags !== undefined) next.suggestedTags = normalizeTags(patch.suggestedTags)
    if (patch.note !== undefined) next.note = String(patch.note ?? '').slice(0, NOTE_MAX_LENGTH)
    if (patch.titleLocked !== undefined) next.titleLocked = Boolean(patch.titleLocked)
    if (patch.titleSource !== undefined) next.titleSource = patch.titleSource ?? null
    if (patch.intent !== undefined) next.intent = patch.intent ?? null
    next.updatedAt = new Date().toISOString()
    this.state.sessions[id] = next
    this.bump()
    return next
  }

  ensureTagDef(name, source = 'manual') {
    const tag = normalizeTag(name)
    if (!tag) return null
    const key = tag.toLowerCase()
    if (!this.state.tagDefs[key]) {
      this.state.tagDefs[key] = { name: tag, source, createdAt: new Date().toISOString() }
    }
    return this.state.tagDefs[key]
  }

  tagDefs() {
    return Object.values(this.state.tagDefs)
  }

  /**
   * Rename one vocabulary entry in place, keeping its source and creation time.
   * Renaming onto an existing entry merges the two (the older definition wins).
   * Returns the surviving definition, or null when there is nothing to rename.
   */
  renameTagDef(from, to) {
    const fromKey = typeof from === 'string' ? from.trim().toLowerCase() : ''
    const tag = normalizeTag(to)
    if (!fromKey || !tag) return null
    const current = this.state.tagDefs[fromKey]
    if (!current) return null
    const toKey = tag.toLowerCase()
    const existing = this.state.tagDefs[toKey]
    const next = {
      ...current,
      ...(existing ? { createdAt: existing.createdAt || current.createdAt, source: existing.source || current.source } : {}),
      name: tag,
    }
    delete this.state.tagDefs[fromKey]
    this.state.tagDefs[toKey] = next
    this.bump()
    return next
  }

  /** Remove one vocabulary entry; returns true when it existed. */
  removeTagDef(name) {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : ''
    if (!key || !this.state.tagDefs[key]) return false
    delete this.state.tagDefs[key]
    this.bump()
    return true
  }

  /** Session ids this plugin still holds a record for (orphan GC input). */
  knownSessionIds() {
    return Object.keys(this.state.sessions)
  }

  /** Drop records whose Session no longer exists anywhere; returns removed ids. */
  gcOrphans(existingIds) {
    const keep = new Set(existingIds)
    const removed = []
    for (const id of Object.keys(this.state.sessions)) {
      if (keep.has(id)) continue
      delete this.state.sessions[id]
      removed.push(id)
    }
    if (removed.length > 0) this.bump()
    return removed
  }

  rules() {
    return this.state.rules
  }

  ruleOf(id) {
    return this.state.rules.find((rule) => rule && rule.id === id)
  }

  putRule(rule) {
    const index = this.state.rules.findIndex((entry) => entry && entry.id === rule.id)
    if (index >= 0) this.state.rules[index] = rule
    else this.state.rules.push(rule)
    this.bump()
    return rule
  }

  deleteRule(id) {
    const before = this.state.rules.length
    this.state.rules = this.state.rules.filter((rule) => !rule || rule.id !== id)
    const removed = before !== this.state.rules.length
    if (removed) this.bump()
    return removed
  }
}

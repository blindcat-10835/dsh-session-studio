/**
 * Background job runner (v0.2, PRD §8.1; frozen contract in docs/CONTRACTS.md).
 *
 * The slow operations of this plugin (AI previews, applying renames, the tag
 * sweep) cannot block a request. The runner owns a FIFO queue that executes one
 * handler at a time, mirrors every job into jobs.json through the atomic
 * StateStore document API, and exposes the PRD Job object to the HTTP layer.
 *
 * Design notes:
 *   - handlers are injected: { [type]: async (jobCtx) => result }. The runner
 *     never imports a capability module, so it stays testable and pure Node.
 *   - progress is reported as absolute counters (report({ total, done, ... })
 *     assigns, it does not increment), matching the handlers in host/api.js.
 *   - writes are debounced by flushMs; a terminal state and stop() flush now.
 *   - every timer is .unref()'d so a loaded plugin cannot hold the process open.
 *   - after stop() the runner neither advances the queue nor writes again.
 */

import crypto from 'node:crypto'

import { StateError } from './store.js'

const DOC_NAME = 'jobs.json'
const SCHEMA = 1
const DEFAULT_FLUSH_MS = 400
const DEFAULT_KEEP_FINISHED = 50
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const ACTIVE_STATES = new Set(['queued', 'running'])

/** Maximum number of per-item rows kept on one Job (PRD §8.1). */
export const JOB_ITEM_LIMIT = 200

function isActive(state) {
  return ACTIVE_STATES.has(state)
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state)
}

function toCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.floor(number)
}

function percentOf(total, done) {
  return total > 0 ? Math.min(99, Math.floor((100 * done) / total)) : 0
}

function isoOf(milliseconds) {
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** Deep-copy a value through JSON so a Job is always serializable; null on failure. */
function jsonSafe(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function normalizeItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {}
  return {
    key: item.key === undefined || item.key === null ? '' : String(item.key),
    state: typeof item.state === 'string' && item.state ? item.state : 'done',
    message: item.message === undefined || item.message === null ? null : String(item.message),
    data: jsonSafe(item.data),
  }
}

function normalizeError(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    code: typeof raw.code === 'string' && raw.code ? raw.code : 'handler_failed',
    message: raw.message === undefined || raw.message === null ? '' : String(raw.message),
  }
}

function snapshot(job) {
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    params: job.params,
    total: job.total,
    done: job.done,
    failed: job.failed,
    skipped: job.skipped,
    percent: job.percent,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result,
    itemsTruncated: job.itemsTruncated,
    items: job.items.map((item) => ({ ...item })),
  }
}

/** Rebuild a Job from a persisted record without trusting the file. */
function hydrateJob(raw, seq) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (!id || !type) return null

  const knownState = typeof raw.state === 'string' && (isActive(raw.state) || isTerminal(raw.state))
  const state = knownState ? raw.state : 'interrupted'
  const total = toCount(raw.total) ?? 0
  const done = toCount(raw.done) ?? 0
  const failed = toCount(raw.failed) ?? 0
  const skipped = toCount(raw.skipped) ?? 0
  const persistedPercent = toCount(raw.percent)
  const items = Array.isArray(raw.items) ? raw.items.slice(0, JOB_ITEM_LIMIT).map(normalizeItem) : []
  let error = normalizeError(raw.error)
  if (!knownState && !error) {
    error = { code: 'interrupted', message: 'Job state was not recoverable after a host restart' }
  }

  return {
    id,
    type,
    state,
    params: raw.params && typeof raw.params === 'object' ? raw.params : {},
    total,
    done,
    failed,
    skipped,
    percent:
      state === 'succeeded'
        ? 100
        : Math.min(99, persistedPercent ?? percentOf(total, done)),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : isoOf(Date.now()),
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    error,
    result: raw.result === undefined ? null : raw.result,
    itemsTruncated: Boolean(raw.itemsTruncated) || (Array.isArray(raw.items) && raw.items.length > JOB_ITEM_LIMIT),
    items,
    _seq: seq,
    _controller: null,
    _cancelRequested: false,
  }
}

/**
 * Create the background job runner.
 *
 * @param {object} options
 * @param {object} options.store        StateStore-like { readDoc(name, fallback), writeDoc(name, value) }
 * @param {object} [options.logger]
 * @param {Record<string, (jobCtx: object) => Promise<any>>} [options.handlers]
 * @param {() => number} [options.now]
 * @param {number} [options.flushMs]
 * @param {number} [options.keepFinished]
 */
export function createJobRunner({
  store,
  logger,
  handlers,
  now = Date.now,
  flushMs = DEFAULT_FLUSH_MS,
  keepFinished = DEFAULT_KEEP_FINISHED,
} = {}) {
  const log = logger || console
  const handlerMap = handlers && typeof handlers === 'object' ? handlers : {}
  const flushDelay = Number.isFinite(flushMs) && flushMs >= 0 ? Number(flushMs) : DEFAULT_FLUSH_MS
  const retainedFinished = Number.isInteger(keepFinished) && keepFinished >= 0 ? keepFinished : DEFAULT_KEEP_FINISHED

  const jobs = new Map()
  const queue = []
  let current = null
  let stopped = false
  let flushTimer = null
  let dirty = false
  let seq = 0

  function clock() {
    try {
      const value = typeof now === 'function' ? now() : Date.now()
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime()
      return Date.now()
    } catch {
      return Date.now()
    }
  }

  function timestamp() {
    return isoOf(clock())
  }

  function newId() {
    let id = ''
    do {
      id = 'job-' + clock() + '-' + crypto.randomBytes(3).toString('hex')
    } while (jobs.has(id))
    return id
  }

  // ---- persistence -------------------------------------------------------

  function persistableJobs() {
    const active = []
    const finished = []
    for (const job of jobs.values()) {
      if (isActive(job.state)) active.push(job)
      else finished.push(job)
    }
    finished.sort((left, right) => left._seq - right._seq)
    const keep = retainedFinished > 0 ? finished.slice(-retainedFinished) : []
    return [...active, ...keep].sort((left, right) => left._seq - right._seq).map(snapshot)
  }

  function clearFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function flushNow(force = false) {
    if (stopped) return false
    clearFlushTimer()
    // A terminal state (or stop/recover) must reach disk even when the debounce
    // timer already flushed an intermediate snapshot.
    if (!dirty && !force) return true
    dirty = false
    try {
      if (typeof store?.writeDoc === 'function') {
        const written = store.writeDoc(DOC_NAME, { schema: SCHEMA, jobs: persistableJobs() })
        if (written === false) {
          dirty = true
          return false
        }
      }
      return true
    } catch (error) {
      dirty = true
      log.error?.('session-manager: failed to persist jobs.json: ' + String(error?.message ?? error))
      return false
    }
  }

  function touch() {
    if (stopped) return
    dirty = true
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushNow()
    }, flushDelay)
    flushTimer.unref?.()
  }

  // ---- queue -------------------------------------------------------------

  function schedulePump() {
    if (stopped || current || queue.length === 0) return
    queueMicrotask(pump)
  }

  function pump() {
    if (stopped || current) return
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job || job.state !== 'queued') continue
      runJob(job)
      return
    }
  }

  function report(job, patch) {
    if (stopped || !job || job.state !== 'running') return
    if (!patch || typeof patch !== 'object') return
    let changed = false
    for (const key of ['total', 'done', 'failed', 'skipped']) {
      if (patch[key] === undefined) continue
      const value = toCount(patch[key])
      if (value === null) continue
      job[key] = value
      changed = true
    }
    if (!changed) return
    job.percent = percentOf(job.total, job.done)
    touch()
  }

  function addItem(job, raw) {
    if (stopped || !job || job.state !== 'running') return
    if (job.items.length >= JOB_ITEM_LIMIT) {
      if (!job.itemsTruncated) {
        job.itemsTruncated = true
        touch()
      }
      return
    }
    job.items.push(normalizeItem(raw))
    touch()
  }

  function pruneFinished() {
    const finished = []
    for (const job of jobs.values()) {
      if (isTerminal(job.state)) finished.push(job)
    }
    finished.sort((left, right) => left._seq - right._seq)
    const excess = finished.length - retainedFinished
    for (let index = 0; index < excess; index += 1) jobs.delete(finished[index].id)
  }

  function runJob(job) {
    current = job
    job.state = 'running'
    job.startedAt = timestamp()
    job._cancelRequested = false
    const controller = new AbortController()
    job._controller = controller
    touch()

    const jobCtx = {
      id: job.id,
      type: job.type,
      params: job.params,
      signal: controller.signal,
      report(patch) {
        report(job, patch)
      },
      addItem(item) {
        addItem(job, item)
      },
    }

    let handler = null
    try {
      if (Object.prototype.hasOwnProperty.call(handlerMap, job.type)) handler = handlerMap[job.type]
    } catch {
      handler = null
    }

    Promise.resolve()
      .then(() => handler(jobCtx))
      .then((result) => settle(job, { state: 'succeeded', result }))
      .catch((error) => {
        const code = typeof error?.code === 'string' && error.code ? error.code : 'handler_failed'
        const message = String(error?.message ?? error)
        settle(job, { state: 'failed', error: { code, message } })
      })
  }

  function settle(job, outcome) {
    if (stopped) {
      current = null
      return
    }
    current = null
    if (job.state !== 'running') return

    let state = outcome.state
    let result = outcome.state === 'succeeded' ? jsonSafe(outcome.result) : null
    let error = outcome.state === 'failed' ? normalizeError(outcome.error) : null

    // A cancellation requested while the handler was running wins over its
    // eventual result: the handler may have finished, but the user asked to stop.
    if (job._cancelRequested) {
      state = 'cancelled'
      result = null
      error = null
    }

    job.state = state
    job.result = result
    job.error = error
    job.finishedAt = timestamp()
    job.percent = state === 'succeeded' ? 100 : Math.min(99, job.percent)
    job._controller = null
    job._cancelRequested = false

    pruneFinished()
    flushNow(true)
    schedulePump()
  }

  // ---- startup -----------------------------------------------------------

  let persisted = null
  try {
    persisted = typeof store?.readDoc === 'function' ? store.readDoc(DOC_NAME, null) : null
  } catch (error) {
    log.warn?.('session-manager: could not read jobs.json: ' + String(error?.message ?? error))
    persisted = null
  }
  if (persisted && Array.isArray(persisted.jobs)) {
    for (const raw of persisted.jobs) {
      seq += 1
      const job = hydrateJob(raw, seq)
      if (job) jobs.set(job.id, job)
    }
  }

  // ---- public surface (frozen contract) ----------------------------------

  function start({ type, params } = {}) {
    if (stopped) {
      throw new StateError('stopped', 'the job runner has been stopped')
    }
    const known =
      typeof type === 'string' &&
      type !== '' &&
      Object.prototype.hasOwnProperty.call(handlerMap, type) &&
      typeof handlerMap[type] === 'function'
    if (!known) {
      throw new StateError('invalid_type', 'unknown job type: ' + String(type))
    }
    seq += 1
    const job = {
      id: newId(),
      type,
      state: 'queued',
      params: params === undefined ? {} : params,
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      percent: 0,
      createdAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      itemsTruncated: false,
      items: [],
      _seq: seq,
      _controller: null,
      _cancelRequested: false,
    }
    jobs.set(job.id, job)
    queue.push(job)
    touch()
    schedulePump()
    return snapshot(job)
  }

  function get(id) {
    if (typeof id !== 'string' || !id) return null
    const job = jobs.get(id)
    return job ? snapshot(job) : null
  }

  function list({ active = false, limit = 20 } = {}) {
    const onlyActive = active === true
    const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 20
    const rows = []
    for (const job of jobs.values()) {
      if (onlyActive && !isActive(job.state)) continue
      rows.push(job)
    }
    // PRD §7.4: unfinished jobs are pinned on top, most recent first inside
    // each group; the UI can render the list as returned.
    rows.sort((left, right) => {
      const leftActive = isActive(left.state) ? 1 : 0
      const rightActive = isActive(right.state) ? 1 : 0
      if (leftActive !== rightActive) return rightActive - leftActive
      return right._seq - left._seq
    })
    return rows.slice(0, max).map(snapshot)
  }

  function cancel(id) {
    if (typeof id !== 'string' || !id) return null
    const job = jobs.get(id)
    if (!job) return null

    if (job.state === 'queued') {
      job.state = 'cancelled'
      job.finishedAt = timestamp()
      job._cancelRequested = false
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      pruneFinished()
      flushNow(true)
    } else if (job.state === 'running') {
      job._cancelRequested = true
      try {
        job._controller?.abort()
      } catch {
        /* abort listeners are the handler's business */
      }
    }
    return snapshot(job)
  }

  function activeCount() {
    let count = 0
    for (const job of jobs.values()) {
      if (isActive(job.state)) count += 1
    }
    return count
  }

  function recover() {
    let changed = false
    for (const job of jobs.values()) {
      if (!isActive(job.state)) continue
      job.state = 'interrupted'
      job.error = { code: 'interrupted', message: 'Job was interrupted by a host restart' }
      job.finishedAt = timestamp()
      job.percent = Math.min(99, job.percent)
      job._controller = null
      job._cancelRequested = false
      changed = true
    }
    if (!changed) return
    pruneFinished()
    flushNow(true)
  }

  function stop() {
    if (stopped) return
    let changed = false

    for (const job of queue) {
      if (job.state !== 'queued') continue
      job.state = 'cancelled'
      job.finishedAt = timestamp()
      changed = true
    }
    queue.length = 0
    current = null

    for (const job of jobs.values()) {
      if (job.state !== 'running') continue
      try {
        job._controller?.abort()
      } catch {
        /* best effort */
      }
    }

    if (changed) dirty = true
    clearFlushTimer()
    // Last permitted write: persist the cancelled queue / current progress before
    // the runner becomes inert.
    flushNow(true)
    stopped = true
  }

  return { start, get, list, cancel, activeCount, recover, stop }
}

/**
 * End-to-end harness: a fake DSH context wired to the *real* plugin services.
 *
 * The fakes live only at the DSH boundary (session controller, persistence,
 * workspace registry, logger, web server, tools). Everything above it — store,
 * session source, status index, tags, rules, trash, api — is the shipping code,
 * so a route exercised here fails for real when a module contract breaks.
 *
 * Nothing touches the network or the real DSH home: every path is under a fresh
 * temporary directory.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore, DEFAULT_SETTINGS } from '../../host/store.js'
import { createSessionSource } from '../../host/sessions.js'
import { createStatusIndexer } from '../../host/status.js'
import { createTagService } from '../../host/tags.js'
import { createRuleService } from '../../host/rules.js'
import { createTrashService } from '../../host/trash.js'
import { createApi, createJobHandlers, API_PREFIX } from '../../host/api.js'

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
export { API_PREFIX }

/** Synthetic Session log: first human message, title, last turn end. */
export function eventLog({ title = '', reason = null, firstMessage = '', titleSource = 'fallback' } = {}) {
  const events = []
  let seq = 0
  if (firstMessage) {
    seq += 1
    events.push({
      seq,
      time: 1000,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: firstMessage }], source: { kind: 'user' } },
    })
  }
  if (title) {
    seq += 1
    events.push({ seq, time: 1100, type: 'session/title', data: { title, source: titleSource } })
  }
  if (reason) {
    seq += 1
    events.push({ seq, time: 1200, type: 'turn/end', data: { reason: { kind: reason } } })
  }
  return events
}

export async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mergeSettings(override) {
  const settings = clone(DEFAULT_SETTINGS)
  if (!override || typeof override !== 'object') return settings
  for (const group of Object.keys(settings)) {
    const values = override[group]
    if (!values || typeof values !== 'object') continue
    for (const key of Object.keys(settings[group])) {
      const value = values[key]
      if (value === undefined || value === null) continue
      if (typeof value === typeof settings[group][key]) settings[group][key] = value
    }
  }
  return settings
}

/** Longest workspace path prefix wins, exactly like index.js does it. */
export function makeWorkspaceLabel(list) {
  const separator = path.sep
  return (cwd) => {
    if (typeof cwd !== 'string' || !cwd) return null
    let best = null
    for (const workspace of list) {
      const workspacePath = workspace?.path
      if (typeof workspacePath !== 'string' || !workspacePath) continue
      const prefix = workspacePath.endsWith(separator) ? workspacePath : workspacePath + separator
      if (cwd === workspacePath || cwd.startsWith(prefix)) {
        if (!best || workspacePath.length > best.path.length) best = { path: workspacePath, title: workspace.title }
      }
    }
    return best ? best.title : null
  }
}

/**
 * Fake DSH context + the boundary fakes, without any plugin service above them.
 * Used both by createHarness() and by tests that call index.js apply() itself.
 */
export function createFakeCtx(options = {}) {
  const descriptors = Array.isArray(options.sessions) ? options.sessions : []
  const artifactsRoot = options.artifactsRoot
  const workspaces = options.workspaces ?? [
    { id: 'w1', path: '/repo/a', title: '仓库 A' },
    { id: 'w2', path: '/repo/b', title: '仓库 B' },
  ]

  const byId = new Map()
  const eventsById = new Map()
  for (const descriptor of descriptors) {
    const id = String(descriptor.id)
    byId.set(id, descriptor)
    eventsById.set(id, Array.isArray(descriptor.events) ? descriptor.events : eventLog(descriptor))
    if (artifactsRoot) {
      const dir = path.join(artifactsRoot, id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'session.log'), 'events for ' + id + '\n')
      fs.writeFileSync(path.join(dir, 'session.lock'), 'lock ' + id + '\n')
    }
  }

  const calls = { rename: [], archive: [], unarchive: [], routeRegistrations: [], tools: [] }
  const disposers = []
  const archived = new Set(Array.isArray(options.archivedIds) ? options.archivedIds : [])
  const pinned = new Set(Array.isArray(options.pinnedIds) ? options.pinnedIds : [])
  const revisions = new Map()

  const services = {}
  const ctx = {
    logger: silentLogger,
    get: (name) => services[name],
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register(route) {
        calls.routeRegistrations.push(route)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    tools: {
      register(definition) {
        calls.tools.push(definition)
        return () => {}
      },
    },
  }

  services.sessionController = {
    async list() {
      return {
        items: descriptors.map((descriptor, index) => ({
          sessionId: descriptor.id,
          updatedAt: typeof descriptor.updatedAt === 'number' ? descriptor.updatedAt : 5000 - index,
          running: Boolean(descriptor.running),
          blank: Boolean(descriptor.blank),
          cwd: descriptor.cwd,
          parentSessionId: descriptor.parentSessionId,
          origin: descriptor.origin,
        })),
      }
    },
    async rename({ sessionId, title }) {
      calls.rename.push({ sessionId, title })
      return { sessionId, title }
    },
  }

  services.workspaceRegistry = {
    get archivedSessionIds() {
      return [...archived]
    },
    get pinnedSessionIds() {
      return [...pinned]
    },
    list: () => workspaces,
    async archiveSession(id, archiveOptions) {
      calls.archive.push({ id, options: archiveOptions })
      archived.add(id)
    },
    async unarchiveSession(id) {
      calls.unarchive.push({ id })
      archived.delete(id)
    },
  }

  const artifactDir = (id) => (artifactsRoot ? path.join(artifactsRoot, id) : null)

  services.sessionPersistence = {
    async stat(id) {
      if (!byId.has(id)) throw new Error('unknown session ' + id)
      return {
        revision: revisions.get(id) ?? 'rev-' + id,
        eventCount: (eventsById.get(id) ?? []).length,
        location: { kind: 'jsonl', path: artifactsRoot ? path.join(artifactDir(id), 'session.log') : '/none/' + id },
        header: { id, cwd: byId.get(id)?.cwd },
      }
    },
    async open(id) {
      const events = eventsById.get(id) ?? []
      return {
        async read(offset, length) {
          return { events: events.slice(offset, offset + Math.max(0, length)) }
        },
        async close() {},
      }
    },
  }

  services.sessionQuery = {
    async readSession(id) {
      return { events: eventsById.get(id) ?? [] }
    },
    async readTitle() {
      return null
    },
  }

  return {
    ctx,
    services,
    calls,
    disposers,
    /** Run every ctx.effect() disposer (e.g. the plugin instance applied by apply()). */
    disposeAll() {
      while (disposers.length > 0) {
        const dispose = disposers.shift()
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
    workspaces,
    byId,
    eventsById,
    revisions,
    artifactDir,
    artifactFile: (id) => (artifactsRoot ? path.join(artifactDir(id), 'session.log') : null),
    setRevision(id, revision) {
      revisions.set(id, revision)
    },
    setArchived(id, value) {
      if (value) archived.add(id)
      else archived.delete(id)
    },
  }
}

/** Drive a registered web-server route through its Node req/res handler. */
export async function invokeHttp(route, request = {}) {
  const method = String(request.method ?? 'GET').toUpperCase()
  const payload = request.body === undefined ? '' : JSON.stringify(request.body)
  const req = {
    method,
    url: API_PREFIX + (request.path ?? '/'),
    on(event, handler) {
      if (event === 'data') {
        if (payload) handler(Buffer.from(payload))
        return
      }
      if (event === 'end') {
        handler()
        return
      }
      if (event === 'error') return
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(chunk) {
      this.body = chunk ?? ''
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

/** Poll GET /sessions until every listed id carries a non-empty title. */
export async function waitForTitles(harness, ids, timeoutMs = 3000) {
  return waitFor(async () => {
    const response = await harness.rows({ includeArchived: '1', includeSubagents: '1' })
    if (response.status !== 200) return false
    const rows = response.body.rows ?? []
    return ids.every((id) => rows.some((row) => row.id === id && typeof row.title === 'string' && row.title !== ''))
  }, timeoutMs)
}

/**
 * Build the whole plugin on top of a fake context.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.sessions] Session descriptors:
 *   { id, cwd, updatedAt, running, blank, parentSessionId, origin, events }
 * @param {string} [options.baseDir]        temp root (a fresh one is created by default)
 * @param {string} [options.dataDir]        plugin data dir (default <base>/data)
 * @param {string} [options.artifactsRoot]  where fake Session dirs live (default <base>/artifacts)
 * @param {string[]} [options.archivedIds]
 * @param {string[]} [options.pinnedIds]
 * @param {object} [options.settings]
 * @param {boolean} [options.autostart]     kick the status index at creation (default true)
 */
export async function createHarness(options = {}) {
  const base = options.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-e2e-'))
  const dataDir = options.dataDir ?? path.join(base, 'data')
  const artifactsRoot = options.artifactsRoot ?? path.join(base, 'artifacts')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(artifactsRoot, { recursive: true })

  const fake = createFakeCtx({ ...options, artifactsRoot })
  const { ctx } = fake

  const settings = mergeSettings(options.settings)
  const store = new StateStore({ dataDir, logger: silentLogger })
  store.loadSync()

  const sessions = createSessionSource({ ctx, logger: silentLogger, settings })
  const factsCalls = []
  const statCalls = []
  const rawFactsOf = sessions.factsOf
  const rawStatOf = sessions.statOf
  sessions.factsOf = async (id, factOptions) => {
    factsCalls.push(id)
    return rawFactsOf(id, factOptions)
  }
  sessions.statOf = async (id) => {
    statCalls.push(id)
    return rawStatOf(id)
  }

  const statusIndex = createStatusIndexer({ store, sessions, logger: silentLogger, settings })
  const tags = createTagService({ store, sessions, statusIndex, logger: silentLogger })
  const rules = createRuleService({ store, sessions, tags, statusIndex, logger: silentLogger })
  const trash = createTrashService({ store, sessions, logger: silentLogger, dataDir })

  // host/ai.js may not exist yet (it is owned by another task): optional load.
  let ai = null
  try {
    const module = await import('../../host/ai.js')
    if (typeof module?.createAiService === 'function') {
      ai = module.createAiService({
        store,
        sessions,
        statusIndex,
        settings,
        logger: silentLogger,
        llm: undefined,
        agentDefaultModel: undefined,
      })
    }
  } catch {
    ai = null
  }

  // host/jobs.js is loaded optionally, mirroring index.js: the api unit tests
  // run with an in-process fake runner, the e2e harness uses the real one.
  let jobs = null
  try {
    const module = await import('../../host/jobs.js')
    if (typeof module?.createJobRunner === 'function') {
      jobs = module.createJobRunner({ store, logger: silentLogger, handlers: createJobHandlers({ ai, tags, store }) })
      jobs.recover?.()
    }
  } catch {
    jobs = null
  }

  const api = createApi({
    store,
    sessions,
    statusIndex,
    tags,
    rules,
    ai,
    trash,
    jobs,
    meta: { version: 'e2e' },
    workspaceLabel: makeWorkspaceLabel(fake.workspaces),
    logger: silentLogger,
  })

  if (options.autostart !== false) statusIndex.start({ force: false })

  return {
    base,
    dataDir,
    artifactsRoot,
    ctx,
    services: fake.services,
    calls: fake.calls,
    store,
    sessions,
    statusIndex,
    tags,
    rules,
    trash,
    ai,
    settings,
    factsCalls,
    statCalls,
    artifactDir: fake.artifactDir,
    artifactFile: fake.artifactFile,
    setRevision: fake.setRevision,
    /** Route through the real api router, no socket. */
    async call(method, tail, body, query) {
      return api.routeSafe({ method, pathname: API_PREFIX + tail, body, query })
    },
    async rows(query) {
      return api.routeSafe({ method: 'GET', pathname: API_PREFIX + '/sessions', query })
    },
    async waitIdle() {
      return waitFor(() => !statusIndex.status().running)
    },
    /** Wait for one job to reach a terminal state, then return it. */
    async waitJob(id, timeoutMs = 5000) {
      const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
      const ok = await waitFor(() => {
        const job = jobs?.get?.(id)
        return Boolean(job && terminal.has(job.state))
      }, timeoutMs)
      if (!ok) throw new Error('job did not settle: ' + id)
      return jobs.get(id)
    },
    jobs,
    dispose() {
      try {
        statusIndex.stop()
      } catch {
        /* ignore */
      }
      try {
        jobs?.stop?.()
      } catch {
        /* ignore */
      }
      fs.rmSync(dataDir, { recursive: true, force: true })
      fs.rmSync(artifactsRoot, { recursive: true, force: true })
      fs.rmSync(base, { recursive: true, force: true })
    },
  }
}

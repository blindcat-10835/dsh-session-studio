import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { API_PREFIX } from '../host/api.js'

/** Synthetic event logs, one per Session id. */
function eventLog({ title, reason, firstMessage }) {
  return [
    { seq: 1, time: 1000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: firstMessage }], source: { kind: 'user' } } },
    { seq: 2, time: 1100, type: 'session/title', data: { title, messageSeqs: [1], source: 'fallback' } },
    { seq: 3, time: 1200, type: 'turn/end', data: { reason: { kind: reason } } },
  ]
}

function createFakeCtx(logs) {
  const services = {}
  const disposers = []
  const routes = []
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (name) => services[name],
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: { requestRejection: () => undefined },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
  }

  services.tools = ctx.tools
  services.sessionController = {
    async list() {
      return {
        items: Object.keys(logs).map((id, index) => ({ sessionId: id, updatedAt: 5000 - index, running: false, blank: false, cwd: '/repo/a' })),
      }
    },
    async rename({ sessionId, title }) {
      return { sessionId, title }
    },
  }
  services.workspaceRegistry = {
    archivedSessionIds: [],
    pinnedSessionIds: ['sm-2'],
    list: () => [{ id: 'w1', path: '/repo/a', title: '仓库 A' }],
    async archiveSession() {},
    async unarchiveSession() {},
  }
  services.sessionPersistence = {
    async stat(id) {
      const events = logs[id]
      if (!events) throw new Error('unknown session ' + id)
      return { revision: 'rev-' + id, eventCount: events.length, location: { kind: 'jsonl', path: path.join('/tmp', id, 'session.v4.jsonl.zstd') }, header: { id } }
    },
    async open(id) {
      const events = logs[id]
      return {
        async read(offset, length) {
          return { events: events.slice(offset, offset + length) }
        },
        async close() {},
      }
    },
  }
  services.sessionQuery = {
    async readSession(id) {
      return { events: logs[id] ?? [] }
    },
    async readTitle() {
      return null
    },
  }
  return { ctx, routes, tools, services }
}

function fakeRequest(method, urlPath) {
  return { method, url: urlPath, on() {} }
}

function fakeResponse() {
  return {
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
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test('wiring serves rows with titles and derived status through the registered HTTP route', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-wiring-'))
  const logs = {
    'sm-1': eventLog({ title: '修登录重试', reason: 'blocked', firstMessage: '登录老是失败' }),
    'sm-2': eventLog({ title: '整理文档', reason: 'completed', firstMessage: '帮我整理文档' }),
  }
  const { ctx, routes } = createFakeCtx(logs)
  await apply(ctx, { dataDir, status: { concurrency: 1 } })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, API_PREFIX)

  const handler = routes[0].handler
  const indexed = await waitFor(() => {
    const res = fakeResponse()
    return handler(fakeRequest('GET', API_PREFIX + '/sessions'), res).then(() => {
      if (res.statusCode !== 200) return false
      const body = JSON.parse(res.body)
      return body.rows.length === 2 && body.rows.every((row) => row.title)
    })
  })
  assert.equal(indexed, true, 'status index should fill titles for both sessions')

  const listRes = fakeResponse()
  await handler(fakeRequest('GET', API_PREFIX + '/sessions'), listRes)
  assert.equal(listRes.statusCode, 200)
  const list = JSON.parse(listRes.body)
  assert.equal(list.rows.length, 2)
  assert.equal(list.rows[0].id, 'sm-1')
  assert.equal(list.rows[0].title, '修登录重试')
  assert.equal(list.rows[0].lastTurnEnd, 'blocked')
  assert.equal(list.rows[0].workspaceTitle, '仓库 A')
  assert.equal(list.rows[1].pinned, true)

  const stateRes = fakeResponse()
  await handler(fakeRequest('GET', API_PREFIX + '/state'), stateRes)
  assert.equal(stateRes.statusCode, 200)
  const state = JSON.parse(stateRes.body)
  assert.equal(state.settings.status.tailEvents, 120)
  assert.equal(state.ai.ok, false, 'no llm service is injected in this test context')

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('wiring registers the two agent tools and exposes them over the tool service', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tools-'))
  const logs = { 'sm-9': eventLog({ title: '一个会话', reason: 'completed', firstMessage: 'hi' }) }
  const { ctx, tools } = createFakeCtx(logs)
  await apply(ctx, { dataDir })
  const names = tools.map((definition) => definition.name).sort()
  assert.deepEqual(names, ['session_studio_list', 'session_studio_tags'])

  const list = tools.find((definition) => definition.name === 'session_studio_list')
  const value = await list.execute({ includeArchived: true, includeSubagents: true, limit: 10 })
  assert.ok(Array.isArray(value.rows))

  const tagTool = tools.find((definition) => definition.name === 'session_studio_tags')
  const tagged = await tagTool.execute({ sessionIds: ['sm-9'], op: 'append', tags: ['文档'] })
  assert.equal(tagged.updated, 1)
  const reread = await list.execute({ limit: 10 })
  assert.deepEqual([...reread.rows[0].tags], ['文档'])

  fs.rmSync(dataDir, { recursive: true, force: true })
})

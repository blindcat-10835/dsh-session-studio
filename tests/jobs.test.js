import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { StateStore } from '../host/store.js'
import { createJobRunner, JOB_ITEM_LIMIT } from '../host/jobs.js'

const silent = { warn() {}, error() {}, debug() {}, info() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-studio-jobs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore({ dataDir: dir, logger: silent })
  store.loadSync()
  return store
}

/** A store wrapper that records every jobs.json write, delegating the real I/O. */
function recordingStore(t) {
  const inner = makeStore(t)
  const writes = []
  return {
    writes,
    store: {
      readDoc: (name, fallback) => inner.readDoc(name, fallback),
      writeDoc: (name, value) => {
        writes.push({ name, value: JSON.parse(JSON.stringify(value)) })
        return inner.writeDoc(name, value)
      },
    },
  }
}

function setup(t, handlers, options = {}) {
  const store = options.store ?? makeStore(t)
  const runner = createJobRunner({ store, logger: silent, handlers, flushMs: 10, ...options })
  t.after(() => {
    try {
      runner.stop()
    } catch {
      /* already stopped */
    }
  })
  return { runner, store }
}

async function waitFor(predicate, label, timeout = 3000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('timed out waiting for ' + label)
    await sleep(5)
  }
}

test('start rejects unknown types and returns a queued Job with the PRD shape', (t) => {
  const { runner } = setup(t, { 'job.test': async () => null })

  assert.throws(
    () => runner.start({ type: 'nope', params: {} }),
    (error) => error.name === 'StateError' && error.code === 'invalid_type',
  )
  assert.throws(() => runner.start({}), (error) => error.code === 'invalid_type')
  assert.throws(() => runner.start(), (error) => error.code === 'invalid_type')

  const created = runner.start({ type: 'job.test', params: { value: 1 } })
  assert.equal(created.state, 'queued')
  assert.match(created.id, /^job-\d+-[0-9a-f]{6}$/)
  assert.equal(created.type, 'job.test')
  assert.deepEqual(created.params, { value: 1 })
  assert.equal(created.total, 0)
  assert.equal(created.done, 0)
  assert.equal(created.failed, 0)
  assert.equal(created.skipped, 0)
  assert.equal(created.percent, 0)
  assert.equal(created.startedAt, null)
  assert.equal(created.finishedAt, null)
  assert.equal(created.error, null)
  assert.equal(created.result, null)
  assert.equal(created.itemsTruncated, false)
  assert.deepEqual(created.items, [])
  assert.equal(typeof created.createdAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(created.createdAt)), 'createdAt is an ISO timestamp')

  assert.equal(runner.get('job-missing'), null)
  assert.equal(runner.cancel('job-missing'), null)
  assert.equal(runner.get(''), null)
})

test('a successful handler settles succeeded with percent 100 and flushes jobs.json immediately', async (t) => {
  const { runner, store } = setup(t, {
    'job.ok': async (ctx) => {
      ctx.report({ total: 2 })
      ctx.addItem({ key: 'one', state: 'done', data: { n: 1 } })
      ctx.report({ done: 1 })
      ctx.addItem({ key: 'two', state: 'done', message: 'ok', data: { n: 2 } })
      return { value: 42 }
    },
  })

  const created = runner.start({ type: 'job.ok', params: { hello: 'world' } })
  const job = await waitFor(() => {
    const current = runner.get(created.id)
    return current && current.state === 'succeeded' ? current : null
  }, 'job success')

  assert.deepEqual(job.params, { hello: 'world' })
  assert.equal(job.done, 1)
  assert.equal(job.total, 2)
  assert.equal(job.percent, 100)
  assert.deepEqual(job.result, { value: 42 })
  assert.equal(job.error, null)
  assert.equal(typeof job.startedAt, 'string')
  assert.equal(typeof job.finishedAt, 'string')
  assert.equal(job.items.length, 2)
  assert.deepEqual(job.items[0], { key: 'one', state: 'done', message: null, data: { n: 1 } })
  assert.deepEqual(job.items[1], { key: 'two', state: 'done', message: 'ok', data: { n: 2 } })
  assert.equal(runner.activeCount(), 0)

  const doc = store.readDoc('jobs.json')
  assert.equal(doc.schema, 1)
  assert.equal(doc.jobs.length, 1)
  assert.equal(doc.jobs[0].id, created.id)
  assert.equal(doc.jobs[0].state, 'succeeded')
  assert.deepEqual(doc.jobs[0].result, { value: 42 })
})

test('a throwing handler marks the job failed and keeps the error message', async (t) => {
  const { runner } = setup(t, {
    'job.fail': async (ctx) => {
      ctx.report({ total: 4 })
      ctx.report({ done: 1 })
      throw new Error('boom')
    },
  })

  const created = runner.start({ type: 'job.fail', params: {} })
  const job = await waitFor(() => {
    const current = runner.get(created.id)
    return current && current.state === 'failed' ? current : null
  }, 'job failure')

  assert.deepEqual(job.error, { code: 'handler_failed', message: 'boom' })
  assert.equal(job.result, null)
  assert.equal(job.percent, 25, 'a failed job keeps the progress it reached, never 100')
  assert.equal(typeof job.finishedAt, 'string')
  assert.equal(runner.activeCount(), 0)
})

test('jobs run serially in FIFO order even when they are started together', async (t) => {
  const order = []
  let active = 0
  let peak = 0
  const { runner } = setup(t, {
    'job.step': async (ctx) => {
      active += 1
      peak = Math.max(peak, active)
      order.push('start:' + ctx.params.n)
      await sleep(15)
      order.push('end:' + ctx.params.n)
      active -= 1
      return ctx.params.n
    },
  })

  const ids = [1, 2, 3].map((n) => runner.start({ type: 'job.step', params: { n } }).id)
  await waitFor(
    async () => ids.every((id) => runner.get(id)?.state === 'succeeded'),
    'all three jobs',
  )

  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'])
  assert.equal(peak, 1, 'only one handler is ever in flight')
  assert.equal(runner.activeCount(), 0)
})

test('list pins active jobs, filters the active set and honours the limit', async (t) => {
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { runner } = setup(t, {
    'job.slow': async () => {
      await gate
      return 'slow'
    },
    'job.fast': async () => 'fast',
  })

  const first = runner.start({ type: 'job.slow', params: { n: 1 } })
  const second = runner.start({ type: 'job.fast', params: { n: 2 } })
  await waitFor(() => runner.get(first.id)?.state === 'running', 'first job running')

  assert.equal(runner.activeCount(), 2)
  assert.deepEqual(
    runner.list({ active: true }).map((job) => job.id),
    [second.id, first.id],
    'both are active; newest first inside the pinned group',
  )
  assert.deepEqual(
    runner.list({ limit: 1 }).map((job) => job.id),
    [second.id],
    'active jobs are not dropped by the limit',
  )

  release()
  await waitFor(
    async () => [first, second].every((job) => runner.get(job.id)?.state === 'succeeded'),
    'both jobs',
  )
  assert.deepEqual(runner.list({ active: true }), [])
  assert.deepEqual(runner.list().map((job) => job.id), [second.id, first.id])
})

test('cancel on a queued job stops it before its handler ever runs', async (t) => {
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let secondCalls = 0
  const { runner } = setup(t, {
    'job.block': async () => {
      await gate
      return 'first'
    },
    'job.second': async () => {
      secondCalls += 1
      return 'second'
    },
  })

  const first = runner.start({ type: 'job.block', params: {} })
  const second = runner.start({ type: 'job.second', params: {} })
  assert.equal(second.state, 'queued')

  const cancelled = runner.cancel(second.id)
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(typeof cancelled.finishedAt, 'string')
  assert.equal(cancelled.result, null)
  assert.equal(cancelled.error, null)

  release()
  await waitFor(() => runner.get(first.id)?.state === 'succeeded', 'first job')
  await sleep(20)
  assert.equal(secondCalls, 0, 'a queued cancelled handler is never invoked')
  assert.equal(runner.get(second.id).state, 'cancelled')
  assert.equal(runner.cancel(second.id).state, 'cancelled', 'cancelling a terminal job returns it unchanged')
})

test('cancel on a running job aborts the signal and settles as cancelled', async (t) => {
  let aborted = false
  let started = null
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const { runner } = setup(t, {
    'job.abort': async (ctx) => {
      started()
      await new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
      })
      return 'should not win'
    },
  })

  const created = runner.start({ type: 'job.abort', params: {} })
  await startedPromise
  assert.equal(runner.get(created.id).state, 'running')

  const pending = runner.cancel(created.id)
  assert.equal(pending.state, 'running', 'the handler is still unwinding when cancel returns')

  const job = await waitFor(() => {
    const current = runner.get(created.id)
    return current && current.state === 'cancelled' ? current : null
  }, 'cancelled job')
  assert.equal(aborted, true, 'the handler saw signal.abort()')
  assert.equal(job.result, null)
  assert.equal(job.error, null)
  assert.equal(typeof job.finishedAt, 'string')
})

test('progress follows absolute counters, caps at 99 while running and hits 100 on success', async (t) => {
  let runner = null
  const seen = []
  const created = setup(t, {
    'job.progress': async (ctx) => {
      ctx.report({ total: 3 })
      ctx.report({ done: 1 })
      seen.push(runner.get(ctx.id).percent)
      ctx.report({ done: 3 })
      seen.push(runner.get(ctx.id).percent)
      ctx.report({ total: 0 })
      seen.push(runner.get(ctx.id).percent)
      return 'done'
    },
  })
  runner = created.runner

  const createdJob = runner.start({ type: 'job.progress', params: {} })
  const job = await waitFor(() => {
    const current = runner.get(createdJob.id)
    return current && current.state === 'succeeded' ? current : null
  }, 'progress job')

  assert.deepEqual(seen, [33, 99, 0], 'floor(100*done/total), capped at 99, 0 without a total')
  assert.equal(job.done, 3)
  assert.equal(job.total, 0)
  assert.equal(job.percent, 100, 'success always ends at 100')
})

test('items are capped at 200 and itemsTruncated reports the loss', async (t) => {
  const total = JOB_ITEM_LIMIT + 5
  const { runner, store } = setup(t, {
    'job.items': async (ctx) => {
      for (let index = 0; index < total; index += 1) {
        ctx.addItem({
          key: 'k' + index,
          state: index % 2 === 0 ? 'skipped' : 'done',
          message: index === 0 ? undefined : null,
          data: { index },
        })
      }
      ctx.report({ total, done: total })
      return { count: total }
    },
  })

  const created = runner.start({ type: 'job.items', params: {} })
  const job = await waitFor(() => {
    const current = runner.get(created.id)
    return current && current.state === 'succeeded' ? current : null
  }, 'items job')

  assert.equal(job.items.length, JOB_ITEM_LIMIT)
  assert.equal(job.itemsTruncated, true)
  assert.equal(job.items[0].key, 'k0')
  assert.equal(job.items[0].state, 'skipped')
  assert.equal(job.items[0].message, null)
  assert.deepEqual(job.items[0].data, { index: 0 })
  assert.equal(job.items[JOB_ITEM_LIMIT - 1].key, 'k' + (JOB_ITEM_LIMIT - 1))

  const doc = store.readDoc('jobs.json')
  assert.equal(doc.jobs[0].items.length, JOB_ITEM_LIMIT)
  assert.equal(doc.jobs[0].itemsTruncated, true)
})

test('recover marks persisted queued and running jobs interrupted and leaves terminal jobs alone', (t) => {
  const store = makeStore(t)
  store.writeDoc('jobs.json', {
    schema: 1,
    jobs: [
      { id: 'job-queued', type: 'job.test', state: 'queued', createdAt: '2026-01-01T00:00:00.000Z', total: 10, done: 2, percent: 20 },
      {
        id: 'job-running',
        type: 'job.test',
        state: 'running',
        createdAt: '2026-01-01T00:00:01.000Z',
        startedAt: '2026-01-01T00:00:01.100Z',
        total: 10,
        done: 5,
        percent: 50,
        items: [{ key: 'a', state: 'done', message: null, data: { n: 1 } }],
      },
      {
        id: 'job-done',
        type: 'job.test',
        state: 'succeeded',
        createdAt: '2026-01-01T00:00:02.000Z',
        finishedAt: '2026-01-01T00:00:02.500Z',
        percent: 100,
        result: { ok: true },
      },
    ],
  })

  const runner = createJobRunner({ store, logger: silent, handlers: { 'job.test': async () => null } })
  t.after(() => runner.stop())

  assert.equal(runner.get('job-queued').state, 'queued', 'loading alone does not rewrite history')
  assert.equal(runner.activeCount(), 2)

  runner.recover()

  const queued = runner.get('job-queued')
  assert.equal(queued.state, 'interrupted')
  assert.deepEqual(queued.error, { code: 'interrupted', message: 'Job was interrupted by a host restart' })
  assert.equal(typeof queued.finishedAt, 'string')

  const running = runner.get('job-running')
  assert.equal(running.state, 'interrupted')
  assert.equal(running.percent, 50, 'the progress already reported is preserved')
  assert.equal(running.items.length, 1)

  const done = runner.get('job-done')
  assert.equal(done.state, 'succeeded')
  assert.deepEqual(done.result, { ok: true })
  assert.equal(runner.activeCount(), 0)

  const doc = store.readDoc('jobs.json')
  assert.deepEqual(doc.jobs.map((job) => job.state), ['interrupted', 'interrupted', 'succeeded'])
})

test('a reloaded runner can list and read the jobs persisted by the previous one', async (t) => {
  const store = makeStore(t)
  const handlers = {
    'job.persist': async (ctx) => {
      ctx.report({ total: 2 })
      ctx.addItem({ key: 'one', state: 'done', data: { n: 1 } })
      ctx.report({ done: 2 })
      return { ok: true }
    },
  }

  const first = createJobRunner({ store, logger: silent, handlers, flushMs: 10 })
  const created = first.start({ type: 'job.persist', params: { flag: true } })
  const finished = await waitFor(() => {
    const current = first.get(created.id)
    return current && current.state === 'succeeded' ? current : null
  }, 'persisted job')
  assert.equal(finished.state, 'succeeded')
  first.stop()

  const reloadedStore = new StateStore({ dataDir: store.dataDir, logger: silent })
  reloadedStore.loadSync()
  const second = createJobRunner({ store: reloadedStore, logger: silent, handlers, flushMs: 10 })
  t.after(() => second.stop())

  const listed = second.list()
  assert.equal(listed.length, 1, 'the finished job survived the restart')
  assert.equal(listed[0].id, created.id)
  assert.equal(listed[0].state, 'succeeded')
  assert.deepEqual(listed[0].result, { ok: true })
  assert.equal(listed[0].items.length, 1)

  const fetched = second.get(created.id)
  assert.equal(fetched.type, 'job.persist')
  assert.deepEqual(fetched.params, { flag: true })
  assert.equal(second.activeCount(), 0)
})

test('stop cancels the queue, flushes once, and never advances or writes again', async (t) => {
  const { store, writes } = recordingStore(t)
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let blockedCalls = 0
  let queuedCalls = 0
  const runner = createJobRunner({
    store,
    logger: silent,
    flushMs: 5,
    handlers: {
      'job.block': async () => {
        blockedCalls += 1
        await gate
        return 'blocked'
      },
      'job.queued': async () => {
        queuedCalls += 1
        return 'queued'
      },
    },
  })
  t.after(() => runner.stop())

  const first = runner.start({ type: 'job.block', params: {} })
  await waitFor(() => runner.get(first.id)?.state === 'running', 'blocking job running')
  const second = runner.start({ type: 'job.queued', params: {} })
  assert.equal(second.state, 'queued')

  runner.stop()

  assert.equal(blockedCalls, 1)
  assert.equal(runner.get(second.id).state, 'cancelled', 'the queued job is cancelled by stop')
  assert.ok(writes.length >= 1, 'stop flushes immediately')
  const writesAtStop = writes.length

  release()
  await sleep(40)
  assert.equal(queuedCalls, 0, 'the queue never advances after stop')
  assert.equal(runner.get(first.id).state, 'running', 'the running handler is not settled after stop')
  assert.equal(writes.length, writesAtStop, 'no write happens after stop')
  assert.throws(
    () => runner.start({ type: 'job.block', params: {} }),
    (error) => error.name === 'StateError' && error.code === 'stopped',
  )
})

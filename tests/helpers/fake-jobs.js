/**
 * In-process job runner used by the api unit tests.
 *
 * It implements the same surface as host/jobs.js (see docs/CONTRACTS.md) but
 * runs the handler immediately and keeps the returned promise on the job under
 * `done`, so a test can await the terminal state without polling.
 */

export function createFakeJobs(handlers = {}) {
  const jobs = new Map()
  let seq = 0

  function start({ type, params } = {}) {
    if (!handlers[type]) {
      const error = new Error('unknown job type: ' + type)
      error.code = 'invalid_type'
      throw error
    }
    const id = 'job-' + String(++seq).padStart(4, '0')
    const job = {
      id,
      type,
      state: 'running',
      params,
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      percent: 0,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      result: null,
      itemsTruncated: false,
      items: [],
    }
    jobs.set(id, job)
    const report = (patch = {}) => {
      if (!patch || typeof patch !== 'object') return
      Object.assign(job, patch)
      if (job.state === 'running') {
        job.percent = job.total > 0 ? Math.min(99, Math.floor((100 * job.done) / job.total)) : 0
      }
    }
    const addItem = (item) => {
      if (job.items.length < 200) job.items.push(item)
      else job.itemsTruncated = true
    }
    const controller = new AbortController()
    // `done` is the progress count in the wire shape, so the settle promise is
    // kept on the test-only `__done` field.
    job.__done = Promise.resolve()
      .then(() => handlers[type]({ id, type, params, signal: controller.signal, report, addItem }))
      .then((result) => {
        job.result = result
        job.state = 'succeeded'
        job.percent = 100
        job.finishedAt = Date.now()
        return job
      })
      .catch((error) => {
        job.state = 'failed'
        job.error = { code: typeof error?.code === 'string' ? error.code : 'handler_failed', message: String(error?.message ?? error) }
        job.finishedAt = Date.now()
        return job
      })
    return job
  }

  return {
    start,
    get: (id) => jobs.get(id) ?? null,
    list: ({ active = false, limit = 20 } = {}) =>
      [...jobs.values()].filter((job) => !active || job.state === 'queued' || job.state === 'running').slice(-limit),
    cancel: (id) => jobs.get(id) ?? null,
    activeCount: () => [...jobs.values()].filter((job) => job.state === 'queued' || job.state === 'running').length,
    recover: () => {},
    stop: () => {},
  }
}

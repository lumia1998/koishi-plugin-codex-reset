const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { resolve, join } = require('node:path')
const { Context } = require('koishi')
const { SQLiteDriver } = require('@minatojs/driver-sqlite')
const plugin = require('../lib/index.js')
const { SnapshotStore, MIN_POLL_INTERVAL_MS } = require('../lib/cache.js')

const TABLE = 'codex_reset_cache'
const API = 'https://example.test/codex-resets'

function snapshot() {
  return {
    schemaVersion: 1, timezone: 'Asia/Shanghai', checkedAt: null,
    historyFrom: '2026-09-01T00:00:00+08:00', count: 1,
    events: [{
      id: 'reset-a', type: 'direct_reset', label: '全员重置', status: 'confirmed', title: '', scope: '',
      createdAt: '2026-09-02T00:00:00+08:00', updatedAt: '2026-09-02T00:00:00+08:00',
      confirmedAt: '2026-09-02T01:00:00+08:00', occurredOn: '2026-09-02',
      confirmationBasis: 'source_post', schedule: null, posts: [], url: 'https://example.test/reset-a',
    }],
  }
}

async function setup(t) {
  const prefix = resolve(__dirname, '../../.codex-reset-test-')
  const directory = await mkdtemp(prefix)
  const apps = new Set()
  let now = Date.parse('2026-10-15T12:00:00+08:00')
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  Date.now = () => now
  t.after(async () => {
    globalThis.fetch = originalFetch
    Date.now = originalNow
    for (const app of apps) await app.stop()
    assert.ok(directory.startsWith(prefix))
    await rm(directory, { recursive: true, force: true })
  })

  async function open(options = {}) {
    const app = new Context()
    app.baseDir = directory
    app.plugin(SQLiteDriver, { path: 'cache.sqlite' })
    await app.start()
    apps.add(app)
    const commands = new Map()
    const ready = []
    const dispose = []
    const timers = []
    const warnings = []
    // Exercise the real plugin's lifecycle and command handlers against an
    // actual SQLite database, with manual timers and no bot transport needed.
    const ctx = {
      baseDir: directory, model: app.model, database: app.database, bots: [],
      logger: () => ({ warn: (message) => warnings.push(message), info: () => {} }),
      on: (event, callback) => (event === 'ready' ? ready : dispose).push(callback),
      setInterval: (callback, interval) => timers.push({ callback, interval }),
      command: (name) => {
        const command = {
          alias: () => command, option: () => command,
          action: (callback) => { commands.set(name.split(' ')[0], callback); return command },
        }
        return command
      },
    }
    plugin.apply(ctx, {
      apiUrl: API, pollInterval: 300, requestTimeout: 15000, targets: [],
      pushAnnouncements: true, pushConfirmedResets: true, mentionAll: false, ...options,
    })
    return {
      app, warnings, timers,
      start: async () => { for (const callback of ready) await callback() },
      query: (name) => commands.get(name)({ options: {} }),
      poll: () => timers[0].callback(),
      disposePlugin: () => { for (const callback of dispose) callback() },
      close: async () => {
        for (const callback of dispose) await callback()
        await app.stop()
        apps.delete(app)
      },
      cache: async () => (await app.database.get(TABLE, {}))[0],
    }
  }
  return { open, advance: (milliseconds) => { now += milliseconds }, now: () => now }
}

test('restart restores the SQLite snapshot and queries never request the API', async (t) => {
  const { open, now } = await setup(t)
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json(snapshot(), { headers: { ETag: '"reset-v1"' } })
  }
  const first = await open()
  await first.start()
  assert.equal(requests, 1)
  assert.equal(first.timers[0].interval, MIN_POLL_INTERVAL_MS)
  const saved = await first.cache()
  assert.deepEqual(saved.snapshot, snapshot())
  assert.equal(saved.etag, '"reset-v1"')
  assert.equal(saved.nextFetchAt, now() + MIN_POLL_INTERVAL_MS)
  await first.close()

  const second = await open()
  await second.start()
  assert.match(await second.query('codex.probability'), /不是官方预测/)
  assert.match(await second.query('codex.event'), /全员重置/)
  assert.equal(requests, 1, 'ready and commands must respect the saved cooldown')
})

test('ETag survives restart and 304 retains the full history in SQLite', async (t) => {
  const { open, advance, now } = await setup(t)
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests++
    if (requests === 1) return Response.json(snapshot(), { headers: { ETag: '"reset-v1"' } })
    assert.equal(options.headers['If-None-Match'], '"reset-v1"')
    return new Response(null, { status: 304, headers: { ETag: '"reset-v2"', 'Cache-Control': 'max-age=1800' } })
  }
  const first = await open()
  await first.start()
  await first.close()
  advance(MIN_POLL_INTERVAL_MS + 1)
  const second = await open()
  await second.start()
  const saved = await second.cache()
  assert.equal(requests, 2)
  assert.deepEqual(saved.snapshot, snapshot())
  assert.equal(saved.etag, '"reset-v2"')
  assert.equal(saved.nextFetchAt, now() + 1800_000)
  assert.deepEqual(second.warnings, [])
})

test('429 without any snapshot persists cooldown across restart and repeated commands', async (t) => {
  const { open, advance, now } = await setup(t)
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json({ retryAfter: 900 }, { status: 429, headers: { 'Retry-After': '1200' } })
  }
  const first = await open()
  await first.start()
  assert.equal((await first.cache()).nextFetchAt, now() + 1200_000)
  assert.match(first.warnings[0], /HTTP 429.*1200/)
  await first.close()

  const second = await open()
  await second.start()
  for (let i = 0; i < 3; i++) {
    assert.match(await second.query('codex.probability'), /暂时无法获取/)
    assert.match(await second.query('codex.event'), /暂时无法获取/)
  }
  advance(MIN_POLL_INTERVAL_MS)
  await second.poll()
  assert.equal(requests, 1)
  advance(1200_000 - MIN_POLL_INTERVAL_MS + 1)
  await second.poll()
  assert.equal(requests, 2)
})

test('Retry-After HTTP dates and JSON fallback both extend the persisted cooldown', async (t) => {
  const { open, advance, now } = await setup(t)
  const retryAt = now() + 1800_000
  globalThis.fetch = async () => new Response('busy', {
    status: 503, headers: { 'Retry-After': new Date(retryAt).toUTCString() },
  })
  const monitor = await open()
  await monitor.start()
  assert.equal((await monitor.cache()).nextFetchAt, retryAt)
  advance(1800_001)
  globalThis.fetch = async () => Response.json({ retryAfter: 1500 }, { status: 429 })
  await monitor.poll()
  assert.equal((await monitor.cache()).nextFetchAt, now() + 1500_000)
})

test('a failed refresh retains data for commands instead of clearing the snapshot', async (t) => {
  const { open, advance } = await setup(t)
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    if (requests === 1) return Response.json(snapshot(), { headers: { ETag: '"reset-v1"' } })
    return Response.json({ retryAfter: 1000 }, { status: 429 })
  }
  const monitor = await open()
  await monitor.start()
  advance(MIN_POLL_INTERVAL_MS + 1)
  await monitor.poll()
  assert.deepEqual((await monitor.cache()).snapshot, snapshot())
  assert.match(await monitor.query('codex.probability'), /不是官方预测/)
  assert.match(await monitor.query('codex.event'), /全员重置/)
  assert.equal(requests, 2)
})

test('database reservation survives a restart before the response is saved', async (t) => {
  const { open } = await setup(t)
  const monitor = await open()
  const store = new SnapshotStore(monitor.app, API, (value) => value?.schemaVersion === 1)
  let requests = 0
  await assert.rejects(store.refresh(300_000, 15000, async () => {
    requests++
    throw new Error('connection interrupted')
  }), /connection interrupted/)
  await monitor.close()
  const restarted = await open()
  globalThis.fetch = async () => { requests++; throw new Error('should remain in cooldown') }
  await restarted.start()
  assert.equal(requests, 1)
})

test('two stores sharing an API coalesce concurrent refreshes', async (t) => {
  const { open } = await setup(t)
  const monitor = await open()
  const validate = (value) => value?.schemaVersion === 1
  const first = new SnapshotStore(monitor.app, API, validate)
  const second = new SnapshotStore(monitor.app, API, validate)
  // Seed the row so this test specifically exercises the conditional update.
  await first.read()
  let requests = 0
  const fetchSnapshot = async () => {
    requests++
    await new Promise(resolve => setTimeout(resolve, 10))
    return { snapshot: snapshot(), etag: '"shared"', notModified: false, maxAgeMs: 0 }
  }
  await Promise.all([
    first.refresh(300_000, 15000, fetchSnapshot),
    second.refresh(300_000, 15000, fetchSnapshot),
  ])
  assert.equal(requests, 1)
  assert.deepEqual((await second.read()).snapshot, snapshot())
})

test('304 without a saved snapshot remains an error and starts a cooldown', async (t) => {
  const { open, now } = await setup(t)
  globalThis.fetch = async () => new Response(null, { status: 304 })
  const monitor = await open()
  await monitor.start()
  assert.match(monitor.warnings[0], /没有本地快照时返回了 304/)
  assert.equal((await monitor.cache()).snapshot, null)
  assert.equal((await monitor.cache()).nextFetchAt, now() + MIN_POLL_INTERVAL_MS)
})

test('request duration does not cause every other scheduled refresh to be skipped', async (t) => {
  const { open, advance } = await setup(t)
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    advance(1000)
    return Response.json(snapshot(), { headers: { 'Cache-Control': 'max-age=600' } })
  }
  const monitor = await open()
  await monitor.start()
  advance(MIN_POLL_INTERVAL_MS)
  await monitor.poll()
  advance(MIN_POLL_INTERVAL_MS - 1000)
  await monitor.poll()
  assert.equal(requests, 3)
})

test('real Koishi plugin injection starts with SQLite and exposes database-backed commands', async (t) => {
  const directory = await mkdtemp(resolve(__dirname, '../../.codex-reset-test-'))
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json(snapshot(), { headers: { ETag: '"integration"' } })
  }
  const app = new Context()
  app.baseDir = directory
  t.after(async () => {
    await app.stop()
    globalThis.fetch = originalFetch
    assert.ok(directory.startsWith(resolve(__dirname, '../../.codex-reset-test-')))
    await rm(directory, { recursive: true, force: true })
  })
  app.plugin(SQLiteDriver, { path: 'integration.sqlite' })
  app.plugin(plugin, plugin.Config({ apiUrl: API, pollInterval: 300 }))
  await app.start()
  const probability = app.$commander.get('codex.probability')
  assert.ok(probability, 'required database injection must activate the plugin')
  assert.match(await probability.execute({}), /不是官方预测/)
  assert.equal(requests, 1)
  const [cache] = await app.database.get(TABLE, {})
  assert.deepEqual(cache.snapshot, snapshot())
})

test('reload during an in-flight request does not restart the disposed monitor timer', async (t) => {
  const { open } = await setup(t)
  let releaseResponse
  let signalRequest
  const requested = new Promise(resolve => { signalRequest = resolve })
  globalThis.fetch = () => {
    signalRequest()
    return new Promise(resolve => { releaseResponse = resolve })
  }
  const monitor = await open()
  const starting = monitor.start()
  await requested
  monitor.disposePlugin()
  releaseResponse(Response.json(snapshot()))
  await starting
  assert.equal(monitor.timers.length, 0)
  assert.deepEqual((await monitor.cache()).snapshot, snapshot())
})

test('a database write failure prevents the upstream request', async (t) => {
  const { open } = await setup(t)
  const monitor = await open()
  const store = new SnapshotStore(monitor.app, API, (value) => value?.schemaVersion === 1)
  await store.read()
  const driver = monitor.app.model.drivers[0]
  driver.db.run('PRAGMA query_only = ON')
  let requests = 0
  try {
    await assert.rejects(store.refresh(300_000, 15000, async () => {
      requests++
      return { snapshot: snapshot(), etag: null, notModified: false, maxAgeMs: 0 }
    }), /readonly/)
    assert.equal(requests, 0)
  } finally {
    driver.db.run('PRAGMA query_only = OFF')
  }
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { resolve, join } = require('node:path')
const { Context } = require('koishi')
const { SQLiteDriver } = require('@minatojs/driver-sqlite')
const plugin = require('../lib/index.js')
const { PENDING_TABLE, PendingQueue, extendPendingModel } = require('../lib/pending.js')

const API = 'https://example.test/codex-resets'

function emptySnapshot() {
  return {
    schemaVersion: 1, timezone: 'Asia/Shanghai', checkedAt: null,
    historyFrom: '2026-09-01T00:00:00+08:00', count: 0, events: [],
  }
}

async function setup(t) {
  const prefix = resolve(__dirname, '../../.codex-reset-pending-')
  const directory = await mkdtemp(prefix)
  const app = new Context()
  app.baseDir = directory
  app.plugin(SQLiteDriver, { path: join(directory, 'pending.sqlite') })
  await app.start()

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(emptySnapshot())
  t.after(async () => {
    globalThis.fetch = originalFetch
    await app.stop()
    assert.ok(directory.startsWith(prefix))
    await rm(directory, { recursive: true, force: true })
  })

  // One mock instance per "process": same database, different state directory
  // and bots, which is exactly the multi-instance deployment we want to guard.
  function openInstance(name, bots) {
    const ready = []
    const dispose = []
    const timers = []
    const warnings = []
    const baseDir = join(directory, name)
    const ctx = {
      baseDir, model: app.model, database: app.database, bots,
      logger: () => ({ warn: (m) => warnings.push(m), info() {} }),
      on: (event, callback) => (event === 'ready' ? ready : dispose).push(callback),
      setTimeout: (callback, interval) => timers.push({ callback, interval }),
      command: () => {
        const command = {
          alias: () => command, option: () => command,
          action: () => command,
        }
        return command
      },
    }
    plugin.apply(ctx, {
      apiUrl: API, pollInterval: 660, requestTimeout: 15000,
      targets: [{ platform: 'onebot', channelId: '100' }],
      pushAnnouncements: true, pushConfirmedResets: true, mentionAll: false,
      commandAuthority: 0, renderCooldown: 5,
    })
    return {
      baseDir, warnings,
      start: async () => { for (const callback of ready) await callback() },
    }
  }

  return { app, openInstance }
}

function makeBot(platform, sink) {
  return {
    platform,
    selfId: 'bot',
    async sendMessage(channelId, content) {
      if (sink.fail) throw new Error('transport down')
      sink.sent.push({ platform, channelId, content })
    },
  }
}

test('pending queue inserts once and lets only one owner claim a row', async (t) => {
  const { app } = await setup(t)
  extendPendingModel(app)
  const a = new PendingQueue(app)
  const b = new PendingQueue(app)

  await a.add('id:confirmed:demo', 'hello', Date.now())
  await b.add('id:confirmed:demo', 'hello', Date.now())

  const rows = await app.database.get(PENDING_TABLE, {})
  assert.equal(rows.length, 1, 'duplicate insert must not create a second row')

  const [claimedA, claimedB] = await Promise.all([a.claim('id:confirmed:demo'), b.claim('id:confirmed:demo')])
  assert.equal([claimedA, claimedB].filter(Boolean).length, 1, 'only one instance may own a row')
})

test('two instances sharing a database deliver a queued event exactly once', async (t) => {
  const { app, openInstance } = await setup(t)
  const sinkA = { sent: [] }
  const sinkB = { sent: [] }
  const a = openInstance('a', [makeBot('onebot', sinkA)])
  const b = openInstance('b', [makeBot('onebot', sinkB)])

  await app.database.create(PENDING_TABLE, {
    key: 'id:confirmed:shared',
    message: '🔥 重置了',
    createdAt: Date.now(),
  })

  await Promise.all([a.start(), b.start()])

  assert.equal(sinkA.sent.length + sinkB.sent.length, 1, 'the event must be sent once, not once per instance')
  assert.equal((await app.database.get(PENDING_TABLE, {})).length, 0, 'delivered rows are removed')
})

test('a failed delivery stays queued and another instance retries it', async (t) => {
  const { app, openInstance } = await setup(t)
  const sinkA = { sent: [], fail: true }
  const sinkB = { sent: [] }
  const a = openInstance('a', [makeBot('onebot', sinkA)])
  const b = openInstance('b', [makeBot('onebot', sinkB)])

  await app.database.create(PENDING_TABLE, {
    key: 'id:confirmed:retry',
    message: '🔥 重试',
    createdAt: Date.now(),
  })

  await a.start()
  assert.equal(sinkA.sent.length, 0)
  assert.equal((await app.database.get(PENDING_TABLE, {})).length, 1, 'failed rows stay queued')

  await b.start()
  assert.equal(sinkB.sent.length, 1, 'the second instance picks the row up')
  assert.equal((await app.database.get(PENDING_TABLE, {})).length, 0)
})

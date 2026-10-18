const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveApiUrl } = require('../lib/cache.js')
const plugin = require('../lib/index.js')

test('rejects a malformed api url with a readable message', () => {
  assert.throws(() => resolveApiUrl('not a url'), /不是合法的 URL/)
})

test('rejects non-http protocols', () => {
  assert.throws(() => resolveApiUrl('file:///etc/passwd'), /只支持 http\/https 协议/)
})

test('normalizes a valid api url', () => {
  assert.equal(
    resolveApiUrl('  https://aihot.news/api/v1/codex-resets  '),
    'https://aihot.news/api/v1/codex-resets',
  )
})

test('keeps the new command limits backward compatible', () => {
  const config = plugin.Config({})
  assert.equal(config.commandAuthority, 0, 'commands stay public by default')
  assert.equal(config.renderCooldown, 5, 'image renders get a small per-user cooldown')
})

test('exposes usage text for the console', () => {
  assert.equal(typeof plugin.usage, 'string')
  assert.match(plugin.usage, /codex\.history/)
})

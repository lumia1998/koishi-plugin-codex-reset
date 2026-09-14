const test = require('node:test')
const assert = require('node:assert/strict')
const { filterHistoryEvents } = require('../lib/history.js')

function event(id, date) {
  return {
    id, type: 'direct_reset', label: '全员重置', status: 'confirmed', title: id,
    scope: '', createdAt: `${date}T12:00:00+08:00`, updatedAt: `${date}T12:00:00+08:00`,
    confirmedAt: `${date}T12:00:00+08:00`, occurredOn: date, confirmationBasis: 'source_post',
    schedule: null, posts: [], url: 'https://example.com',
  }
}

test('filters history by Beijing calendar month and supports all history', () => {
  const events = [event('recent', '2026-09-10'), event('boundary', '2026-08-13'), event('two-months', '2026-07-20'), event('old', '2026-07-10')]
  const now = new Date('2026-09-14T12:00:00+08:00')
  assert.deepEqual(filterHistoryEvents(events, now).map((item) => item.id), ['recent'])
  assert.deepEqual(filterHistoryEvents(events, now, 2).map((item) => item.id), ['recent', 'boundary', 'two-months'])
  assert.deepEqual(filterHistoryEvents(events, now, 'all').map((item) => item.id), ['recent', 'boundary', 'two-months', 'old'])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { analyzeProbability, formatLatestReset, formatProbability } = require('../lib/stats.js')

function snapshot() {
  return {
    schemaVersion: 1,
    timezone: 'Asia/Shanghai',
    checkedAt: '2026-09-10T00:00:00+08:00',
    historyFrom: '2026-09-01T00:00:00+08:00',
    count: 3,
    events: [
      {
        id: 'a', type: 'direct_reset', label: '全员重置', status: 'confirmed', title: '', scope: '',
        createdAt: '2026-09-02T00:00:00+08:00', updatedAt: '2026-09-02T00:00:00+08:00',
        confirmedAt: '2026-09-02T01:00:00+08:00', occurredOn: '2026-09-02', confirmationBasis: 'source_post', schedule: null, posts: [], url: 'https://example.com/a',
      },
      {
        id: 'b', type: 'reset_credit', label: '发重置卡', status: 'confirmed', title: '', scope: '',
        createdAt: '2026-09-03T00:00:00+08:00', updatedAt: '2026-09-03T00:00:00+08:00',
        confirmedAt: '2026-09-03T01:00:00+08:00', occurredOn: '2026-09-03', confirmationBasis: 'source_post', schedule: null, posts: [], url: 'https://example.com/b',
      },
      {
        id: 'c', type: 'direct_reset', label: '全员重置', status: 'announced', title: '', scope: '',
        createdAt: '2026-09-04T00:00:00+08:00', updatedAt: '2026-09-04T00:00:00+08:00',
        confirmedAt: null, occurredOn: null, confirmationBasis: null,
        schedule: { precision: 'date', from: '2026-09-05T00:00:00+08:00', through: '2026-09-05T00:00:00+08:00', label: '9月5日' }, posts: [], url: 'https://example.com/c',
      },
    ],
  }
}

test('analyzes confirmed event days and pending announcements', () => {
  const result = analyzeProbability(snapshot(), new Date('2026-09-10T00:00:00+08:00'))
  assert.equal(result.confirmedCount, 2)
  assert.equal(result.directResetCount, 1)
  assert.equal(result.resetCreditCount, 1)
  assert.equal(result.announcedCount, 1)
  assert.equal(result.activeDays, 2)
  assert.ok(result.next7dProbability > result.next24hProbability)
  assert.match(formatProbability(result), /不是官方预测/)
})

test('formats the latest confirmed reset as elapsed hours', () => {
  const result = formatLatestReset(snapshot(), new Date('2026-09-03T05:00:00+08:00'))
  assert.match(result, /上一次重置：约 4 小时前/)
  assert.match(result, /类型：重置卡/)
})

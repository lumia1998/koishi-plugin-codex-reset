const test = require('node:test')
const assert = require('node:assert/strict')
const { renderProbabilityHtml } = require('../lib/probability.js')

test('renders a styled probability card with the key statistics', () => {
  const html = renderProbabilityHtml({
    confirmedCount: 26,
    directResetCount: 18,
    resetCreditCount: 8,
    announcedCount: 14,
    activeDays: 24,
    observedDays: 95,
    dailyEventDayRate: 0.2526,
    next24hProbability: 0.22,
    next7dProbability: 0.83,
    lastConfirmedDate: '2026-09-12',
  }, new Date('2026-09-14T16:20:00+08:00'))
  assert.match(html, /Codex 重置概率分析/)
  assert.match(html, /未来 24 小时/)
  assert.match(html, /22%/)
  assert.match(html, /83%/)
  assert.match(html, /95/)
  assert.match(html, /条未重置预告/)
  assert.match(html, /25\.26% \/ 天/)
})

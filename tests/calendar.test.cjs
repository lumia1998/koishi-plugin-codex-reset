const test = require('node:test')
const assert = require('node:assert/strict')
const { renderCalendarHtml } = require('../lib/calendar.js')

test('renders a monthly calendar with fixed command date and escapes source text', () => {
  const html = renderCalendarHtml([
    {
      id: 'x', type: 'direct_reset', label: '<script>', status: 'announced',
      title: '<script>alert(1)</script>', scope: '', createdAt: '2026-09-01T00:00:00+08:00',
      updatedAt: '2026-09-01T00:00:00+08:00', confirmedAt: null, occurredOn: null,
      confirmationBasis: null,
      schedule: { precision: 'date', from: '2026-09-12T00:00:00+08:00', through: '2026-09-12T00:00:00+08:00', label: '9月12日' },
      posts: [{
        id: 'post-1', publishedAt: '2026-09-12T08:00:00+08:00', stage: '确认完成',
        text: '重置已完成。', originalText: 'Reset complete.', url: 'https://example.com/post-1',
      }], url: 'https://example.com',
    },
  ], new Date('2026-09-10T00:00:00+08:00'))
  assert.match(html, /calendar-card/)
  assert.match(html, /2026 年 九月/)
  assert.match(html, /最近 2 条动态/)
  assert.match(html, /12/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /avatar-(image|fallback)/)
  assert.doesNotMatch(html, /中文译文/)
  assert.doesNotMatch(html, /aria-label="<script>/)
})

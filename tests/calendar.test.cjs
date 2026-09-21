const test = require('node:test')
const assert = require('node:assert/strict')
const { renderCalendarHtml } = require('../lib/calendar.js')

test('renders a monthly calendar with fixed command date and escapes source text', () => {
  const html = renderCalendarHtml([
    {
      id: 'x', type: 'direct_reset', label: '<script>', status: 'confirmed',
      title: '<script>alert(1)</script>', scope: '', createdAt: '2026-09-01T00:00:00+08:00',
      updatedAt: '2026-09-01T00:00:00+08:00', confirmedAt: null, occurredOn: '2026-09-12',
      confirmationBasis: null,
      schedule: { precision: 'date', from: '2026-09-12T00:00:00+08:00', through: '2026-09-12T00:00:00+08:00', label: '9月12日' },
      posts: [{
        id: 'post-1', publishedAt: '2026-09-12T08:00:00+08:00', stage: '确认完成',
        text: '重置已完成。', originalText: 'Reset complete.', url: 'https://example.com/post-1',
      }], url: 'https://example.com',
    },
  ], new Date('2026-09-21T00:00:00+08:00'))
  assert.match(html, /calendar-card/)
  assert.match(html, /2026 年 九月/)
  assert.match(html, /最近 2 条动态/)
  assert.match(html, /12/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /avatar-(image|fallback)/)
  assert.doesNotMatch(html, /中文译文/)
  assert.doesNotMatch(html, /aria-label="<script>/)
})

test('calendar excludes previews and uses confirmation date instead of a scheduled window', () => {
  const event = {
    id: 'credit', type: 'reset_credit', label: '重置卡', status: 'confirmed',
    title: '已确认发卡', confirmedAt: '2026-09-11T20:00:00Z', occurredOn: null,
    schedule: { from: '2026-09-22T15:00:00+08:00', through: '2026-09-23T15:00:00+08:00', label: '预计窗口' },
    posts: [],
  }
  const html = renderCalendarHtml([
    event,
    { ...event, id: 'preview', status: 'announced', title: '尚未发卡' },
    { ...event, id: 'unknown', confirmedAt: null },
    { ...event, id: 'future', occurredOn: '2026-09-23' },
  ], new Date('2026-09-21T00:00:00+08:00'))
  assert.match(html, /1 张重置卡/)
  assert.match(html, /class="day has-credit"[^>]*>\s*<span class="number">12<\/span>/)
  assert.equal((html.match(/class="day has-credit"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /尚未发卡|预计窗口|未重置预告/)
})

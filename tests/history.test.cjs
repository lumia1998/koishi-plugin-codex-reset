const test = require('node:test')
const assert = require('node:assert/strict')
const { renderHistoryHtml } = require('../lib/history.js')

test('renders a history timeline without remote source links', () => {
  const html = renderHistoryHtml([{
    id: 'history-1', type: 'direct_reset', label: '全员重置', status: 'confirmed',
    title: 'Codex 额度重置已完成', scope: '', createdAt: '2026-09-12T15:00:00+08:00',
    updatedAt: '2026-09-12T16:09:00+08:00', confirmedAt: '2026-09-12T16:09:00+08:00',
    occurredOn: '2026-09-12', confirmationBasis: 'source_post',
    schedule: null,
    posts: [{ id: 'post-1', publishedAt: '2026-09-12T16:09:00+08:00', stage: '确认完成', text: '重置完成。', originalText: 'Reset complete.', url: 'https://x.com/example' }],
    url: 'https://x.com/example',
  }], new Date('2026-09-13T00:00:00+08:00'))
  assert.match(html, /Codex 重置历史/)
  assert.match(html, /历史概览/)
  assert.match(html, /2026年9月12日/)
  assert.match(html, /avatar-(image|fallback)/)
  assert.doesNotMatch(html, /查看原帖/)
})

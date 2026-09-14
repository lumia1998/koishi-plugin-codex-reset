import type { CodexResetEvent } from './types'
import { CalendarBrowser, CalendarPage, getTiboAvatarDataUri } from './calendar'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function eventTimestamp(event: CodexResetEvent): number {
  const values = [
    event.confirmedAt,
    event.occurredOn ? `${event.occurredOn}T12:00:00+08:00` : null,
    event.schedule?.from,
    event.createdAt,
  ]
  for (const value of values) {
    const timestamp = parseTimestamp(value)
    if (timestamp !== null) return timestamp
  }
  return 0
}

function dateLabel(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${Number(values.year)}年${Number(values.month)}月${Number(values.day)}日`
}

function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatGeneratedAt(now: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
}

function typeLabel(event: CodexResetEvent): string {
  return event.type === 'direct_reset' ? '全员重置' : '重置卡'
}

function statusLabel(event: CodexResetEvent): string {
  return event.status === 'confirmed' ? '已确认' : '预告'
}

function renderPostPreview(event: CodexResetEvent): string {
  const post = event.posts[0]
  if (!post) return '<div class="post-preview empty">暂无来源帖子内容</div>'
  const text = post.text || post.originalText
  const avatar = getTiboAvatarDataUri()
    ? `<img class="avatar-image" src="${getTiboAvatarDataUri()}" alt="">`
    : '<span class="avatar-fallback">T</span>'
  return `<div class="post-preview">
    <div class="post-head">
      <div class="avatar">${avatar}</div>
      <div class="author"><strong>Tibo</strong><span>@thsottiaux</span></div>
      <time>${escapeHtml(timeLabel(parseTimestamp(post.publishedAt) ?? eventTimestamp(event)))} 发布</time>
    </div>
    <p>${escapeHtml(text)}</p>
  </div>`
}

function renderTimelineItem(event: CodexResetEvent): string {
  const timestamp = eventTimestamp(event)
  const statusClass = event.status === 'confirmed' ? 'confirmed' : 'announced'
  const schedule = event.schedule?.label ? `<div class="schedule">时间：${escapeHtml(event.schedule.label)}</div>` : ''
  return `<article class="timeline-item">
    <div class="timeline-date"><strong>${escapeHtml(dateLabel(timestamp))}</strong><span>${escapeHtml(timeLabel(timestamp))}</span></div>
    <div class="timeline-dot ${statusClass}"></div>
    <div class="event-card">
      <div class="event-meta"><span class="type-label">${typeLabel(event)}</span><span class="status ${statusClass}">${statusLabel(event)}</span></div>
      <h2>${escapeHtml(event.title)}</h2>
      ${schedule}
      ${renderPostPreview(event)}
    </div>
  </article>`
}

export function renderHistoryHtml(events: CodexResetEvent[], now = new Date()): string {
  const sorted = [...events].sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
  const confirmed = events.filter((event) => event.status === 'confirmed')
  const directResetCount = confirmed.filter((event) => event.type === 'direct_reset').length
  const resetCreditCount = confirmed.filter((event) => event.type === 'reset_credit').length
  const announcedCount = events.filter((event) => event.status === 'announced').length
  const firstTimestamp = sorted.at(-1) ? eventTimestamp(sorted.at(-1)!) : now.getTime()
  const lastTimestamp = sorted[0] ? eventTimestamp(sorted[0]) : now.getTime()
  const period = `${dateLabel(firstTimestamp)} 至 ${dateLabel(lastTimestamp)}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f4f6f5; color: #27343c; font-family: "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; }
    body { padding: 24px; }
    .history-shell { max-width: 1280px; margin: 0 auto; padding: 28px 30px 34px; border: 1px solid #d2dadd; border-radius: 16px; background: #fff; }
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; padding-bottom: 20px; border-bottom: 1px solid #e0e5e6; }
    .eyebrow { color: #08768b; font-size: 12px; letter-spacing: .08em; }
    h1 { margin: 7px 0 8px; font-size: 28px; line-height: 1.2; }
    .subtitle { margin: 0; color: #6f7d83; font-size: 13px; }
    .generated { color: #6f7d83; font-size: 11px; text-align: right; line-height: 1.6; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 286px; gap: 28px; padding-top: 26px; }
    .timeline { position: relative; }
    .timeline::before { content: ""; position: absolute; left: 112px; top: 16px; bottom: 16px; width: 1px; background: #cbd7d9; }
    .timeline-item { position: relative; display: grid; grid-template-columns: 94px 36px minmax(0, 1fr); gap: 0; margin-bottom: 18px; }
    .timeline-date { padding-top: 17px; padding-right: 14px; text-align: right; line-height: 1.5; }
    .timeline-date strong { display: block; color: #27343c; font-size: 11px; white-space: nowrap; }
    .timeline-date span { color: #89969a; font-size: 10px; }
    .timeline-dot { position: relative; z-index: 1; width: 12px; height: 12px; margin: 22px auto 0; border: 3px solid #fff; border-radius: 50%; background: #08768b; box-shadow: 0 0 0 1px #08768b; }
    .timeline-dot.announced { background: #b8863b; box-shadow: 0 0 0 1px #b8863b; }
    .event-card { padding: 15px 17px 16px; border: 1px solid #d2dadd; border-radius: 13px; background: #fff; }
    .event-meta { display: flex; gap: 7px; align-items: center; margin-bottom: 7px; }
    .type-label, .status { display: inline-block; padding: 3px 7px; border-radius: 999px; font-size: 10px; }
    .type-label { color: #08768b; background: #edf7f8; }
    .status.confirmed { color: #177255; background: #edf8f1; }
    .status.announced { color: #8b6426; background: #fbf4e6; }
    .event-card h2 { margin: 0 0 10px; font-size: 17px; line-height: 1.35; }
    .schedule { margin-bottom: 10px; color: #08768b; font-size: 11px; }
    .post-preview { padding: 11px 12px; border: 1px solid #e0e5e6; border-radius: 10px; background: #fbfcfc; }
    .post-preview.empty { color: #89969a; font-size: 12px; }
    .post-head { display: flex; align-items: center; min-width: 0; }
    .avatar { display: grid; flex: 0 0 auto; width: 28px; height: 28px; place-items: center; overflow: hidden; border-radius: 50%; background: linear-gradient(145deg, #a57954, #d3aa7d); color: #fff; font-size: 14px; font-weight: 700; }
    .avatar-image { display: block; width: 100%; height: 100%; object-fit: cover; }
    .avatar-fallback { display: block; }
    .author { display: flex; flex-direction: column; margin-left: 8px; line-height: 1.2; }
    .author strong { font-size: 11px; }
    .author span { color: #89969a; font-size: 9px; }
    .post-head time { margin-left: auto; color: #89969a; font-size: 10px; }
    .post-preview p { margin: 10px 0 0; color: #27343c; font-size: 12px; line-height: 1.55; }
    .summary { align-self: start; padding: 18px; border: 1px solid #d2dadd; border-radius: 13px; background: #fbfcfc; }
    .summary h2 { margin: 0 0 15px; font-size: 17px; }
    .summary-period { margin-bottom: 18px; color: #6f7d83; font-size: 11px; line-height: 1.5; }
    .stat { display: flex; align-items: baseline; justify-content: space-between; padding: 11px 0; border-top: 1px solid #e0e5e6; }
    .stat span { color: #6f7d83; font-size: 12px; }
    .stat strong { color: #27343c; font-size: 22px; }
    .summary-note { margin: 17px 0 0; color: #89969a; font-size: 10px; line-height: 1.6; }
    .empty { padding: 54px 0; color: #89969a; text-align: center; }
  </style>
</head>
<body>
  <main class="history-shell">
    <header class="page-header">
      <div><div class="eyebrow">CODEX RESET MONITOR</div><h1>Codex 重置历史</h1><p class="subtitle">按北京时间排列的公开重置事件时间线</p></div>
      <div class="generated">生成时间<br>${escapeHtml(formatGeneratedAt(now))}</div>
    </header>
    <div class="layout">
      <section class="timeline">
        ${sorted.length ? sorted.map(renderTimelineItem).join('') : '<div class="empty">暂无历史事件</div>'}
      </section>
      <aside class="summary">
        <h2>历史概览</h2>
        <div class="summary-period">统计区间<br>${escapeHtml(period)}</div>
        <div class="stat"><span>事件总数</span><strong>${events.length}</strong></div>
        <div class="stat"><span>已确认</span><strong>${confirmed.length}</strong></div>
        <div class="stat"><span>全员重置</span><strong>${directResetCount}</strong></div>
        <div class="stat"><span>重置卡</span><strong>${resetCreditCount}</strong></div>
        <div class="stat"><span>待确认预告</span><strong>${announcedCount}</strong></div>
        <p class="summary-note">数据来自 AIHOT 公开快照。时间线仅展示公开事件，不代表账户一定获得重置。</p>
      </aside>
    </div>
  </main>
</body>
</html>`
}

export async function renderHistoryImage(
  browser: CalendarBrowser,
  events: CodexResetEvent[],
  now = new Date(),
): Promise<Buffer> {
  let page: CalendarPage | null = null
  try {
    page = await browser.page()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.setContent(renderHistoryHtml(events, now), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const image = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(image)
  } finally {
    if (page) await page.close()
  }
}

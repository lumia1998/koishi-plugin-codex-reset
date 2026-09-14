import { getTiboAvatarDataUri } from './calendar'
import type { CalendarBrowser, CalendarPage } from './calendar'
import type { LatestResetSummary } from './stats'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatElapsed(timestamp: number, now: Date): string {
  const elapsedHours = Math.max(0, (now.getTime() - timestamp) / (60 * 60 * 1000))
  if (elapsedHours < 1) return `${Math.max(1, Math.round(elapsedHours * 60))} 分钟前`
  if (elapsedHours < 24) return `${Math.round(elapsedHours * 10) / 10} 小时前`
  return `${Math.round(elapsedHours / 24 * 10) / 10} 天前`
}

function typeLabel(summary: LatestResetSummary): string {
  return summary.event.type === 'direct_reset' ? '全员重置' : '重置卡'
}

function latestPost(summary: LatestResetSummary): LatestResetSummary['event']['posts'][number] | null {
  return [...summary.event.posts]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] ?? null
}

function renderSourcePost(summary: LatestResetSummary): string {
  const post = latestPost(summary)
  if (!post) return '<div class="post-empty">暂无来源帖子内容</div>'
  const avatar = getTiboAvatarDataUri()
    ? `<img class="avatar-image" src="${getTiboAvatarDataUri()}" alt="">`
    : '<span class="avatar-fallback">T</span>'
  const text = post.text || post.originalText
  const publishedAt = Date.parse(post.publishedAt)
  const time = Number.isFinite(publishedAt) ? formatDateTime(publishedAt) : '时间未知'
  return `<article class="post-card">
    <div class="post-head">
      <div class="avatar">${avatar}</div>
      <div class="author"><strong>Tibo</strong><span>@thsottiaux</span></div>
      <time>${escapeHtml(time)} 发布</time>
    </div>
    <p class="post-text">${escapeHtml(text)}</p>
    <div class="post-foot">${escapeHtml(post.stage)}</div>
  </article>`
}

export function renderLatestResetHtml(summary: LatestResetSummary, now = new Date()): string {
  const approximate = summary.approximate ? '时间按公开日期估算' : '已记录精确确认时间'
  const event = summary.event
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f4f6f5; color: #27343c; font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif; }
    body { padding: 24px; }
    .card { position: relative; display: grid; grid-template-columns: .92fr 1.08fr; width: 1120px; min-height: 520px; overflow: hidden; border: 1px solid #d2dadd; border-radius: 16px; background: #fff; box-shadow: 0 16px 38px rgba(42, 58, 64, .10); }
    .card::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle at 7% 12%, rgba(8, 118, 139, .11), transparent 34%), radial-gradient(circle at 95% 96%, rgba(184, 134, 59, .10), transparent 34%); }
    .overview, .source { position: relative; z-index: 1; padding: 38px 40px; }
    .overview { display: flex; flex-direction: column; border-right: 1px solid #d9dfe0; background: linear-gradient(145deg, rgba(237, 247, 246, .8), rgba(255, 255, 255, .96) 64%); }
    .source { background: linear-gradient(160deg, rgba(250, 246, 238, .68), rgba(255, 255, 255, .98) 55%); }
    .eyebrow { color: #08768b; font-size: 11px; font-weight: 700; letter-spacing: .18em; }
    .source .eyebrow { color: #a27831; }
    h1 { margin: 18px 0 7px; color: #27343c; font-size: 31px; letter-spacing: -.04em; }
    .subtitle { margin: 0; color: #6f7d83; font-size: 13px; line-height: 1.6; }
    .elapsed { margin-top: 40px; color: #08768b; font-family: Georgia, "Times New Roman", serif; font-size: 54px; font-weight: 700; letter-spacing: -.06em; line-height: 1; }
    .elapsed-label { margin-top: 8px; color: #617079; font-size: 12px; }
    .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: auto; padding-top: 32px; }
    .fact { padding: 13px 14px; border: 1px solid #c8dedd; border-radius: 11px; background: rgba(255, 255, 255, .72); }
    .fact-label { color: #6f7d83; font-size: 10px; }
    .fact-value { margin-top: 5px; color: #27343c; font-size: 14px; font-weight: 700; }
    .note { margin-top: 16px; color: #7a888d; font-size: 10px; line-height: 1.6; }
    .source-header { display: flex; align-items: flex-start; justify-content: space-between; padding-bottom: 17px; border-bottom: 1px solid #e0e5e6; }
    .source-header h2 { margin: 0; color: #27343c; font-size: 19px; }
    .source-header span { color: #6f7d83; font-size: 10px; }
    .event-title { margin: 25px 0 19px; color: #27343c; font-size: 22px; line-height: 1.4; }
    .post-card { padding: 18px; border: 1px solid #d2dadd; border-radius: 13px; background: rgba(255, 255, 255, .86); }
    .post-head { display: flex; align-items: center; min-width: 0; }
    .avatar { display: grid; flex: 0 0 auto; width: 42px; height: 42px; place-items: center; overflow: hidden; border-radius: 50%; background: linear-gradient(145deg, #a57954, #d3aa7d); color: #fff; font-size: 19px; font-weight: 700; }
    .avatar-image { display: block; width: 100%; height: 100%; object-fit: cover; }
    .avatar-fallback { display: block; }
    .author { display: flex; flex-direction: column; margin-left: 10px; line-height: 1.3; }
    .author strong { font-size: 14px; }
    .author span { color: #6f7d83; font-size: 10px; }
    .post-head time { margin-left: auto; color: #6f7d83; font-size: 10px; }
    .post-text { display: -webkit-box; margin: 19px 0 15px; overflow: hidden; color: #27343c; font-size: 15px; line-height: 1.7; -webkit-box-orient: vertical; -webkit-line-clamp: 5; }
    .post-foot { color: #6f7d83; font-size: 10px; }
    .post-empty { padding: 45px 20px; border: 1px dashed #d2dadd; border-radius: 13px; color: #7a888d; font-size: 13px; text-align: center; }
    .source-note { margin-top: 17px; color: #7a888d; font-size: 10px; line-height: 1.6; }
    .mark { margin-top: 34px; color: #a27831; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
  </style>
</head>
<body>
  <main class="card">
    <section class="overview">
      <div class="eyebrow">CODEX RESET / LATEST</div>
      <h1>最近重置</h1>
      <p class="subtitle">AIHOT 公开快照中的最近一次已确认事件</p>
      <div class="elapsed">${escapeHtml(formatElapsed(summary.timestamp, now))}</div>
      <div class="elapsed-label">距离这次重置已经过去</div>
      <div class="facts">
        <div class="fact"><div class="fact-label">发生时间</div><div class="fact-value">${escapeHtml(formatDateTime(summary.timestamp))}</div></div>
        <div class="fact"><div class="fact-label">事件类型</div><div class="fact-value">${typeLabel(summary)}</div></div>
      </div>
      <p class="note">${escapeHtml(approximate)}。数据来自 AIHOT 当前历史快照，不代表你的账户一定获得重置。</p>
    </section>
    <section class="source">
      <header class="source-header"><h2>事件来源</h2><span>北京时间</span></header>
      <h2 class="event-title">${escapeHtml(event.title)}</h2>
      ${renderSourcePost(summary)}
      <p class="source-note">${escapeHtml(event.scope ? `范围：${event.scope}` : '公开来源帖子记录')}</p>
      <div class="mark">RESET MONITOR</div>
    </section>
  </main>
</body>
</html>`
}

export async function renderLatestResetImage(
  browser: CalendarBrowser,
  summary: LatestResetSummary,
  now = new Date(),
): Promise<Buffer> {
  let page: CalendarPage | null = null
  try {
    page = await browser.page()
    await page.setViewport({ width: 1120, height: 570, deviceScaleFactor: 1 })
    await page.setContent(renderLatestResetHtml(summary, now), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const image = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(image)
  } finally {
    if (page) await page.close()
  }
}

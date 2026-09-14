import type { CalendarBrowser, CalendarPage } from './calendar'
import type { ProbabilitySummary } from './stats'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function percentage(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 0.01) return '<1%'
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
}

function ratio(value: number, total: number): string {
  if (!total) return '0%'
  return `${Math.round((value / total) * 100)}%`
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

function metricCard(label: string, value: string, note: string, tone: string): string {
  return `<div class="metric ${tone}">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
    <div class="metric-note">${escapeHtml(note)}</div>
  </div>`
}

export function renderProbabilityHtml(summary: ProbabilitySummary, now = new Date()): string {
  const confirmedTotal = summary.directResetCount + summary.resetCreditCount
  const directRatio = ratio(summary.directResetCount, confirmedTotal)
  const creditRatio = ratio(summary.resetCreditCount, confirmedTotal)
  const recentDate = summary.lastConfirmedDate ?? '暂无记录'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f4f6f5; color: #27343c; font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif; }
    body { padding: 26px; }
    .card { position: relative; width: 1120px; min-height: 680px; overflow: hidden; padding: 38px 44px 30px; border: 1px solid #d2dadd; border-radius: 16px; background: radial-gradient(circle at 82% 12%, rgba(8, 118, 139, .07), transparent 30%), radial-gradient(circle at 10% 96%, rgba(184, 134, 59, .07), transparent 28%), #fff; box-shadow: 0 16px 38px rgba(42, 58, 64, .10); }
    .card::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .32; background-image: linear-gradient(rgba(8, 118, 139, .05) 1px, transparent 1px), linear-gradient(90deg, rgba(8, 118, 139, .05) 1px, transparent 1px); background-size: 34px 34px; mask-image: linear-gradient(to bottom, rgba(0,0,0,.42), transparent 72%); }
    .content { position: relative; z-index: 1; }
    .topline { display: flex; align-items: flex-start; justify-content: space-between; }
    .eyebrow { color: #08768b; font-size: 11px; font-weight: 700; letter-spacing: .22em; }
    .source { color: #6f7d83; font-size: 11px; line-height: 1.6; text-align: right; }
    h1 { margin: 22px 0 8px; color: #27343c; font-size: 34px; font-weight: 700; letter-spacing: -.04em; }
    .subtitle { margin: 0; color: #6f7d83; font-size: 14px; }
    .rule { width: 100%; height: 1px; margin: 26px 0 22px; background: linear-gradient(90deg, rgba(8, 118, 139, .36), rgba(8, 118, 139, .08), transparent); }
    .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .metric { position: relative; min-height: 186px; padding: 22px 24px; overflow: hidden; border: 1px solid #c8dedd; border-radius: 13px; background: #eef7f6; }
    .metric::after { content: ""; position: absolute; right: -28px; bottom: -58px; width: 180px; height: 180px; border: 1px solid rgba(8, 118, 139, .18); border-radius: 50%; box-shadow: 0 0 0 18px rgba(8, 118, 139, .035), 0 0 0 36px rgba(8, 118, 139, .018); }
    .metric.seven { background: #faf6ee; border-color: #e2d8c5; }
    .metric.seven::after { border-color: rgba(184, 134, 59, .22); box-shadow: 0 0 0 18px rgba(184, 134, 59, .035), 0 0 0 36px rgba(184, 134, 59, .018); }
    .metric-label { color: #6f7d83; font-size: 13px; }
    .metric-value { margin-top: 7px; color: #08768b; font-family: Georgia, "Times New Roman", serif; font-size: 66px; font-weight: 700; letter-spacing: -.07em; line-height: 1; }
    .metric.seven .metric-value { color: #a27831; }
    .metric-note { margin-top: 14px; color: #52646a; font-size: 12px; }
    .lower { display: grid; grid-template-columns: 1.15fr .85fr; gap: 16px; margin-top: 16px; }
    .panel { padding: 18px 20px; border: 1px solid #d2dadd; border-radius: 13px; background: #fbfcfc; }
    .panel h2 { margin: 0 0 15px; color: #27343c; font-size: 14px; }
    .sample-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .sample { padding-right: 10px; border-right: 1px solid #e0e5e6; }
    .sample:last-child { border-right: 0; }
    .sample-value { color: #27343c; font-size: 22px; font-weight: 700; }
    .sample-label { margin-top: 4px; color: #6f7d83; font-size: 11px; }
    .bar-row { display: grid; grid-template-columns: 76px 1fr 42px; align-items: center; gap: 9px; margin: 12px 0; color: #52646a; font-size: 11px; }
    .bar { height: 7px; overflow: hidden; border-radius: 99px; background: #e4ecec; }
    .bar span { display: block; height: 100%; border-radius: inherit; background: #71c8bd; }
    .bar-row.credit .bar span { background: #d8ad5f; }
    .bar-percent { color: #27343c; text-align: right; }
    .recent { display: flex; align-items: center; justify-content: space-between; padding-top: 15px; margin-top: 16px; border-top: 1px solid #e0e5e6; }
    .recent-label { color: #6f7d83; font-size: 11px; }
    .recent-date { color: #a27831; font-size: 15px; font-weight: 700; }
    .footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 30px; margin-top: 22px; color: #7a888d; font-size: 10px; line-height: 1.65; }
    .footer strong { color: #52646a; font-weight: 600; }
    .mark { color: #08768b; font-size: 11px; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
  </style>
</head>
<body>
  <main class="card">
    <div class="content">
      <header class="topline">
        <div class="eyebrow">CODEX RESET / PUBLIC HISTORY</div>
        <div class="source">AIHOT · ASIA/SHANGHAI<br>生成于 ${escapeHtml(formatGeneratedAt(now))}</div>
      </header>
      <h1>Codex 重置概率分析</h1>
      <p class="subtitle">基于当前公开历史快照的经验统计，不是官方预测</p>
      <div class="rule"></div>

      <section class="metrics">
        ${metricCard('未来 24 小时', percentage(summary.next24hProbability), '至少出现一个公开重置事件', 'day')}
        ${metricCard('未来 7 天', percentage(summary.next7dProbability), '至少出现一个公开重置事件', 'seven')}
      </section>

      <section class="lower">
        <div class="panel">
          <h2>样本概览</h2>
          <div class="sample-grid">
            <div class="sample"><div class="sample-value">${summary.observedDays}</div><div class="sample-label">天观察样本</div></div>
            <div class="sample"><div class="sample-value">${summary.confirmedCount}</div><div class="sample-label">条已确认</div></div>
            <div class="sample"><div class="sample-value">${summary.activeDays}</div><div class="sample-label">个事件日</div></div>
            <div class="sample"><div class="sample-value">${summary.announcedCount}</div><div class="sample-label">条未重置预告</div></div>
          </div>
          <div class="recent"><span class="recent-label">最近确认日期</span><span class="recent-date">${escapeHtml(recentDate)}</span></div>
        </div>
        <div class="panel">
          <h2>已确认事件构成</h2>
          <div class="bar-row"><span>全员重置</span><div class="bar"><span style="width:${directRatio}"></span></div><span class="bar-percent">${summary.directResetCount}</span></div>
          <div class="bar-row credit"><span>重置卡</span><div class="bar"><span style="width:${creditRatio}"></span></div><span class="bar-percent">${summary.resetCreditCount}</span></div>
          <div class="recent"><span class="recent-label">历史事件日率</span><span class="recent-date">${(summary.dailyEventDayRate * 100).toFixed(2)}% / 天</span></div>
        </div>
      </section>

      <footer class="footer"><span><strong>说明：</strong>概率由历史事件日率进行经验估计，不代表你的账户一定会获得重置。</span><span class="mark">RESET MONITOR</span></footer>
    </div>
  </main>
</body>
</html>`
}

export async function renderProbabilityImage(
  browser: CalendarBrowser,
  summary: ProbabilitySummary,
  now = new Date(),
): Promise<Buffer> {
  let page: CalendarPage | null = null
  try {
    page = await browser.page()
    await page.setViewport({ width: 1120, height: 680, deviceScaleFactor: 1 })
    await page.setContent(renderProbabilityHtml(summary, now), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const image = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(image)
  } finally {
    if (page) await page.close()
  }
}

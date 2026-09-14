import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexResetEvent } from './types'

const MONTH_NAMES = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
]
const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日']
const DAY_MS = 24 * 60 * 60 * 1000

export function getTiboAvatarDataUri(): string {
  const candidates = [
    join(__dirname, '..', 'resources', 'tibo-avatar.jpg'),
    join(process.cwd(), 'resources', 'tibo-avatar.jpg'),
  ]
  for (const file of candidates) {
    if (existsSync(file)) {
      return `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`
    }
  }
  return ''
}

const TIBO_AVATAR = getTiboAvatarDataUri()

export interface CalendarPage {
  setViewport(options: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>
  setContent(content: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>
  screenshot(options: { type: 'png'; fullPage: true }): Promise<Uint8Array>
  close(): Promise<void>
}

export interface CalendarBrowser {
  page(): Promise<CalendarPage>
}

interface CalendarMark {
  event: CodexResetEvent
  type: CodexResetEvent['type']
  status: CodexResetEvent['status']
  label: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

function parseDateKey(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, year, month, day] = match.map(Number)
  const result = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(result.getTime())) return null
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) return null
  return result
}

function timestampDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  return value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
}

function beijingDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function monthStart(date: Date, offset = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getEventDateRange(event: CodexResetEvent): [string, string] | null {
  if (event.status === 'confirmed' && event.occurredOn) return [event.occurredOn, event.occurredOn]
  const from = timestampDateKey(event.schedule?.from) ?? timestampDateKey(event.confirmedAt) ?? timestampDateKey(event.createdAt)
  if (!from) return null
  const through = timestampDateKey(event.schedule?.through) ?? from
  return [from, through]
}

function buildMonthMarks(events: CodexResetEvent[], start: Date): Map<string, CalendarMark[]> {
  const end = monthStart(start, 1)
  const marks = new Map<string, CalendarMark[]>()

  for (const event of events) {
    const range = getEventDateRange(event)
    const from = range ? parseDateKey(range[0]) : null
    const through = range ? parseDateKey(range[1]) : null
    if (!from || !through || through < from) continue

    const cursor = new Date(Math.max(start.getTime(), from.getTime()))
    const last = new Date(Math.min(end.getTime() - DAY_MS, through.getTime()))
    while (cursor <= last) {
      const key = dateKey(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate())
      const list = marks.get(key) ?? []
      list.push({ event, type: event.type, status: event.status, label: event.label })
      marks.set(key, list)
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  return marks
}

function formatDateHeader(value: string): { day: string; year: string } {
  const date = parseDateKey(value)
  if (!date) return { day: value, year: '' }
  return {
    day: `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`,
    year: String(date.getUTCFullYear()),
  }
}

function formatPublishedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.month}/${values.day} ${values.hour}:${values.minute} 发布`
}

function renderDayCell(
  date: Date,
  month: Date,
  marks: Map<string, CalendarMark[]>,
  selectedDate: string,
  today: string,
): string {
  const key = dateKey(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const inMonth = date.getUTCMonth() === month.getUTCMonth()
  const dayMarks = marks.get(key) ?? []
  const classes = ['day']
  if (!inMonth) classes.push('outside')
  if (key === selectedDate) classes.push('selected')
  if (key === today) classes.push('today')
  if (dayMarks.some((mark) => mark.type === 'direct_reset')) classes.push('has-reset')
  if (dayMarks.some((mark) => mark.type === 'reset_credit')) classes.push('has-credit')

  const labels = dayMarks.map((mark) => `${mark.label}（${mark.status === 'confirmed' ? '已确认' : '预告'}）`).join('、')
  const marksHtml = dayMarks.slice(0, 2).map((mark) => {
    const label = mark.type === 'direct_reset' ? '全员重置' : '发重置卡'
    const className = mark.type === 'direct_reset' ? 'reset-mark' : 'credit-mark'
    return `<span class="${className}">${label}</span>`
  }).join('')

  return `<div class="${classes.join(' ')}" aria-label="${escapeHtml(labels)}">
    <span class="number">${date.getUTCDate()}</span>
    ${key === today ? '<span class="today-dot"></span>' : ''}
    <div class="marks">${marksHtml}</div>
  </div>`
}

function renderCalendarGrid(month: Date, marks: Map<string, CalendarMark[]>, selectedDate: string, today: string): string {
  const firstDayOffset = (month.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate()
  const cellCount = Math.ceil((firstDayOffset + daysInMonth) / 7) * 7
  const firstCell = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1 - firstDayOffset))
  const cells: string[] = []
  for (let index = 0; index < cellCount; index++) {
    const date = new Date(firstCell.getTime() + index * DAY_MS)
    cells.push(renderDayCell(date, month, marks, selectedDate, today))
  }
  return cells.join('')
}

function renderPostCard(event: CodexResetEvent, post: CodexResetEvent['posts'][number]): string {
  const text = post.text || post.originalText
  const schedule = event.schedule?.label ? `<div class="schedule">原预告：${escapeHtml(event.schedule.label)}</div>` : ''
  const avatar = TIBO_AVATAR
    ? `<img class="avatar-image" src="${TIBO_AVATAR}" alt="">`
    : '<span class="avatar-fallback">T</span>'
  return `<article class="post-card">
    <div class="post-head">
      <div class="avatar">${avatar}</div>
      <div class="author"><strong>Tibo</strong><span>@thsottiaux</span></div>
      <time>${escapeHtml(formatPublishedAt(post.publishedAt))}</time>
    </div>
    <p class="post-text">${escapeHtml(text)}</p>
    ${schedule}
    <div class="post-foot">${escapeHtml(post.stage)}</div>
  </article>`
}

function renderDetails(selectedDate: string, marks: Map<string, CalendarMark[]>): string {
  const header = formatDateHeader(selectedDate)
  const selectedEvents = [...new Map((marks.get(selectedDate) ?? []).map((mark) => [mark.event.id, mark.event])).values()]
  const groups = selectedEvents.map((event) => {
    const status = event.status === 'confirmed' ? '已重置' : '未重置预告'
    const statusClass = event.status === 'confirmed' ? 'confirmed-state' : 'announced-state'
    const posts = event.posts.slice(0, 3).map((post) => renderPostCard(event, post)).join('')
    return `<section class="event-group">
      <div class="event-state ${statusClass}"><span class="state-icon">${event.status === 'confirmed' ? '✓' : '◷'}</span>${status}</div>
      <h2>${escapeHtml(event.title)}</h2>
      ${posts || '<div class="post-card empty-post">暂无来源帖子内容</div>'}
    </section>`
  }).join('')

  return `<aside class="details-pane">
    <div class="details-header"><h2>${header.day}</h2><span>${header.year}</span></div>
    <div class="details-body">${groups || '<div class="empty-state">这一天没有记录</div>'}</div>
  </aside>`
}

export function renderCalendarHtml(events: CodexResetEvent[], now = new Date()): string {
  const today = beijingDateKey(now)
  const todayDate = parseDateKey(today) ?? new Date()
  const month = monthStart(todayDate)
  const marks = buildMonthMarks(events, month)
  // A static image has no interactive selection. The detail pane always represents
  // the Beijing calendar date on which the command was invoked.
  const selectedDate = today
  const monthEvents = [...new Map([...marks.values()].flat().map((mark) => [mark.event.id, mark.event])).values()]
  const resetCount = monthEvents.filter((event) => event.type === 'direct_reset').length
  const creditCount = monthEvents.filter((event) => event.type === 'reset_credit').length
  const monthLabel = `${month.getUTCFullYear()} 年 ${MONTH_NAMES[month.getUTCMonth()]}`

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; background: #f5f6f4; color: #25313a; font-family: Inter, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
    .calendar-card { width: 1248px; min-height: 578px; display: grid; grid-template-columns: 1.46fr 1fr; overflow: hidden; border: 1px solid #d2dadd; border-radius: 14px; background: #fff; }
    .calendar-pane { padding: 30px 24px 22px; }
    .calendar-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 0 0 18px; }
    .calendar-header h1 { margin: 0; font-size: 23px; line-height: 1.3; letter-spacing: .2px; }
    .month-summary { margin-top: 20px; color: #617079; font-size: 12px; }
    .calendar-nav { display: flex; align-items: center; gap: 22px; padding-top: 3px; color: #617079; font-size: 11px; }
    .calendar-nav .arrow { color: #617079; font-size: 20px; font-weight: 300; line-height: 1; }
    .weekday-row, .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
    .weekday-row { margin-bottom: 6px; color: #65737b; font-size: 12px; text-align: center; }
    .weekday-row span { padding: 8px 0; }
    .calendar-grid { grid-auto-rows: 70px; }
    .day { position: relative; min-width: 0; padding: 11px 12px 7px; border: 1px solid transparent; border-radius: 10px; background: #fafafa; }
    .day.outside { color: #adb6b9; background: #fcfcfc; }
    .day.selected { border-color: #147487; background: #edf7f6; box-shadow: inset 0 0 0 1px rgba(20, 116, 135, .12); }
    .day.has-reset { background: #eef6f2; }
    .day.has-credit { background: #f7f3ec; }
    .day.selected.has-reset, .day.selected.has-credit { background: #e8f3f2; }
    .number { display: inline-block; font-size: 14px; line-height: 1; }
    .outside .number { color: #aeb7ba; }
    .today-dot { position: absolute; top: 11px; right: 13px; width: 4px; height: 4px; border-radius: 50%; background: #147487; }
    .marks { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; overflow: hidden; }
    .marks span { overflow: hidden; color: #347465; font-size: 9px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    .marks .credit-mark { color: #967044; }
    .outside .marks span { color: #b6d0c9; }
    .outside .marks .credit-mark { color: #cbbda6; }
    .calendar-note { margin-top: 18px; color: #617079; font-size: 11px; }
    .details-pane { min-width: 0; padding: 26px 24px 20px; border-left: 1px solid #d9dfe0; }
    .details-header { display: flex; justify-content: space-between; align-items: center; padding: 0 0 17px; border-bottom: 1px solid #d9dfe0; }
    .details-header h2 { margin: 0; font-size: 18px; }
    .details-header span { color: #65737b; font-size: 11px; }
    .details-body { padding-top: 18px; }
    .event-group + .event-group { margin-top: 22px; }
    .event-state { display: flex; align-items: center; gap: 7px; margin-bottom: 12px; font-size: 11px; font-weight: 700; }
    .confirmed-state { color: #29735f; }
    .announced-state { color: #98713d; }
    .state-icon { font-size: 16px; font-weight: 500; }
    .event-group h2 { margin: 0 0 16px; font-size: 18px; line-height: 1.35; }
    .post-card { margin-bottom: 12px; padding: 16px; border: 1px solid #d2dadd; border-radius: 13px; background: #fff; }
    .post-head { display: flex; align-items: center; min-width: 0; }
    .avatar { display: grid; flex: 0 0 auto; width: 36px; height: 36px; place-items: center; overflow: hidden; border-radius: 50%; background: linear-gradient(145deg, #a57954, #d3aa7d); color: #fff; font-size: 18px; font-weight: 700; }
    .avatar-image { display: block; width: 100%; height: 100%; object-fit: cover; }
    .avatar-fallback { display: block; }
    .author { display: flex; flex-direction: column; margin-left: 9px; line-height: 1.25; }
    .author strong { font-size: 13px; }
    .author span { color: #6f7d83; font-size: 10px; }
    .post-head time { margin-left: auto; color: #6f7d83; font-size: 10px; }
    .post-text { margin: 14px 0 10px; color: #27343c; font-size: 14px; line-height: 1.65; }
    .schedule { margin: 0 0 10px; color: #08768b; font-size: 11px; }
    .post-foot { color: #6f7d83; font-size: 10px; }
    .empty-state, .empty-post { color: #7a888d; font-size: 13px; text-align: center; }
    .empty-state { padding: 56px 0; }
    .empty-post { padding: 24px 12px; }
  </style>
</head>
<body>
  <main class="calendar-card">
    <section class="calendar-pane">
      <header class="calendar-header">
        <div><h1>${monthLabel}</h1><div class="month-summary">本月：${resetCount} 条全员重置&nbsp;&nbsp;·&nbsp;&nbsp;${creditCount} 张重置卡</div></div>
        <div class="calendar-nav"><span>回到最近</span><span class="arrow">‹</span><span class="arrow">›</span></div>
      </header>
      <div class="weekday-row">${WEEK_NAMES.map((name) => `<span>${name}</span>`).join('')}</div>
      <div class="calendar-grid">${renderCalendarGrid(month, marks, selectedDate, today)}</div>
      <div class="calendar-note">按北京时间记录；发放日期不明确的事件，按来源帖子日期展示。</div>
    </section>
    ${renderDetails(selectedDate, marks)}
  </main>
</body>
</html>`
}

export async function renderCalendarImage(
  browser: CalendarBrowser,
  events: CodexResetEvent[],
  now = new Date(),
): Promise<Buffer> {
  let page: CalendarPage | null = null
  try {
    page = await browser.page()
    await page.setViewport({ width: 1280, height: 620, deviceScaleFactor: 1 })
    await page.setContent(renderCalendarHtml(events, now), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const image = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(image)
  } finally {
    if (page) await page.close()
  }
}

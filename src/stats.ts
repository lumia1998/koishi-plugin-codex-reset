import type { CodexResetEvent, CodexResetsResponse } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

function dateKeyFromTimestamp(value: string | null | undefined): string | null {
  if (!value) return null
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? null
}

function validDateKey(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function normalizedDateKey(value: string | null): string | null {
  return validDateKey(value) ? value : null
}

function eventDateKey(event: CodexResetEvent): string | null {
  return normalizedDateKey(event.occurredOn)
    ?? normalizedDateKey(dateKeyFromTimestamp(event.confirmedAt))
    ?? normalizedDateKey(dateKeyFromTimestamp(event.schedule?.from))
    ?? normalizedDateKey(dateKeyFromTimestamp(event.createdAt))
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function dateKeyTimestamp(value: string): number | null {
  const timestamp = Date.parse(`${value}T00:00:00+08:00`)
  return Number.isFinite(timestamp) ? timestamp : null
}

function inclusiveDays(start: string, end: string): number {
  const startTime = parseTimestamp(start)
  const endTime = parseTimestamp(end)
  if (startTime === null || endTime === null || endTime < startTime) return 1
  return Math.max(1, Math.floor((endTime - startTime) / DAY_MS) + 1)
}

function percentage(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 0.01) return '<1%'
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
}

export interface ProbabilitySummary {
  confirmedCount: number
  directResetCount: number
  resetCreditCount: number
  announcedCount: number
  activeDays: number
  observedDays: number
  dailyEventDayRate: number
  next24hProbability: number
  next7dProbability: number
  lastConfirmedDate: string | null
}

export interface LatestResetSummary {
  event: CodexResetEvent
  timestamp: number
  approximate: boolean
}

function eventTimestamp(event: CodexResetEvent): { timestamp: number; approximate: boolean } | null {
  if (event.confirmedAt) {
    const timestamp = Date.parse(event.confirmedAt)
    if (Number.isFinite(timestamp)) return { timestamp, approximate: false }
  }

  if (event.occurredOn) {
    const timestamp = Date.parse(`${event.occurredOn}T12:00:00+08:00`)
    if (Number.isFinite(timestamp)) return { timestamp, approximate: true }
  }

  for (const value of [event.schedule?.from, event.createdAt]) {
    const timestamp = parseTimestamp(value)
    if (timestamp !== null) return { timestamp, approximate: true }
  }
  return null
}

export function findLatestConfirmedReset(
  response: CodexResetsResponse,
  now = new Date(),
): LatestResetSummary | null {
  const nowTimestamp = now.getTime()
  return response.events
    .filter((event) => event.status === 'confirmed')
    .map((event) => {
      const value = eventTimestamp(event)
      return value ? { event, ...value } : null
    })
    .filter((value): value is LatestResetSummary => value !== null && value.timestamp <= nowTimestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null
}

export function formatLatestReset(
  response: CodexResetsResponse,
  now = new Date(),
): string {
  const latest = findLatestConfirmedReset(response, now)
  if (!latest) return '暂时没有已确认的 Codex 重置事件。'

  const elapsedHours = Math.max(0, (now.getTime() - latest.timestamp) / (60 * 60 * 1000))
  const elapsed = elapsedHours < 1
    ? `约 ${Math.max(1, Math.round(elapsedHours * 60))} 分钟前`
    : `约 ${Math.round(elapsedHours * 10) / 10} 小时前`
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(latest.timestamp))
  const type = latest.event.type === 'direct_reset' ? '全员重置' : '重置卡'
  const approximate = latest.approximate ? '（时间按公开日期估算）' : ''

  return [
    '最近一次 Codex 重置',
    `上一次重置：${elapsed}${approximate}`,
    `发生时间：${date}（北京时间）`,
    `类型：${type}`,
    `事件：${latest.event.title}`,
  ].join('\n')
}

/**
 * Estimate event-day probabilities from the public historical snapshot.
 * This is deliberately an empirical Poisson estimate, not an official forecast.
 */
export function analyzeProbability(
  response: CodexResetsResponse,
  now = new Date(),
): ProbabilitySummary {
  const historyStart = parseTimestamp(response.historyFrom) ?? Number.NEGATIVE_INFINITY
  const nowTimestamp = now.getTime()
  const confirmed = response.events.filter((event) => {
    if (event.status !== 'confirmed') return false
    const date = eventDateKey(event)
    const timestamp = date ? dateKeyTimestamp(date) : null
    return timestamp !== null && timestamp >= historyStart && timestamp <= nowTimestamp
  })
  const announcedCount = response.events.filter((event) => event.status === 'announced').length
  const activeDates = new Set(
    confirmed.map(eventDateKey).filter((value): value is string => Boolean(value)),
  )
  const latest = now.toISOString()
  const observedDays = inclusiveDays(response.historyFrom, latest)
  const dailyEventDayRate = activeDates.size / observedDays

  return {
    confirmedCount: confirmed.length,
    directResetCount: confirmed.filter((event) => event.type === 'direct_reset').length,
    resetCreditCount: confirmed.filter((event) => event.type === 'reset_credit').length,
    announcedCount,
    activeDays: activeDates.size,
    observedDays,
    dailyEventDayRate,
    next24hProbability: 1 - Math.exp(-dailyEventDayRate),
    next7dProbability: 1 - Math.exp(-dailyEventDayRate * 7),
    lastConfirmedDate: [...activeDates].sort().at(-1) ?? null,
  }
}

export function formatProbability(summary: ProbabilitySummary): string {
  const lines = [
    'Codex 重置事件概率分析（历史统计）',
    `样本：${summary.observedDays} 天，已确认事件 ${summary.confirmedCount} 条，发生过事件的日期 ${summary.activeDays} 天。`,
    `其中：全员重置 ${summary.directResetCount} 条，重置卡 ${summary.resetCreditCount} 条，待确认预告 ${summary.announcedCount} 条。`,
  ]

  if (summary.confirmedCount === 0 || summary.activeDays === 0) {
    lines.push('有效样本不足，暂时无法估算概率。')
  } else {
    lines.push(`历史事件日率：${(summary.dailyEventDayRate * 100).toFixed(2)}%/天。`)
    lines.push(`未来 24 小时至少出现一个公开重置事件的粗略概率：${percentage(summary.next24hProbability)}。`)
    lines.push(`未来 7 天至少出现一个公开重置事件的粗略概率：${percentage(summary.next7dProbability)}。`)
    lines.push(`最近确认日期：${summary.lastConfirmedDate ?? '未知'}。`)
  }

  lines.push('说明：这是基于 AIHOT 当前历史快照的经验估计，不是官方预测，也不代表你的账户一定会获得重置。')
  return lines.join('\n')
}

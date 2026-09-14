import { Context, h, Schema } from 'koishi'
import type { CalendarBrowser } from './calendar'
import { renderCalendarImage } from './calendar'
import { filterHistoryEvents, renderHistoryImage } from './history'
import { renderLatestResetImage } from './event'
import { renderProbabilityImage } from './probability'
import { analyzeProbability, findLatestConfirmedReset, formatLatestReset, formatProbability } from './stats'
import type { LatestResetSummary, ProbabilitySummary } from './stats'
import type {
  CodexResetEvent,
  CodexResetsResponse,
  Config as PluginConfig,
  TargetConfig,
} from './types'

export const name = 'codex-reset'
export const inject = {
  optional: ['puppeteer'],
}

export type Config = PluginConfig

export const Config: Schema<Config> = Schema.object({
  apiUrl: Schema.string()
    .default('https://aihot.news/api/v1/codex-resets')
    .description('监控接口地址。通常不需要修改。'),
  pollInterval: Schema.number()
    .min(60)
    .default(300)
    .description('监控间隔，单位为秒。AIHOT 推荐约 5 分钟轮询一次。'),
  requestTimeout: Schema.number()
    .min(5000)
    .default(15000)
    .description('请求超时时间，单位为毫秒。'),
  targets: Schema.array(Schema.object({
    platform: Schema.string()
      .default('')
      .description('平台，例如 onebot、discord。留空时会尝试所有在线 Bot。'),
    channelId: Schema.string()
      .required()
      .description('频道或群组 ID。建议同时填写平台，避免多账号重复发送。'),
  } satisfies Record<keyof TargetConfig, unknown>)).role('table').default([]).description('推送目标列表。'),
  pushAnnouncements: Schema.boolean()
    .default(true)
    .description('发现新的重置预告时推送。'),
  pushConfirmedResets: Schema.boolean()
    .default(true)
    .description('发现重置或重置卡已确认时推送。'),
  mentionAll: Schema.boolean()
    .default(false)
    .description('推送通知时是否艾特全体。需要平台和频道支持全体艾特。'),
}).i18n({
  'zh-CN': {
    apiUrl: '监控接口地址',
    pollInterval: '监控间隔',
    requestTimeout: '请求超时时间',
    targets: {
      $description: '推送目标',
      platform: '平台',
      channelId: '频道或群组 ID',
    },
    pushAnnouncements: '推送重置预告',
    pushConfirmedResets: '推送已确认重置',
    mentionAll: '艾特全体',
  },
})

interface FetchResult {
  snapshot: CodexResetsResponse | null
  etag: string | null
  notModified: boolean
}

type MessageContent = string | ReturnType<typeof h> | ReturnType<typeof h>[]

interface PuppeteerContext extends Context {
  puppeteer?: CalendarBrowser
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function isResetEvent(value: unknown): value is CodexResetEvent {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.label !== 'string' || typeof value.title !== 'string' || typeof value.scope !== 'string') return false
  if (value.type !== 'direct_reset' && value.type !== 'reset_credit') return false
  if (value.status !== 'announced' && value.status !== 'confirmed') return false
  if (value.confirmationBasis !== null && value.confirmationBasis !== 'source_post' && value.confirmationBasis !== 'receipt_review') return false
  if (typeof value.url !== 'string') return false
  if (!isDateTime(value.createdAt) || !isDateTime(value.updatedAt)) return false
  if (value.confirmedAt !== null && !isDateTime(value.confirmedAt)) return false
  if (value.occurredOn !== null && !isDateKey(value.occurredOn)) return false
  if (value.schedule !== null) {
    if (!isRecord(value.schedule)
      || !['exact', 'approximate', 'deadline', 'date', 'window'].includes(String(value.schedule.precision))
      || !isDateTime(value.schedule.from)
      || !isDateTime(value.schedule.through)
      || typeof value.schedule.label !== 'string') return false
  }
  if (!Array.isArray(value.posts)) return false
  return value.posts.every((post) => {
    if (!isRecord(post)) return false
    return typeof post.id === 'string'
      && isDateTime(post.publishedAt)
      && typeof post.stage === 'string'
      && typeof post.text === 'string'
      && typeof post.originalText === 'string'
      && typeof post.url === 'string'
  })
}

function isSnapshot(value: unknown): value is CodexResetsResponse {
  if (!isRecord(value)) return false
  return value.schemaVersion === 1
    && value.timezone === 'Asia/Shanghai'
    && isDateTime(value.historyFrom)
    && typeof value.count === 'number'
    && (value.checkedAt === null || isDateTime(value.checkedAt))
    && Array.isArray(value.events)
    && value.events.every(isResetEvent)
}

function eventSummary(event: CodexResetEvent): string {
  const kind = event.type === 'direct_reset' ? 'Codex 额度重置' : 'Codex 重置卡发放'
  const status = event.status === 'announced' ? '预告' : '已确认'
  const scope = event.scope ? `（范围：${event.scope}）` : ''
  const schedule = event.schedule?.label ? `\n时间：${event.schedule.label}` : ''
  const source = event.posts[0]?.url ? `\n来源：${event.posts[0].url}` : ''
  return `${kind}${status}${scope}${schedule}${source}`
}

async function sendToTargets(ctx: Context, targets: TargetConfig[], content: MessageContent): Promise<number> {
  let sent = 0
  const sentBindings = new Set<string>()
  for (const target of targets) {
    const channelId = target.channelId?.trim()
    if (!channelId) continue
    const bots = [...ctx.bots].filter((bot) => !target.platform?.trim() || bot.platform === target.platform.trim())
    for (const bot of bots) {
      // A blank-platform target already covers explicit platform targets. Send only once
      // per platform/channel binding, while still trying another bot if the first fails.
      const key = `${bot.platform}\u0000${channelId}`
      if (sentBindings.has(key)) continue
      try {
        await bot.sendMessage(channelId, content)
        sentBindings.add(key)
        sent++
      } catch (error) {
        ctx.logger('codex-reset').warn(
          `发送到 ${bot.platform}:${target.channelId} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  return sent
}

class CodexResetMonitor {
  private snapshot: CodexResetsResponse | null = null
  private etag: string | null = null
  private pollPromise: Promise<void> | null = null
  private disposed = false

  constructor(private readonly ctx: PuppeteerContext, private readonly config: Config) {}

  get currentSnapshot(): CodexResetsResponse | null {
    return this.snapshot
  }

  get hasPuppeteer(): boolean {
    return Boolean(this.ctx.puppeteer)
  }

  async ensureSnapshot(): Promise<CodexResetsResponse | null> {
    if (!this.snapshot) await this.poll()
    return this.snapshot
  }

  async poll(): Promise<void> {
    if (this.disposed) return
    if (this.pollPromise) return this.pollPromise
    this.pollPromise = this.performPoll()
    try {
      await this.pollPromise
    } finally {
      this.pollPromise = null
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private async performPoll(): Promise<void> {
    try {
      const result = await this.fetchSnapshot()
      if (result.notModified || !result.snapshot) return
      const previous = this.snapshot
      this.snapshot = result.snapshot
      this.etag = result.etag ?? this.etag

      // The API returns a complete, mutable snapshot. The first fetch is a baseline.
      if (!previous) return
      await this.notifyChanges(previous, result.snapshot)
    } catch (error) {
      this.ctx.logger('codex-reset').warn(
        `获取 AIHOT 重置事件失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async createCalendarImage(): Promise<Buffer | null> {
    const snapshot = await this.ensureSnapshot()
    const browser = this.ctx.puppeteer
    if (!snapshot || !browser) return null
    return renderCalendarImage(browser, snapshot.events)
  }

  async createHistoryImage(events?: CodexResetEvent[], now = new Date()): Promise<Buffer | null> {
    const snapshot = await this.ensureSnapshot()
    const browser = this.ctx.puppeteer
    if (!snapshot || !browser) return null
    return renderHistoryImage(browser, events ?? snapshot.events, now)
  }

  async createProbabilityImage(summary: ProbabilitySummary): Promise<Buffer | null> {
    const browser = this.ctx.puppeteer
    if (!browser) return null
    return renderProbabilityImage(browser, summary)
  }

  async createLatestResetImage(summary: LatestResetSummary, now = new Date()): Promise<Buffer | null> {
    const browser = this.ctx.puppeteer
    if (!browser) return null
    return renderLatestResetImage(browser, summary, now)
  }

  private async fetchSnapshot(ignoreEtag = false): Promise<FetchResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout)
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'koishi-plugin-codex-reset/0.1.3',
      }
      if (!ignoreEtag && this.etag && this.snapshot) headers['If-None-Match'] = this.etag
      const response = await fetch(this.config.apiUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (response.status === 304 && this.snapshot) {
        return { snapshot: null, etag: this.etag, notModified: true }
      }
      if (response.status === 304) return this.fetchSnapshot(true)
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ')
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`)
      }
      const body: unknown = await response.json()
      if (!isSnapshot(body)) throw new Error('响应格式不符合 Codex 重置 API v1')
      return {
        snapshot: body,
        etag: response.headers.get('etag'),
        notModified: false,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async notifyChanges(previous: CodexResetsResponse, current: CodexResetsResponse): Promise<void> {
    const previousById = new Map(previous.events.map((event) => [event.id, event]))
    const messages: string[] = []

    for (const event of current.events) {
      const oldEvent = previousById.get(event.id)
      if (event.status === 'announced' && this.config.pushAnnouncements && !oldEvent) {
        messages.push(`📢 Codex 重置预告\n${eventSummary(event)}`)
      }
      if (event.status === 'confirmed' && this.config.pushConfirmedResets && (!oldEvent || oldEvent.status === 'announced')) {
        messages.push(`✅ Codex 重置事件\n${eventSummary(event)}`)
      }
    }

    for (const message of messages) {
      if (!this.config.targets.length) {
        this.ctx.logger('codex-reset').info(`检测到新事件，但未配置推送目标：\n${message}`)
        continue
      }
      const content: MessageContent = this.config.mentionAll
        ? [h('at', { type: 'all' }), h.text(`\n${message}`)]
        : message
      await sendToTargets(this.ctx, this.config.targets, content)
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const monitor = new CodexResetMonitor(ctx as PuppeteerContext, config)

  ctx.on('ready', () => {
    void monitor.poll()
    ctx.setInterval(() => void monitor.poll(), config.pollInterval * 1000)
  })
  ctx.on('dispose', () => monitor.dispose())

  ctx.command('codex.probability', '分析 Codex 重置事件的历史概率')
    .alias('重置概率')
    .action(async () => {
      const snapshot = await monitor.ensureSnapshot()
      if (!snapshot) return '暂时无法获取 Codex 重置事件数据，请稍后再试。'
      const summary = analyzeProbability(snapshot)
      if (!monitor.hasPuppeteer) return formatProbability(summary)
      try {
        const image = await monitor.createProbabilityImage(summary)
        if (!image) return formatProbability(summary)
        return h.image(image, 'image/png')
      } catch (error) {
        ctx.logger('codex-reset').warn(`生成概率卡片失败：${error instanceof Error ? error.message : String(error)}`)
        return formatProbability(summary)
      }
    })

  ctx.command('codex.event', '查看上一次 Codex 重置距今多久')
    .alias('最近重置')
    .action(async () => {
      const snapshot = await monitor.ensureSnapshot()
      if (!snapshot) return '暂时无法获取 Codex 重置事件数据，请稍后再试。'
      const now = new Date()
      const latest = findLatestConfirmedReset(snapshot, now)
      if (!latest) return formatLatestReset(snapshot, now)
      if (!monitor.hasPuppeteer) return formatLatestReset(snapshot, now)
      try {
        const image = await monitor.createLatestResetImage(latest, now)
        if (!image) return formatLatestReset(snapshot, now)
        return h.image(image, 'image/png')
      } catch (error) {
        ctx.logger('codex-reset').warn(`生成最近重置卡片失败：${error instanceof Error ? error.message : String(error)}`)
        return formatLatestReset(snapshot, now)
      }
    })

  ctx.command('codex.calendar', '发送本月的 Codex 重置日历图片')
    .alias('重置日历')
    .action(async () => {
      if (!monitor.hasPuppeteer) return '发送日历图片需要先安装并启用 koishi-plugin-puppeteer。'
      try {
        const image = await monitor.createCalendarImage()
        if (!image) return '暂时无法生成日历图片，请稍后再试。'
        return h.image(image, 'image/png')
      } catch (error) {
        ctx.logger('codex-reset').warn(`生成日历图片失败：${error instanceof Error ? error.message : String(error)}`)
        return '日历图片生成失败，请检查 Puppeteer 服务和中文字体。'
      }
    })

  ctx.command('codex.history [range:number]', '发送 Codex 重置历史时间线图片')
    .alias('重置历史')
    .option('all', '-a 查看全部历史')
    .action(async (argv, range?: number) => {
      if (!monitor.hasPuppeteer) return '发送历史时间线图片需要先安装并启用 koishi-plugin-puppeteer。'
      try {
        const snapshot = await monitor.ensureSnapshot()
        if (!snapshot) return '暂时无法获取 Codex 重置事件数据，请稍后再试。'
        const now = new Date()
        const historyRange = argv.options?.all
          ? 'all' as const
          : Math.max(1, Math.min(120, Math.floor(Math.abs(range ?? 1))))
        const events = filterHistoryEvents(snapshot.events, now, historyRange)
        const image = await monitor.createHistoryImage(events, now)
        if (!image) return '暂时无法生成历史时间线图片，请稍后再试。'
        return h.image(image, 'image/png')
      } catch (error) {
        ctx.logger('codex-reset').warn(`生成历史时间线图片失败：${error instanceof Error ? error.message : String(error)}`)
        return '历史时间线图片生成失败，请检查 Puppeteer 服务和中文字体。'
      }
    })
}

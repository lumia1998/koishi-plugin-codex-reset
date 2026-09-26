import { Context, h, Schema } from 'koishi'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

const MAX_NOTIFICATION_AGE_MS = 48 * 60 * 60 * 1000
const MAX_PENDING_AGE_MS = 48 * 60 * 60 * 1000
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_HISTORY_EVENTS = 120
const MAX_CONCURRENT_RENDERS = 2
const RENDER_START_INTERVAL_MS = 3000

interface PendingNotification {
  key: string
  message: string
  createdAt: number
  deliveredBindings: string[]
}

interface StoredState {
  version: 1
  initialized: boolean
  seenStages: string[]
  pending: PendingNotification[]
}

class RenderBusyError extends Error {}
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
  const scope = event.scope ? `（范围：${event.scope.slice(0, 200)}）` : ''
  let schedule = ''
  if (event.status === 'announced' && event.schedule?.label) {
    schedule = `\n预计时间：${event.schedule.label.slice(0, 200)}`
  } else if (event.status === 'confirmed' && event.occurredOn) {
    schedule = `\n发生日期：${event.occurredOn}（北京时间）`
  } else if (event.status === 'confirmed' && event.confirmedAt) {
    const confirmedAt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(event.confirmedAt))
    schedule = `\n确认时间：${confirmedAt}`
  }
  const source = event.posts[0]?.url ? `\n来源：${event.posts[0].url.slice(0, 500)}` : ''
  return `${kind}${status}${scope}${schedule}${source}`
}

function stageKeys(event: CodexResetEvent): string[] {
  return [`id:${event.status}:${event.id}`]
}

function isRecent(timestamp: number, now: number): boolean {
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60 * 1000 && now - timestamp <= MAX_NOTIFICATION_AGE_MS
}

function isRecentEventDay(value: string, now: number): boolean {
  const timestamp = Date.parse(`${value}T12:00:00+08:00`)
  // occurredOn has day precision. Today's noon may still be in the future
  // when a morning confirmation arrives.
  return Number.isFinite(timestamp) && timestamp <= now + 12 * 60 * 60 * 1000
    && now - timestamp <= MAX_NOTIFICATION_AGE_MS
}

function isFreshNotification(event: CodexResetEvent, now: number, wasAnnounced: boolean): boolean {
  if (event.status === 'announced') return isRecent(Date.parse(event.createdAt), now)
  // A fresh confirmation can be attached to a much older reset. Never revive
  // that historical event merely because the API filled in confirmedAt today.
  if (event.occurredOn && !isRecentEventDay(event.occurredOn, now)) return false
  if (!event.occurredOn && event.schedule?.through
    && now - Date.parse(event.schedule.through) > MAX_NOTIFICATION_AGE_MS) return false
  if (event.confirmedAt) return isRecent(Date.parse(event.confirmedAt), now)
  if (event.occurredOn) return isRecentEventDay(event.occurredOn, now)
  return (wasAnnounced || isRecent(Date.parse(event.createdAt), now))
    && isRecent(Date.parse(event.updatedAt), now)
}

async function sendToTargets(
  ctx: Context,
  targets: TargetConfig[],
  content: MessageContent,
  deliveredBindings: string[],
  onDelivered: () => Promise<void>,
): Promise<boolean> {
  const delivered = new Set(deliveredBindings)
  let complete = true
  for (const target of targets) {
    const channelId = target.channelId?.trim()
    if (!channelId) continue
    const bots = [...ctx.bots].filter((bot) => !target.platform?.trim() || bot.platform === target.platform.trim())
    if (!bots.length) complete = false
    for (const platform of new Set(bots.map((bot) => bot.platform))) {
      const key = `${platform}\u0000${channelId}`
      if (delivered.has(key)) continue
      for (const bot of bots.filter((candidate) => candidate.platform === platform)) {
        try {
          await bot.sendMessage(channelId, content)
        } catch (error) {
          ctx.logger('codex-reset').warn(
            `发送到 ${bot.platform}:${target.channelId} 失败：${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        delivered.add(key)
        deliveredBindings.push(key)
        await onDelivered()
        break
      }
      if (!delivered.has(key)) complete = false
    }
  }
  return complete
}

class CodexResetMonitor {
  private snapshot: CodexResetsResponse | null = null
  private etag: string | null = null
  private pollPromise: Promise<void> | null = null
  private disposed = false
  private readonly statePath: string
  private readonly stateLoaded: Promise<void>
  private readonly seenStages = new Set<string>()
  private readonly pending = new Map<string, PendingNotification>()
  private initialized = false
  private activeRenders = 0
  private nextRenderAllowedAt = 0

  constructor(private readonly ctx: PuppeteerContext, private readonly config: Config) {
    const instanceId = createHash('sha256')
      .update(JSON.stringify({ apiUrl: config.apiUrl, targets: config.targets }))
      .digest('hex').slice(0, 16)
    this.statePath = join(ctx.baseDir, 'data', 'codex-reset', `${instanceId}.json`)
    this.stateLoaded = this.loadState()
  }

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
      await this.stateLoaded
      const result = await this.fetchSnapshot()
      if (!result.notModified && result.snapshot) {
        this.snapshot = result.snapshot
        this.etag = result.etag ?? this.etag
        if (!this.initialized) {
          // A fresh installation starts with the entire current snapshot as its baseline.
          for (const event of result.snapshot.events) this.markSeen(event)
          this.initialized = true
        } else {
          this.captureChanges(result.snapshot, Date.now())
        }
      }
      await this.flushPending()
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
    return this.withRenderSlot(() => renderCalendarImage(browser, snapshot.events))
  }

  async createHistoryImage(events?: CodexResetEvent[], now = new Date()): Promise<Buffer | null> {
    const snapshot = await this.ensureSnapshot()
    const browser = this.ctx.puppeteer
    if (!snapshot || !browser) return null
    return this.withRenderSlot(() => renderHistoryImage(browser, events ?? snapshot.events, now))
  }

  async createProbabilityImage(summary: ProbabilitySummary): Promise<Buffer | null> {
    const browser = this.ctx.puppeteer
    if (!browser) return null
    return this.withRenderSlot(() => renderProbabilityImage(browser, summary))
  }

  async createLatestResetImage(summary: LatestResetSummary, now = new Date()): Promise<Buffer | null> {
    const browser = this.ctx.puppeteer
    if (!browser) return null
    return this.withRenderSlot(() => renderLatestResetImage(browser, summary, now))
  }

  private async withRenderSlot<T>(render: () => Promise<T>): Promise<T> {
    const now = Date.now()
    if (this.activeRenders >= MAX_CONCURRENT_RENDERS || now < this.nextRenderAllowedAt) {
      throw new RenderBusyError('图片生成任务较多')
    }
    this.nextRenderAllowedAt = now + RENDER_START_INTERVAL_MS
    this.activeRenders++
    try {
      return await render()
    } finally {
      this.activeRenders--
    }
  }

  private async loadState(): Promise<void> {
    try {
      const state: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.seenStages) || !Array.isArray(state.pending)) {
        throw new Error('状态文件格式无效')
      }
      this.initialized = state.initialized === true
      for (const key of state.seenStages) {
        if (typeof key === 'string') this.seenStages.add(key)
      }
      for (const item of state.pending) {
        if (!isRecord(item) || typeof item.key !== 'string' || typeof item.message !== 'string'
          || typeof item.createdAt !== 'number' || !Array.isArray(item.deliveredBindings)) continue
        this.pending.set(item.key, {
          key: item.key,
          message: item.message,
          createdAt: item.createdAt,
          deliveredBindings: item.deliveredBindings.filter((key): key is string => typeof key === 'string'),
        })
      }
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return
      this.ctx.logger('codex-reset').warn(
        `读取推送状态失败，将重新建立基线：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async saveState(): Promise<void> {
    const state: StoredState = {
      version: 1,
      initialized: this.initialized,
      seenStages: [...this.seenStages],
      pending: [...this.pending.values()],
    }
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`
    try {
      await mkdir(dirname(this.statePath), { recursive: true })
      await writeFile(temporaryPath, JSON.stringify(state), 'utf8')
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      this.ctx.logger('codex-reset').warn(
        `保存推送状态失败：${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  private markSeen(event: CodexResetEvent): void {
    for (const key of stageKeys(event)) this.seenStages.add(key)
  }

  private captureChanges(current: CodexResetsResponse, now: number): void {
    for (const event of current.events) {
      const keys = stageKeys(event)
      const alreadySeen = keys.some((key) => this.seenStages.has(key))
      const wasAnnounced = this.seenStages.has(`id:announced:${event.id}`)
      this.markSeen(event)
      if (alreadySeen || !isFreshNotification(event, now, wasAnnounced)) continue
      if (event.status === 'announced' && !this.config.pushAnnouncements) continue
      if (event.status === 'confirmed' && !this.config.pushConfirmedResets) continue
      const message = event.status === 'announced'
        ? `📢 Codex 重置预告\n${eventSummary(event)}`
        : `✅ Codex 重置事件\n${eventSummary(event)}`
      if (!this.config.targets.length) {
        this.ctx.logger('codex-reset').info(`检测到新事件，但未配置推送目标：\n${message}`)
        continue
      }
      const key = keys[0]
      this.pending.set(key, { key, message, createdAt: now, deliveredBindings: [] })
    }
  }

  private async flushPending(): Promise<void> {
    // Persist the observed stages and queue before sending. This also repairs
    // a previous write failure when the next API response is 304.
    await this.saveState()
    let changed = false
    for (const [key, item] of this.pending) {
      if (Date.now() - item.createdAt > MAX_PENDING_AGE_MS) {
        this.ctx.logger('codex-reset').warn(`推送超过 48 小时仍未完成，已放弃：${key}`)
        this.pending.delete(key)
        changed = true
        continue
      }
      const content: MessageContent = this.config.mentionAll
        ? [h('at', { type: 'all' }), h.text(`\n${item.message}`)]
        : item.message
      const deliveredCount = item.deliveredBindings.length
      const complete = await sendToTargets(this.ctx, this.config.targets, content, item.deliveredBindings, () => this.saveState())
      if (complete) this.pending.delete(key)
      if (complete || deliveredCount !== item.deliveredBindings.length) changed = true
    }
    if (changed) await this.saveState()
  }

  private async fetchSnapshot(): Promise<FetchResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout)
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'koishi-plugin-codex-reset/0.1.5',
      }
      if (this.etag && this.snapshot) headers['If-None-Match'] = this.etag
      const response = await fetch(this.config.apiUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (response.status === 304 && this.snapshot) {
        return { snapshot: null, etag: this.etag, notModified: true }
      }
      if (response.status === 304) throw new Error('服务端在没有本地快照时返回了 304')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declaredLength = Number(response.headers.get('content-length'))
      if (declaredLength > MAX_API_RESPONSE_BYTES) throw new Error('API 响应超过 4 MiB')
      if (!response.body) throw new Error('API 响应没有内容')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_API_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('API 响应超过 4 MiB')
        }
        chunks.push(value)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
        if (error instanceof RenderBusyError) return formatProbability(summary)
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
        if (error instanceof RenderBusyError) return formatLatestReset(snapshot, now)
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
        if (error instanceof RenderBusyError) return '图片生成任务较多，请稍后再试。'
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
        if (events.length > MAX_HISTORY_EVENTS) return `历史事件超过 ${MAX_HISTORY_EVENTS} 条，请缩小查询的月份范围。`
        const image = await monitor.createHistoryImage(events, now)
        if (!image) return '暂时无法生成历史时间线图片，请稍后再试。'
        return h.image(image, 'image/png')
      } catch (error) {
        if (error instanceof RenderBusyError) return '图片生成任务较多，请稍后再试。'
        ctx.logger('codex-reset').warn(`生成历史时间线图片失败：${error instanceof Error ? error.message : String(error)}`)
        return '历史时间线图片生成失败，请检查 Puppeteer 服务和中文字体。'
      }
    })
}

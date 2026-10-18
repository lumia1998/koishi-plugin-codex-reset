export type ResetEventType = 'direct_reset' | 'reset_credit'

export type ResetEventStatus = 'announced' | 'confirmed'

export interface ResetSchedule {
  precision: 'exact' | 'approximate' | 'deadline' | 'date' | 'window'
  from: string
  through: string
  label: string
}

export interface ResetPost {
  id: string
  publishedAt: string
  stage: string
  text: string
  originalText: string
  url: string
}

export interface CodexResetEvent {
  id: string
  type: ResetEventType
  label: string
  status: ResetEventStatus
  title: string
  scope: string
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
  occurredOn: string | null
  confirmationBasis: 'source_post' | 'receipt_review' | null
  schedule: ResetSchedule | null
  posts: ResetPost[]
  url: string
}

export interface CodexResetsResponse {
  schemaVersion: 1
  timezone: 'Asia/Shanghai'
  checkedAt: string | null
  historyFrom: string
  count: number
  events: CodexResetEvent[]
}

export interface TargetConfig {
  platform: string
  channelId: string
}

export interface Config {
  apiUrl: string
  pollInterval: number
  requestTimeout: number
  targets: TargetConfig[]
  pushAnnouncements: boolean
  pushConfirmedResets: boolean
  mentionAll: boolean
  commandAuthority: number
  renderCooldown: number
}

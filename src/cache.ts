import type { Context } from 'koishi'
import { createHash, randomUUID } from 'node:crypto'
import type { CodexResetsResponse } from './types'

// Leave a little room beyond AIHOT's ten-minute full-history limit.
export const MIN_POLL_INTERVAL_MS = 660_000
const TABLE = 'codex_reset_cache'
const inFlight = new WeakMap<Context, Map<string, Promise<SnapshotCache>>>()

export interface SnapshotCache {
  id: string
  snapshot: CodexResetsResponse | null
  etag: string | null
  fetchedAt: number
  nextFetchAt: number
  requestId: string
}

declare module 'koishi' {
  interface Tables {
    codex_reset_cache: SnapshotCache
  }
}

export interface FetchResult {
  snapshot: CodexResetsResponse | null
  etag: string | null
  notModified: boolean
  maxAgeMs: number
}

export class SnapshotRequestError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message)
  }
}

export function extendCacheModel(ctx: Context): void {
  ctx.model.extend(TABLE, {
    id: 'string',
    snapshot: { type: 'json', nullable: true, initial: null },
    etag: { type: 'string', nullable: true, initial: null },
    fetchedAt: { type: 'double', initial: 0 },
    nextFetchAt: { type: 'double', initial: 0 },
    requestId: { type: 'string', initial: '' },
  }, { primary: 'id' })
}

export class SnapshotStore {
  private readonly id: string

  constructor(
    private readonly ctx: Context,
    apiUrl: string,
    private readonly validate: (value: unknown) => value is CodexResetsResponse,
  ) {
    // Targets do not affect API data or the upstream request quota.
    this.id = createHash('sha256').update(new URL(apiUrl).href).digest('hex')
  }

  async read(): Promise<SnapshotCache> {
    let [cache] = await this.ctx.database.get(TABLE, this.id)
    if (!cache) {
      try {
        cache = await this.ctx.database.create(TABLE, { id: this.id })
      } catch (error) {
        // Another instance may have created the same API cache concurrently.
        const existing = await this.ctx.database.get(TABLE, this.id)
        cache = existing[0]
        if (!cache) throw error
      }
    }
    if (!this.validate(cache.snapshot)) return { ...cache, snapshot: null, etag: null }
    return cache
  }

  refresh(
    intervalMs: number,
    timeoutMs: number,
    fetchSnapshot: (cache: SnapshotCache) => Promise<FetchResult>,
  ): Promise<SnapshotCache> {
    const root = this.ctx.root ?? this.ctx
    let requests = inFlight.get(root)
    if (!requests) inFlight.set(root, requests = new Map())
    const pending = requests.get(this.id)
    if (pending) return pending
    const request = this.performRefresh(intervalMs, timeoutMs, fetchSnapshot)
      .finally(() => requests.delete(this.id))
    requests.set(this.id, request)
    return request
  }

  private async performRefresh(
    intervalMs: number,
    timeoutMs: number,
    fetchSnapshot: (cache: SnapshotCache) => Promise<FetchResult>,
  ): Promise<SnapshotCache> {
    const cache = await this.read()
    const now = Date.now()
    if (now < cache.nextFetchAt) return cache

    const delay = Math.max(MIN_POLL_INTERVAL_MS, intervalMs)
    const requestId = randomUUID()
    // Reserve the next request before network I/O. A restart or another plugin
    // instance must observe this reservation, even if the request fails.
    await this.ctx.database.set(TABLE, {
      id: this.id,
      nextFetchAt: cache.nextFetchAt,
      requestId: cache.requestId,
    }, {
      requestId,
      nextFetchAt: now + Math.max(delay, timeoutMs + 1000),
    })
    const reserved = await this.read()
    if (reserved.requestId !== requestId) return reserved

    try {
      const result = await fetchSnapshot(cache)
      await this.ctx.database.set(TABLE, { id: this.id, requestId }, {
        snapshot: result.notModified ? cache.snapshot : result.snapshot,
        etag: result.etag,
        fetchedAt: Date.now(),
        nextFetchAt: Math.max(now + delay, Date.now() + result.maxAgeMs),
      })
    } catch (error) {
      const retryAfterMs = error instanceof SnapshotRequestError ? error.retryAfterMs : 0
      await this.ctx.database.set(TABLE, { id: this.id, requestId }, {
        nextFetchAt: Date.now() + Math.max(delay, retryAfterMs),
      })
      throw error
    }
    return this.read()
  }
}

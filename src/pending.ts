import type { Context } from 'koishi'
import { randomUUID } from 'node:crypto'

/**
 * Notifications live in the database rather than in a per-process JSON file, so
 * several Koishi instances sharing one database coordinate on a single send.
 *
 * Delivery is protected by a lease: an instance claims a row with a
 * compare-and-swap update and only the winner talks to the bots. A crashed or
 * slow instance loses the lease after {@link PENDING_LEASE_MS}, and another
 * instance picks the row up again. Progress is written per target, so a retry
 * after a partial send skips the targets that already received the message.
 */
export const PENDING_TABLE = 'codex_reset_pending'
export const PENDING_LEASE_MS = 5 * 60 * 1000

export interface PendingRow {
  key: string
  message: string
  createdAt: number
  delivered: string[]
  owner: string
  ownerAt: number
}

declare module 'koishi' {
  interface Tables {
    codex_reset_pending: PendingRow
  }
}

export function extendPendingModel(ctx: Context): void {
  ctx.model.extend(PENDING_TABLE, {
    key: 'string',
    message: 'text',
    createdAt: 'double',
    delivered: { type: 'json', initial: [] },
    owner: { type: 'string', initial: '' },
    ownerAt: { type: 'double', initial: 0 },
  }, { primary: 'key' })
}

export class PendingQueue {
  readonly owner = randomUUID()

  constructor(private readonly ctx: Context) {}

  /** Insert once: a duplicate key means another instance already queued it. */
  async add(key: string, message: string, createdAt: number): Promise<void> {
    const [existing] = await this.ctx.database.get(PENDING_TABLE, key)
    if (existing) return
    try {
      await this.ctx.database.create(PENDING_TABLE, { key, message, createdAt })
    } catch {
      // Another instance inserted the same key between the read and the create.
      // That is exactly the de-duplication this table exists for.
    }
  }

  async list(): Promise<PendingRow[]> {
    const rows = await this.ctx.database.get(PENDING_TABLE, {})
    return rows.filter((row) => typeof row?.key === 'string')
  }

  /** Claim a row for this instance; returns null when another instance holds it. */
  async claim(key: string, leaseMs = PENDING_LEASE_MS): Promise<PendingRow | null> {
    const now = Date.now()
    const threshold = now - leaseMs
    const query = {
      $and: [
        { key },
        { $or: [{ owner: '' }, { ownerAt: { $lt: threshold } }] },
      ],
    }
    await this.ctx.database.set(PENDING_TABLE, query, { owner: this.owner, ownerAt: now })
    const [row] = await this.ctx.database.get(PENDING_TABLE, key)
    return row && row.owner === this.owner ? row : null
  }

  async appendDelivered(key: string, binding: string): Promise<void> {
    const [row] = await this.ctx.database.get(PENDING_TABLE, { key, owner: this.owner })
    if (!row) return
    const delivered = Array.isArray(row.delivered) ? row.delivered : []
    if (delivered.includes(binding)) return
    await this.ctx.database.set(PENDING_TABLE, { key, owner: this.owner }, {
      delivered: [...delivered, binding],
    })
  }

  async complete(key: string): Promise<void> {
    await this.ctx.database.remove(PENDING_TABLE, { key, owner: this.owner })
  }

  async release(key: string): Promise<void> {
    await this.ctx.database.set(PENDING_TABLE, { key, owner: this.owner }, { owner: '' })
  }

  /** Drop rows nobody managed to deliver within the notification window. */
  async prune(maxAgeMs: number): Promise<number> {
    const stale = await this.ctx.database.get(PENDING_TABLE, {
      createdAt: { $lt: Date.now() - maxAgeMs },
    })
    for (const row of stale) {
      await this.ctx.database.remove(PENDING_TABLE, { key: row.key })
    }
    return stale.length
  }
}

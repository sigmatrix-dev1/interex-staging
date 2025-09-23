import { audit } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

export type NotificationKind = 'success' | 'error' | 'info' | 'warning'

export interface CreateUserNotificationInput {
  userId: string
  kind: NotificationKind
  title: string
  description?: string | null
  expiresAtMs?: number | null // epoch ms
  actionUrl?: string | null
  groupKey?: string | null
  metadata?: unknown
  autoRead?: boolean // if true mark read immediately
}

const MAX_PER_USER = 200 // hard cap to avoid unbounded growth (simple pruning strategy)
const VALID_KINDS: NotificationKind[] = ['success', 'error', 'info', 'warning']
const MAX_TITLE_LEN = 160
const MAX_DESC_LEN = 2000
const PURGE_AGE_DAYS = 7

function sanitizeString(value: unknown, fallback: string, max: number) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, max)
}

export async function purgeOldNotifications(opts: { auditActorId?: string | null; manual?: boolean } = {}) {
  const client: any = prisma
  const cutoff = new Date(Date.now() - PURGE_AGE_DAYS * 24 * 60 * 60 * 1000)
  let deleted = 0
  try {
    const result = await client.userNotification.deleteMany({
      where: {
        OR: [
          { createdAt: { lt: cutoff } },
          { expiresAt: { lt: new Date() } },
          { dismissedAt: { lt: cutoff } },
        ],
      },
    })
    deleted = (result?.count as number) || 0
  } catch {
    // swallow (non-critical maintenance)
  }
  // Audit (only if manual OR non-zero deletion to avoid spam)
  try {
    if (opts.manual || deleted > 0) {
      await audit.system({
        action: 'NOTIFICATION_PURGE',
        actorType: opts.auditActorId ? 'USER' : 'SYSTEM',
        actorId: opts.auditActorId ?? null,
        summary: `${deleted} notifications purged`,
        metadata: { deleted, manual: !!opts.manual, retentionDays: PURGE_AGE_DAYS },
      })
    }
  } catch {
    // ignore audit failure
  }
  return deleted
}

export async function createUserNotification(input: CreateUserNotificationInput) {
  // Defensive validation / sanitation
  const kind: NotificationKind = VALID_KINDS.includes(input.kind) ? input.kind : 'info'
  const title = sanitizeString(input.title, 'Notification', MAX_TITLE_LEN)
  const description = input.description
    ? sanitizeString(input.description, '', MAX_DESC_LEN)
    : null
  const expiresAt = input.expiresAtMs ? new Date(input.expiresAtMs) : undefined
  const client: any = prisma // cast to any for now
  const created = await client.userNotification.create({
    data: {
      userId: input.userId,
      kind,
      title,
      description: description || null,
      expiresAt,
      actionUrl: input.actionUrl || null,
      groupKey: input.groupKey || null,
      metadata: input.metadata ? (input.metadata as any) : undefined,
      readAt: input.autoRead ? new Date() : null,
    },
  })

  // Simple pruning: keep only most recent MAX_PER_USER (by createdAt)
  void prisma.$transaction(async (tx: any) => {
    const toDelete: Array<{ id: string }> = await tx.userNotification.findMany({
      where: { userId: input.userId },
      orderBy: { createdAt: 'desc' },
      skip: MAX_PER_USER,
      select: { id: true },
    })
    if (toDelete.length) {
      await tx.userNotification.deleteMany({ where: { id: { in: toDelete.map((r: { id: string }) => r.id) } } })
    }
  }).catch(() => {})

  // Opportunistic purge (non-blocking, system audit only if deletions occur)
  void purgeOldNotifications({ manual: false })

  return created
}

export interface ListUserNotificationsOptions {
  userId: string
  limit?: number
  includeDismissed?: boolean
}

export async function listUserNotifications(opts: ListUserNotificationsOptions) {
  const client: any = prisma
  return client.userNotification.findMany({
    where: {
      userId: opts.userId,
      dismissedAt: opts.includeDismissed ? undefined : null,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
  })
}

export async function markUserNotificationRead(userId: string, id: string) {
  const client: any = prisma
  return client.userNotification.update({
    where: { id },
    data: { readAt: new Date() },
  })
}

export async function markAllUserNotificationsRead(userId: string) {
  const client: any = prisma
  return client.userNotification.updateMany({
    where: { userId, readAt: null, dismissedAt: null },
    data: { readAt: new Date() },
  })
}

export async function dismissUserNotification(userId: string, id: string) {
  const client: any = prisma
  return client.userNotification.update({
    where: { id },
    data: { dismissedAt: new Date() },
  })
}

export async function dismissAllUserNotifications(userId: string) {
  const client: any = prisma
  return client.userNotification.updateMany({
    where: { userId, dismissedAt: null },
    data: { dismissedAt: new Date() },
  })
}

export function serializeForClient(row: any) {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    description: row.description ?? undefined,
    createdAt: new Date(row.createdAt).getTime(),
    read: !!row.readAt,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : undefined,
  }
}

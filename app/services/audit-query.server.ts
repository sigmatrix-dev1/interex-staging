// app/services/audit-query.server.ts
// Centralized read/query helpers for new AuditEvent table.
// Provides focused, composable functions instead of ad-hoc queries sprinkled across routes.
// Each function enforces multi-tenant scoping and safe pagination patterns.

import { prisma } from '#app/utils/db.server.ts'

export type CursorPage<T> = {
  items: T[]
  nextCursor?: { createdAt: string; id: string }
  hasMore: boolean
}

// Shape returned to callers (omit heavy fields by default; allow expansion via options later)
export interface AuditEventView {
  id: string
  createdAt: string
  chainKey: string
  seq: number
  category: string
  action: string
  status: string
  actorType: string
  actorId?: string | null
  customerId?: string | null
  entityType?: string | null
  entityId?: string | null
  requestId?: string | null
  summary?: string | null
  message?: string | null
  metadata?: unknown
  diff?: unknown
}

function toView(e: any): AuditEventView {
  return {
    id: e.id,
    createdAt: e.createdAt.toISOString(),
    chainKey: e.chainKey,
    seq: e.seq,
    category: e.category,
    action: e.action,
    status: e.status,
    actorType: e.actorType,
    actorId: e.actorId,
    customerId: e.customerId,
    entityType: e.entityType,
    entityId: e.entityId,
    requestId: e.requestId,
    summary: e.summary,
    message: e.message,
    metadata: e.metadata ? safeParseJson(e.metadata) : undefined,
    diff: e.diff ? safeParseJson(e.diff) : undefined,
  }
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return undefined }
}

// ----------------------------- Pagination Helper -----------------------------
// We page by createdAt DESC, id DESC (id tie-breaker) with opaque cursor consisting of both.

interface PageOpts {
  limit?: number
  cursor?: { createdAt: string; id: string }
}

function buildCursorWhere(cursor?: { createdAt: string; id: string }) {
  if (!cursor) return {}
  // For DESC ordering: (createdAt < cursor.createdAt) OR (createdAt == cursor.createdAt AND id < cursor.id)
  return {
    OR: [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { AND: [ { createdAt: new Date(cursor.createdAt) }, { id: { lt: cursor.id } } ] },
    ],
  }
}

// ----------------------------- 1. Recent Submission Events (per customer) -----------------------------
export async function getRecentSubmissionAuditEvents(customerId: string, opts: PageOpts = {}): Promise<CursorPage<AuditEventView>> {
  const take = Math.min(200, Math.max(1, opts.limit ?? 50))
  const cursorWhere = buildCursorWhere(opts.cursor)
  const rows = await prisma.auditEvent.findMany({
    where: {
      customerId,
      category: 'SUBMISSION',
      ...cursorWhere,
    },
    orderBy: [ { createdAt: 'desc' }, { id: 'desc' } ],
    take: take + 1, // fetch one extra to know hasMore
  })
  const hasMore = rows.length > take
  const slice = rows.slice(0, take)
  let nextCursor: { createdAt: string; id: string } | undefined
  if (hasMore && slice.length > 0) {
    const last = slice[slice.length - 1]!
    nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id }
  }
  return { items: slice.map(toView), hasMore, nextCursor }
}

// ----------------------------- 2. Correlate by requestId -----------------------------
export async function getAuditEventsByRequestId(requestId: string): Promise<AuditEventView[]> {
  if (!requestId) return []
  const rows = await prisma.auditEvent.findMany({
    where: { requestId },
    orderBy: { createdAt: 'asc' },
    take: 1000, // safety cap
  })
  return rows.map(toView)
}

// ----------------------------- 3. Actor activity (optionally scoped) -----------------------------
export async function getActorActivity(actorId: string, opts: { limit?: number; sinceMinutes?: number } = {}): Promise<AuditEventView[]> {
  if (!actorId) return []
  const since = opts.sinceMinutes ? new Date(Date.now() - opts.sinceMinutes * 60_000) : undefined
  const rows = await prisma.auditEvent.findMany({
    where: {
      actorId,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, opts.limit ?? 100)),
  })
  return rows.map(toView)
}

// ----------------------------- 4. Generic filtered search with cursor pagination -----------------------------
export interface AuditSearchFilters {
  customerId?: string
  actorId?: string
  category?: string
  action?: string
  entityType?: string
  entityId?: string
  status?: string
  requestId?: string
  text?: string // matches summary / message
  from?: Date
  to?: Date
}

export async function searchAuditEvents(filters: AuditSearchFilters, opts: PageOpts = {}): Promise<CursorPage<AuditEventView>> {
  const take = Math.min(200, Math.max(1, opts.limit ?? 50))
  const cursorWhere = buildCursorWhere(opts.cursor)

  const where: any = { ...cursorWhere }
  if (filters.customerId) where.customerId = filters.customerId
  if (filters.actorId) where.actorId = filters.actorId
  if (filters.category) where.category = filters.category
  if (filters.action) where.action = filters.action
  if (filters.entityType) where.entityType = filters.entityType
  if (filters.entityId) where.entityId = filters.entityId
  if (filters.status) where.status = filters.status
  if (filters.requestId) where.requestId = filters.requestId
  if (filters.from || filters.to) {
    where.createdAt = {}
    if (filters.from) where.createdAt.gte = filters.from
    if (filters.to) where.createdAt.lte = filters.to
  }
  if (filters.text) {
    const t = filters.text
    where.OR = [
      { summary: { contains: t } },
      { message: { contains: t } },
      { metadata: { contains: t } }, // simple substring on JSON string
    ]
  }

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: [ { createdAt: 'desc' }, { id: 'desc' } ],
    take: take + 1,
  })
  const hasMore = rows.length > take
  const slice = rows.slice(0, take)
  let nextCursor: { createdAt: string; id: string } | undefined
  if (hasMore && slice.length > 0) {
    const last = slice[slice.length - 1]!
    nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id }
  }
  return { items: slice.map(toView), hasMore, nextCursor }
}

// ----------------------------- 5. Convenience: chain head & tail for a chainKey -----------------------------
export async function getChainExtents(chainKey: string) {
  if (!chainKey) return null
  const head = await prisma.auditEvent.findFirst({ where: { chainKey }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, hashSelf: true, hashPrev: true, createdAt: true } })
  const tail = await prisma.auditEvent.findFirst({ where: { chainKey }, orderBy: { seq: 'desc' }, select: { id: true, seq: true, hashSelf: true, hashPrev: true, createdAt: true } })
  if (!head || !tail) return null
  return { head, tail }
}

// ----------------------------- 6. Convenience: fetch contiguous segment by chainKey+range -----------------------------
export async function getChainSegment(chainKey: string, fromSeq: number, toSeq: number) {
  if (!chainKey) return []
  if (fromSeq > toSeq) return []
  const rows = await prisma.auditEvent.findMany({
    where: { chainKey, seq: { gte: fromSeq, lte: toSeq } },
    orderBy: { seq: 'asc' },
  })
  return rows
}


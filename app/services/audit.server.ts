import { randomUUID } from 'node:crypto'
import { computeAuditHashSelf, validateAndSerializePayload } from '#app/utils/audit-hash.ts'
import { prisma } from '#app/utils/db.server.ts'

// Local string literal unions mirror Prisma enum values; avoids lint complaints about type-only imports.
type AuditCategory =
  | 'AUTH'
  | 'SUBMISSION'
  | 'DOCUMENT'
  | 'USER_ROLE'
  | 'TENANT_CFG'
  | 'INTEGRATION'
  | 'SECURITY'
  | 'ADMIN'
  | 'SYSTEM'
  | 'ERROR'
type AuditStatus = 'SUCCESS' | 'FAILURE' | 'INFO' | 'WARNING'
type AuditActorType = 'USER' | 'SYSTEM' | 'SERVICE'

export interface AuditEventInput {
  category: AuditCategory
  action: string
  status?: AuditStatus
  chainKey?: string // defaults to customerId||'global'
  customerId?: string | null
  actorType: AuditActorType
  actorId?: string | null
  actorDisplay?: string | null
  actorIp?: string | null
  actorUserAgent?: string | null
  entityType?: string | null
  entityId?: string | null
  requestId?: string | null
  traceId?: string | null
  spanId?: string | null
  summary?: string | null
  message?: string | null
  metadata?: unknown
  diff?: unknown
  allowPhi?: boolean
}

export interface AuditEventResult {
  id: string
  seq: number
  hashSelf: string
  hashPrev?: string | null
}

const BUSY_RETRIES = 6
const BUSY_BACKOFF_MS = 25

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

export async function logAuditEvent(input: AuditEventInput): Promise<AuditEventResult> {
  const chainKey = input.chainKey || input.customerId || 'global'

  // serialize & validate payload
  const { metadataJson, diffJson, phiDetected } = validateAndSerializePayload(
    input.metadata,
    input.diff,
    { allowPhi: !!input.allowPhi }
  )

  // Best-effort enrichment: if a USER actor is provided without a display name, resolve name/email now
  // so future reads don't need to backfill. This adds one lightweight query only when needed.
  if (!input.actorDisplay && input.actorType === 'USER' && input.actorId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: input.actorId },
        select: { name: true, email: true },
      })
      if (user) {
        input.actorDisplay = user.name || user.email || input.actorId
      }
    } catch {
      // ignore lookup failures; UI loader will still attempt a fallback mapping
    }
  }

  // Optimistic concurrency: fetch current tail seq/hashSelf outside of an explicit write transaction
  // then attempt insert with (chainKey, seq) unique constraint. On conflict / busy, retry with fresh tail.
  let attempt = 0
  while (attempt <= BUSY_RETRIES) {
    try {
      const tail = await prisma.auditEvent.findFirst({
        where: { chainKey },
        orderBy: { seq: 'desc' },
        select: { seq: true, hashSelf: true },
      })
      const nextSeq = (tail?.seq ?? 0) + 1
      const hashPrev = tail?.hashSelf ?? null
      const hashSelf = computeAuditHashSelf({
        chainKey,
        seq: nextSeq,
        category: input.category,
        action: input.action,
        status: input.status || 'SUCCESS',
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        summary: input.summary ?? null,
        metadata: metadataJson ? JSON.parse(metadataJson) : undefined,
        diff: diffJson ? JSON.parse(diffJson) : undefined,
        hashPrev,
      })
      const created = await prisma.auditEvent.create({
        data: {
          id: randomUUID(),
          chainKey,
          seq: nextSeq,
          hashPrev,
          hashSelf,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          actorDisplay: input.actorDisplay ?? null,
          actorIp: input.actorIp ?? null,
          actorUserAgent: input.actorUserAgent ?? null,
          customerId: input.customerId ?? null,
          category: input.category,
            action: input.action,
            status: input.status || 'SUCCESS',
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            requestId: input.requestId ?? null,
            traceId: input.traceId ?? null,
            spanId: input.spanId ?? null,
            summary: input.summary ?? null,
            message: input.message ?? null,
            metadata: metadataJson ?? null,
            diff: diffJson ?? null,
            phi: phiDetected,
        },
        select: { id: true, seq: true, hashSelf: true, hashPrev: true },
      })
      return created
    } catch (err: any) {
      const msg = String(err?.message || err)
      // Unique constraint violation (another writer inserted our target seq) OR busy => retry
      if ((/unique constraint failed/i.test(msg) && /AuditEvent.*chainKey.*seq/i.test(msg)) || /P2002/.test(err?.code) || /SQLITE_BUSY/.test(msg)) {
        if (attempt < BUSY_RETRIES) {
          attempt++
          const wait = BUSY_BACKOFF_MS * attempt + Math.floor(Math.random() * 15)
          await sleep(wait)
          continue
        }
      }
      throw err
    }
  }
  throw new Error('Failed to write audit event after retries')
}

// Convenience category wrappers
function base(category: AuditCategory) {
  return (partial: Omit<AuditEventInput, 'category'>) =>
    logAuditEvent({ ...partial, category })
}

export const audit = {
  auth: base('AUTH'),
  submission: base('SUBMISSION'),
  document: base('DOCUMENT'),
  userRole: base('USER_ROLE'),
  tenantCfg: base('TENANT_CFG'),
  integration: base('INTEGRATION'),
  security: base('SECURITY'),
  admin: base('ADMIN'),
  system: base('SYSTEM'),
  error: base('ERROR'),
  direct: logAuditEvent,
}

// Temporary compatibility alias: some stale build artifact referenced a named export `writeAudit`.
// Provide an alias to avoid spurious type errors if an old import lingers. Prefer using `audit.<category>` helpers instead.
export const writeAudit = logAuditEvent

export type AuditService = typeof audit

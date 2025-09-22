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

const BUSY_RETRIES = 4
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

  let attempt = 0
  while (true) {
    try {
      return await prisma.$transaction(async (tx) => {
        const tail = await tx.auditEvent.findFirst({
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

        const created = await tx.auditEvent.create({
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
      })
    } catch (err: any) {
      const msg = String(err?.message || err)
      if (/SQLITE_BUSY/.test(msg) && attempt < BUSY_RETRIES) {
        attempt++
        await sleep(BUSY_BACKOFF_MS * attempt)
        continue
      }
      throw err
    }
  }
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

export type AuditService = typeof audit

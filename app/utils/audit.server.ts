// app/utils/audit.server.ts

// New shim: legacy interface -> new tamper-evident AuditEvent writer.
// Prefer importing category-specific helpers directly where possible.
import { type AuditAction } from '#app/domain/audit-enums.ts'
import { audit as auditEvent } from '#app/services/audit.server.ts'

type MinimalUser = {
  id: string
  email?: string | null
  name?: string | null
  roles?: { name: string }[]
  customerId?: string | null
}

function getIp(request: Request) {
  const h = request.headers
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip') ||
    (h as any).get?.('cf-connecting-ip') ||
    null
  )
}

/**
 * Legacy audit helper (kept temporarily) now routes to AuditEvent.
 * Maps old loosely-typed fields into the structured writer.
 * Will be removed once all callers migrate to category-specific helpers.
 */
export async function audit({
  request,
  user,
  action,
  entityType,
  entityId,
  success = true,
  message,
  meta,
  payload,
}: {
  request: Request
  user?: MinimalUser | null
  action: AuditAction | string
  entityType?: string | null
  entityId?: string | null
  success?: boolean
  message?: string | null
  meta?: unknown
  payload?: unknown
}) {
  try {
    const ip = getIp(request) || undefined
    const ua = request.headers.get('user-agent') || undefined
    const route = new URL(request.url).pathname
    // Choose category heuristically (AUTH if action starts with AUTH_, else ADMIN)
    const category = /^AUTH_/i.test(action) ? 'AUTH' : 'ADMIN'
    await auditEvent.direct({
      category: category as any,
      action: String(action),
      status: success ? 'SUCCESS' : 'FAILURE',
      actorType: 'USER',
      actorId: user?.id || null,
      actorDisplay: user?.name || user?.email || null,
      actorIp: ip || null,
      actorUserAgent: ua || null,
      customerId: user?.customerId || null,
      entityType: entityType || null,
      entityId: entityId || null,
      summary: message || null,
      metadata: {
        route,
        roles: user?.roles?.map(r => r.name) || [],
        legacyMeta: meta ?? undefined,
        legacyPayload: payload ?? undefined,
      },
    })
  } catch {
    // Swallow errors to preserve legacy behavior
  }
}
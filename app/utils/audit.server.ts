// app/utils/audit.server.ts

import { prisma } from '#app/utils/db.server.ts'
import { type AuditAction } from '#app/domain/audit-enums.ts'

    type MinimalUser = {
      id: string
  email?: string | null
  name?: string | null
  roles?: { name: string }[]
  customerId?: string | null
    }

    function getIp(request: Request) {
          // common proxies
              const h = request.headers
              return (
                    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                    h.get('x-real-ip') ||
                    // last resort (non-standard in Cloudflare workers etc.)
                        (h as any).get?.('cf-connecting-ip') ||
                    null
                  )
            }

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
                const rolesCsv = user?.roles?.map(r => r.name).join(',') || undefined
                const route = new URL(request.url).pathname
            
                await prisma.auditLog.create({
                      data: {
                    userId: user?.id,
                        userEmail: user?.email || undefined,
                        userName: user?.name || undefined,
                        rolesCsv,
                        customerId: user?.customerId || undefined,
                        action,
                        entityType: entityType || undefined,
                        entityId: entityId || undefined,
                        route,
                        ip,
                        userAgent: ua,
                        success,
                        message: message || undefined,
                        meta: meta as any,
                        payload: payload as any,
                      },
            })
          } catch {
            // never throw from audit logging
              }
    }
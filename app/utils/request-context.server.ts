import { getUserId, requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

export interface RequestContextOptions {
  requireUser?: boolean
  customerField?: boolean // if true, load user and customer id
}

export interface RequestContext {
  requestId?: string
  traceId?: string
  spanId?: string
  ip?: string
  userAgent?: string
  userId?: string
  customerId?: string | null
  actorDisplay?: string | null
  rolesCsv?: string | null
}

// Basic header names we might support for correlation
const HDR_REQUEST_ID = 'x-request-id'
const HDR_TRACE_ID = 'x-trace-id'
const HDR_SPAN_ID = 'x-span-id'

export async function extractRequestContext(request: Request, opts: RequestContextOptions = {}): Promise<RequestContext> {
  let userId: string | undefined
  if (opts.requireUser) {
    try {
      userId = await requireUserId(request)
    } catch {
      userId = undefined
    }
  } else {
    const maybe = await getUserId(request)
    userId = maybe ?? undefined
  }

  let customerId: string | null | undefined
  let actorDisplay: string | null | undefined
  let rolesCsv: string | null | undefined
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, customerId: true, roles: { select: { name: true } } },
    })
    if (user) {
      customerId = user.customerId
      actorDisplay = user.name || user.email
      rolesCsv = user.roles.map(r => r.name).join(',') || null
    }
  }

  const forwarded = request.headers.get('x-forwarded-for') || ''
  const ip = forwarded.split(',')[0]?.trim() || undefined
  const userAgent = request.headers.get('user-agent') || undefined

  return {
    requestId: request.headers.get(HDR_REQUEST_ID) || crypto.randomUUID(),
    traceId: request.headers.get(HDR_TRACE_ID) || undefined,
    spanId: request.headers.get(HDR_SPAN_ID) || undefined,
    ip,
    userAgent,
    userId,
    customerId: customerId ?? null,
    actorDisplay: actorDisplay ?? null,
    rolesCsv: rolesCsv ?? null,
  }
}

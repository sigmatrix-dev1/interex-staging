import { randomUUID, createHash } from 'node:crypto'
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
    const user = await (prisma as any).user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, customerId: true, roles: { select: { name: true } } },
    })
    if (user) {
      customerId = user.customerId
      actorDisplay = user.name || user.email
      rolesCsv = user.roles.map((r: any) => r.name).join(',') || null
    }
  }

  // Prefer trusted proxy headers when present
  const flyIp = request.headers.get('fly-client-ip') || ''
  const cfIp = request.headers.get('cf-connecting-ip') || ''
  const forwarded = request.headers.get('x-forwarded-for') || ''
  const rawIp = (flyIp || cfIp || forwarded.split(',')[0]?.trim() || undefined) as string | undefined
  const ip = sanitizeIp(rawIp)
  const userAgent = request.headers.get('user-agent') || undefined

  return {
  requestId: request.headers.get(HDR_REQUEST_ID) || randomUUID(),
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

function sanitizeIp(ip?: string) {
  if (!ip) return undefined
  const mode = process.env.LOG_IP_MODE || 'raw'
  if (mode === 'raw') return ip
  if (mode === 'masked') {
    // IPv4: a.b.c.d -> a.b.c.0/24; IPv6: keep first 3 hextets /48
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      const parts = ip.split('.')
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
    }
    const hex = ip.split(':')
    return `${hex.slice(0, 3).join(':')}::/48`
  }
  if (mode === 'hash') {
    const salt = process.env.IP_HASH_SALT || ''
    const h = createHash('sha256').update(salt + ip).digest('hex')
    return h
  }
  return ip
}

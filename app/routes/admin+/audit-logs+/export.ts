// /admin/audit-logs/export resource route (correct folder-nesting version)
import { type LoaderFunctionArgs } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, roles: { select: { name: true } } },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const url = new URL(request.url)
  const search = url.searchParams.get('search')?.trim() || ''
  const actions = url.searchParams.getAll('action').filter(Boolean)
  const entityTypes = url.searchParams.getAll('entityType').filter(Boolean)
  const categories = url.searchParams.getAll('category').filter(Boolean)
  const statuses = url.searchParams.getAll('status').filter(Boolean)
  const chainKeys = url.searchParams.getAll('chainKey').filter(Boolean)
  const createdFrom = url.searchParams.get('createdFrom') || ''
  const createdTo = url.searchParams.get('createdTo') || ''
  const format = url.searchParams.get('format') || 'csv'
  const full = format.endsWith('-full')
  const baseFormat = format.replace('-full','')
  const take = Math.min(full ? 5000 : 500, Number(url.searchParams.get('take') || (full ? 5000 : 500)))

  const where: any = {}
  if (search) {
    where.OR = [
      { actorDisplay: { contains: search } },
      { actorId: { contains: search } },
      { entityId: { contains: search } },
      { summary: { contains: search } },
      { message: { contains: search } },
      { requestId: { contains: search } },
      { traceId: { contains: search } },
    ]
  }
  if (actions.length === 1) where.action = actions[0]; else if (actions.length > 1) where.action = { in: actions }
  if (entityTypes.length === 1) where.entityType = entityTypes[0]; else if (entityTypes.length > 1) where.entityType = { in: entityTypes }
  if (categories.length === 1) where.category = categories[0] as any; else if (categories.length > 1) where.category = { in: categories as any }
  if (statuses.length === 1) where.status = statuses[0] as any; else if (statuses.length > 1) where.status = { in: statuses as any }
  if (chainKeys.length === 1) where.chainKey = chainKeys[0]; else if (chainKeys.length > 1) where.chainKey = { in: chainKeys }
  if (createdFrom || createdTo) {
    const range: any = {}
    if (createdFrom) { const d = new Date(createdFrom); if (!isNaN(d.getTime())) range.gte = d }
    if (createdTo) { const d = new Date(createdTo); if (!isNaN(d.getTime())) range.lte = d }
    if (Object.keys(range).length) where.createdAt = range
  }

  const logs = await prisma.auditEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
  })

  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0]
  const commonHeaders: Record<string,string> = {
    'X-Audit-Export': '1',
  }
  // Light keepalive cookie to avoid session expiring during export (optional)
  commonHeaders['Set-Cookie'] = `audit_export_ping=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`

  if (baseFormat === 'json') {
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: logs.length,
      fullExport: full,
      filters: { search, actions, entityTypes, categories, statuses, chainKeys, createdFrom, createdTo },
      logs,
    }, null, 2)
    return new Response(body, { headers: {
      ...commonHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-logs-${timestamp}${full ? '-full' : ''}.json"`,
    } })
  }

  const header = [
    'createdAt','category','action','status','actorDisplay','actorId','actorType','actorIp','entityType','entityId','requestId','traceId','spanId','summary','message','seq','chainKey','hashPrev','hashSelf','metadata','diff'
  ]
  const esc = (v: any) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  const rows = logs.map(l => header.map(h => esc((l as any)[h])).join(','))
  const csv = [header.join(','), ...rows].join('\n')
  return new Response(csv, { headers: {
    ...commonHeaders,
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="audit-logs-${timestamp}${full ? '-full' : ''}.csv"`,
  } })
}

export default function ExportBoundary() { return null }

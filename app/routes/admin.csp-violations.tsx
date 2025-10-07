import { data } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

// Simple aggregation page (JSON) for recent CSP violations. Gated to system-admin.
// Future: convert to UI table. For now returns top directives + counts + throttled markers in last 24h.

export async function loader({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  // Check role
  const roles = await prisma.role.findMany({ where: { users: { some: { id: userId } } }, select: { name: true } })
  const isAdmin = roles.some(r => r.name === 'system-admin')
  if (!isAdmin) throw new Response('Forbidden', { status: 403 })

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  // Pull relevant security events
  const rows = await prisma.securityEvent.findMany({
    where: { createdAt: { gte: since }, kind: { in: ['CSP_VIOLATION','CSP_VIOLATION_THROTTLED'] } },
    select: { kind: true, createdAt: true, reason: true, data: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  })
  const directiveCounts: Record<string, number> = {}
  let throttledCount = 0
  for (const r of rows) {
    if (r.kind === 'CSP_VIOLATION_THROTTLED') throttledCount++
    const dir = r.reason || 'unknown'
    directiveCounts[dir] = (directiveCounts[dir] || 0) + 1
  }
  const top = Object.entries(directiveCounts).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([directive,count])=>({directive,count}))
  return data({ windowHours: 24, total: rows.length, throttledCount, topDirectives: top })
}

export default function AdminCspViolations() {
  return <div className="p-4 text-sm text-gray-600">CSP violation summary is JSON-only. Fetch this route via XHR for data.</div>
}
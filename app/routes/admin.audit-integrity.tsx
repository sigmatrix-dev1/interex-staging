import { data } from 'react-router'
import { canRunAuditIntegrityJob, markAuditIntegrityJobRun, runAuditIntegrityJob } from '#app/services/audit-integrity-job.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

export async function loader({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const roles = await prisma.role.findMany({ where: { users: { some: { id: userId } } }, select: { name: true } })
  const isAdmin = roles.some(r => r.name === 'system-admin')
  if (!isAdmin) throw new Response('Forbidden', { status: 403 })

  const url = new URL(request.url)
  const run = url.searchParams.get('run') === '1'
  if (run) {
    if (!canRunAuditIntegrityJob()) {
      return data({ status: 'THROTTLED' })
    }
    markAuditIntegrityJobRun()
    const result = await runAuditIntegrityJob()
    return data({ status: 'OK', result })
  }
  return data({ status: 'IDLE' })
}

export default function AdminAuditIntegrity() {
  return <div className="p-4 text-sm text-gray-600">Audit integrity job endpoint. Append ?run=1 to execute (JSON response).</div>
}

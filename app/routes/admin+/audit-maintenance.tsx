// app/routes/admin+/audit-maintenance.tsx
// Admin maintenance UI: chain verification & archival (manual batch)

import * as React from 'react'
import { Form, useActionData, useLoaderData, useNavigation, data, type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { archiveOldAuditEvents } from '#app/services/audit-archive.server.ts'
import { verifyChain, verifyAllChains } from '#app/services/audit-verify.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, roles: { select: { name: true } } } })
  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  // basic chain stats (top 5 chains by recent activity)
  const chains = await prisma.auditEvent.groupBy({
    by: ['chainKey'],
    _count: { chainKey: true },
    orderBy: { _count: { chainKey: 'desc' } },
    take: 5,
  })
  return data({ user, chains })
}

interface ActionResult {
  ok: boolean
  message: string
  details?: any
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData()
  const intent = form.get('intent') as string | null
  const chainKey = form.get('chainKey') as string | null

  if (!intent) return data<ActionResult>({ ok: false, message: 'Missing intent' }, { status: 400 })

  try {
    if (intent === 'verify-chain' && chainKey) {
      const res = await verifyChain({ chainKey })
      return data<ActionResult>({ ok: true, message: res.valid ? 'Chain valid' : 'Chain has mismatches', details: res })
    }
    if (intent === 'verify-all') {
      const results = await verifyAllChains()
      const allValid = results.every(r => r.valid)
      return data<ActionResult>({ ok: true, message: allValid ? 'All sampled chains valid' : 'Mismatches detected', details: results })
    }
    if (intent === 'archive') {
      const days = Number(form.get('olderThanDays') || 90)
      const beforeDate = new Date(Date.now() - days * 24 * 3600_000)
      const dryRun = form.get('dryRun') === 'on'
      const limit = Number(form.get('limit') || 500)
      const res = await archiveOldAuditEvents({ beforeDate, limit, chainKey: chainKey || undefined, dryRun })
      return data<ActionResult>({ ok: true, message: dryRun ? 'Dry run complete' : 'Archive batch complete', details: res })
    }
    return data<ActionResult>({ ok: false, message: 'Unsupported intent' }, { status: 400 })
  } catch (err: any) {
    return data<ActionResult>({ ok: false, message: err?.message || String(err) }, { status: 500 })
  }
}

export default function AuditMaintenancePage() {
  const { user, chains } = useLoaderData<typeof loader>()
  const actionData = useActionData<ActionResult | undefined>()
  const nav = useNavigation()
  const busy = nav.state !== 'idle'

  return (
    <InterexLayout
      user={user}
      title="Audit Maintenance"
      subtitle="Verify chain integrity & archive aged events"
      showBackButton
      backTo="/admin"
      currentPath="/admin/audit-maintenance"
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {actionData ? (
          <div className={`border rounded p-3 text-sm ${actionData.ok ? 'border-green-300 bg-green-50' : 'border-rose-300 bg-rose-50'}`}>
            <div className="font-semibold mb-1">{actionData.message}</div>
            {actionData.details ? <pre className="max-h-60 overflow-auto text-xs bg-white p-2 rounded border">{JSON.stringify(actionData.details, null, 2)}</pre> : null}
          </div>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Chain Verification</h2>
          <Form method="post" className="flex flex-col gap-2 md:flex-row md:items-end">
            <input type="hidden" name="intent" value="verify-chain" />
            <label className="flex flex-col text-xs font-medium gap-1">
              <span>Chain Key</span>
              <input name="chainKey" className="border rounded px-2 py-1" placeholder="tenant-id or global" required />
            </label>
            <button disabled={busy} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded shadow disabled:opacity-50">Verify Chain</button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="verify-all" />
            <button disabled={busy} className="bg-gray-800 text-white text-sm px-4 py-2 rounded shadow disabled:opacity-50">Verify Sample of All Chains</button>
          </Form>
          <div className="text-xs text-gray-500">Top chains (by count): {chains.map(c => `${c.chainKey}:${c._count.chainKey}`).join(', ')}</div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Archive Batch</h2>
          <Form method="post" className="grid gap-3 md:grid-cols-5 items-end">
            <input type="hidden" name="intent" value="archive" />
            <label className="flex flex-col text-xs font-medium gap-1">
              <span>Older Than (days)</span>
              <input type="number" name="olderThanDays" defaultValue={90} min={7} className="border rounded px-2 py-1" />
            </label>
            <label className="flex flex-col text-xs font-medium gap-1">
              <span>Limit</span>
              <input type="number" name="limit" defaultValue={500} min={10} className="border rounded px-2 py-1" />
            </label>
            <label className="flex flex-col text-xs font-medium gap-1">
              <span>Chain Key (optional)</span>
              <input name="chainKey" className="border rounded px-2 py-1" placeholder="tenant-id" />
            </label>
            <label className="flex items-center gap-2 text-xs font-medium mt-5">
              <input type="checkbox" name="dryRun" defaultChecked /> Dry Run
            </label>
            <button disabled={busy} className="bg-amber-600 text-white text-sm px-4 py-2 rounded shadow disabled:opacity-50 md:mt-5">Run</button>
          </Form>
          <p className="text-xs text-gray-500">Archival copies events into `AuditEventArchive` then deletes originals in a transaction. Start with dry runs to preview counts.</p>
        </section>
      </div>
    </InterexLayout>
  )
}

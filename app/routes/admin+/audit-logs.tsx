import * as React from 'react'
import { type LoaderFunctionArgs, data, useLoaderData, Form } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

    export async function loader({ request }: LoaderFunctionArgs) {
      const userId = await requireUserId(request)
          const user = await prisma.user.findUnique({
            where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } } },
      })
      if (!user) throw new Response('Unauthorized', { status: 401 })
      requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])
    
      const url = new URL(request.url)
          const search = url.searchParams.get('search')?.trim() || ''
          const action = url.searchParams.get('action') || ''
          const entityType = url.searchParams.get('entityType') || ''
          const take = Math.min(500, Number(url.searchParams.get('take') || 200))
        
          const where: any = {}
          if (search) {
            where.OR = [
                      { userEmail: { contains: search } },
                      { userName: { contains: search } },
                      { entityId: { contains: search } },
                      { message: { contains: search } },
                      { route: { contains: search } },
                      { ip: { contains: search } },
                    ]
              }
      if (action) where.action = action
          if (entityType) where.entityType = entityType
        
          const logs = await prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        take,
          })
      return data({ user, logs, search, action, entityType, take })
        }

    export default function AdminAuditLogsPage() {
      const { user, logs, search, action, entityType, take } = useLoaderData<typeof loader>()
      const isPending = useIsPending()
          return (
            <InterexLayout
      user={user}
          title="Audit Logs"
          subtitle="System-wide actions and outcomes"
          showBackButton
          backTo="/admin"
          currentPath="/admin/audit-logs"
            >
              <LoadingOverlay show={Boolean(isPending)} />
        
              <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
                    <div className="bg-white shadow rounded-md p-4">
                      <Form method="get" className="flex flex-wrap items-end gap-3">
                        <div className="flex flex-col">
                          <label className="text-xs text-gray-500">Search</label>
                          <input name="search" defaultValue={search} placeholder="email / entityId / route / IP…" className="border rounded px-2 py-1 text-sm" />
                        </div>
                        <div className="flex flex-col">
                          <label className="text-xs text-gray-500">Action</label>
                          <input name="action" defaultValue={action} placeholder="e.g. LETTERS_SYNC" className="border rounded px-2 py-1 text-sm" />
                        </div>
                        <div className="flex flex-col">
                          <label className="text-xs text-gray-500">Entity Type</label>
                          <input name="entityType" defaultValue={entityType} placeholder="LETTER / PROVIDER" className="border rounded px-2 py-1 text-sm" />
                        </div>
                        <div className="flex flex-col">
                          <label className="text-xs text-gray-500">Limit</label>
                          <input name="take" type="number" min={1} max={500} defaultValue={take} className="border rounded px-2 py-1 text-sm w-24" />
                        </div>
                        <button className="bg-gray-800 text-white text-sm rounded px-3 py-1.5">Apply</button>
                      </Form>
                    </div>
            
                    <div className="bg-white shadow rounded-md overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                      <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Entity</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Route / IP</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Raw</th>
                          </tr>
                    </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                      {logs.length === 0 ? (
                            <tr><td colSpan={7} className="px-4 py-6 text-sm text-gray-500 text-center">No logs.</td></tr>
                          ) : logs.map((row: any) => (
                            <tr key={row.id} className="hover:bg-gray-50">
                                  <td className="px-3 py-2 text-xs">{new Date(row.createdAt).toLocaleString()}</td>
                                  <td className="px-3 py-2 text-xs">
                                    <div className="text-gray-900">{row.userName || row.userEmail || row.userId || '—'}</div>
                                    <div className="text-[11px] text-gray-500">{row.rolesCsv || '—'}</div>
                                  </td>
                                  <td className="px-3 py-2 text-xs">
                                    <div className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${row.success ? 'bg-green-100 text-green-800' : 'bg-rose-100 text-rose-800'}`}>
                                      {row.action}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 text-xs">
                                    <div>{row.entityType || '—'}</div>
                                    <div className="text-[11px] text-gray-500">{row.entityId || '—'}</div>
                                  </td>
                                  <td className="px-3 py-2 text-[11px] text-gray-700">
                                    <div>{row.route || '—'}</div>
                                    <div className="text-gray-500">{row.ip || '—'}</div>
                                  </td>
                                  <td className="px-3 py-2 text-xs">{row.message || '—'}</td>
                                  <td className="px-3 py-2 text-xs"><JsonViewer data={{ meta: row.meta, payload: row.payload, ua: row.userAgent }} /></td>
                                </tr>
                          ))}
                    </tbody>
                      </table>
                    </div>
                  </div>
            </InterexLayout>
      )
    }
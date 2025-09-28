import * as React from 'react'
import { data, Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      customerId: true,
      providerGroupId: true,
      roles: { select: { name: true } },
    },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })

  // Basic User (and above) can access; requires a customer
  requireRoles(user, [INTEREX_ROLES.BASIC_USER, INTEREX_ROLES.PROVIDER_GROUP_ADMIN, INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.SYSTEM_ADMIN])
  if (!user.customerId) throw new Response('User must be associated with a customer', { status: 400 })

  const [customer, group, assignedProviders, submissionCount] = await Promise.all([
    prisma.customer.findUnique({ where: { id: user.customerId }, select: { id: true, name: true } }),
    user.providerGroupId ? prisma.providerGroup.findUnique({ where: { id: user.providerGroupId }, select: { id: true, name: true } }) : Promise.resolve(null),
    prisma.provider.findMany({
      where: { customerId: user.customerId, userNpis: { some: { userId: user.id } } },
      select: { id: true, npi: true, name: true, active: true, providerGroup: { select: { id: true, name: true } } },
      orderBy: { npi: 'asc' },
    }),
    // Match submissions visibility from customer+/submissions.tsx for basic users
    prisma.submission.count({
      where: {
        customerId: user.customerId,
        providerId: { in: (await prisma.userNpi.findMany({ where: { userId: user.id }, select: { providerId: true } })).map(p => p.providerId) },
      },
    }),
  ])

  return data({ user, customer, group, assignedProviders, metrics: { submissionCount, assignedNpis: assignedProviders.length } })
}

export default function BasicDashboard() {
  const { user, customer, group, assignedProviders, metrics } = useLoaderData<typeof loader>()

  return (
    <InterexLayout
      user={user}
      title="Dashboard"
      subtitle={customer ? `${customer.name}` : undefined}
      currentPath="/basic"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-gray-200 shadow rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Icon name="hero:submissions" className="h-6 w-6 text-indigo-600" />
              <div>
                <div className="text-sm text-gray-500">Total Submissions</div>
                <div className="text-2xl font-semibold text-gray-900">{metrics.submissionCount}</div>
              </div>
            </div>
          </div>
          <div className="bg-white border border-gray-200 shadow rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Icon name="hero:users" className="h-6 w-6 text-indigo-600" />
              <div>
                <div className="text-sm text-gray-500">Your Group</div>
                <div className="text-lg font-medium text-gray-900">{group?.name ?? 'No group'}</div>
              </div>
            </div>
          </div>
          <div className="bg-white border border-gray-200 shadow rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Icon name="id-card" className="h-6 w-6 text-indigo-600" />
              <div>
                <div className="text-sm text-gray-500">Assigned NPIs</div>
                <div className="text-2xl font-semibold text-gray-900">{metrics.assignedNpis}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Assigned NPIs (inline from My NPIs) */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium text-gray-900">Your Assigned NPIs</h2>
              <p className="text-sm text-gray-500">Read-only • scoped to your assignments</p>
            </div>
            <div>
              <Link
                to="/customer/provider-npis"
                className="inline-flex items-center px-3 py-1.5 text-sm rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100"
                title="Open Provider Management"
              >
                <Icon name="link-2" className="h-4 w-4 mr-1" />
                Manage Providers
              </Link>
            </div>
          </div>
          {assignedProviders.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Icon name="id-card" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No NPIs assigned to you</h3>
              <p className="text-gray-500">If you believe this is an error, please contact your administrator.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPI</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Group</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quick Links</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {assignedProviders.map(p => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{p.npi}</div>
                      </td>
                      <td className="px-6 py-4"><div className="text-sm text-gray-900">{p.name || 'No name'}</div></td>
                      <td className="px-6 py-4 whitespace-nowrap"><div className="text-sm text-gray-900">{p.providerGroup?.name || 'No group'}</div></td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${p.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                          {p.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <div className="flex items-center gap-2">
                          <Link to={`/customer/provider-npis?search=${encodeURIComponent(p.npi)}`} className="inline-flex items-center px-2 py-1 rounded-md text-blue-700 hover:text-blue-900 hover:bg-blue-50" title="Open in Provider Management">
                            <Icon name="link-2" className="h-4 w-4 mr-1" />
                            Manage
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </InterexLayout>
  )
}

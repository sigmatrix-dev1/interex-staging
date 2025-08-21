import { type LoaderFunctionArgs } from 'react-router'
import { data, useLoaderData, Link } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require system admin role
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  // Get all NPI assignments (UserNpi records) across all customers
  const npiAssignments = await prisma.userNpi.findMany({
    select: {
      id: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          customer: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      provider: {
        select: {
          id: true,
          npi: true,
          name: true,
          active: true,
          customer: {
            select: {
              id: true,
              name: true,
            },
          },
          providerGroup: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: [
      { provider: { customer: { name: 'asc' } } },
      { provider: { npi: 'asc' } },
      { user: { name: 'asc' } },
    ],
  })

  return data({ user, npiAssignments })
}

export default function AdminNpis() {
  const { user, npiAssignments } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="NPI Management"
      subtitle="Manage NPI assignments across all customers"
      currentPath="/admin/npis"
      actions={
        <Link
          to="/admin/dashboard"
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
        >
          <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
          Back to Dashboard
        </Link>
      }
    >
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="check" className="h-6 w-6 text-blue-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Assignments</dt>
                    <dd className="text-lg font-medium text-gray-900">{npiAssignments.length}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
          
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="cross-1" className="h-6 w-6 text-green-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Unique NPIs</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {new Set(npiAssignments.map(na => na.provider.npi)).size}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="avatar" className="h-6 w-6 text-purple-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Unique Users</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {new Set(npiAssignments.map(na => na.user.id)).size}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="file-text" className="h-6 w-6 text-yellow-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Customers</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {new Set(npiAssignments.map(na => na.provider.customer.id)).size}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* NPI Assignments Table */}
        <div className="bg-white shadow overflow-hidden sm:rounded-md">
          <div className="px-4 py-5 sm:px-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">All NPI Assignments</h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              System-wide NPI user assignments across all customers.
            </p>
          </div>
          <ul className="divide-y divide-gray-200">
            {npiAssignments.map((assignment) => (
              <li key={assignment.id}>
                <div className="px-4 py-4 sm:px-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <Icon 
                          name="check" 
                          className={`h-8 w-8 ${assignment.provider.active ? 'text-green-500' : 'text-gray-400'}`} 
                        />
                      </div>
                      <div className="ml-4">
                        <div className="flex items-center space-x-4">
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              NPI: {assignment.provider.npi}
                            </p>
                            {assignment.provider.name && (
                              <p className="text-sm text-gray-600">{assignment.provider.name}</p>
                            )}
                          </div>
                          <div className="hidden sm:block">
                            <span className="text-gray-400">→</span>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-blue-900">
                              {assignment.user.name || assignment.user.username}
                            </p>
                            <p className="text-sm text-gray-600">{assignment.user.email}</p>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center text-sm text-gray-500 space-x-4">
                          <div className="flex items-center">
                            <Icon name="file-text" className="h-4 w-4 mr-1" />
                            <span>Provider: {assignment.provider.customer.name}</span>
                          </div>
                          
                          {assignment.user.customer && (
                            <div className="flex items-center">
                              <Icon name="avatar" className="h-4 w-4 mr-1" />
                              <span>User: {assignment.user.customer.name}</span>
                            </div>
                          )}
                          
                          {assignment.provider.providerGroup && (
                            <div className="flex items-center">
                              <Icon name="dots-horizontal" className="h-4 w-4 mr-1" />
                              <span>Group: {assignment.provider.providerGroup.name}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <p className="text-sm text-gray-500">
                        Assigned {new Date(assignment.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </InterexLayout>
  )
}

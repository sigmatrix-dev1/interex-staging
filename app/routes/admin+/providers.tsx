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

  // Get all providers across all customers
  const providers = await prisma.provider.findMany({
    select: {
      id: true,
      npi: true,
      name: true,
      active: true,
      createdAt: true,
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
      userNpis: {
        select: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
        },
      },
    },
    orderBy: [
      { customer: { name: 'asc' } },
      { npi: 'asc' },
    ],
  })

  return data({ user, providers })
}

export default function AdminProviders() {
  const { user, providers } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="Provider Management"
      subtitle="Manage providers across all customers"
      currentPath="/admin/providers"
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="cross-1" className="h-6 w-6 text-blue-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Providers</dt>
                    <dd className="text-lg font-medium text-gray-900">{providers.length}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
          
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="check" className="h-6 w-6 text-green-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Active</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {providers.filter(p => p.active).length}
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
                    <dt className="text-sm font-medium text-gray-500 truncate">With Users</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {providers.filter(p => p.userNpis.length > 0).length}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Providers Table */}
        <div className="bg-white shadow overflow-hidden sm:rounded-md">
          <div className="px-4 py-5 sm:px-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">All Providers</h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              System-wide provider management across all customers.
            </p>
          </div>
          <ul className="divide-y divide-gray-200">
            {providers.map((provider) => (
              <li key={provider.id}>
                <div className="px-4 py-4 sm:px-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <Icon 
                          name="cross-1" 
                          className={`h-8 w-8 ${provider.active ? 'text-green-500' : 'text-gray-400'}`} 
                        />
                      </div>
                      <div className="ml-4">
                        <div className="flex items-center">
                          <p className="text-sm font-medium text-gray-900">
                            NPI: {provider.npi}
                          </p>
                          {!provider.active && (
                            <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                              Inactive
                            </span>
                          )}
                        </div>
                        {provider.name && (
                          <p className="text-sm text-gray-600">{provider.name}</p>
                        )}
                        <div className="mt-1 flex items-center text-sm text-gray-500">
                          <Icon name="file-text" className="h-4 w-4 mr-1" />
                          <span className="mr-4">{provider.customer.name}</span>
                          
                          {provider.providerGroup && (
                            <>
                              <Icon name="dots-horizontal" className="h-4 w-4 mr-1" />
                              <span className="mr-4">{provider.providerGroup.name}</span>
                            </>
                          )}
                          
                          {provider.userNpis.length > 0 && (
                            <>
                              <Icon name="avatar" className="h-4 w-4 mr-1" />
                              <span className="mr-4">
                                {provider.userNpis.length} user{provider.userNpis.length > 1 ? 's' : ''}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <p className="text-sm text-gray-500">
                        Added {new Date(provider.createdAt).toLocaleDateString()}
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

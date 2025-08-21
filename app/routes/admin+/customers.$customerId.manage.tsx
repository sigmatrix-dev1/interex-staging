import { type LoaderFunctionArgs } from 'react-router'
import { data, useLoaderData, Link } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'

export async function loader({ request, params }: LoaderFunctionArgs) {
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

  const customerId = params.customerId
  if (!customerId) {
    throw new Response('Customer ID is required', { status: 400 })
  }

  // Get customer with detailed information
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      description: true,
      baaNumber: true,
      baaDate: true,
      createdAt: true,
      active: true,
      _count: {
        select: {
          users: true,
          providers: true,
          providerGroups: true,
        }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // Get customer users
  const users = await prisma.user.findMany({
    where: { customerId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      active: true,
      createdAt: true,
      roles: { select: { name: true } },
      userNpis: {
        select: {
          provider: {
            select: {
              npi: true,
              name: true,
            }
          }
        }
      }
    },
    orderBy: { name: 'asc' }
  })

  // Get customer provider groups
  const providerGroups = await prisma.providerGroup.findMany({
    where: { customerId },
    select: {
      id: true,
      name: true,
      description: true,
      _count: {
        select: {
          providers: true,
          users: true,
        }
      }
    },
    orderBy: { name: 'asc' }
  })

  // Get customer providers/NPIs
  const providers = await prisma.provider.findMany({
    where: { customerId },
    select: {
      id: true,
      npi: true,
      name: true,
      providerGroup: {
        select: {
          id: true,
          name: true,
        }
      },
      userNpis: {
        select: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            }
          }
        }
      }
    },
    orderBy: { name: 'asc' }
  })

  return data({ 
    user,
    customer,
    users,
    providerGroups,
    providers
  })
}

export default function CustomerManagement() {
  const { user, customer, users, providerGroups, providers } = useLoaderData<typeof loader>()

  // Debug logging to ensure we're getting the right data
  console.log('Customer Management - Customer:', customer.name, 'ID:', customer.id)
  console.log('Customer Management - Users count:', users.length)
  console.log('Customer Management - Provider groups count:', providerGroups.length) 
  console.log('Customer Management - Providers count:', providers.length)

  return (
    <InterexLayout 
      user={user}
      title={`Manage ${customer.name}`}
      subtitle="Customer Management"
      currentPath={`/admin/customers/${customer.id}/manage`}
      actions={
        <div className="flex items-center space-x-2">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            System Admin
          </span>
          <Link
            to="/admin/dashboard"
            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
            Back to Dashboard
          </Link>
        </div>
      }
    >
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        
        {/* Customer Information Header - SPECIFIC TO THIS CUSTOMER ONLY */}
        <div className="bg-white overflow-hidden shadow rounded-lg mb-6">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
                <p className="text-sm text-gray-500 mt-1">{customer.description || 'No description'}</p>
                <div className="mt-2 flex items-center space-x-4 text-sm text-gray-500">
                  <span className="font-medium">Customer ID: {customer.id}</span>
                  {customer.baaNumber && (
                    <span>BAA: {customer.baaNumber}</span>
                  )}
                  <span>Created: {new Date(customer.createdAt).toLocaleDateString()}</span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${customer.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {customer.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>
              <div className="flex space-x-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{users.length}</div>
                  <div className="text-xs text-gray-500">Users</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">{providers.length}</div>
                  <div className="text-xs text-gray-500">Providers</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-indigo-600">{providerGroups.length}</div>
                  <div className="text-xs text-gray-500">Groups</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Management Tabs */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Users Management */}
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
                  <Icon name="avatar" className="h-5 w-5 text-green-600 mr-2" />
                  Users ({users.length})
                </h3>
                <Link
                  to={`/admin/users?action=add&customerId=${customer.id}`}
                  className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
                >
                  <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                  Add User
                </Link>
              </div>
              
              {users.length === 0 ? (
                <div className="text-center py-4">
                  <Icon name="avatar" className="mx-auto h-8 w-8 text-gray-400" />
                  <p className="mt-2 text-sm text-gray-500">No users found</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {users.map((user) => (
                    <div key={user.id} className="bg-gray-50 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {user.name || user.username}
                          </p>
                          <p className="text-xs text-gray-500 truncate">{user.email}</p>
                          <div className="flex items-center mt-1">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                              {user.roles[0]?.name || 'No role'}
                            </span>
                            {user.userNpis.length > 0 && (
                              <span className="ml-2 text-xs text-gray-500">
                                {user.userNpis.length} NPI{user.userNpis.length > 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${user.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                          {user.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="mt-4 pt-4 border-t border-gray-200">
                <Link
                  to={`/admin/users?filter=${customer.id}`}
                  className="text-sm text-blue-600 hover:text-blue-500"
                >
                  View all users →
                </Link>
              </div>
            </div>
          </div>

          {/* Provider Groups Management */}
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
                  <Icon name="dots-horizontal" className="h-5 w-5 text-indigo-600 mr-2" />
                  Groups ({providerGroups.length})
                </h3>
                <Link
                  to={`/admin/provider-groups/new?customerId=${customer.id}`}
                  className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                  Add Group
                </Link>
              </div>
              
              {providerGroups.length === 0 ? (
                <div className="text-center py-4">
                  <Icon name="dots-horizontal" className="mx-auto h-8 w-8 text-gray-400" />
                  <p className="mt-2 text-sm text-gray-500">No groups found</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {providerGroups.map((group) => (
                    <div key={group.id} className="bg-gray-50 rounded-lg p-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{group.name}</p>
                        <p className="text-xs text-gray-500">{group.description || 'No description'}</p>
                        <div className="mt-1 flex items-center space-x-3 text-xs text-gray-500">
                          <span>{group._count.providers} provider{group._count.providers !== 1 ? 's' : ''}</span>
                          <span>{group._count.users} user{group._count.users !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="mt-4 pt-4 border-t border-gray-200">
                <Link
                  to={`/admin/provider-groups?customerId=${customer.id}`}
                  className="text-sm text-indigo-600 hover:text-indigo-500"
                >
                  View all groups →
                </Link>
              </div>
            </div>
          </div>

          {/* Providers/NPIs Management */}
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
                  <Icon name="cross-1" className="h-5 w-5 text-purple-600 mr-2" />
                  Providers ({providers.length})
                </h3>
                <Link
                  to={`/admin/providers/new?customerId=${customer.id}`}
                  className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700"
                >
                  <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                  Add Provider
                </Link>
              </div>
              
              {providers.length === 0 ? (
                <div className="text-center py-4">
                  <Icon name="cross-1" className="mx-auto h-8 w-8 text-gray-400" />
                  <p className="mt-2 text-sm text-gray-500">No providers found</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {providers.map((provider) => (
                    <div key={provider.id} className="bg-gray-50 rounded-lg p-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{provider.name}</p>
                        <p className="text-xs text-gray-500">NPI: {provider.npi}</p>
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-xs text-gray-500">
                            {provider.providerGroup?.name || 'No group'}
                          </span>
                          {provider.userNpis.length > 0 && (
                            <span className="text-xs text-green-600">
                              {provider.userNpis.length} user{provider.userNpis.length > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="mt-4 pt-4 border-t border-gray-200">
                <Link
                  to={`/admin/providers?customerId=${customer.id}`}
                  className="text-sm text-purple-600 hover:text-purple-500"
                >
                  View all providers →
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="mt-6 bg-gray-50 overflow-hidden shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">Quick Actions</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Link
                to={`/admin/users?filter=${customer.id}`}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 justify-center"
              >
                <Icon name="avatar" className="-ml-1 mr-2 h-4 w-4" />
                Manage All Users
              </Link>
              <Link
                to={`/admin/provider-groups?customerId=${customer.id}`}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 justify-center"
              >
                <Icon name="dots-horizontal" className="-ml-1 mr-2 h-4 w-4" />
                Manage Groups
              </Link>
              <Link
                to={`/admin/providers?customerId=${customer.id}`}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 justify-center"
              >
                <Icon name="cross-1" className="-ml-1 mr-2 h-4 w-4" />
                Manage Providers
              </Link>
              <Link
                to={`/admin/npis/assign?customerId=${customer.id}`}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-yellow-600 hover:bg-yellow-700 justify-center"
              >
                <Icon name="check" className="-ml-1 mr-2 h-4 w-4" />
                Assign NPIs
              </Link>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

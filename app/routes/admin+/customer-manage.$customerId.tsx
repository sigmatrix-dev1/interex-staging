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
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // Get customer users - ONLY for this specific customer
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

  // Get customer provider groups - ONLY for this specific customer
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

  // Get customer providers/NPIs - ONLY for this specific customer
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

export default function CustomerManagementPage() {
  const { user, customer, users, providerGroups, providers } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title={`Manage ${customer.name}`}
      subtitle="Customer Management Dashboard"
      currentPath={`/admin/customer-manage/${customer.id}`}
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
        
        {/* Customer Information Header */}
        <div className="bg-white overflow-hidden shadow rounded-lg mb-6">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
                <p className="text-sm text-gray-500 mt-1">{customer.description || 'No description'}</p>
                <div className="mt-2 flex items-center space-x-4 text-sm text-gray-500">
                  {customer.baaNumber && (
                    <span>BAA: {customer.baaNumber}</span>
                  )}
                  <span>Created: {new Date(customer.createdAt).toLocaleDateString()}</span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${customer.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {customer.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>
              
              {/* Summary Stats */}
              <div className="flex space-x-6">
                <div className="text-center">
                  <div className="text-3xl font-bold text-green-600">{users.length}</div>
                  <div className="text-sm text-gray-500">Users</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-purple-600">{providers.length}</div>
                  <div className="text-sm text-gray-500">Providers</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-indigo-600">{providerGroups.length}</div>
                  <div className="text-sm text-gray-500">Groups</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Management Options - Clean Navigation Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* Users Management Card */}
          <div className="bg-white overflow-hidden shadow rounded-lg hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="p-3 bg-green-100 rounded-lg">
                    <Icon name="avatar" className="h-8 w-8 text-green-600" />
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">User Management</h3>
                  <p className="text-sm text-gray-500 mt-1">Manage users, roles, and permissions for {customer.name}</p>
                </div>
              </div>
              
              <div className="mt-6">
                <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
                  <span>{users.length} users total</span>
                  <span>{users.filter(u => u.active).length} active</span>
                </div>
                
                <div className="space-y-2">
                  <Link
                    to={`/admin/customer-manage/${customer.id}/users`}
                    className="block w-full text-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700"
                  >
                    Manage Users
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Provider Groups Management Card */}
          <div className="bg-white overflow-hidden shadow rounded-lg hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="p-3 bg-indigo-100 rounded-lg">
                    <Icon name="dots-horizontal" className="h-8 w-8 text-indigo-600" />
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">Provider Groups</h3>
                  <p className="text-sm text-gray-500 mt-1">Organize and manage provider groups for {customer.name}</p>
                </div>
              </div>
              
              <div className="mt-6">
                <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
                  <span>{providerGroups.length} groups total</span>
                  <span>{providerGroups.reduce((acc, g) => acc + g._count.providers, 0)} providers</span>
                </div>
                
                <div className="space-y-2">
                  <Link
                    to={`/admin/customer-manage/${customer.id}/provider-groups`}
                    className="block w-full text-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
                  >
                    Manage Groups
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Providers/NPIs Management Card */}
          <div className="bg-white overflow-hidden shadow rounded-lg hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="p-3 bg-purple-100 rounded-lg">
                    <Icon name="cross-1" className="h-8 w-8 text-purple-600" />
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">Providers & NPIs</h3>
                  <p className="text-sm text-gray-500 mt-1">Manage healthcare providers and NPI assignments</p>
                </div>
              </div>
              
              <div className="mt-6">
                <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
                  <span>{providers.length} providers</span>
                  <span>{providers.reduce((acc, p) => acc + p.userNpis.length, 0)} assignments</span>
                </div>
                
                <div className="space-y-2">
                  <Link
                    to={`/admin/customer-manage/${customer.id}/providers`}
                    className="block w-full text-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-purple-600 hover:bg-purple-700"
                  >
                    Manage Providers
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Additional Quick Actions */}
        <div className="mt-8 bg-gray-50 overflow-hidden shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">Additional Actions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Link
                to={`/admin/npis/assign?customerId=${customer.id}`}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-yellow-600 hover:bg-yellow-700 justify-center"
              >
                <Icon name="check" className="-ml-1 mr-2 h-4 w-4" />
                Assign NPIs to Users
              </Link>
              <Link
                to={`/admin/customers/${customer.id}/edit`}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 justify-center"
              >
                <Icon name="file-text" className="-ml-1 mr-2 h-4 w-4" />
                Edit Customer Details
              </Link>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

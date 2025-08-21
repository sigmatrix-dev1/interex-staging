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

  // Get customer information
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      description: true,
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // Get users for this specific customer
  const users = await prisma.user.findMany({
    where: { customerId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      active: true,
      createdAt: true,
      customer: {
        select: {
          id: true,
          name: true,
        },
      },
      roles: {
        select: {
          name: true,
        },
      },
      userNpis: {
        select: {
          provider: {
            select: {
              npi: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' }
  })

  return data({ 
    user,
    customer,
    users
  })
}

export default function CustomerUsersManagementPage() {
  const { user, customer, users } = useLoaderData<typeof loader>()
  
  // Debug logging
  console.log('🔥 CustomerUsersManagementPage RENDERING - customer:', customer.name, 'users count:', users.length)

  return (
    <InterexLayout 
      user={user}
      title={`User Management - ${customer.name}`}
      subtitle={`Managing ${users.length} users for ${customer.name}`}
      currentPath={`/admin/customer-manage/${customer.id}/users`}
      actions={
        <div className="flex items-center space-x-2">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            System Admin
          </span>
          <Link
            to={`/admin/customer-manage/${customer.id}`}
            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
            Back to Customer
          </Link>
        </div>
      }
    >
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        
        {/* VERY OBVIOUS INDICATOR THIS IS USER MANAGEMENT */}
        <div className="bg-red-500 text-white p-4 rounded-lg mb-6 text-center">
          <h1 className="text-2xl font-bold">🚨 USER MANAGEMENT SCREEN - {customer.name} 🚨</h1>
          <p>If you see this red banner, the user management page is working!</p>
        </div>
        
        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="avatar" className="h-6 w-6 text-blue-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      Total Users
                    </dt>
                    <dd className="text-lg font-medium text-gray-900">{users.length}</dd>
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
                    <dt className="text-sm font-medium text-gray-500 truncate">Active Users</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {users.filter(u => u.active).length}
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
                  <Icon name="cross-1" className="h-6 w-6 text-yellow-600" />
                </div>
                <div className="ml-3 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">With NPIs</dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {users.filter(u => u.userNpis.length > 0).length}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Users Table */}
        <div className="bg-white shadow overflow-hidden sm:rounded-md">
          <div className="px-4 py-5 sm:px-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              {customer.name} Users
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              User management for {customer.name}
            </p>
          </div>
          
          {users.length === 0 ? (
            <div className="text-center py-12">
              <Icon name="avatar" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No users found</h3>
              <p className="mt-1 text-sm text-gray-500">
                This customer doesn't have any users yet.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {users.map((userItem) => (
                <li key={userItem.id}>
                  <div className="px-4 py-4 sm:px-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <div className="flex-shrink-0">
                          <Icon name="avatar" className="h-8 w-8 text-gray-400" />
                        </div>
                        <div className="ml-4">
                          <div className="flex items-center">
                            <p className="text-sm font-medium text-gray-900">
                              {userItem.name || userItem.username}
                            </p>
                            {!userItem.active && (
                              <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                Inactive
                              </span>
                            )}
                            {userItem.roles.map(role => (
                              <span
                                key={role.name}
                                className={`ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                  role.name === 'system-admin' 
                                    ? 'bg-red-100 text-red-800'
                                    : role.name === 'customer-admin'
                                    ? 'bg-blue-100 text-blue-800'
                                    : role.name === 'provider-group-admin'
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-gray-100 text-gray-800'
                                }`}
                              >
                                {role.name}
                              </span>
                            ))}
                          </div>
                          <p className="text-sm text-gray-500">{userItem.email}</p>
                          <div className="mt-1 flex items-center text-sm text-gray-500">
                            <span className="mr-4">@{userItem.username}</span>
                            {userItem.userNpis.length > 0 && (
                              <>
                                <Icon name="cross-1" className="h-4 w-4 mr-1" />
                                <span>{userItem.userNpis.length} NPI{userItem.userNpis.length > 1 ? 's' : ''}</span>
                              </>
                            )}
                          </div>
                          
                          {/* Show NPIs if any */}
                          {userItem.userNpis.length > 0 && (
                            <div className="mt-2">
                              <div className="flex flex-wrap gap-1">
                                {userItem.userNpis.slice(0, 3).map((userNpi, index) => (
                                  <span 
                                    key={index}
                                    className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
                                  >
                                    {userNpi.provider.npi}
                                  </span>
                                ))}
                                {userItem.userNpis.length > 3 && (
                                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                                    +{userItem.userNpis.length - 3} more
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-4">
                        <div className="text-right">
                          <p className="text-sm text-gray-500">
                            Joined {new Date(userItem.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        
                        {/* Action buttons */}
                        <div className="flex space-x-2">
                          <Link
                            to={`/admin/users/${userItem.id}`}
                            className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded text-white bg-blue-600 hover:bg-blue-700"
                          >
                            View
                          </Link>
                          <Link
                            to={`/admin/users/${userItem.id}/edit`}
                            className="inline-flex items-center px-3 py-1 border border-gray-300 text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                          >
                            Edit
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </InterexLayout>
  )
}

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

  // Get provider groups for this specific customer
  const providerGroups = await prisma.providerGroup.findMany({
    where: { customerId },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      _count: {
        select: {
          providers: true,
          users: true,
        }
      },
      providers: {
        select: {
          id: true,
          npi: true,
          name: true,
        },
        take: 5 // Show first 5 providers as preview
      }
    },
    orderBy: { name: 'asc' }
  })

  return data({ 
    user,
    customer,
    providerGroups
  })
}

export default function CustomerProviderGroupsManagementPage() {
  const { user, customer, providerGroups } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title={`${customer.name} - Provider Groups`}
      subtitle={`Managing ${providerGroups.length} provider groups`}
      currentPath={`/admin/customer-manage/${customer.id}/provider-groups`}
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
        
        {/* Summary Stats */}
        <div className="bg-white overflow-hidden shadow rounded-lg mb-6">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Provider Groups</h2>
                <p className="text-sm text-gray-500 mt-1">Provider groups for {customer.name}</p>
              </div>
              
              <div className="flex space-x-6">
                <div className="text-center">
                  <div className="text-2xl font-bold text-indigo-600">{providerGroups.length}</div>
                  <div className="text-sm text-gray-500">Total Groups</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">{providerGroups.reduce((acc, g) => acc + g._count.providers, 0)}</div>
                  <div className="text-sm text-gray-500">Total Providers</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{providerGroups.reduce((acc, g) => acc + g._count.users, 0)}</div>
                  <div className="text-sm text-gray-500">User Assignments</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Provider Groups Grid */}
        {providerGroups.length === 0 ? (
          <div className="bg-white shadow sm:rounded-lg">
            <div className="text-center py-12">
              <Icon name="dots-horizontal" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No provider groups found</h3>
              <p className="mt-1 text-sm text-gray-500">
                This customer doesn't have any provider groups yet.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {providerGroups.map((group) => (
              <div key={group.id} className="bg-white overflow-hidden shadow rounded-lg hover:shadow-lg transition-shadow">
                <div className="p-6">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <div className="p-3 bg-indigo-100 rounded-lg">
                        <Icon name="dots-horizontal" className="h-6 w-6 text-indigo-600" />
                      </div>
                    </div>
                    <div className="ml-4 flex-1">
                      <h3 className="text-lg font-medium text-gray-900">{group.name}</h3>
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                        {group.description || 'No description'}
                      </p>
                    </div>
                  </div>
                  
                  {/* Stats */}
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <div className="text-center">
                      <div className="text-lg font-bold text-purple-600">{group._count.providers}</div>
                      <div className="text-xs text-gray-500">Providers</div>
                    </div>
                    <div className="text-center">
                      <div className="text-lg font-bold text-green-600">{group._count.users}</div>
                      <div className="text-xs text-gray-500">Users</div>
                    </div>
                  </div>
                  
                  {/* Provider Preview */}
                  {group.providers.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs text-gray-500 font-medium mb-2">Providers:</p>
                      <div className="space-y-1">
                        {group.providers.slice(0, 3).map((provider) => (
                          <div key={provider.id} className="text-xs text-gray-600 truncate">
                            {provider.npi} - {provider.name}
                          </div>
                        ))}
                        {group.providers.length > 3 && (
                          <div className="text-xs text-gray-500">
                            +{group.providers.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Actions */}
                  <div className="mt-6 flex space-x-2">
                    <Link
                      to={`/admin/provider-groups/${group.id}`}
                      className="flex-1 text-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
                    >
                      View Details
                    </Link>
                    <Link
                      to={`/admin/provider-groups/${group.id}/edit`}
                      className="flex-1 text-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Edit
                    </Link>
                  </div>
                  
                  {/* Meta info */}
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-xs text-gray-400">
                      Created: {new Date(group.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </InterexLayout>
  )
}

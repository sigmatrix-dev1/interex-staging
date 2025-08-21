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

  // Get providers for this specific customer
  const providers = await prisma.provider.findMany({
    where: { customerId },
    select: {
      id: true,
      npi: true,
      name: true,
      createdAt: true,
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
    providers
  })
}

export default function CustomerProvidersManagementPage() {
  const { user, customer, providers } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title={`${customer.name} - Providers & NPIs`}
      subtitle={`Managing ${providers.length} providers`}
      currentPath={`/admin/customer-manage/${customer.id}/providers`}
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
                <h2 className="text-xl font-bold text-gray-900">Providers & NPIs</h2>
                <p className="text-sm text-gray-500 mt-1">Healthcare providers for {customer.name}</p>
              </div>
              
              <div className="flex space-x-6">
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">{providers.length}</div>
                  <div className="text-sm text-gray-500">Total Providers</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{providers.reduce((acc, p) => acc + p.userNpis.length, 0)}</div>
                  <div className="text-sm text-gray-500">User Assignments</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-indigo-600">{new Set(providers.map(p => p.providerGroup?.id).filter(Boolean)).size}</div>
                  <div className="text-sm text-gray-500">Provider Groups</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Providers Table */}
        <div className="bg-white shadow overflow-hidden sm:rounded-md">
          <div className="px-4 py-5 sm:px-6 border-b border-gray-200">
            <h3 className="text-lg leading-6 font-medium text-gray-900">Providers List</h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              All healthcare providers and NPIs for {customer.name}
            </p>
          </div>
          
          {providers.length === 0 ? (
            <div className="text-center py-12">
              <Icon name="cross-1" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No providers found</h3>
              <p className="mt-1 text-sm text-gray-500">
                This customer doesn't have any providers yet.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {providers.map((provider) => (
                <li key={provider.id} className="px-4 py-4 sm:px-6 hover:bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <div className="h-10 w-10 bg-purple-100 rounded-full flex items-center justify-center">
                          <Icon name="cross-1" className="h-6 w-6 text-purple-600" />
                        </div>
                      </div>
                      <div className="ml-4">
                        <div className="flex items-center">
                          <p className="text-sm font-medium text-gray-900">{provider.name}</p>
                          <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                            NPI: {provider.npi}
                          </span>
                        </div>
                        {provider.providerGroup && (
                          <p className="text-sm text-gray-500">
                            Group: {provider.providerGroup.name}
                          </p>
                        )}
                        <p className="text-xs text-gray-400">
                          Created: {new Date(provider.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    
                    <div className="flex items-center space-x-4">
                      <div className="text-right">
                        <p className="text-sm text-gray-900">
                          {provider.userNpis.length} user assignment{provider.userNpis.length !== 1 ? 's' : ''}
                        </p>
                        {provider.userNpis.length > 0 && (
                          <p className="text-xs text-gray-500">
                            Last: {provider.userNpis[provider.userNpis.length - 1]?.user.name}
                          </p>
                        )}
                      </div>
                      
                      <div className="flex space-x-2">
                        <Link
                          to={`/admin/providers/${provider.id}`}
                          className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded text-white bg-purple-600 hover:bg-purple-700"
                        >
                          View
                        </Link>
                        <Link
                          to={`/admin/providers/${provider.id}/edit`}
                          className="inline-flex items-center px-3 py-1 border border-gray-300 text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                        >
                          Edit
                        </Link>
                      </div>
                    </div>
                  </div>
                  
                  {provider.userNpis.length > 0 && (
                    <div className="mt-3 ml-14">
                      <p className="text-xs text-gray-500 font-medium">Assigned to users:</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {provider.userNpis.map((userNpi, index) => (
                          <span 
                            key={index}
                            className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                          >
                            {userNpi.user.name} ({userNpi.user.email})
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Group by Provider Groups */}
        {providers.length > 0 && (
          <div className="mt-8 bg-gray-50 overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">Providers by Group</h3>
              
              {/* Providers with groups */}
              {Object.entries(
                providers
                  .filter(p => p.providerGroup)
                  .reduce((acc, provider) => {
                    const groupName = provider.providerGroup!.name
                    if (!acc[groupName]) acc[groupName] = []
                    acc[groupName].push(provider)
                    return acc
                  }, {} as Record<string, typeof providers>)
              ).map(([groupName, groupProviders]) => (
                <div key={groupName} className="mb-4">
                  <h4 className="text-sm font-medium text-gray-900 mb-2">{groupName}</h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {groupProviders.map((provider) => (
                      <div key={provider.id} className="bg-white p-3 rounded border text-sm">
                        <div className="font-medium text-gray-900">{provider.name}</div>
                        <div className="text-xs text-gray-500">NPI: {provider.npi}</div>
                        <div className="text-xs text-purple-600">{provider.userNpis.length} assignments</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              
              {/* Providers without groups */}
              {providers.filter(p => !p.providerGroup).length > 0 && (
                <div className="mb-4">
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Unassigned Providers</h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {providers.filter(p => !p.providerGroup).map((provider) => (
                      <div key={provider.id} className="bg-white p-3 rounded border text-sm">
                        <div className="font-medium text-gray-900">{provider.name}</div>
                        <div className="text-xs text-gray-500">NPI: {provider.npi}</div>
                        <div className="text-xs text-purple-600">{provider.userNpis.length} assignments</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </InterexLayout>
  )
}

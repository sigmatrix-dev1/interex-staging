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
      username: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require customer admin role
  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const providerGroupId = params.providerGroupId
  if (!providerGroupId) {
    throw new Response('Provider group ID is required', { status: 400 })
  }

  // Get provider group data
  const providerGroup = await prisma.providerGroup.findFirst({
    where: {
      id: providerGroupId,
      customerId: user.customerId,
    },
    include: {
      customer: { select: { name: true } },
      users: {
        include: {
          roles: { select: { name: true } }
        },
        orderBy: { name: 'asc' }
      },
      providers: {
        orderBy: { name: 'asc' }
      },
      _count: {
        select: { users: true, providers: true }
      }
    }
  })

  if (!providerGroup) {
    throw new Response('Provider group not found', { status: 404 })
  }

  return data({ user, providerGroup })
}

export default function ViewProviderGroupPage() {
  const { user, providerGroup } = useLoaderData<typeof loader>()

  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <Link to="/customer/provider-groups" className="text-gray-500 hover:text-gray-700 mr-4">
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{providerGroup.name}</h1>
                {providerGroup.description && (
                  <p className="text-sm text-gray-500 mt-1">{providerGroup.description}</p>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <Link
                to={`/customer/provider-groups/${providerGroup.id}/edit`}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <Icon name="pencil-1" className="-ml-1 mr-2 h-4 w-4" />
                Edit
              </Link>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                providerGroup.active 
                  ? 'bg-green-100 text-green-800' 
                  : 'bg-gray-100 text-gray-800'
              }`}>
                {providerGroup.active ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="space-y-6">
          {/* Statistics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white shadow rounded-lg p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="avatar" className="h-8 w-8 text-blue-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Assigned Users</dt>
                    <dd className="text-lg font-medium text-gray-900">{providerGroup._count.users}</dd>
                  </dl>
                </div>
              </div>
            </div>
            
            <div className="bg-white shadow rounded-lg p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="id-card" className="h-8 w-8 text-green-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">NPIs/Providers</dt>
                    <dd className="text-lg font-medium text-gray-900">{providerGroup._count.providers}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          {/* Assigned Users */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">Assigned Users ({providerGroup.users.length})</h2>
            </div>
            <div className="p-6">
              {providerGroup.users.length === 0 ? (
                <p className="text-gray-500 text-sm">No users assigned to this provider group.</p>
              ) : (
                <div className="space-y-3">
                  {providerGroup.users.map((user) => (
                    <div key={user.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">{user.name}</p>
                        <p className="text-sm text-gray-500">{user.email}</p>
                        <p className="text-xs text-gray-400">@{user.username}</p>
                      </div>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {user.roles[0]?.name.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Assigned Providers */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">NPIs/Providers ({providerGroup.providers.length})</h2>
            </div>
            <div className="p-6">
              {providerGroup.providers.length === 0 ? (
                <p className="text-gray-500 text-sm">No providers assigned to this provider group.</p>
              ) : (
                <div className="space-y-3">
                  {providerGroup.providers.map((provider) => (
                    <div key={provider.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">{provider.name}</p>
                        <p className="text-sm text-gray-500">NPI: {provider.npi}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-xs text-gray-500">
                          Created {new Date(provider.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Provider Group Details */}
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Provider Group Details</h2>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">Name</dt>
                <dd className="mt-1 text-sm text-gray-900">{providerGroup.name}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Status</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    providerGroup.active 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    {providerGroup.active ? 'Active' : 'Inactive'}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Description</dt>
                <dd className="mt-1 text-sm text-gray-900">{providerGroup.description || 'No description provided'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Customer</dt>
                <dd className="mt-1 text-sm text-gray-900">{providerGroup.customer.name}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Created</dt>
                <dd className="mt-1 text-sm text-gray-900">{new Date(providerGroup.createdAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Last Updated</dt>
                <dd className="mt-1 text-sm text-gray-900">{new Date(providerGroup.updatedAt).toLocaleDateString()}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

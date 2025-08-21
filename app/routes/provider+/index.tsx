import { data, useLoaderData } from 'react-router'
import { type LoaderFunctionArgs } from 'react-router'
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
      roles: { select: { name: true } },
      providerGroup: {
        select: {
          id: true,
          name: true,
          description: true,
          customer: {
            select: {
              name: true,
            }
          },
          providers: {
            select: {
              id: true,
              npi: true,
              name: true,
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
            }
          },
          users: {
            select: {
              id: true,
              name: true,
              email: true,
              roles: { select: { name: true } }
            }
          }
        }
      }
    }
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require provider group admin role
  requireRoles(user, [INTEREX_ROLES.PROVIDER_GROUP_ADMIN])

  return data({ user })
}

export default function ProviderIndex() {
  const { user } = useLoaderData<typeof loader>()
  
  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-gray-900">Provider Group Management</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">Welcome, {user.name}</span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Provider Group Admin
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* Provider Group Overview */}
        <div className="bg-white overflow-hidden shadow rounded-lg mb-6">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-2">
              {user.providerGroup?.name}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {user.providerGroup?.customer?.name} • {user.providerGroup?.description}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="text-2xl font-bold text-blue-600">
                  {user.providerGroup?.providers?.length || 0}
                </div>
                <div className="text-sm text-gray-600">NPIs Managed</div>
              </div>
              <div className="bg-green-50 p-4 rounded-lg">
                <div className="text-2xl font-bold text-green-600">
                  {user.providerGroup?.users?.length || 0}
                </div>
                <div className="text-sm text-gray-600">Group Users</div>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="text-2xl font-bold text-purple-600">
                  {user.providerGroup?.providers?.reduce((acc, p) => acc + p.userNpis.length, 0) || 0}
                </div>
                <div className="text-sm text-gray-600">Active Assignments</div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* NPIs/Providers */}
          <div className="bg-white shadow overflow-hidden sm:rounded-md">
            <div className="px-4 py-5 sm:px-6 flex justify-between items-center">
              <div>
                <h3 className="text-lg leading-6 font-medium text-gray-900">NPIs</h3>
                <p className="mt-1 text-sm text-gray-500">
                  National Provider Identifiers in your group.
                </p>
              </div>
              <a 
                href="/customer/provider-npis" 
                className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
              >
                <Icon name="id-card" className="-ml-0.5 mr-1 h-4 w-4" />
                Manage NPIs
              </a>
            </div>
            <ul className="divide-y divide-gray-200 max-h-64 overflow-y-auto">
              {user.providerGroup?.providers?.map((provider) => (
                <li key={provider.id}>
                  <div className="px-4 py-3 hover:bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          NPI: {provider.npi}
                        </div>
                        <div className="text-sm text-gray-500">{provider.name}</div>
                      </div>
                      <div className="text-xs text-gray-400">
                        {provider.userNpis.length} assignments
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Users */}
          <div className="bg-white shadow overflow-hidden sm:rounded-md">
            <div className="px-4 py-5 sm:px-6 flex justify-between items-center">
              <div>
                <h3 className="text-lg leading-6 font-medium text-gray-900">Users</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Users assigned to your provider group.
                </p>
              </div>
              <a 
                href="/customer/users" 
                className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-green-700 bg-green-100 hover:bg-green-200"
              >
                <Icon name="avatar" className="-ml-0.5 mr-1 h-4 w-4" />
                Manage Users
              </a>
            </div>
            <ul className="divide-y divide-gray-200 max-h-64 overflow-y-auto">
              {user.providerGroup?.users?.map((groupUser) => (
                <li key={groupUser.id}>
                  <div className="px-4 py-3 hover:bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {groupUser.name}
                        </div>
                        <div className="text-sm text-gray-500">{groupUser.email}</div>
                      </div>
                      <div className="flex items-center space-x-2">
                        {groupUser.roles.map((role) => (
                          <span
                            key={role.name}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
                          >
                            {role.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}
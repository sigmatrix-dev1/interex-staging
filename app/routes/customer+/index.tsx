import { data, useLoaderData } from 'react-router'
import { type LoaderFunctionArgs } from 'react-router'
import { Link } from 'react-router'
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
      customer: {
        select: {
          id: true,
          name: true,
          description: true,
          baaNumber: true,
          baaDate: true,
          providerGroups: {
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
            }
          },
          providers: {
            select: {
              id: true,
              npi: true,
              name: true,
            }
          }
        }
      }
    }
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require customer admin role
  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  return data({ user })
}

export default function CustomerIndex() {
  const { user } = useLoaderData<typeof loader>()
  
  return (
    <InterexLayout 
      user={user}
      title="Customer Administration"
      subtitle={`Welcome, ${user.name}`}
      currentPath="/customer"
      actions={
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          Customer Admin
        </span>
      }
    >

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* Customer Overview */}
        <div className="bg-white overflow-hidden shadow rounded-lg mb-6">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              {user.customer?.name}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="text-2xl font-bold text-blue-600">
                  {user.customer?.providerGroups?.length || 0}
                </div>
                <div className="text-sm text-gray-600">Provider Groups</div>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="text-2xl font-bold text-purple-600">
                  {user.customer?.providers?.length || 0}
                </div>
                <div className="text-sm text-gray-600">Provider NPIs</div>
              </div>
              <div className="bg-green-50 p-4 rounded-lg">
                <div className="text-2xl font-bold text-green-600">
                  {user.customer?.providerGroups?.reduce((acc, pg) => acc + pg._count.users, 0) || 0}
                </div>
                <div className="text-sm text-gray-600">Total Users</div>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="dots-horizontal" className="h-8 w-8 text-blue-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Provider Groups</dt>
                    <dd className="text-lg font-medium text-gray-900">Organize providers</dd>
                  </dl>
                </div>
              </div>
              <div className="mt-4">
                <Link
                  to="/customer/provider-groups"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  <Icon name="dots-horizontal" className="-ml-1 mr-2 h-4 w-4" />
                  Manage Groups
                </Link>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="id-card" className="h-8 w-8 text-purple-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Provider NPIs</dt>
                    <dd className="text-lg font-medium text-gray-900">Manage NPIs</dd>
                  </dl>
                </div>
              </div>
              <div className="mt-4">
                <Link
                  to="/customer/provider-npis"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700"
                >
                  <Icon name="id-card" className="-ml-1 mr-2 h-4 w-4" />
                  Manage NPIs
                </Link>
              </div>
            </div>
          </div>
          
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="avatar" className="h-8 w-8 text-green-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">User Management</dt>
                    <dd className="text-lg font-medium text-gray-900">Manage team access</dd>
                  </dl>
                </div>
              </div>
              <div className="mt-4">
                <Link
                  to="/customer/users"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
                >
                  <Icon name="avatar" className="-ml-1 mr-2 h-4 w-4" />
                  Manage Users
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}
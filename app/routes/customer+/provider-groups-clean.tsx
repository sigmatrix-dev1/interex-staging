import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { data, useLoaderData, Form, Link } from 'react-router'
import { z } from 'zod'
import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'

const DeleteProviderGroupSchema = z.object({
  intent: z.literal('delete'),
  providerGroupId: z.string().min(1, 'Provider group ID is required'),
})

const SearchSchema = z.object({
  search: z.string().optional(),
})

export async function loader({ request }: LoaderFunctionArgs) {
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

  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  // Parse search parameters
  const url = new URL(request.url)
  const searchParams = {
    search: url.searchParams.get('search') || '',
  }

  // Build search conditions for provider groups
  const whereConditions: any = {
    customerId: user.customerId,
  }

  if (searchParams.search) {
    whereConditions.OR = [
      { name: { contains: searchParams.search, mode: 'insensitive' } },
      { description: { contains: searchParams.search, mode: 'insensitive' } },
    ]
  }

  // Get customer data with filtered provider groups and their related counts
  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
    include: {
      providerGroups: {
        where: whereConditions.OR ? { OR: whereConditions.OR } : {},
        include: {
          _count: {
            select: { users: true, providers: true }
          }
        },
        orderBy: { name: 'asc' }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  return data({ user, customer, searchParams })
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: DeleteProviderGroupSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { providerGroupId } = submission.value

  // Verify the provider group belongs to the customer
  const providerGroup = await prisma.providerGroup.findFirst({
    where: {
      id: providerGroupId,
      customerId: user.customerId,
    },
    include: {
      _count: {
        select: { users: true, providers: true }
      }
    }
  })

  if (!providerGroup) {
    return data(
      { error: 'Provider group not found or not authorized to delete this provider group' },
      { status: 404 }
    )
  }

  // Prevent deleting provider groups with users or providers
  if (providerGroup._count.users > 0) {
    return data(
      { error: `Cannot delete provider group with ${providerGroup._count.users} assigned users. Please reassign or remove users first.` },
      { status: 403 }
    )
  }

  if (providerGroup._count.providers > 0) {
    return data(
      { error: `Cannot delete provider group with ${providerGroup._count.providers} providers. Please remove providers first.` },
      { status: 403 }
    )
  }

  // Delete the provider group
  await prisma.providerGroup.delete({
    where: { id: providerGroupId }
  })

  return data({ success: true, message: 'Provider group deleted successfully' })
}

export default function CustomerProviderGroupsPage() {
  const { user, customer, searchParams } = useLoaderData<typeof loader>()

  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-4">
              <Link to="/customer" className="text-gray-400 hover:text-gray-600">
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Provider Group Management</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">Customer: {customer.name}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">
          {/* Search */}
          <div className="bg-white shadow rounded-lg p-6">
            <Form method="get" className="flex items-center space-x-4">
              <div className="flex-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Icon name="magnifying-glass" className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  name="search"
                  placeholder="Search provider groups..."
                  defaultValue={searchParams.search}
                  className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <button
                type="submit"
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                Search
              </button>
              {searchParams.search && (
                <Link
                  to="/customer/provider-groups"
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Clear
                </Link>
              )}
            </Form>
          </div>

          {/* Provider Groups List */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-lg font-medium text-gray-900">Provider Groups</h2>
                  <p className="text-sm text-gray-500">{customer.providerGroups.length} total groups</p>
                </div>
                <div className="flex space-x-3">
                  <Link
                    to="new"
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <Icon name="plus" className="h-4 w-4 mr-2" />
                    Add Provider Group
                  </Link>
                </div>
              </div>
            </div>
            
            {customer.providerGroups.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No provider groups found</h3>
                <p className="text-gray-500 mb-6">
                  {searchParams.search 
                    ? `No provider groups match your search criteria "${searchParams.search}".`
                    : 'Get started by creating your first provider group.'
                  }
                </p>
                <Link
                  to="new"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  Add Provider Group
                </Link>
              </div>
            ) : (
              <div className="overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Name
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Description
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Users
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Providers
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {customer.providerGroups.map((providerGroup) => (
                      <tr key={providerGroup.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">{providerGroup.name}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-sm text-gray-900">
                            {providerGroup.description || 'No description'}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {providerGroup._count.users}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {providerGroup._count.providers}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <div className="flex items-center space-x-2">
                            <Link
                              to={`${providerGroup.id}/edit`}
                              className="text-blue-600 hover:text-blue-800"
                            >
                              Edit
                            </Link>

                            {/* Only show delete button if no users or providers */}
                            {providerGroup._count.users === 0 && providerGroup._count.providers === 0 && (
                              <Form method="post" className="inline">
                                <input type="hidden" name="intent" value="delete" />
                                <input type="hidden" name="providerGroupId" value={providerGroup.id} />
                                <button
                                  type="submit"
                                  className="text-red-600 hover:text-red-800"
                                  onClick={(e) => {
                                    if (!confirm(`Are you sure you want to delete "${providerGroup.name}"? This action cannot be undone.`)) {
                                      e.preventDefault()
                                    }
                                  }}
                                >
                                  Delete
                                </button>
                              </Form>
                            )}
                            
                            {/* Show warning if provider group cannot be deleted */}
                            {(providerGroup._count.users > 0 || providerGroup._count.providers > 0) && (
                              <span className="text-gray-400" title="Cannot delete: has assigned users or providers">
                                <Icon name="lock-closed" className="h-4 w-4" />
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Statistics */}
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Statistics</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-blue-50 rounded-lg p-4">
                <div className="flex items-center">
                  <Icon name="dots-horizontal" className="h-8 w-8 text-blue-600 mr-3" />
                  <div>
                    <p className="text-sm font-medium text-blue-900">Total Provider Groups</p>
                    <p className="text-2xl font-bold text-blue-600">{customer.providerGroups.length}</p>
                  </div>
                </div>
              </div>
              
              <div className="bg-green-50 rounded-lg p-4">
                <div className="flex items-center">
                  <Icon name="avatar" className="h-8 w-8 text-green-600 mr-3" />
                  <div>
                    <p className="text-sm font-medium text-green-900">Total Users</p>
                    <p className="text-2xl font-bold text-green-600">
                      {customer.providerGroups.reduce((sum, pg) => sum + pg._count.users, 0)}
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="bg-purple-50 rounded-lg p-4">
                <div className="flex items-center">
                  <Icon name="id-card" className="h-8 w-8 text-purple-600 mr-3" />
                  <div>
                    <p className="text-sm font-medium text-purple-900">Total Providers</p>
                    <p className="text-2xl font-bold text-purple-600">
                      {customer.providerGroups.reduce((sum, pg) => sum + pg._count.providers, 0)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

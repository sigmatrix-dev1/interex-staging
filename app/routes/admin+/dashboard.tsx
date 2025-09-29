// app/routes/admin+/dashboard.tsx

import { useEffect, useState } from 'react'
import { type LoaderFunctionArgs, type ActionFunctionArgs, data, useLoaderData, Link, Form, redirect, useNavigation  } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { audit } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'

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

  // Require admin role
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  // Get system statistics and customers
  const [totalUsers, totalCustomers, totalProviderGroups, totalProviders, customers] = await Promise.all([
    prisma.user.count(),
    prisma.customer.count(),
    prisma.providerGroup.count(),
    prisma.provider.count(),
    prisma.customer.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        baaNumber: true,
        createdAt: true,
        _count: {
          select: {
            users: true,
            providers: true,
            providerGroups: true,
            submissions: true,
            PrepayLetter: true,
            PostpayLetter: true,
            PostpayOtherLetter: true,
          }
        }
      }
    })
  ])

  return data({ 
    user, 
    stats: {
      totalUsers,
      totalCustomers,
      totalProviderGroups,
      totalProviders,
    },
    customers
  })
}

export async function action({ request }: ActionFunctionArgs) {
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

  // Only system admins may delete customers
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const formData = await request.formData()
  const intent = formData.get('intent')?.toString()
  if (intent !== 'delete-customer') {
    return data({ error: 'Invalid action' }, { status: 400 })
  }

  const customerId = formData.get('customerId')?.toString()
  if (!customerId) {
    return data({ error: 'Missing customerId' }, { status: 400 })
  }

  // Fetch customer and dependency counts (some counts not used after policy change but kept for modal context)
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      description: true,
      _count: {
        select: {
          users: true,
          providers: true,
          submissions: true,
          PrepayLetter: true,
          PostpayLetter: true,
          PostpayOtherLetter: true,
        },
      },
    },
  })

  if (!customer) {
    return redirect('/admin/dashboard')
  }

  const isTestCustomer = (customer.description || '').includes('Test-Customer')
  if (!isTestCustomer) {
    return await redirectWithToast('/admin/dashboard', {
      type: 'error',
      title: 'Delete not allowed',
      description: 'Only customers marked as "Test-Customer" in the description can be deleted.',
    })
  }

  // Force-clean dependent records for test customers, then delete
  try {
    await prisma.$transaction(async (tx) => {
      // Submissions (will cascade submission documents & events)
      await tx.submission.deleteMany({ where: { customerId } })

      // Provider events for this customer
      await tx.providerEvent.deleteMany({ where: { customerId } })

      // Letters for this customer
      await tx.prepayLetter.deleteMany({ where: { customerId } })
      await tx.postpayLetter.deleteMany({ where: { customerId } })
      await tx.postpayOtherLetter.deleteMany({ where: { customerId } })

      // Providers (will cascade userNpis, provider list/registration snapshots)
      await tx.provider.deleteMany({ where: { customerId } })

      // Provider groups
      await tx.providerGroup.deleteMany({ where: { customerId } })

      // Users that belong to this customer (will cascade password, sessions, notifications, etc.)
      await tx.user.deleteMany({ where: { customerId } })

      // Finally, the customer
      await tx.customer.delete({ where: { id: customer.id } })
    })
  } catch {
    return await redirectWithToast('/admin/dashboard', {
      type: 'error',
      title: 'Delete failed',
      description: 'Unexpected error while deleting customer and dependencies. Please try again.',
    })
  }

  // Audit
  await audit.admin({
    actorType: 'USER',
    actorId: user.id,
    actorDisplay: user.name || user.email || user.id,
    customerId: customer.id,
    action: 'CUSTOMER_DELETE',
    entityType: 'Customer',
    entityId: customer.id,
    summary: `Force-deleted Test-Customer: ${customer.name}`,
    metadata: { name: customer.name },
  })

  return await redirectWithToast('/admin/dashboard', {
    type: 'success',
    title: 'Customer force-deleted',
    description: `${customer.name} (Test-Customer) and all dependent data have been removed.`,
  })
}

export default function AdminDashboard() {
  const { user, stats, customers } = useLoaderData<typeof loader>()
  const navigation = useNavigation()
  const [submittedDelete, setSubmittedDelete] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const isDeleting = navigation.state === 'submitting' && navigation.formData?.get('intent') === 'delete-customer'

  useEffect(() => {
    if (!submittedDelete) return
    if (navigation.state === 'loading' || navigation.state === 'idle') {
      // Close modal after server responds/navigates
      setConfirmDelete(null)
      setConfirmText('')
      setSubmittedDelete(false)
    }
  }, [navigation.state, submittedDelete])

  return (
    <InterexLayout 
      user={user}
      title="System Administration"
      subtitle={`Welcome, ${user.name}`}
      currentPath="/admin/dashboard"
      actions={
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            System Admin
          </span>
          <Link
            to="/admin/reports"
            className="inline-flex items-center gap-2.5 px-5 py-3 rounded-full text-base font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-lg ring-1 ring-blue-500/20"
            title="Open Reports"
          >
            <Icon name="hero:chart" size="lg" className="-ml-0.5" />
            Reports
          </Link>
          <Link
            to="/admin/users"
            className="inline-flex items-center gap-2.5 px-5 py-3 rounded-full text-base font-semibold text-white bg-slate-700 hover:bg-slate-800 shadow-lg ring-1 ring-slate-500/20"
            title="Manage Users"
          >
            <Icon name="hero:users" size="lg" className="-ml-0.5" />
            Users
          </Link>
        </div>
      }
    >

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* System Statistics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="avatar" className="h-8 w-8 text-blue-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Users</dt>
                    <dd className="text-lg font-medium text-gray-900">{stats.totalUsers}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="file-text" className="h-8 w-8 text-green-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Customers</dt>
                    <dd className="text-lg font-medium text-gray-900">{stats.totalCustomers}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="dots-horizontal" className="h-8 w-8 text-purple-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Provider Groups</dt>
                    <dd className="text-lg font-medium text-gray-900">{stats.totalProviderGroups}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Icon name="id-card" className="h-8 w-8 text-orange-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">NPIs</dt>
                    <dd className="text-lg font-medium text-gray-900">{stats.totalProviders}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Customer Management */}
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg leading-6 font-medium text-gray-900">Customer Management</h3>
              <Link
                to="/admin/customers/new"
                className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                New Customer
              </Link>
            </div>
            
            {customers.length === 0 ? (
              <div className="text-center py-6">
                <Icon name="file-text" className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No customers</h3>
                <p className="mt-1 text-sm text-gray-500">Get started by creating a new customer.</p>
              </div>
            ) : (
              <div className="overflow-x-auto shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                <table className="min-w-[1280px] w-full divide-y divide-gray-300">
                  <thead className="bg-gray-50">
                    <tr>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Customer
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Users
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Providers
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Groups
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Submissions
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Prepay Letters
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Postpay Letters
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Other Letters
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Manage
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Add Admin
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Edit
                      </th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Delete
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {customers.map((customer) => (
                      <tr key={customer.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{customer.name}</span>
                              {(
                                ((customer.description || '').toLowerCase().includes('test-customer')) ||
                                ((customer.description || '').toLowerCase().includes('auto generated by test cases')) ||
                                customer.name.startsWith('C-')
                              ) && (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-800 border border-red-200"
                                  title="Test customer"
                                >
                                  Test-Customer
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-gray-500">{customer.description || 'No description'}</div>
                            {customer.baaNumber && (
                              <div className="text-xs text-gray-400">BAA: {customer.baaNumber}</div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="avatar" className="h-4 w-4 text-green-500 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.users}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="laptop" className="h-4 w-4 text-purple-500 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.providers}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="file-text" className="h-4 w-4 text-indigo-500 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.providerGroups}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="file-text" className="h-4 w-4 text-blue-500 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.submissions}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="file-text" className="h-4 w-4 text-emerald-500 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.PrepayLetter}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="file-text" className="h-4 w-4 text-amber-600 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.PostpayLetter}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <Icon name="file-text" className="h-4 w-4 text-rose-500 mr-1" />
                            <span className="text-sm text-gray-900">{customer._count.PostpayOtherLetter}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <Link
                            to={`/admin/customer-manage/${customer.id}`}
                            className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                            title="Open customer management dashboard"
                          >
                            <Icon name="laptop" className="-ml-1 mr-2 h-4 w-4" />
                            Manage
                          </Link>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <Link
                            to={`/admin/customers?action=add-admin&customerId=${customer.id}`}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 rounded-md shadow-sm"
                            title="Add a new System Admin for this customer"
                          >
                            <Icon name="hero:user-plus" className="-ml-1 mr-2 h-4 w-4" />
                            Add Admin
                          </Link>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <Link
                            to={`/admin/customers?action=edit&customerId=${customer.id}`}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 rounded-md shadow-sm"
                            title="Edit customer details"
                          >
                            <Icon name="pencil-2" className="-ml-1 mr-2 h-4 w-4" />
                            Edit
                          </Link>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          {(customer.description || '').includes('Test-Customer') ? (
                            <button
                              type="button"
                              className="inline-flex items-center px-3 py-2 border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 shadow-sm text-sm font-medium rounded-md"
                              onClick={() => {
                                setConfirmText('')
                                setConfirmDelete({ id: customer.id, name: customer.name })
                              }}
                              title="Delete Test-Customer (requires double confirmation)"
                            >
                              <Icon name="trash" className="-ml-1 mr-2 h-4 w-4" />
                              Delete
                            </button>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Delete Confirmation Modal */}
      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!isDeleting) setConfirmDelete(null) }} />
          <div role="dialog" aria-modal="true" aria-busy={isDeleting || undefined} className="relative z-10 w-full max-w-lg mx-4 rounded-lg bg-white shadow-xl ring-1 ring-black/10">
            <div className="px-6 pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 text-red-600">
                  <Icon name="warning-triangle" className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Delete customer</h3>
                  <p className="mt-1 text-sm text-gray-600">
                    You are about to permanently delete
                    <span className="font-semibold"> {confirmDelete.name}</span>.
                    This action cannot be undone and will remove all related data (letters, submissions, providers, groups) for this customer.
                  </p>
                  <p className="mt-3 text-sm text-gray-700">
                    Please type <span className="font-mono font-semibold">DELETE</span> to confirm.
                  </p>
                  <Form method="post" replace className="mt-3 space-y-3" onSubmit={() => setSubmittedDelete(true)}>
                    <input type="hidden" name="intent" value="delete-customer" />
                    <input type="hidden" name="customerId" value={confirmDelete.id} />
                    <input
                      type="text"
                      autoFocus
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="Type DELETE to confirm"
                      disabled={isDeleting}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:bg-gray-100 disabled:text-gray-400"
                    />
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        className={
                          (isDeleting
                            ? 'opacity-50 cursor-not-allowed'
                            : 'hover:bg-gray-50') +
                          ' inline-flex items-center rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700'
                        }
                        disabled={isDeleting}
                        onClick={() => { if (!isDeleting) setConfirmDelete(null) }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={confirmText.trim().toUpperCase() !== 'DELETE' || isDeleting}
                        className={
                          (confirmText.trim().toUpperCase() === 'DELETE' && !isDeleting
                            ? 'bg-red-600 hover:bg-red-700 text-white'
                            : 'bg-red-200 text-red-600 cursor-not-allowed') +
                          ' inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold shadow-sm'
                        }
                        title="Confirm deletion"
                      >
                        {isDeleting ? (
                          <svg className="-ml-0.5 mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                          </svg>
                        ) : (
                          <Icon name="trash" className="-ml-0.5 mr-2 h-4 w-4" />
                        )}
                        {isDeleting ? 'Deleting…' : 'Permanently delete'}
                      </button>
                    </div>
                  </Form>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </InterexLayout>
  )
}
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { data, useLoaderData, Form, Link, useSearchParams } from 'react-router'
import { z } from 'zod'
import { parseWithZod, getZodConstraint } from '@conform-to/zod'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { useState, useEffect } from 'react'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import { useToast } from '#app/components/toaster.tsx'

const CreateProviderSchema = z.object({
  intent: z.literal('create'),
  npi: z.string().regex(/^\d{10}$/, 'NPI must be exactly 10 digits'),
  name: z.string().min(1, 'Provider name is required').max(200, 'Provider name must be less than 200 characters'),
  providerGroupId: z.string().min(1, 'Provider group is required'),
})

const UpdateProviderSchema = z.object({
  intent: z.literal('update'),
  providerId: z.string().min(1, 'Provider ID is required'),
  name: z.string().min(1, 'Provider name is required').max(200, 'Provider name must be less than 200 characters'),
  providerGroupId: z.string().min(1, 'Provider group is required'),
  active: z
    .union([z.boolean(), z.string()])
    .transform(value => {
      if (typeof value === 'boolean') return value
      if (value === 'on' || value === 'true') return true
      return false
    })
    .optional(),
})

const DeleteProviderSchema = z.object({
  intent: z.literal('delete'),
  providerId: z.string().min(1, 'Provider ID is required'),
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
      providerGroupId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Allow both customer admin and provider group admin roles
  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN])

  if (!user.customerId) {
    throw new Response('User must be associated with a customer', { status: 400 })
  }

  const userRoles = user.roles.map(r => r.name)
  const isCustomerAdmin = userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
  const isProviderGroupAdmin = userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)

  // Provider group admins must have a provider group assigned
  if (isProviderGroupAdmin && !isCustomerAdmin && !user.providerGroupId) {
    throw new Response('Provider group admin must be assigned to a provider group', { status: 400 })
  }

  // Parse search parameters
  const url = new URL(request.url)
  const searchParams = {
    search: url.searchParams.get('search') || '',
    action: url.searchParams.get('action') || '',
    providerId: url.searchParams.get('providerId') || '',
  }

  // Build search conditions for providers based on role scope
  const whereConditions: any = {
    customerId: user.customerId,
  }

  // Provider group admins can only see providers in their provider group
  if (isProviderGroupAdmin && !isCustomerAdmin) {
    whereConditions.providerGroupId = user.providerGroupId
  }

  if (searchParams.search) {
    whereConditions.OR = [
      { npi: { contains: searchParams.search } },
      { name: { contains: searchParams.search } },
    ]
  }

  // Get customer data with filtered providers and their related counts
  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
    include: {
      providers: {
        where: whereConditions,
        include: {
          providerGroup: true,
          _count: {
            select: { userNpis: true }
          }
        },
        orderBy: { npi: 'asc' }
      },
      providerGroups: {
        // Provider group admins can only see their own group
        where: isProviderGroupAdmin && !isCustomerAdmin ? { id: user.providerGroupId! } : {},
        orderBy: { name: 'asc' }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // If editing, get the specific provider data
  let editingProvider = null
  if (searchParams.action === 'edit' && searchParams.providerId) {
    editingProvider = await prisma.provider.findFirst({
      where: {
        id: searchParams.providerId,
        customerId: user.customerId,
      },
      include: {
        providerGroup: true,
        _count: {
          select: { userNpis: true }
        }
      }
    })
  }

  const { toast, headers } = await getToast(request)

  return data(
    { user, customer, searchParams, editingProvider, toast },
    { headers: headers ?? undefined }
  )
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      providerGroupId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Allow both customer admin and provider group admin roles
  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN])

  if (!user.customerId) {
    throw new Response('User must be associated with a customer', { status: 400 })
  }

  const userRoles = user.roles.map(r => r.name)
  const isCustomerAdmin = userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
  const isProviderGroupAdmin = userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)

  // Provider group admins must have a provider group assigned
  if (isProviderGroupAdmin && !isCustomerAdmin && !user.providerGroupId) {
    throw new Response('Provider group admin must be assigned to a provider group', { status: 400 })
  }

  const formData = await request.formData()
  const intent = formData.get('intent')

  // Handle create provider
  if (intent === 'create') {
    const submission = parseWithZod(formData, { schema: CreateProviderSchema })

    if (submission.status !== 'success') {
      return data(
        { result: submission.reply() },
        { status: submission.status === 'error' ? 400 : 200 }
      )
    }

    const { npi, name, providerGroupId } = submission.value

    // Check if NPI already exists globally (NPIs must be unique across all customers)
    const existingProvider = await prisma.provider.findFirst({
      where: { npi }
    })

    if (existingProvider) {
      return data(
        { result: submission.reply({ fieldErrors: { npi: ['This NPI is already registered in the system'] } }) },
        { status: 400 }
      )
    }

    // Verify provider group belongs to customer
    const providerGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId: user.customerId,
      }
    })

    if (!providerGroup) {
      return data(
        { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
        { status: 400 }
      )
    }

    // Provider group admin scope validation
    if (isProviderGroupAdmin && !isCustomerAdmin) {
      // Can only create providers in their assigned provider group
      if (providerGroupId !== user.providerGroupId) {
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['You can only create providers in your assigned provider group'] } }) },
          { status: 400 }
        )
      }
    }

    // Create the provider
    await prisma.provider.create({
      data: {
        npi,
        name,
        customerId: user.customerId,
        providerGroupId,
        active: true,
      },
    })

    return redirectWithToast('/customer/provider-npis', {
      type: 'success',
      title: 'Provider NPI created',
      description: `NPI ${npi} (${name}) has been created successfully.`,
    })
  }

  // Handle update provider
  if (intent === 'update') {
    const submission = parseWithZod(formData, { schema: UpdateProviderSchema })

    if (submission.status !== 'success') {
      return data(
        { result: submission.reply() },
        { status: submission.status === 'error' ? 400 : 200 }
      )
    }

    const { providerId, name, providerGroupId, active } = submission.value

    // Verify the provider belongs to the customer
    const existingProvider = await prisma.provider.findFirst({
      where: {
        id: providerId,
        customerId: user.customerId,
      }
    })

    if (!existingProvider) {
      return redirectWithToast('/customer/provider-npis', {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized to edit this provider.',
      })
    }

    // Provider group admin scope validation
    if (isProviderGroupAdmin && !isCustomerAdmin) {
      // Can only edit providers in their assigned provider group
      if (existingProvider.providerGroupId !== user.providerGroupId) {
        return redirectWithToast('/customer/provider-npis', {
          type: 'error',
          title: 'Access denied',
          description: 'You can only edit providers in your assigned provider group.',
        })
      }
      
      // Can only assign providers to their own provider group
      if (providerGroupId !== user.providerGroupId) {
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['You can only assign providers to your provider group'] } }) },
          { status: 400 }
        )
      }
    }

    // Verify provider group belongs to customer
    const providerGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId: user.customerId,
      }
    })

    if (!providerGroup) {
      return data(
        { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
        { status: 400 }
      )
    }

    // Update the provider
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        name,
        providerGroupId,
        active: active ?? true,
      },
    })

    return redirectWithToast('/customer/provider-npis', {
      type: 'success',
      title: 'Provider NPI updated',
      description: `NPI ${existingProvider.npi} (${name}) has been updated successfully.`,
    })
  }

  // Handle delete provider
  if (intent === 'delete') {
    const submission = parseWithZod(formData, { schema: DeleteProviderSchema })

    if (submission.status !== 'success') {
      return data(
        { result: submission.reply() },
        { status: submission.status === 'error' ? 400 : 200 }
      )
    }

    const { providerId } = submission.value

    // Verify the provider belongs to the customer
    const provider = await prisma.provider.findFirst({
      where: {
        id: providerId,
        customerId: user.customerId,
      },
      include: {
        _count: {
          select: { userNpis: true }
        }
      }
    })

    if (!provider) {
      return redirectWithToast('/customer/provider-npis', {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized to delete this provider.',
      })
    }

    // Provider group admin scope validation
    if (isProviderGroupAdmin && !isCustomerAdmin) {
      // Can only delete providers in their assigned provider group
      if (provider.providerGroupId !== user.providerGroupId) {
        return redirectWithToast('/customer/provider-npis', {
          type: 'error',
          title: 'Access denied',
          description: 'You can only delete providers in your assigned provider group.',
        })
      }
    }

    // Prevent deleting providers with assigned users
    if (provider._count.userNpis > 0) {
      return redirectWithToast('/customer/provider-npis', {
        type: 'error',
        title: 'Cannot delete provider',
        description: `Cannot delete provider with ${provider._count.userNpis} assigned users. Please unassign users first.`,
      })
    }

    // Delete the provider
    const providerInfo = `${provider.npi} (${provider.name})`
    await prisma.provider.delete({
      where: { id: providerId }
    })

    return redirectWithToast('/customer/provider-npis', {
      type: 'success',
      title: 'Provider NPI deleted',
      description: `NPI ${providerInfo} has been deleted successfully.`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerProviderNpiPage() {
  const { user, customer, searchParams, editingProvider, toast } = useLoaderData<typeof loader>()
  const [urlSearchParams, setUrlSearchParams] = useSearchParams()
  const isPending = useIsPending()

  useToast(toast)

  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    providerId?: string
  }>({ isOpen: false, mode: 'create' })

  // Handle URL parameters for drawer state  
  useEffect(() => {
    const action = searchParams.action
    const providerId = searchParams.providerId
    
    if (action === 'create') {
      setDrawerState({ isOpen: true, mode: 'create' })
    } else if (action === 'edit' && providerId) {
      setDrawerState({ isOpen: true, mode: 'edit', providerId })
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'edit', providerId?: string) => {
    const newParams = new URLSearchParams(urlSearchParams)
    newParams.set('action', mode)
    if (providerId) newParams.set('providerId', providerId)
    setUrlSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(urlSearchParams)
    newParams.delete('action')
    newParams.delete('providerId')
    setUrlSearchParams(newParams)
  }

  const selectedProvider = drawerState.providerId 
    ? customer.providers.find(p => p.id === drawerState.providerId)
    : null

  const [createForm, createFields] = useForm({
    id: 'create-provider-form',
    constraint: getZodConstraint(CreateProviderSchema),
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateProviderSchema })
    },
  })

  const [editForm, editFields] = useForm({
    id: 'edit-provider-form',
    constraint: getZodConstraint(UpdateProviderSchema),
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateProviderSchema })
    },
  })

  return (
    <>
      {/* Main content area - blur when drawer is open */}
      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
        <InterexLayout 
          user={user}
          title="Provider NPI Management"
          subtitle={`Customer: ${customer.name}`}
          showBackButton={true}
          backTo="/customer"
          currentPath="/customer/provider-npis"
        >

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
                      placeholder="Search provider NPIs..."
                      defaultValue={searchParams.search}
                      className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md leading-5 bg-white text-gray-900 placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
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
                      to="/customer/provider-npis"
                      className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Clear
                    </Link>
                  )}
                </Form>
              </div>

              {/* Provider NPIs List */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900">Provider NPIs</h2>
                      <p className="text-sm text-gray-500">{customer.providers.length} total providers</p>
                    </div>
                    <div className="flex space-x-3">
                      <button
                        onClick={() => openDrawer('create')}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        Add Provider NPI
                      </button>
                    </div>
                  </div>
                </div>
                
              {/* Table or empty state */}
              {customer.providers.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <Icon name="id-card" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No provider NPIs found</h3>
                  <p className="text-gray-500 mb-6">
                    {searchParams.search 
                      ? `No providers match your search criteria "${searchParams.search}".`
                      : 'Get started by adding your first provider NPI.'
                    }
                  </p>
                  <button
                    onClick={() => openDrawer('create')}
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    <Icon name="plus" className="h-4 w-4 mr-2" />
                    Add Provider NPI
                  </button>
                </div>
              ) : (
                <div className="overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          NPI
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Provider Name
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Provider Group
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Assigned Users
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {customer.providers.map((provider) => (
                        <tr key={provider.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm font-medium text-gray-900">{provider.npi}</div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm text-gray-900">
                              {provider.name || 'No name'}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm text-gray-900">
                              {provider.providerGroup?.name || 'No group'}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {provider._count.userNpis}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              provider.active 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-gray-100 text-gray-800'
                            }`}>
                              {provider.active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                            <div className="flex items-center space-x-2">
                              <button
                                onClick={() => openDrawer('edit', provider.id)}
                                className="text-blue-600 hover:text-blue-800 p-1"
                                title="Edit provider"
                              >
                                <Icon name="pencil-1" className="h-4 w-4" />
                              </button>

                              {/* Only show delete button if no assigned users */}
                              {provider._count.userNpis === 0 && (
                                <Form method="post" className="inline">
                                  <input type="hidden" name="intent" value="delete" />
                                  <input type="hidden" name="providerId" value={provider.id} />
                                  <button
                                    type="submit"
                                    className="text-red-600 hover:text-red-800 p-1"
                                    title="Delete provider"
                                    onClick={(e) => {
                                      if (!confirm(`Are you sure you want to delete NPI "${provider.npi}" (${provider.name})? This action cannot be undone.`)) {
                                        e.preventDefault()
                                      }
                                    }}
                                  >
                                    <Icon name="trash" className="h-4 w-4" />
                                  </button>
                                </Form>
                              )}

                              {/* Show lock icon if has assigned users */}
                              {provider._count.userNpis > 0 && (
                                <span className="text-gray-400" title="Cannot delete - has assigned users">
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
                    <Icon name="id-card" className="h-8 w-8 text-blue-600 mr-3" />
                    <div>
                      <p className="text-sm font-medium text-blue-900">Total Provider NPIs</p>
                      <p className="text-2xl font-bold text-blue-600">{customer.providers.length}</p>
                    </div>
                  </div>
                </div>
                
                <div className="bg-green-50 rounded-lg p-4">
                  <div className="flex items-center">
                    <Icon name="check" className="h-8 w-8 text-green-600 mr-3" />
                    <div>
                      <p className="text-sm font-medium text-green-900">Active Providers</p>
                      <p className="text-2xl font-bold text-green-600">
                        {customer.providers.filter(p => p.active).length}
                      </p>
                    </div>
                  </div>
                </div>
                
                <div className="bg-purple-50 rounded-lg p-4">
                  <div className="flex items-center">
                    <Icon name="avatar" className="h-8 w-8 text-purple-600 mr-3" />
                    <div>
                      <p className="text-sm font-medium text-purple-900">Assigned Users</p>
                      <p className="text-2xl font-bold text-purple-600">
                        {customer.providers.reduce((sum, p) => sum + p._count.userNpis, 0)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        </InterexLayout>
      </div>

      {/* Create Provider Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'create'}
        onClose={closeDrawer}
        title="Add Provider NPI"
        size="md"
      >
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <Field
              labelProps={{ children: 'National Provider Identifier (NPI) *' }}
              inputProps={{
                ...getInputProps(createFields.npi, { type: 'text' }),
                placeholder: 'Enter 10-digit NPI number'
              }}
              errors={createFields.npi.errors}
            />

            <Field
              labelProps={{ children: 'Provider Name *' }}
              inputProps={{
                ...getInputProps(createFields.name, { type: 'text' }),
                placeholder: 'e.g., Dr. John Smith'
              }}
              errors={createFields.name.errors}
            />

            <SelectField
              labelProps={{ children: 'Provider Group *' }}
              selectProps={{
                ...getInputProps(createFields.providerGroupId, { type: 'text' }),
              }}
              errors={createFields.providerGroupId.errors}
            >
              <option value="" disabled>Choose provider group...</option>
              {customer.providerGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  🏥 {group.name}
                </option>
              ))}
            </SelectField>

            <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
              <button
                type="button"
                onClick={closeDrawer}
                className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <StatusButton
                type="submit"
                disabled={isPending}
                status={isPending ? 'pending' : 'idle'}
                className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Create Provider NPI
              </StatusButton>
            </div>
          </div>
        </Form>
      </Drawer>

      {/* Edit Provider Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'edit'}
        onClose={closeDrawer}
        title={`Edit NPI ${selectedProvider?.npi || 'Provider'}`}
        size="md"
      >
        {selectedProvider && (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="providerId" value={selectedProvider.id} />
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'National Provider Identifier (NPI) - Read Only' }}
                inputProps={{
                  type: 'text',
                  value: selectedProvider.npi,
                  disabled: true,
                  className: 'bg-gray-50 text-gray-500',
                }}
              />

              <Field
                labelProps={{ children: 'Provider Name *' }}
                inputProps={{
                  ...getInputProps(editFields.name, { type: 'text' }),
                  defaultValue: selectedProvider.name || '',
                  placeholder: 'e.g., Dr. John Smith'
                }}
                errors={editFields.name.errors}
              />

              <SelectField
                labelProps={{ children: 'Provider Group *' }}
                selectProps={{
                  ...getInputProps(editFields.providerGroupId, { type: 'text' }),
                  defaultValue: selectedProvider.providerGroupId || '',
                }}
                errors={editFields.providerGroupId.errors}
              >
                {customer.providerGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    🏥 {group.name}
                  </option>
                ))}
              </SelectField>

              <div>
                <label className="flex items-center">
                  <input
                    {...getInputProps(editFields.active, { type: 'checkbox' })}
                    defaultChecked={selectedProvider.active}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 block text-sm text-gray-900">Active</span>
                </label>
                <ErrorList errors={editFields.active.errors} />
              </div>

              <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </button>
                <StatusButton
                  type="submit"
                  disabled={isPending}
                  status={isPending ? 'pending' : 'idle'}
                  className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Save Changes
                </StatusButton>
              </div>

              {/* Show provider information when editing */}
              <div className="mt-8 pt-6 border-t border-gray-200">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Provider Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center">
                      <Icon name="avatar" className="h-6 w-6 text-blue-600 mr-2" />
                      <div>
                        <p className="text-xs font-medium text-gray-900">Assigned Users</p>
                        <p className="text-lg font-bold text-blue-600">{selectedProvider._count.userNpis}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center">
                      <Icon name="id-card" className="h-6 w-6 text-green-600 mr-2" />
                      <div>
                        <p className="text-xs font-medium text-gray-900">NPI Status</p>
                        <p className={`text-lg font-bold ${selectedProvider.active ? 'text-green-600' : 'text-red-600'}`}>
                          {selectedProvider.active ? 'Active' : 'Inactive'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Form>
        )}
      </Drawer>
    </>
  )
}
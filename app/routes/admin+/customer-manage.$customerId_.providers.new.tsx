import { data, useLoaderData, Form, useSearchParams, useActionData } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Link } from 'react-router'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { useState, useEffect } from 'react'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import { useToast } from '#app/components/toaster.tsx'

const CreateProviderSchema = z.object({
  intent: z.literal('create'),
  npi: z.string().min(10, 'NPI must be at least 10 digits').max(10, 'NPI must be exactly 10 digits'),
  name: z.string().min(1, 'Name is required'),
  providerGroupId: z.string().optional(),
})

const UpdateProviderSchema = z.object({
  intent: z.literal('update'),
  providerId: z.string().min(1, 'Provider ID is required'),
  name: z.string().min(1, 'Name is required'),
  providerGroupId: z.string().optional(),
})

const DeleteProviderSchema = z.object({
  intent: z.literal('delete'),
  providerId: z.string().min(1, 'Provider ID is required'),
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateProviderSchema,
  UpdateProviderSchema,
  DeleteProviderSchema,
])

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

  // Parse search parameters
  const url = new URL(request.url)
  const searchTerm = url.searchParams.get('search') || ''

  // Get customer information
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      description: true,
      providerGroups: {
        select: {
          id: true,
          name: true,
          _count: {
            select: { providers: true, users: true }
          }
        },
        orderBy: { name: 'asc' }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // Build search conditions for providers
  const providerWhereConditions: any = {
    customerId
  }

  if (searchTerm) {
    providerWhereConditions.OR = [
      { npi: { contains: searchTerm } },
      { name: { contains: searchTerm } },
    ]
  }

  // Get providers for this specific customer
  const providers = await prisma.provider.findMany({
    where: providerWhereConditions,
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
    orderBy: [{ providerGroupId: 'asc' }, { npi: 'asc' }]
  })

  const { toast, headers } = await getToast(request)

  return data({ 
    user,
    customer,
    providers,
    searchTerm,
    toast
  }, { headers: headers ?? undefined })
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const customerId = params.customerId
  if (!customerId) {
    throw new Response('Customer ID is required', { status: 400 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: ActionSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const action = submission.value

  // Handle create action
  if (action.intent === 'create') {
    const { npi, name, providerGroupId } = action

    // Check if NPI already exists
    const existingProvider = await prisma.provider.findFirst({
      where: { npi }
    })

    if (existingProvider) {
      return data(
        { result: submission.reply({ fieldErrors: { npi: ['A provider with this NPI already exists'] } }) },
        { status: 400 }
      )
    }

    // Validate provider group if provided
    if (providerGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({
        where: {
          id: providerGroupId,
          customerId,
        }
      })

      if (!providerGroup) {
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
          { status: 400 }
        )
      }
    }

    // Create the provider
    await prisma.provider.create({
      data: {
        npi,
        name,
        customerId,
        providerGroupId: providerGroupId || undefined,
      }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/providers`, {
      type: 'success',
      title: 'Provider created',
      description: `${name} (NPI: ${npi}) has been created successfully.`,
    })
  }

  // Handle update action
  if (action.intent === 'update') {
    const { providerId, name, providerGroupId } = action

    // Verify the provider exists and belongs to this customer
    const existingProvider = await prisma.provider.findFirst({
      where: {
        id: providerId,
        customerId,
      }
    })

    if (!existingProvider) {
      return data(
        { error: 'Provider not found' },
        { status: 404 }
      )
    }

    // Validate provider group if provided
    if (providerGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({
        where: {
          id: providerGroupId,
          customerId,
        }
      })

      if (!providerGroup) {
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
          { status: 400 }
        )
      }
    }

    // Update the provider
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        name,
        providerGroupId: providerGroupId || undefined,
      }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/providers`, {
      type: 'success',
      title: 'Provider updated',
      description: `${name} has been updated successfully.`,
    })
  }

  // Handle delete action
  if (action.intent === 'delete') {
    const { providerId } = action

    // Verify the provider exists and belongs to this customer
    const existingProvider = await prisma.provider.findFirst({
      where: {
        id: providerId,
        customerId,
      },
      include: {
        userNpis: true
      }
    })

    if (!existingProvider) {
      return data(
        { error: 'Provider not found' },
        { status: 404 }
      )
    }

    // Check if provider has user assignments
    if (existingProvider.userNpis.length > 0) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/providers`, {
        type: 'error',
        title: 'Cannot delete provider',
        description: 'Provider has user assignments. Remove them first.',
      })
    }

    // Delete the provider
    const providerName = existingProvider.name
    const providerNpi = existingProvider.npi
    await prisma.provider.delete({
      where: { id: providerId }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/providers`, {
      type: 'success',
      title: 'Provider deleted',
      description: `${providerName} (NPI: ${providerNpi}) has been deleted successfully.`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerProvidersManagementPage() {
  const { user, customer, providers, toast, searchTerm } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  const isPending = useIsPending()
  
  useToast(toast)
  
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    providerId?: string
  }>({ isOpen: false, mode: 'create' })

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.get('action')
    const providerId = searchParams.get('providerId')
    
    if (action === 'add') {
      setDrawerState({ isOpen: true, mode: 'create' })
    } else if (action === 'edit' && providerId) {
      setDrawerState({ isOpen: true, mode: 'edit', providerId })
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'edit', providerId?: string) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('action', mode === 'create' ? 'add' : 'edit')
    if (providerId) newParams.set('providerId', providerId)
    setSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('action')
    newParams.delete('providerId')
    setSearchParams(newParams)
  }

  const selectedProvider = drawerState.providerId 
    ? providers.find(p => p.id === drawerState.providerId)
    : null

  const [createForm, createFields] = useForm({
    id: 'create-provider-form',
    constraint: getZodConstraint(CreateProviderSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateProviderSchema })
    },
  })

  const [editForm, editFields] = useForm({
    id: 'edit-provider-form',
    constraint: getZodConstraint(UpdateProviderSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateProviderSchema })
    },
    defaultValue: selectedProvider ? {
      name: selectedProvider.name,
      providerGroupId: selectedProvider.providerGroup?.id || '',
    } : undefined,
  })

  return (
    <>
      {/* Main content area - blur when drawer is open */}
      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
        <InterexLayout 
          user={user}
          title="Provider & NPI Management"
          subtitle={`Customer: ${customer.name}`}
          showBackButton={true}
          backTo={`/admin/customer-manage/${customer.id}`}
          currentPath={`/admin/customer-manage/${customer.id}/providers`}
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
                      placeholder="Search providers & NPIs..."
                      defaultValue={searchTerm}
                      className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md leading-5 bg-white text-gray-900 placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    Search
                  </button>
                  {searchTerm && (
                    <Link
                      to={`/admin/customer-manage/${customer.id}/providers`}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Clear
                    </Link>
                  )}
                </Form>
              </div>

              {/* Providers List */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900">Providers & NPIs</h2>
                      <p className="text-sm text-gray-500">{providers.length} total providers</p>
                    </div>
                    <div className="flex space-x-3">
                      <button
                        onClick={() => openDrawer('create')}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        Add Provider
                      </button>
                    </div>
                  </div>
                </div>
                
                {providers.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Icon name="cross-1" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No providers found</h3>
                    <p className="text-gray-500 mb-6">
                      {searchTerm 
                        ? `No providers match your search criteria "${searchTerm}".`
                        : 'Get started by creating your first provider.'
                      }
                    </p>
                    <button
                      onClick={() => openDrawer('create')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                    >
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      Add Provider
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
                            Name
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Provider Group
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            User Assignments
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {providers.map((provider) => (
                          <tr key={provider.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm font-mono font-medium text-gray-900">{provider.npi}</div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm font-medium text-gray-900">{provider.name}</div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">
                                {provider.providerGroup ? (
                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                                    {provider.providerGroup.name}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">Unassigned</span>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">
                                <span className="font-medium">{provider.userNpis.length}</span> user{provider.userNpis.length !== 1 ? 's' : ''}
                                {provider.userNpis.length > 0 && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    {provider.userNpis.slice(0, 2).map(un => un.user.name).join(', ')}
                                    {provider.userNpis.length > 2 && ` +${provider.userNpis.length - 2} more`}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-500">
                                {new Date(provider.createdAt).toLocaleDateString()}
                              </div>
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
                                
                                <Form method="post" className="inline">
                                  <input type="hidden" name="intent" value="delete" />
                                  <input type="hidden" name="providerId" value={provider.id} />
                                  <button
                                    type="submit"
                                    className="text-red-600 hover:text-red-800 p-1"
                                    title="Delete provider"
                                    onClick={(e) => {
                                      if (!confirm(`Are you sure you want to delete "${provider.name}" (NPI: ${provider.npi})? This action cannot be undone.`)) {
                                        e.preventDefault()
                                      }
                                    }}
                                  >
                                    <Icon name="trash" className="h-4 w-4" />
                                  </button>
                                </Form>
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
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-purple-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="cross-1" className="h-8 w-8 text-purple-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-purple-900">Total Providers</p>
                        <p className="text-2xl font-bold text-purple-600">{providers.length}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-indigo-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="dots-horizontal" className="h-8 w-8 text-indigo-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-indigo-900">Assigned to Groups</p>
                        <p className="text-2xl font-bold text-indigo-600">
                          {providers.filter(p => p.providerGroup).length}
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-green-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="avatar" className="h-8 w-8 text-green-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-green-900">User Assignments</p>
                        <p className="text-2xl font-bold text-green-600">
                          {providers.reduce((acc, p) => acc + p.userNpis.length, 0)}
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-yellow-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="clock" className="h-8 w-8 text-yellow-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-yellow-900">Unassigned</p>
                        <p className="text-2xl font-bold text-yellow-600">
                          {providers.filter(p => !p.providerGroup).length}
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
        title="Add New Provider"
        size="md"
      >
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <Field
              labelProps={{ children: 'NPI' }}
              inputProps={{
                ...getInputProps(createFields.npi, { type: 'text' }),
                placeholder: '1234567890',
                maxLength: 10,
              }}
              errors={createFields.npi.errors}
            />

            <Field
              labelProps={{ children: 'Provider Name' }}
              inputProps={{
                ...getInputProps(createFields.name, { type: 'text' }),
                placeholder: 'Dr. John Smith',
              }}
              errors={createFields.name.errors}
            />

            <SelectField
              labelProps={{ children: 'Provider Group (Optional)' }}
              selectProps={{
                ...getInputProps(createFields.providerGroupId, { type: 'text' }),
              }}
              errors={createFields.providerGroupId.errors}
            >
              <option value="">No provider group</option>
              {customer.providerGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group._count.providers} providers)
                </option>
              ))}
            </SelectField>

            <ErrorList id={createForm.errorId} errors={createForm.errors} />

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
                Create Provider
              </StatusButton>
            </div>
          </div>
        </Form>
      </Drawer>

      {/* Edit Provider Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'edit'}
        onClose={closeDrawer}
        title={`Edit ${selectedProvider?.name || 'Provider'}`}
        size="md"
      >
        {selectedProvider && (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="providerId" value={selectedProvider.id} />
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'NPI (Read-only)' }}
                inputProps={{
                  type: 'text',
                  value: selectedProvider.npi,
                  disabled: true,
                  className: 'bg-gray-50 text-gray-500 font-mono',
                }}
              />

              <Field
                labelProps={{ children: 'Provider Name' }}
                inputProps={{
                  ...getInputProps(editFields.name, { type: 'text' }),
                  defaultValue: selectedProvider.name || '',
                }}
                errors={editFields.name.errors}
              />

              <SelectField
                labelProps={{ children: 'Provider Group' }}
                selectProps={{
                  ...getInputProps(editFields.providerGroupId, { type: 'text' }),
                  defaultValue: selectedProvider.providerGroup?.id || '',
                }}
                errors={editFields.providerGroupId.errors}
              >
                <option value="">No provider group</option>
                {customer.providerGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group._count.providers} providers)
                  </option>
                ))}
              </SelectField>

              <ErrorList id={editForm.errorId} errors={editForm.errors} />

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
            </div>
          </Form>
        )}
      </Drawer>
    </>
  )
}

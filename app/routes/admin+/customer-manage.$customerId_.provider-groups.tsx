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
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { useState, useEffect } from 'react'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import { useToast } from '#app/components/toaster.tsx'

const CreateProviderGroupSchema = z.object({
  intent: z.literal('create'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
})

const UpdateProviderGroupSchema = z.object({
  intent: z.literal('update'),
  providerGroupId: z.string().min(1, 'Provider Group ID is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  active: z
    .union([z.boolean(), z.string()])
    .transform(value => {
      if (typeof value === 'boolean') return value
      if (value === 'on' || value === 'true') return true
      return false
    })
    .optional(),
})

const DeleteProviderGroupSchema = z.object({
  intent: z.literal('delete'),
  providerGroupId: z.string().min(1, 'Provider Group ID is required'),
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateProviderGroupSchema,
  UpdateProviderGroupSchema,
  DeleteProviderGroupSchema,
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
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // Build search conditions for provider groups
  const providerGroupWhereConditions: any = {
    customerId
  }

  if (searchTerm) {
    providerGroupWhereConditions.OR = [
      { name: { contains: searchTerm } },
      { description: { contains: searchTerm } },
    ]
  }

  // Get provider groups for this specific customer
  const providerGroups = await prisma.providerGroup.findMany({
    where: providerGroupWhereConditions,
    select: {
      id: true,
      name: true,
      description: true,
      active: true,
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
        take: 5, // Show first 5 providers as preview
        orderBy: { npi: 'asc' }
      },
      users: {
        select: {
          id: true,
          name: true,
          email: true,
          roles: { select: { name: true } }
        },
        take: 3, // Show first 3 users as preview
        orderBy: { name: 'asc' }
      }
    },
    orderBy: { name: 'asc' }
  })

  const { toast, headers } = await getToast(request)

  return data({ 
    user,
    customer,
    providerGroups,
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
    const { name, description } = action

    // Check if name already exists for this customer
    const existingGroup = await prisma.providerGroup.findFirst({
      where: { 
        customerId,
        name 
      }
    })

    if (existingGroup) {
      return data(
        { result: submission.reply({ fieldErrors: { name: ['A provider group with this name already exists'] } }) },
        { status: 400 }
      )
    }

    // Create the provider group
    await prisma.providerGroup.create({
      data: {
        name,
        description: description || undefined,
        customerId,
        active: true,
      }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, {
      type: 'success',
      title: 'Provider group created',
      description: `${name} has been created successfully.`,
    })
  }

  // Handle update action
  if (action.intent === 'update') {
    const { providerGroupId, name, description, active } = action

    // Verify the provider group exists and belongs to this customer
    const existingGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId,
      }
    })

    if (!existingGroup) {
      return data(
        { error: 'Provider group not found' },
        { status: 404 }
      )
    }

    // Check if name already exists for this customer (excluding current group)
    const duplicateGroup = await prisma.providerGroup.findFirst({
      where: { 
        customerId,
        name,
        id: { not: providerGroupId }
      }
    })

    if (duplicateGroup) {
      return data(
        { result: submission.reply({ fieldErrors: { name: ['A provider group with this name already exists'] } }) },
        { status: 400 }
      )
    }

    // Update the provider group
    await prisma.providerGroup.update({
      where: { id: providerGroupId },
      data: {
        name,
        description: description || undefined,
        active: active ?? true,
      }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, {
      type: 'success',
      title: 'Provider group updated',
      description: `${name} has been updated successfully.`,
    })
  }

  // Handle delete action
  if (action.intent === 'delete') {
    const { providerGroupId } = action

    // Verify the provider group exists and belongs to this customer
    const existingGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId,
      },
      include: {
        _count: {
          select: {
            providers: true,
            users: true,
          }
        }
      }
    })

    if (!existingGroup) {
      return data(
        { error: 'Provider group not found' },
        { status: 404 }
      )
    }

    // Check if provider group has associated providers or users
    if (existingGroup._count.providers > 0 || existingGroup._count.users > 0) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, {
        type: 'error',
        title: 'Cannot delete provider group',
        description: 'Provider group has associated providers or users. Remove them first.',
      })
    }

    // Delete the provider group
    const groupName = existingGroup.name
    await prisma.providerGroup.delete({
      where: { id: providerGroupId }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, {
      type: 'success',
      title: 'Provider group deleted',
      description: `${groupName} has been deleted successfully.`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerProviderGroupsManagementPage() {
  const { user, customer, providerGroups, toast, searchTerm } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  const isPending = useIsPending()
  
  useToast(toast)
  
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    providerGroupId?: string
  }>({ isOpen: false, mode: 'create' })

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.get('action')
    const providerGroupId = searchParams.get('providerGroupId')
    
    if (action === 'add') {
      setDrawerState({ isOpen: true, mode: 'create' })
    } else if (action === 'edit' && providerGroupId) {
      setDrawerState({ isOpen: true, mode: 'edit', providerGroupId })
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'edit', providerGroupId?: string) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('action', mode === 'create' ? 'add' : 'edit')
    if (providerGroupId) newParams.set('providerGroupId', providerGroupId)
    setSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('action')
    newParams.delete('providerGroupId')
    setSearchParams(newParams)
  }

  const selectedProviderGroup = drawerState.providerGroupId 
    ? providerGroups.find(g => g.id === drawerState.providerGroupId)
    : null

  const [createForm, createFields] = useForm({
    id: 'create-provider-group-form',
    constraint: getZodConstraint(CreateProviderGroupSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateProviderGroupSchema })
    },
  })

  const [editForm, editFields] = useForm({
    id: 'edit-provider-group-form',
    constraint: getZodConstraint(UpdateProviderGroupSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateProviderGroupSchema })
    },
    defaultValue: selectedProviderGroup ? {
      name: selectedProviderGroup.name,
      description: selectedProviderGroup.description || '',
    } : undefined,
  })

  return (
    <>
      {/* Main content area - blur when drawer is open */}
      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
        <InterexLayout 
          user={user}
          title="Provider Group Management"
          subtitle={`Customer: ${customer.name}`}
          showBackButton={true}
          backTo={`/admin/customer-manage/${customer.id}`}
          currentPath={`/admin/customer-manage/${customer.id}/provider-groups`}
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
                      placeholder="Search provider groups..."
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
                      to={`/admin/customer-manage/${customer.id}/provider-groups`}
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
                      <p className="text-sm text-gray-500">{providerGroups.length} total provider groups</p>
                    </div>
                    <div className="flex space-x-3">
                      <button
                        onClick={() => openDrawer('create')}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        Add Provider Group
                      </button>
                    </div>
                  </div>
                </div>
                
                {providerGroups.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No provider groups found</h3>
                    <p className="text-gray-500 mb-6">
                      {searchTerm 
                        ? `No provider groups match your search criteria "${searchTerm}".`
                        : 'Get started by creating your first provider group.'
                      }
                    </p>
                    <button
                      onClick={() => openDrawer('create')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                    >
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      Add Provider Group
                    </button>
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
                            Providers
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Users
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
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
                        {providerGroups.map((group) => (
                          <tr key={group.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm font-medium text-gray-900">{group.name}</div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="text-sm text-gray-900 max-w-xs truncate">
                                {group.description || '-'}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">
                                <span className="font-medium">{group._count.providers}</span>
                                {group.providers.length > 0 && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    {group.providers.slice(0, 2).map(p => p.npi).join(', ')}
                                    {group.providers.length > 2 && ` +${group.providers.length - 2} more`}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">
                                <span className="font-medium">{group._count.users}</span>
                                {group.users.length > 0 && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    {group.users.slice(0, 2).map(u => u.name).join(', ')}
                                    {group.users.length > 2 && ` +${group.users.length - 2} more`}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                group.active 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-gray-100 text-gray-800'
                              }`}>
                                {group.active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-500">
                                {new Date(group.createdAt).toLocaleDateString()}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                              <div className="flex items-center space-x-2">
                                <button
                                  onClick={() => openDrawer('edit', group.id)}
                                  className="text-blue-600 hover:text-blue-800 p-1"
                                  title="Edit provider group"
                                >
                                  <Icon name="pencil-1" className="h-4 w-4" />
                                </button>
                                
                                {/* Only show delete button if no users or providers */}
                                {group._count.users === 0 && group._count.providers === 0 && (
                                  <Form method="post" className="inline">
                                    <input type="hidden" name="intent" value="delete" />
                                    <input type="hidden" name="providerGroupId" value={group.id} />
                                    <button
                                      type="submit"
                                      className="text-red-600 hover:text-red-800 p-1"
                                      title="Delete provider group"
                                      onClick={(e) => {
                                        if (!confirm(`Are you sure you want to delete "${group.name}"? This action cannot be undone.`)) {
                                          e.preventDefault()
                                        }
                                      }}
                                    >
                                      <Icon name="trash" className="h-4 w-4" />
                                    </button>
                                  </Form>
                                )}
                                
                                {/* Show warning if provider group cannot be deleted */}
                                {(group._count.users > 0 || group._count.providers > 0) && (
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
                  <div className="bg-indigo-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="file-text" className="h-8 w-8 text-indigo-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-indigo-900">Total Groups</p>
                        <p className="text-2xl font-bold text-indigo-600">{providerGroups.length}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-purple-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="laptop" className="h-8 w-8 text-purple-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-purple-900">Total Providers</p>
                        <p className="text-2xl font-bold text-purple-600">
                          {providerGroups.reduce((acc, g) => acc + g._count.providers, 0)}
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
                          {providerGroups.reduce((acc, g) => acc + g._count.users, 0)}
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

      {/* Create Provider Group Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'create'}
        onClose={closeDrawer}
        title="Add New Provider Group"
        size="md"
      >
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <Field
              labelProps={{ children: 'Group Name' }}
              inputProps={{
                ...getInputProps(createFields.name, { type: 'text' }),
                placeholder: 'e.g., Primary Care Group',
              }}
              errors={createFields.name.errors}
            />

            <Field
              labelProps={{ children: 'Description (Optional)' }}
              inputProps={{
                ...getInputProps(createFields.description, { type: 'text' }),
                placeholder: 'Brief description of this provider group...',
              }}
              errors={createFields.description.errors}
            />

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
                Create Provider Group
              </StatusButton>
            </div>
          </div>
        </Form>
      </Drawer>

      {/* Edit Provider Group Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'edit'}
        onClose={closeDrawer}
        title={`Edit ${selectedProviderGroup?.name || 'Provider Group'}`}
        size="md"
      >
        {selectedProviderGroup && (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="providerGroupId" value={selectedProviderGroup.id} />
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'Group Name' }}
                inputProps={{
                  ...getInputProps(editFields.name, { type: 'text' }),
                  defaultValue: selectedProviderGroup.name,
                }}
                errors={editFields.name.errors}
              />

              <Field
                labelProps={{ children: 'Description (Optional)' }}
                inputProps={{
                  ...getInputProps(editFields.description, { type: 'text' }),
                  defaultValue: selectedProviderGroup.description || '',
                }}
                errors={editFields.description.errors}
              />

              <div className="flex items-center">
                <input
                  {...getInputProps(editFields.active, { type: 'checkbox' })}
                  defaultChecked={selectedProviderGroup.active}
                  className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                />
                <span className="ml-2 block text-sm text-gray-900">Active</span>
              </div>
              <ErrorList errors={editFields.active.errors} />

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

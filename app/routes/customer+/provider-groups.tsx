// app/routes/customer+/provider-groups.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod, getZodConstraint } from '@conform-to/zod'
import { useState, useEffect } from 'react'
import { type LoaderFunctionArgs, type ActionFunctionArgs, data, useLoaderData, Form, Link, useSearchParams, useActionData  } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { useToast } from '#app/components/toaster.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit as auditEvent } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'

const CreateProviderGroupSchema = z.object({
  intent: z.literal('create'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  description: z.string().max(500, 'Description must be less than 500 characters').optional(),
})

const UpdateProviderGroupSchema = z.object({
  intent: z.literal('update'),
  providerGroupId: z.string().min(1, 'Provider group ID is required'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  description: z.string().max(500, 'Description must be less than 500 characters').optional(),
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
  providerGroupId: z.string().min(1, 'Provider group ID is required'),
})

// (SearchSchema removed – search handled inline)

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
    action: url.searchParams.get('action') || '',
    providerGroupId: url.searchParams.get('providerGroupId') || '',
  }

  // Build search conditions for provider groups
  const whereConditions: any = {
    customerId: user.customerId,
  }

  if (searchParams.search) {
    whereConditions.OR = [
      { name: { contains: searchParams.search } },
      { description: { contains: searchParams.search } },
    ]
  }

  // Get customer data with filtered provider groups and their related counts
  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
    include: {
      providerGroups: {
        where: whereConditions.OR ? { OR: whereConditions.OR } : {},
        include: {
          users: { select: { id: true, name: true, email: true } },
          providers: { select: { id: true, npi: true, name: true } },
          _count: { select: { users: true, providers: true } },
        },
        orderBy: { name: 'asc' },
      },
    },
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // If editing, get the specific provider group data
  let editingProviderGroup = null
  if (searchParams.action === 'edit' && searchParams.providerGroupId) {
    editingProviderGroup = await prisma.providerGroup.findFirst({
      where: {
        id: searchParams.providerGroupId,
        customerId: user.customerId,
      },
      include: {
        users: { select: { id: true, name: true, email: true } },
        providers: { select: { id: true, npi: true, name: true } },
        _count: { select: { users: true, providers: true } }
      }
    })
  }

  const { toast, headers } = await getToast(request)

  return data(
    { user, customer, searchParams, editingProviderGroup, toast },
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
  const intent = formData.get('intent')

  // Small helper mirroring pattern from provider-npis route for consistency.
  async function writeAudit(input: {
    action:
      | 'PROVIDER_GROUP_CREATE'
      | 'PROVIDER_GROUP_CREATE_ATTEMPT'
      | 'PROVIDER_GROUP_UPDATE'
      | 'PROVIDER_GROUP_UPDATE_ATTEMPT'
      | 'PROVIDER_GROUP_DELETE'
      | 'PROVIDER_GROUP_DELETE_ATTEMPT'
      | 'PROVIDER_GROUP_DELETE_BLOCKED'
      | 'PROVIDER_GROUP_NAME_CONFLICT'
      | 'PROVIDER_GROUP_NOT_FOUND'
    providerGroupId?: string | null
    success: boolean
    message?: string | null
    metadata?: Record<string, any> | null
  }) {
    try {
      if (!user) return
      await auditEvent.admin({
        action: input.action,
        status: input.success ? 'SUCCESS' : 'FAILURE',
        actorType: 'USER',
        actorId: user.id ?? null,
        actorDisplay: user.id ?? null,
        customerId: user.customerId ?? null,
        entityType: 'PROVIDER_GROUP',
        entityId: input.providerGroupId ?? null,
        summary: input.message ?? null,
        metadata: input.metadata ?? undefined,
      })
    } catch {
      // swallow – do not block user flow on audit failure
    }
  }

  // Handle create provider group
  if (intent === 'create') {
    const submission = parseWithZod(formData, { schema: CreateProviderGroupSchema })

    if (submission.status !== 'success') {
      await writeAudit({
        action: 'PROVIDER_GROUP_CREATE_ATTEMPT',
        success: false,
        message: 'Validation failed creating provider group',
        metadata: { issues: submission.error?.issues ?? undefined },
      })
      return data(
        { result: submission.reply() },
        { status: submission.status === 'error' ? 400 : 200 }
      )
    }

    const { name, description } = submission.value

    // Check if provider group name already exists for this customer
    const existingProviderGroup = await prisma.providerGroup.findFirst({
      where: {
        name,
        customerId: user.customerId,
      }
    })

    if (existingProviderGroup) {
      await writeAudit({
        action: 'PROVIDER_GROUP_NAME_CONFLICT',
        success: false,
        providerGroupId: existingProviderGroup.id,
        message: 'Name already exists when creating provider group',
        metadata: { name },
      })
      return data(
        { result: submission.reply({ fieldErrors: { name: ['Provider group name already exists'] } }) },
        { status: 400 }
      )
    }

    // Create the provider group
    const created = await prisma.providerGroup.create({
      data: {
        name,
        description: description || '',
        customerId: user.customerId,
        active: true,
      },
    })

    await writeAudit({
      action: 'PROVIDER_GROUP_CREATE',
      success: true,
      providerGroupId: created.id,
      message: 'Provider group created',
      metadata: { name, description },
    })

    return redirectWithToast('/customer/provider-groups', {
      type: 'success',
      title: 'Provider group created',
      description: `${name} has been created successfully.`,
    })
  }

  // Handle update provider group
  if (intent === 'update') {
    const submission = parseWithZod(formData, { schema: UpdateProviderGroupSchema })

    if (submission.status !== 'success') {
      await writeAudit({
        action: 'PROVIDER_GROUP_UPDATE_ATTEMPT',
        success: false,
        message: 'Validation failed updating provider group',
        metadata: { issues: submission.error?.issues ?? undefined },
      })
      return data(
        { result: submission.reply() },
        { status: submission.status === 'error' ? 400 : 200 }
      )
    }

    const { providerGroupId, name, description, active } = submission.value

    // Verify the provider group belongs to the customer
    const existingProviderGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId: user.customerId,
      }
    })

    if (!existingProviderGroup) {
      await writeAudit({
        action: 'PROVIDER_GROUP_NOT_FOUND',
        success: false,
        providerGroupId: providerGroupId,
        message: 'Provider group not found for update',
        metadata: { providerGroupId },
      })
      return data(
        { error: 'Provider group not found or not authorized to edit this provider group' },
        { status: 404 }
      )
    }

    // Check if the new name conflicts with another provider group (excluding current one)
    if (name !== existingProviderGroup.name) {
      const nameConflict = await prisma.providerGroup.findFirst({
        where: {
          name,
          customerId: user.customerId,
          id: { not: providerGroupId }
        }
      })

      if (nameConflict) {
        await writeAudit({
          action: 'PROVIDER_GROUP_NAME_CONFLICT',
          success: false,
          providerGroupId: providerGroupId,
          message: 'Name conflict updating provider group',
          metadata: { providerGroupId, attemptedName: name },
        })
        return data(
          { 
            result: submission.reply({
              fieldErrors: {
                name: ['Provider group name already exists']
              }
            })
          },
          { status: 400 }
        )
      }
    }

    // Update the provider group
    const updated = await prisma.providerGroup.update({
      where: { id: providerGroupId },
      data: {
        name,
        description: description || '',
        active: active ?? true,
      },
    })

    await writeAudit({
      action: 'PROVIDER_GROUP_UPDATE',
      success: true,
      providerGroupId: providerGroupId,
      message: 'Provider group updated',
      metadata: {
        before: {
          name: existingProviderGroup.name,
          description: existingProviderGroup.description,
          active: existingProviderGroup.active,
        },
        after: {
          name: updated.name,
          description: updated.description,
          active: updated.active,
        },
      },
    })

    return redirectWithToast('/customer/provider-groups', {
      type: 'success',
      title: 'Provider group updated',
      description: `${name} has been updated successfully.`,
    })
  }

  // Handle delete provider group
  if (intent === 'delete') {
    const submission = parseWithZod(formData, { schema: DeleteProviderGroupSchema })

    if (submission.status !== 'success') {
      await writeAudit({
        action: 'PROVIDER_GROUP_DELETE_ATTEMPT',
        success: false,
        message: 'Validation failed deleting provider group',
        metadata: { issues: submission.error?.issues ?? undefined },
      })
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
      await writeAudit({
        action: 'PROVIDER_GROUP_NOT_FOUND',
        success: false,
        providerGroupId: providerGroupId,
        message: 'Provider group not found for delete',
        metadata: { providerGroupId },
      })
      return data(
        { error: 'Provider group not found or not authorized to delete this provider group' },
        { status: 404 }
      )
    }

    // Prevent deleting provider groups with users or providers
    if (providerGroup._count.users > 0) {
      await writeAudit({
        action: 'PROVIDER_GROUP_DELETE_BLOCKED',
        success: false,
        providerGroupId: providerGroupId,
        message: 'Delete blocked: users still assigned',
        metadata: { counts: providerGroup._count },
      })
      return redirectWithToast('/customer/provider-groups', {
        type: 'error',
        title: 'Cannot delete provider group',
        description: `Cannot delete provider group with ${providerGroup._count.users} assigned users. Please reassign or remove users first.`,
      })
    }

    if (providerGroup._count.providers > 0) {
      await writeAudit({
        action: 'PROVIDER_GROUP_DELETE_BLOCKED',
        success: false,
        providerGroupId: providerGroupId,
        message: 'Delete blocked: providers still assigned',
        metadata: { counts: providerGroup._count },
      })
      return redirectWithToast('/customer/provider-groups', {
        type: 'error',
        title: 'Cannot delete provider group',
        description: `Cannot delete provider group with ${providerGroup._count.providers} providers. Please remove providers first.`,
      })
    }

    // Delete the provider group
    const providerGroupName = providerGroup.name
    await prisma.providerGroup.delete({
      where: { id: providerGroupId }
    })

    await writeAudit({
      action: 'PROVIDER_GROUP_DELETE',
      success: true,
      providerGroupId: providerGroupId,
      message: 'Provider group deleted',
      metadata: { name: providerGroupName },
    })

    return redirectWithToast('/customer/provider-groups', {
      type: 'success',
      title: 'Provider group deleted',
      description: `${providerGroupName} has been deleted successfully.`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerProviderGroupsPage() {
  const { user, customer, searchParams, toast } = useLoaderData<typeof loader>()
  const [urlSearchParams, setUrlSearchParams] = useSearchParams()
  const actionData = useActionData<typeof action>()
  const isPending = useIsPending()

  useToast(toast)

  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    providerGroupId?: string
  }>({ isOpen: false, mode: 'create' })

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.action
    const providerGroupId = searchParams.providerGroupId
    
    if (action === 'create') {
      setDrawerState({ isOpen: true, mode: 'create' })
    } else if (action === 'edit' && providerGroupId) {
      setDrawerState({ isOpen: true, mode: 'edit', providerGroupId })
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'edit', providerGroupId?: string) => {
    const newParams = new URLSearchParams(urlSearchParams)
    newParams.set('action', mode)
    if (providerGroupId) newParams.set('providerGroupId', providerGroupId)
    setUrlSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(urlSearchParams)
    newParams.delete('action')
    newParams.delete('providerGroupId')
    setUrlSearchParams(newParams)
  }

  const selectedProviderGroup = drawerState.providerGroupId 
    ? customer.providerGroups.find(pg => pg.id === drawerState.providerGroupId)
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
          backTo="/customer"
          currentPath="/customer/provider-groups"
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
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Users</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPIs</th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Edit</th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Delete</th>
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
                        <td className="px-6 py-4 align-top text-sm text-gray-900">
                          {/* Users list */}
                          <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                            {providerGroup.users && providerGroup.users.length > 0 ? (
                              providerGroup.users.map(u => (
                                <div key={u.id} className="text-xs text-gray-700">
                                  {u.name || u.email}
                                </div>
                              ))
                            ) : (
                              <span className="text-xs text-gray-400">None</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 align-top text-sm text-gray-900">
                          {/* Providers list */}
                          <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                            {providerGroup.providers && providerGroup.providers.length > 0 ? (
                              providerGroup.providers.map(p => (
                                <div key={p.id} className="text-xs text-gray-700 font-mono">
                                  {p.npi}
                                </div>
                              ))
                            ) : (
                              <span className="text-xs text-gray-400">None</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                          <button
                            onClick={() => openDrawer('edit', providerGroup.id)}
                            className="text-blue-600 hover:text-blue-800 p-1"
                            title="Edit provider group"
                          >
                            <Icon name="pencil-1" className="h-4 w-4" />
                          </button>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                          {providerGroup._count.users === 0 && providerGroup._count.providers === 0 ? (
                            <Form method="post" className="inline">
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="providerGroupId" value={providerGroup.id} />
                              <button
                                type="submit"
                                className="text-red-600 hover:text-red-800 p-1"
                                title="Delete provider group"
                                onClick={(e) => {
                                  if (!confirm(`Are you sure you want to delete "${providerGroup.name}"? This action cannot be undone.`)) {
                                    e.preventDefault()
                                  }
                                }}
                              >
                                <Icon name="trash" className="h-4 w-4" />
                              </button>
                            </Form>
                          ) : (
                            <span className="text-gray-400" title="Cannot delete: has assigned users or providers">
                              <Icon name="trash" className="h-4 w-4" />
                            </span>
                          )}
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
      </div>

      {/* Drawer - outside of blur container so it stays sharp */}
      
      {/* Create Provider Group Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'create'}
        onClose={closeDrawer}
        title="Add Provider Group"
        size="md"
      >
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <Field
              labelProps={{ children: 'Provider Group Name *' }}
              inputProps={{
                ...getInputProps(createFields.name, { type: 'text' }),
                placeholder: 'e.g., Cardiology Group, Primary Care North'
              }}
              errors={createFields.name.errors}
            />

            <Field
              labelProps={{ children: 'Description' }}
              inputProps={{
                ...getInputProps(createFields.description, { type: 'text' }),
                placeholder: 'Optional description of the provider group'
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
                labelProps={{ children: 'Provider Group Name *' }}
                inputProps={{
                  ...getInputProps(editFields.name, { type: 'text' }),
                  defaultValue: selectedProviderGroup.name || '',
                  placeholder: 'e.g., Cardiology Group, Primary Care North'
                }}
                errors={editFields.name.errors}
              />

              <Field
                labelProps={{ children: 'Description' }}
                inputProps={{
                  ...getInputProps(editFields.description, { type: 'text' }),
                  defaultValue: selectedProviderGroup.description || '',
                  placeholder: 'Optional description of the provider group'
                }}
                errors={editFields.description.errors}
              />

              <div>
                <label className="flex items-center">
                  <input
                    {...getInputProps(editFields.active, { type: 'checkbox' })}
                    defaultChecked={selectedProviderGroup.active}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 block text-sm text-gray-900">Active</span>
                </label>
                <ErrorList errors={editFields.active.errors} />
              </div>

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

              {/* Show provider group information when editing */}
              <div className="mt-8 pt-6 border-t border-gray-200">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Provider Group Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center">
                      <Icon name="avatar" className="h-6 w-6 text-blue-600 mr-2" />
                      <div>
                        <p className="text-xs font-medium text-gray-900">Assigned Users</p>
                        <p className="text-lg font-bold text-blue-600">{selectedProviderGroup._count.users}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center">
                      <Icon name="id-card" className="h-6 w-6 text-green-600 mr-2" />
                      <div>
                        <p className="text-xs font-medium text-gray-900">NPIs/Providers</p>
                        <p className="text-lg font-bold text-green-600">{selectedProviderGroup._count.providers}</p>
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

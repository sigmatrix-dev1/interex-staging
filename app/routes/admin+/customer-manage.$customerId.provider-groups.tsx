import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod, getZodConstraint } from '@conform-to/zod'
import { useEffect, useState } from 'react'
import { type LoaderFunctionArgs, type ActionFunctionArgs, data, useLoaderData, Link, Form, useSearchParams, useActionData } from 'react-router'
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

// Schemas
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

// Loader
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, roles: { select: { name: true } } },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })

  // Require system admin role
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const customerId = params.customerId
  if (!customerId) throw new Response('Customer ID is required', { status: 400 })

  const url = new URL(request.url)
  const searchParams = {
    search: url.searchParams.get('search') || '',
    action: url.searchParams.get('action') || '',
    providerGroupId: url.searchParams.get('providerGroupId') || '',
  }

  // Build filter for provider groups
  const whereProviderGroups: any = searchParams.search
    ? { OR: [{ name: { contains: searchParams.search } }, { description: { contains: searchParams.search } }] }
    : {}

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      providerGroups: {
        where: whereProviderGroups,
        include: {
          users: { select: { id: true, name: true, email: true } },
          providers: { select: { id: true, npi: true, name: true } },
          _count: { select: { users: true, providers: true } },
        },
        orderBy: { name: 'asc' },
      },
    },
  })
  if (!customer) throw new Response('Customer not found', { status: 404 })

  // If editing, prefetch selected group for drawer defaults
  let editingProviderGroup: null | {
    id: string
    name: string
    description: string | null
    active: boolean
    _count: { users: number; providers: number }
  } = null
  if (searchParams.action === 'edit' && searchParams.providerGroupId) {
    const pg = await prisma.providerGroup.findFirst({
      where: { id: searchParams.providerGroupId, customerId },
      select: { id: true, name: true, description: true, active: true, _count: { select: { users: true, providers: true } } },
    })
    if (pg) editingProviderGroup = pg
  }

  const { toast, headers } = await getToast(request)
  return data({ user, customer, searchParams, editingProviderGroup, toast }, { headers: headers ?? undefined })
}

// Action
export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, roles: { select: { name: true } } } })
  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const customerId = params.customerId
  if (!customerId) throw new Response('Customer ID is required', { status: 400 })

  const formData = await request.formData()
  const intent = formData.get('intent')

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
      await auditEvent.admin({
        action: input.action,
        status: input.success ? 'SUCCESS' : 'FAILURE',
        actorType: 'USER',
  actorId: userId ?? null,
  actorDisplay: userId ?? null,
        customerId,
        entityType: 'PROVIDER_GROUP',
        entityId: input.providerGroupId ?? null,
        summary: input.message ?? null,
        metadata: input.metadata ?? undefined,
      })
    } catch {}
  }

  // CREATE
  if (intent === 'create') {
    const submission = parseWithZod(formData, { schema: CreateProviderGroupSchema })
    if (submission.status !== 'success') {
      await writeAudit({ action: 'PROVIDER_GROUP_CREATE_ATTEMPT', success: false, message: 'Validation failed', metadata: { issues: submission.error?.issues } })
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { name, description } = submission.value
    const exists = await prisma.providerGroup.findFirst({ where: { name, customerId } })
    if (exists) {
      await writeAudit({ action: 'PROVIDER_GROUP_NAME_CONFLICT', success: false, providerGroupId: exists.id, message: 'Name exists', metadata: { name } })
      return data({ result: submission.reply({ fieldErrors: { name: ['Provider group name already exists'] } }) }, { status: 400 })
    }
    const created = await prisma.providerGroup.create({ data: { name, description: description || '', active: true, customerId } })
    await writeAudit({ action: 'PROVIDER_GROUP_CREATE', success: true, providerGroupId: created.id, message: 'Created', metadata: { name } })
    return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, { type: 'success', title: 'Provider group created', description: `${name} has been created successfully.` })
  }

  // UPDATE
  if (intent === 'update') {
    const submission = parseWithZod(formData, { schema: UpdateProviderGroupSchema })
    if (submission.status !== 'success') {
      await writeAudit({ action: 'PROVIDER_GROUP_UPDATE_ATTEMPT', success: false, message: 'Validation failed', metadata: { issues: submission.error?.issues } })
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { providerGroupId, name, description, active } = submission.value
    const existing = await prisma.providerGroup.findFirst({ where: { id: providerGroupId, customerId } })
    if (!existing) {
      await writeAudit({ action: 'PROVIDER_GROUP_NOT_FOUND', success: false, providerGroupId, message: 'Not found' })
      return data({ error: 'Provider group not found or not authorized' }, { status: 404 })
    }
    if (name !== existing.name) {
      const conflict = await prisma.providerGroup.findFirst({ where: { name, customerId, id: { not: providerGroupId } } })
      if (conflict) {
        await writeAudit({ action: 'PROVIDER_GROUP_NAME_CONFLICT', success: false, providerGroupId, message: 'Name conflict', metadata: { attemptedName: name } })
        return data({ result: submission.reply({ fieldErrors: { name: ['Provider group name already exists'] } }) }, { status: 400 })
      }
    }
    const updated = await prisma.providerGroup.update({ where: { id: providerGroupId }, data: { name, description: description || '', active: active ?? true } })
    await writeAudit({ action: 'PROVIDER_GROUP_UPDATE', success: true, providerGroupId, message: 'Updated', metadata: { before: { name: existing.name, description: existing.description, active: existing.active }, after: { name: updated.name, description: updated.description, active: updated.active } } })
    return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, { type: 'success', title: 'Provider group updated', description: `${name} has been updated successfully.` })
  }

  // DELETE
  if (intent === 'delete') {
    const submission = parseWithZod(formData, { schema: DeleteProviderGroupSchema })
    if (submission.status !== 'success') {
      await writeAudit({ action: 'PROVIDER_GROUP_DELETE_ATTEMPT', success: false, message: 'Validation failed', metadata: { issues: submission.error?.issues } })
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { providerGroupId } = submission.value
    const group = await prisma.providerGroup.findFirst({ where: { id: providerGroupId, customerId }, include: { _count: { select: { users: true, providers: true } } } })
    if (!group) {
      await writeAudit({ action: 'PROVIDER_GROUP_NOT_FOUND', success: false, providerGroupId, message: 'Not found' })
      return data({ error: 'Provider group not found or not authorized' }, { status: 404 })
    }
    if (group._count.users > 0) {
      await writeAudit({ action: 'PROVIDER_GROUP_DELETE_BLOCKED', success: false, providerGroupId, message: 'Users attached', metadata: { counts: group._count } })
      return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, { type: 'error', title: 'Cannot delete provider group', description: `Cannot delete provider group with ${group._count.users} assigned users. Please reassign or remove users first.` })
    }
    if (group._count.providers > 0) {
      await writeAudit({ action: 'PROVIDER_GROUP_DELETE_BLOCKED', success: false, providerGroupId, message: 'Providers attached', metadata: { counts: group._count } })
      return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, { type: 'error', title: 'Cannot delete provider group', description: `Cannot delete provider group with ${group._count.providers} providers. Please remove providers first.` })
    }
    const groupName = group.name
    await prisma.providerGroup.delete({ where: { id: providerGroupId } })
    await writeAudit({ action: 'PROVIDER_GROUP_DELETE', success: true, providerGroupId, message: 'Deleted', metadata: { name: groupName } })
    return redirectWithToast(`/admin/customer-manage/${customerId}/provider-groups`, { type: 'success', title: 'Provider group deleted', description: `${groupName} has been deleted successfully.` })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

// Component
export default function AdminCustomerProviderGroupsPage() {
  const { user, customer, searchParams, editingProviderGroup, toast } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [urlSearchParams, setUrlSearchParams] = useSearchParams()
  const isPending = useIsPending()

  useToast(toast)

  // Drawer state from URL
  const [drawerState, setDrawerState] = useState<{ isOpen: boolean; mode: 'create' | 'edit'; providerGroupId?: string }>({ isOpen: false, mode: 'create' })
  useEffect(() => {
    const action = searchParams.action
    const providerGroupId = searchParams.providerGroupId
    if (action === 'create') setDrawerState({ isOpen: true, mode: 'create' })
    else if (action === 'edit' && providerGroupId) setDrawerState({ isOpen: true, mode: 'edit', providerGroupId })
    else setDrawerState({ isOpen: false, mode: 'create' })
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
    ? customer.providerGroups.find(pg => pg.id === drawerState.providerGroupId) || editingProviderGroup
    : undefined

  const lastResult = actionData && 'result' in (actionData as any) ? (actionData as any).result : undefined
  const [createForm, createFields] = useForm({
    id: 'create-provider-group-form',
    constraint: getZodConstraint(CreateProviderGroupSchema),
    lastResult,
    onValidate({ formData }) { return parseWithZod(formData, { schema: CreateProviderGroupSchema }) },
  })
  const [editForm, editFields] = useForm({
    id: 'edit-provider-group-form',
    constraint: getZodConstraint(UpdateProviderGroupSchema),
    lastResult,
    onValidate({ formData }) { return parseWithZod(formData, { schema: UpdateProviderGroupSchema }) },
  })

  return (
    <>
      <InterexLayout
        user={user}
        title={`${customer.name} - Provider Groups`}
        subtitle={`Managing ${customer.providerGroups.length} provider groups`}
        currentPath={`/admin/customer-manage/${customer.id}/provider-groups`}
        actions={
          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">System Admin</span>
            <Link to={`/admin/customer-manage/${customer.id}`} className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">
              <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
              Back to Customer
            </Link>
          </div>
        }
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
                  <input type="text" name="search" placeholder="Search provider groups..." defaultValue={searchParams.search} className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md leading-5 bg-white text-gray-900 placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" />
                </div>
                <button type="submit" className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700">Search</button>
                {searchParams.search && (
                  <Link to={`/admin/customer-manage/${customer.id}/provider-groups`} className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Clear</Link>
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
                    <button onClick={() => openDrawer('create')} className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
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
                  <p className="text-gray-500 mb-6">{searchParams.search ? `No provider groups match your search criteria "${searchParams.search}".` : 'Get started by creating your first provider group.'}</p>
                  <button onClick={() => openDrawer('create')} className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700">
                    <Icon name="plus" className="h-4 w-4 mr-2" />
                    Add Provider Group
                  </button>
                </div>
              ) : (
                <div className="overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Users</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPIs</th>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Edit</th>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Delete</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {customer.providerGroups.map(pg => (
                        <tr key={pg.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap"><div className="text-sm font-medium text-gray-900">{pg.name}</div></td>
                          <td className="px-6 py-4"><div className="text-sm text-gray-900">{pg.description || 'No description'}</div></td>
                          <td className="px-6 py-4 align-top text-sm text-gray-900">
                            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">{pg.users && pg.users.length > 0 ? pg.users.map(u => (<div key={u.id} className="text-xs text-gray-700">{u.name || u.email}</div>)) : (<span className="text-xs text-gray-400">None</span>)}</div>
                          </td>
                          <td className="px-6 py-4 align-top text-sm text-gray-900">
                            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">{pg.providers && pg.providers.length > 0 ? pg.providers.map(p => (<div key={p.id} className="text-xs text-gray-700 font-mono">{p.npi}</div>)) : (<span className="text-xs text-gray-400">None</span>)}</div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                            <button onClick={() => openDrawer('edit', pg.id)} className="text-blue-600 hover:text-blue-800 p-1" title="Edit provider group"><Icon name="pencil-1" className="h-4 w-4" /></button>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                            {pg._count.users === 0 && pg._count.providers === 0 ? (
                              <Form method="post" className="inline">
                                <input type="hidden" name="intent" value="delete" />
                                <input type="hidden" name="providerGroupId" value={pg.id} />
                                <button type="submit" className="text-red-600 hover:text-red-800 p-1" title="Delete provider group" onClick={(e) => { if (!confirm(`Are you sure you want to delete "${pg.name}"? This action cannot be undone.`)) e.preventDefault() }}>
                                  <Icon name="trash" className="h-4 w-4" />
                                </button>
                              </Form>
                            ) : (
                              <span className="text-gray-400" title="Cannot delete: has assigned users or providers"><Icon name="trash" className="h-4 w-4" /></span>
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
                <div className="bg-blue-50 rounded-lg p-4"><div className="flex items-center"><Icon name="dots-horizontal" className="h-8 w-8 text-blue-600 mr-3" /><div><p className="text-sm font-medium text-blue-900">Total Provider Groups</p><p className="text-2xl font-bold text-blue-600">{customer.providerGroups.length}</p></div></div></div>
                <div className="bg-green-50 rounded-lg p-4"><div className="flex items-center"><Icon name="avatar" className="h-8 w-8 text-green-600 mr-3" /><div><p className="text-sm font-medium text-green-900">Total Users</p><p className="text-2xl font-bold text-green-600">{customer.providerGroups.reduce((sum, pg) => sum + pg._count.users, 0)}</p></div></div></div>
                <div className="bg-purple-50 rounded-lg p-4"><div className="flex items-center"><Icon name="id-card" className="h-8 w-8 text-purple-600 mr-3" /><div><p className="text-sm font-medium text-purple-900">Total Providers</p><p className="text-2xl font-bold text-purple-600">{customer.providerGroups.reduce((sum, pg) => sum + pg._count.providers, 0)}</p></div></div></div>
              </div>
            </div>
          </div>
        </div>
      </InterexLayout>

      {/* Drawers */}
      <Drawer isOpen={drawerState.isOpen && drawerState.mode === 'create'} onClose={closeDrawer} title="Add Provider Group" size="md">
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <Field labelProps={{ children: 'Provider Group Name *' }} inputProps={{ ...getInputProps(createFields.name, { type: 'text' }), placeholder: 'e.g., Cardiology Group, Primary Care North' }} errors={createFields.name.errors} />
            <Field labelProps={{ children: 'Description' }} inputProps={{ ...getInputProps(createFields.description, { type: 'text' }), placeholder: 'Optional description of the provider group' }} errors={createFields.description.errors} />
            <ErrorList id={createForm.errorId} errors={createForm.errors} />
            <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
              <button type="button" onClick={closeDrawer} className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
              <StatusButton type="submit" disabled={isPending} status={isPending ? 'pending' : 'idle'} className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700">Create Provider Group</StatusButton>
            </div>
          </div>
        </Form>
      </Drawer>

      <Drawer isOpen={drawerState.isOpen && drawerState.mode === 'edit'} onClose={closeDrawer} title={`Edit ${selectedProviderGroup?.name || 'Provider Group'}`} size="md">
        {selectedProviderGroup && (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="providerGroupId" value={selectedProviderGroup.id} />
            <div className="space-y-6">
              <Field labelProps={{ children: 'Provider Group Name *' }} inputProps={{ ...getInputProps(editFields.name, { type: 'text' }), defaultValue: selectedProviderGroup.name || '', placeholder: 'e.g., Cardiology Group, Primary Care North' }} errors={editFields.name.errors} />
              <Field labelProps={{ children: 'Description' }} inputProps={{ ...getInputProps(editFields.description, { type: 'text' }), defaultValue: selectedProviderGroup.description || '', placeholder: 'Optional description of the provider group' }} errors={editFields.description.errors} />
              <div>
                <label className="flex items-center">
                  <input {...getInputProps(editFields.active, { type: 'checkbox' })} defaultChecked={(selectedProviderGroup as any).active} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
                  <span className="ml-2 block text-sm text-gray-900">Active</span>
                </label>
                <ErrorList errors={editFields.active.errors} />
              </div>
              <ErrorList id={editForm.errorId} errors={editForm.errors} />
              <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
                <button type="button" onClick={closeDrawer} className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                <StatusButton type="submit" disabled={isPending} status={isPending ? 'pending' : 'idle'} className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700">Save Changes</StatusButton>
              </div>
              {(selectedProviderGroup as any)._count && (
                <div className="mt-8 pt-6 border-t border-gray-200">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">Provider Group Information</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-50 rounded-lg p-3"><div className="flex items-center"><Icon name="avatar" className="h-6 w-6 text-blue-600 mr-2" /><div><p className="text-xs font-medium text-gray-900">Assigned Users</p><p className="text-lg font-bold text-blue-600">{(selectedProviderGroup as any)._count.users}</p></div></div></div>
                    <div className="bg-gray-50 rounded-lg p-3"><div className="flex items-center"><Icon name="id-card" className="h-6 w-6 text-green-600 mr-2" /><div><p className="text-xs font-medium text-gray-900">NPIs/Providers</p><p className="text-lg font-bold text-green-600">{(selectedProviderGroup as any)._count.providers}</p></div></div></div>
                  </div>
                </div>
              )}
            </div>
          </Form>
        )}
      </Drawer>
    </>
  )
}

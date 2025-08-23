import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod, getZodConstraint } from '@conform-to/zod'
import { useState, useEffect } from 'react'
import {
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
  data,
  useLoaderData,
  Form,
  Link,
  useSearchParams,
  useActionData,
} from 'react-router'

import { z } from 'zod'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { useToast } from '#app/components/toaster.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts' // safe on client
import { useIsPending } from '#app/utils/misc.tsx'


/** Helper: append a provider event (audit) — server-only import inside */
async function logProviderEvent(input: {
  providerId: string
  customerId: string
  actorId?: string | null
  kind:
      | 'CREATED'
      | 'UPDATED'
      | 'ACTIVATED'
      | 'INACTIVATED'
      | 'GROUP_ASSIGNED'
      | 'GROUP_UNASSIGNED'
      | 'PCG_ADD_ATTEMPT'
      | 'PCG_ADD_ERROR'
  message?: string
  payload?: any
}) {
  const { prisma } = await import('#app/utils/db.server.ts')
  await prisma.providerEvent.create({
    data: {
      providerId: input.providerId,
      customerId: input.customerId,
      actorId: input.actorId ?? null,
      kind: input.kind as any,
      message: input.message,
      payload: (input.payload ?? null) as any,
    },
  })
}

const CreateProviderSchema = z.object({
  intent: z.literal('create'),
  npi: z.string().regex(/^\d{10}$/, 'NPI must be exactly 10 digits'),
  name: z.string().min(1, 'Provider name is required').max(200, 'Provider name must be less than 200 characters'),
  providerGroupId: z.string().optional(),
})

const UpdateProviderSchema = z.object({
  intent: z.literal('update'),
  providerId: z.string().min(1, 'Provider ID is required'),
  name: z.string().min(1, 'Provider name is required').max(200, 'Provider name must be less than 200 characters'),
  providerGroupId: z.string().optional(),
  active: z
      .union([z.boolean(), z.string()])
      .transform(value => {
        if (typeof value === 'boolean') return value
        if (value === 'on' || value === 'true') return true
        return false
      })
      .optional(),
})

const ToggleActiveSchema = z.object({
  intent: z.literal('toggle-active'),
  providerId: z.string().min(1, 'Provider ID is required'),
  active: z.union([z.boolean(), z.string()]).transform(v => {
    if (typeof v === 'boolean') return v
    return v === 'true' || v === 'on'
  }),
})

const SearchSchema = z.object({
  search: z.string().optional(),
})

export async function loader({ request }: LoaderFunctionArgs) {
  // 🔽 dynamic server imports
  const [{ requireUserId }, { prisma }, { requireRoles }, { getToast }] = await Promise.all([
    import('#app/utils/auth.server.ts'),
    import('#app/utils/db.server.ts'),
    import('#app/utils/role-redirect.server.ts'),
    import('#app/utils/toast.server.ts'),
  ])

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
  if (!user) throw new Response('Unauthorized', { status: 401 })

  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN])
  if (!user.customerId) throw new Response('User must be associated with a customer', { status: 400 })

  const userRoles = user.roles.map(r => r.name)
  const isCustomerAdmin = userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
  const isProviderGroupAdmin = userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)

  if (isProviderGroupAdmin && !isCustomerAdmin && !user.providerGroupId) {
    throw new Response('Provider group admin must be assigned to a provider group', { status: 400 })
  }

  // Search params
  const url = new URL(request.url)
  const searchParams = {
    search: url.searchParams.get('search') || '',
    action: url.searchParams.get('action') || '',
    providerId: url.searchParams.get('providerId') || '',
  }

  // Visibility scope
  const whereConditions: any = { customerId: user.customerId }
  if (isProviderGroupAdmin && !isCustomerAdmin) {
    whereConditions.providerGroupId = user.providerGroupId
  }
  if (searchParams.search) {
    whereConditions.OR = [{ npi: { contains: searchParams.search } }, { name: { contains: searchParams.search } }]
  }

  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
    include: {
      providers: {
        where: whereConditions,
        include: {
          providerGroup: true,
          _count: { select: { userNpis: true } },
        },
        orderBy: { npi: 'asc' },
      },
      providerGroups: {
        where: isProviderGroupAdmin && !isCustomerAdmin ? { id: user.providerGroupId! } : {},
        orderBy: { name: 'asc' },
      },
    },
  })
  if (!customer) throw new Response('Customer not found', { status: 404 })

  const events = await prisma.providerEvent.findMany({
    where: { customerId: user.customerId },
    include: {
      provider: { select: { npi: true, name: true } },
      actor: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  // preload editing provider (if any)
  let editingProvider: any = null
  if (searchParams.action === 'edit' && searchParams.providerId) {
    editingProvider = await prisma.provider.findFirst({
      where: { id: searchParams.providerId, customerId: user.customerId },
      include: { providerGroup: true, _count: { select: { userNpis: true } } },
    })
  }

  const { toast, headers } = await getToast(request)
  // ✅ expose role booleans to the client for UI gating
  return data(
      { user, customer, searchParams, editingProvider, toast, events, isCustomerAdmin, isProviderGroupAdmin },
      { headers: headers ?? undefined },
  )
}

export async function action({ request }: ActionFunctionArgs) {
  // 🔽 dynamic server imports
  const [
    { requireUserId },
    { prisma },
    { requireRoles },
    { redirectWithToast },
    { pcgGetUserNpis, pcgAddProviderNpi },
  ] = await Promise.all([
    import('#app/utils/auth.server.ts'),
    import('#app/utils/db.server.ts'),
    import('#app/utils/role-redirect.server.ts'),
    import('#app/utils/toast.server.ts'),
    import('#app/services/pcg-hih.server.ts'),
  ])

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
  if (!user) throw new Response('Unauthorized', { status: 401 })

  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN])
  if (!user.customerId) throw new Response('User must be associated with a customer', { status: 400 })

  // ✅ compute once and reuse everywhere in this action
  const userRoles = user.roles.map(r => r.name)
  const isCustomerAdmin = userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
  const isProviderGroupAdmin = userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)
  if (isProviderGroupAdmin && !isCustomerAdmin && !user.providerGroupId) {
    throw new Response('Provider group admin must be assigned to a provider group', { status: 400 })
  }

  const formData = await request.formData()
  const intent = formData.get('intent')

  // Fetch org NPIs from PCG
  if (intent === 'fetch-remote-npis') {
    try {
      const list = await pcgGetUserNpis()
      return data({ pcgNpis: list })
    } catch (err: any) {
      return data({ pcgError: err?.message ?? 'Failed to fetch NPIs from PCG.' }, { status: 500 })
    }
  }

  // Create provider
  if (intent === 'create') {
    const submission = parseWithZod(formData, { schema: CreateProviderSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }

    const { npi, name } = submission.value
    const providerGroupIdRaw = submission.value.providerGroupId
    const providerGroupId = providerGroupIdRaw && providerGroupIdRaw.length > 0 ? providerGroupIdRaw : null

    // Unique NPI (global)
    const existingProvider = await prisma.provider.findFirst({ where: { npi } })
    if (existingProvider) {
      return data(
          { result: submission.reply({ fieldErrors: { npi: ['This NPI is already registered in the system'] } }) },
          { status: 400 },
      )
    }

    // PCG add — tolerate "already exists", fail on other errors
    try {
      await pcgAddProviderNpi({ providerNPI: npi, customerName: name })
    } catch (err: any) {
      const msg = String(err?.message || '')
      const duplicate = /already|exist|registered|duplicate/i.test(msg)
      if (!duplicate) {
        return data({ result: submission.reply({ formErrors: [msg || 'Failed to add NPI in PCG.'] }) }, { status: 400 })
      }
    }

    // Optional group validation
    if (providerGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({
        where: { id: providerGroupId, customerId: user.customerId },
      })
      if (!providerGroup) {
        return data(
            { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
            { status: 400 },
        )
      }
      if (isProviderGroupAdmin && !isCustomerAdmin && providerGroupId !== user.providerGroupId) {
        return data(
            { result: submission.reply({ fieldErrors: { providerGroupId: ['You can only assign your group'] } }) },
            { status: 400 },
        )
      }
    }

    // Create locally
    const created = await prisma.provider.create({
      data: { npi, name, customerId: user.customerId, providerGroupId, active: true },
    })

    // Events
    await logProviderEvent({
      providerId: created.id,
      customerId: user.customerId,
      actorId: userId,
      kind: 'PCG_ADD_ATTEMPT',
      message: 'PCG Add Provider NPI - api call attempted ',
      payload: { npi, name },
    })
    await logProviderEvent({
      providerId: created.id,
      customerId: user.customerId,
      actorId: userId,
      kind: 'CREATED',
      message: `Provider created (${npi})`,
      payload: { name, providerGroupId },
    })
    if (providerGroupId) {
      await logProviderEvent({
        providerId: created.id,
        customerId: user.customerId,
        actorId: userId,
        kind: 'GROUP_ASSIGNED',
        message: `Assigned to group ${providerGroupId}`,
        payload: { field: 'providerGroupId', to: providerGroupId },
      })
    }

    return redirectWithToast('/customer/provider-npis', {
      type: 'success',
      title: 'Provider NPI created',
      description: `NPI ${npi} (${name}) has been added (synced or already present in PCG).`,
    })
  }

  // Update provider
  if (intent === 'update') {
    const submission = parseWithZod(formData, { schema: UpdateProviderSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }

    const { providerId, name, providerGroupId, active } = submission.value
    const newGroupId = providerGroupId && providerGroupId.length > 0 ? providerGroupId : null

    const existingProvider = await prisma.provider.findFirst({
      where: { id: providerId, customerId: user.customerId },
    })
    if (!existingProvider) {
      return redirectWithToast('/customer/provider-npis', {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized to edit this provider.',
      })
    }

    if (isProviderGroupAdmin && !isCustomerAdmin) {
      if (existingProvider.providerGroupId !== user.providerGroupId) {
        return redirectWithToast('/customer/provider-npis', {
          type: 'error',
          title: 'Access denied',
          description: 'You can only edit providers in your assigned provider group.',
        })
      }
      if (newGroupId && newGroupId !== user.providerGroupId) {
        return data(
            {
              result: submission.reply({
                fieldErrors: { providerGroupId: ['You can only assign your group or unassign'] },
              }),
            },
            { status: 400 },
        )
      }
    }

    if (newGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({
        where: { id: newGroupId, customerId: user.customerId },
      })
      if (!providerGroup) {
        return data(
            { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
            { status: 400 },
        )
      }
    }

    const oldName = existingProvider.name ?? ''
    const oldGroupId = existingProvider.providerGroupId ?? null
    const nameChanged = (name ?? '') !== oldName
    const groupChanged = oldGroupId !== newGroupId
    const activeChanged = typeof active !== 'undefined' && active !== existingProvider.active

    await prisma.provider.update({
      where: { id: providerId },
      data: {
        name,
        providerGroupId: newGroupId,
        ...(typeof active !== 'undefined' ? { active } : {}),
      },
    })

    if (nameChanged) {
      await logProviderEvent({
        providerId,
        customerId: user.customerId,
        actorId: userId,
        kind: 'UPDATED',
        message: `Name: "${oldName || '—'}" → "${name || '—'}"`,
        payload: { field: 'name', from: oldName, to: name },
      })
    }
    if (groupChanged) {
      await logProviderEvent({
        providerId,
        customerId: user.customerId,
        actorId: userId,
        kind: newGroupId ? 'GROUP_ASSIGNED' : 'GROUP_UNASSIGNED',
        message: newGroupId ? `Assigned to group ${newGroupId}` : 'Unassigned from provider group',
        payload: { field: 'providerGroupId', from: oldGroupId, to: newGroupId },
      })
    }
    if (activeChanged) {
      await logProviderEvent({
        providerId,
        customerId: user.customerId,
        actorId: userId,
        kind: active ? 'ACTIVATED' : 'INACTIVATED',
        message: active ? 'Provider activated (via edit)' : 'Provider inactivated (via edit)',
      })
    }

    return redirectWithToast('/customer/provider-npis', {
      type: 'success',
      title: 'Provider NPI updated',
      description: `NPI ${existingProvider.npi} (${name}) has been updated successfully.`,
    })
  }

  // Toggle active
  if (intent === 'toggle-active') {
    const submission = parseWithZod(formData, { schema: ToggleActiveSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }

    const { providerId, active } = submission.value
    const provider = await prisma.provider.findFirst({
      where: { id: providerId, customerId: user.customerId },
    })
    if (!provider) {
      return redirectWithToast('/customer/provider-npis', {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized.',
      })
    }

    // ✅ Authorization (final):
    // Customer Admins can always toggle.
    if (!isCustomerAdmin) {
      // Only PG Admins (or none) reach here due to requireRoles
      if (isProviderGroupAdmin) {
        // PG Admins can toggle providers in their own group OR unassigned.
        const inDifferentGroup =
            provider.providerGroupId != null && provider.providerGroupId !== user.providerGroupId

        if (inDifferentGroup) {
          return redirectWithToast('/customer/provider-npis', {
            type: 'error',
            title: 'Access denied',
            description: 'You can only edit providers in your assigned provider group.',
          })
        }
      } else {
        return redirectWithToast('/customer/provider-npis', {
          type: 'error',
          title: 'Access denied',
          description: 'You do not have permission to perform this action.',
        })
      }
    }

    await prisma.provider.update({ where: { id: providerId }, data: { active } })
    await logProviderEvent({
      providerId,
      customerId: user.customerId,
      actorId: userId,
      kind: active ? 'ACTIVATED' : 'INACTIVATED',
      message: active ? 'Provider activated' : 'Provider inactivated',
    })

    return redirectWithToast('/customer/provider-npis', {
      type: 'success',
      title: active ? 'Activated' : 'Inactivated',
      description: `NPI ${provider.npi} has been ${active ? 'activated' : 'inactivated'}.`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerProviderNpiPage() {
  const { user, customer, searchParams, editingProvider, toast, events, isCustomerAdmin, isProviderGroupAdmin } =
      useLoaderData<typeof loader>()
  const [urlSearchParams, setUrlSearchParams] = useSearchParams()
  const isPending = useIsPending()

  type PcgNpisPayload = { total: number; pageSize: number; page: number; npis: string[] }
  type ActionData = { pcgNpis: PcgNpisPayload } | { pcgError: string } | { result: any } | { error: string }
  const actionData = useActionData<ActionData>()

  useToast(toast)

  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    providerId?: string
  }>({ isOpen: false, mode: 'create' })

  useEffect(() => {
    const action = searchParams.action
    const providerId = searchParams.providerId
    if (action === 'create') setDrawerState({ isOpen: true, mode: 'create' })
    else if (action === 'edit' && providerId) setDrawerState({ isOpen: true, mode: 'edit', providerId })
    else setDrawerState({ isOpen: false, mode: 'create' })
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

  const selectedProvider = drawerState.providerId ? customer.providers.find(p => p.id === drawerState.providerId) : null

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

                {/* User NPIs (from PCG) */}
                <div className="bg-white shadow rounded-lg">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <div className="flex justify-between items-center">
                      <div>
                        <h2 className="text-lg font-medium text-gray-900">User NPIs (from PCG)</h2>
                        {actionData && 'pcgNpis' in actionData ? (
                            <p className="text-sm text-gray-500">
                              {actionData.pcgNpis.total} total • page {actionData.pcgNpis.page} (size{' '}
                              {actionData.pcgNpis.pageSize})
                            </p>
                        ) : (
                            <p className="text-sm text-gray-500">Click “Fetch” to load NPIs registered for your organization.</p>
                        )}
                      </div>
                      <Form method="post">
                        <input type="hidden" name="intent" value="fetch-remote-npis" />
                        <StatusButton
                            type="submit"
                            disabled={isPending}
                            status={isPending ? 'pending' : 'idle'}
                            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                        >
                          <Icon name="update" className="h-4 w-4 mr-2" />
                          Fetch
                        </StatusButton>
                      </Form>
                    </div>
                  </div>

                  {actionData && 'pcgError' in actionData && (
                      <div className="px-6 py-4">
                        <div className="rounded-md bg-red-50 p-4">
                          <div className="flex">
                            <div className="flex-shrink-0">
                              <Icon name="question-mark-circled" className="h-5 w-5 text-red-400" />
                            </div>
                            <div className="ml-3">
                              <h3 className="text-sm font-medium text-red-800">Failed to fetch NPIs</h3>
                              <div className="mt-2 text-sm text-red-700">{actionData.pcgError}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                  )}

                  {actionData && 'pcgNpis' in actionData && (
                      <div className="overflow-hidden">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPI</th>
                          </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                          {actionData.pcgNpis.npis.length === 0 ? (
                              <tr>
                                <td className="px-6 py-4 text-sm text-gray-500" colSpan={2}>
                                  No NPIs returned for your organization.
                                </td>
                              </tr>
                          ) : (
                              actionData.pcgNpis.npis.map((npi: string, idx: number) => (
                                  <tr key={npi} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{idx + 1}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{npi}</td>
                                  </tr>
                              ))
                          )}
                          </tbody>
                        </table>
                      </div>
                  )}
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

                  {customer.providers.length === 0 ? (
                      <div className="px-6 py-12 text-center">
                        <Icon name="id-card" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-gray-900 mb-2">No provider NPIs found</h3>
                        <p className="text-gray-500 mb-6">
                          {searchParams.search
                              ? `No providers match your search criteria "${searchParams.search}".`
                              : 'Get started by adding your first provider NPI.'}
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
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPI</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Provider Name
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Provider Group
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Assigned Users
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                          </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                          {customer.providers.map(provider => {
                            // ✅ UI gating mirrors server logic:
                            const canToggle =
                                isCustomerAdmin ||
                                (isProviderGroupAdmin &&
                                    (provider.providerGroupId === null ||
                                        provider.providerGroupId === user.providerGroupId))

                            return (
                                <tr key={provider.id} className="hover:bg-gray-50">
                                  <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="text-sm font-medium text-gray-900">{provider.npi}</div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="text-sm text-gray-900">{provider.name || 'No name'}</div>
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="text-sm text-gray-900">{provider.providerGroup?.name || 'No group'}</div>
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{provider._count.userNpis}</td>
                                  <td className="px-6 py-4 whitespace-nowrap">
                                <span
                                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                        provider.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                                    }`}
                                >
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

                                      {/* Activate / Inactivate */}
                                      <Form method="post" className="inline">
                                        <input type="hidden" name="intent" value="toggle-active" />
                                        <input type="hidden" name="providerId" value={provider.id} />
                                        <input type="hidden" name="active" value={(!provider.active).toString()} />
                                        <button
                                            type="submit"
                                            disabled={!canToggle}
                                            className={`p-1 ${
                                                provider.active
                                                    ? 'text-amber-600 hover:text-amber-800'
                                                    : 'text-green-600 hover:text-green-800'
                                            } ${!canToggle ? 'opacity-40 cursor-not-allowed' : ''}`}
                                            title={
                                              canToggle
                                                  ? provider.active
                                                      ? 'Mark Inactive'
                                                      : 'Activate'
                                                  : 'You do not have permission to change this provider'
                                            }
                                        >
                                          <Icon name={provider.active ? 'lock-closed' : 'lock-open-1'} className="h-4 w-4" />
                                        </button>
                                      </Form>
                                    </div>
                                  </td>
                                </tr>
                            )
                          })}
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

                {/* Activity Log */}
                <div className="bg-white shadow rounded-lg p-6 mt-8">
                  <h2 className="text-lg font-medium text-gray-900 mb-2">Activity Log</h2>
                  <p className="text-sm text-gray-500 mb-4">All provider events (most recent first)</p>

                  <div className="max-h-96 overflow-y-auto border rounded-md">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">When</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">NPI</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Event</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">user</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Details</th>
                      </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                      {events.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-6 text-sm text-gray-500">
                              No activity yet.
                            </td>
                          </tr>
                      ) : (
                          events.map((ev: any) => (
                              <tr key={ev.id}>
                                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                                  {new Date(ev.createdAt).toLocaleString()}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                                  {ev.provider?.npi}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                                  {ev.provider?.name ?? '—'}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                                {ev.kind}
                              </span>
                                  {ev.message ? <span className="ml-2 text-sm text-gray-700">{ev.message}</span> : null}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                                  {ev.actor?.name || ev.actor?.email || '—'}
                                </td>
                                <td className="px-4 py-3 text-sm">
                                  {/* Toggleable JSON of the raw API body or any event payload */}
                                  <JsonViewer data={ev.payload} />
                                </td>
                              </tr>
                          ))
                      )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </InterexLayout>
        </div>

        {/* Create Provider Drawer */}
        <Drawer isOpen={drawerState.isOpen && drawerState.mode === 'create'} onClose={closeDrawer} title="Add Provider NPI" size="md">
          <Form method="post" {...getFormProps(createForm)}>
            <input type="hidden" name="intent" value="create" />
            <div className="space-y-6">
              <Field
                  labelProps={{ children: 'National Provider Identifier (NPI) *' }}
                  inputProps={{
                    ...getInputProps(createFields.npi, { type: 'text' }),
                    placeholder: 'Enter 10-digit NPI number',
                  }}
                  errors={createFields.npi.errors}
              />

              <Field
                  labelProps={{ children: 'Provider Name *' }}
                  inputProps={{
                    ...getInputProps(createFields.name, { type: 'text' }),
                    placeholder: 'e.g., Dr. John Smith',
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
                <option value="">— No group —</option>
                {customer.providerGroups.map(group => (
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
                      labelProps={{children: 'National Provider Identifier (NPI) - Read Only'}}
                      inputProps={{
                        type: 'text',
                        value: selectedProvider.npi,
                        disabled: true,
                        className: 'bg-gray-50 text-gray-500',
                      }}
                  />

                  <Field
                      labelProps={{children: 'Provider Name *'}}
                      inputProps={{
                        ...getInputProps(editFields.name, {type: 'text'}),
                        defaultValue: selectedProvider.name || '',
                        placeholder: 'e.g., Dr. John Smith',
                      }}
                      errors={editFields.name.errors}
                  />

                  <SelectField
                      labelProps={{children: 'Provider Group (Optional)'}}
                      selectProps={{
                        ...getInputProps(editFields.providerGroupId, {type: 'text'}),
                        defaultValue: selectedProvider.providerGroupId || '',
                      }}
                      errors={editFields.providerGroupId.errors}
                  >
                    <option value="">— No group —</option>
                    {customer.providerGroups.map(group => (
                        <option key={group.id} value={group.id}>
                          🏥 {group.name}
                        </option>
                    ))}
                  </SelectField>

                  <div>
                    <label className="flex items-center">
                      {/* Always send false; overridden if checkbox is checked */}
                      <input
                          {...getInputProps(editFields.active, {type: 'hidden'})}
                          value="false"
                      />
                      <input
                          {...getInputProps(editFields.active, {type: 'checkbox'})}
                          value="true"
                          defaultChecked={selectedProvider.active}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <span className="ml-2 block text-sm text-gray-900">Active</span>
                    </label>
                    <ErrorList errors={editFields.active.errors}/>
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

                  {/* Quick facts */}
                  <div className="mt-8 pt-6 border-t border-gray-200">
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Provider Information</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center">
                          <Icon name="avatar" className="h-6 w-6 text-blue-600 mr-2"/>
                          <div>
                            <p className="text-xs font-medium text-gray-900">Assigned Users</p>
                            <p className="text-lg font-bold text-blue-600">{selectedProvider._count.userNpis}</p>
                          </div>
                        </div>
                      </div>

                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center">
                          <Icon name="id-card" className="h-6 w-6 text-green-600 mr-2"/>
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

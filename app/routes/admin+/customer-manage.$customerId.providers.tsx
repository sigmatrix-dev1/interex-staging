// Admin Providers & NPIs management (System Admin only)
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod, getZodConstraint } from '@conform-to/zod'
import React from 'react'
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
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit as auditEvent } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

// Schemas (restored after accidental removal during patch)
const CreateProviderSchema = z.object({
  intent: z.literal('create'),
  npi: z.string().min(10).max(10),
  name: z.string().min(1, 'Provider name is required'),
  providerGroupId: z.string().optional(),
})

const UpdateProviderSchema = z.object({
  intent: z.literal('update'),
  providerId: z.string().min(1),
  name: z.string().min(1, 'Provider name is required').optional(),
  providerGroupId: z.string().optional(),
  active: z.boolean().optional(),
})

const ToggleActiveSchema = z.object({
  intent: z.literal('toggle-active'),
  providerId: z.string().min(1),
  active: z.boolean(),
})

// Local helpers copied/adapted from customer provider NPIs page
async function logProviderEvent(input: {
  providerId: string
  customerId: string
  actorId?: string | null
  kind: 'CREATED' | 'UPDATED' | 'ACTIVATED' | 'INACTIVATED' | 'GROUP_ASSIGNED' | 'GROUP_UNASSIGNED' | 'PCG_ADD_ATTEMPT' | 'PCG_ADD_ERROR'
  message?: string
  payload?: any
}) {
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

async function writeAudit(input: {
  userId: string
  userEmail?: string | null
  userName?: string | null
  rolesCsv: string
  customerId: string | null
  action:
    | 'PROVIDER_CREATE'
    | 'PROVIDER_UPDATE'
    | 'PROVIDER_TOGGLE_ACTIVE'
    | 'PCG_ADD_PROVIDER_NPI'
    | 'PROVIDER_FETCH_REMOTE_NPIS'
    | 'PROVIDER_ASSIGN_USER_ATTEMPT'
    | 'PROVIDER_DELETE'
  entityId?: string | null
  success: boolean
  message?: string | null
  route?: string
  meta?: unknown | null
  payload?: unknown | null
}) {
  try {
    await auditEvent.admin({
      action: input.action,
      status: input.success ? 'SUCCESS' : 'FAILURE',
      actorType: 'USER',
      actorId: input.userId,
      actorDisplay: input.userName || input.userEmail || null,
      customerId: input.customerId,
      entityType: 'PROVIDER',
      entityId: input.entityId ?? null,
      summary: input.message || null,
      metadata: {
        rolesCsv: input.rolesCsv,
        route: input.route ?? '/admin/customer-manage',
        meta: input.meta ?? undefined,
        payload: input.payload ?? undefined,
      },
    })
  } catch {}
}

const UpdateGroupSchema = z.object({
  intent: z.literal('update-group'),
  providerId: z.string().min(1, 'Provider ID is required'),
  providerGroupId: z.string().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
  const [{ getToast }] = await Promise.all([
    import('#app/utils/toast.server.ts'),
  ])

  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, roles: { select: { name: true } } },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })

  // Require System Admin strictly
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const customerId = params.customerId
  if (!customerId) throw new Response('Customer ID is required', { status: 400 })

  const url = new URL(request.url)
  const searchParams = {
    search: url.searchParams.get('search') || '',
    action: url.searchParams.get('action') || '',
    providerId: url.searchParams.get('providerId') || '',
  }

  const whereConditions: any = { customerId }
  if (searchParams.search) {
    whereConditions.OR = [
      { npi: { contains: searchParams.search } },
      { name: { contains: searchParams.search } },
    ]
  }

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      providers: {
        where: whereConditions,
        include: {
          providerGroup: true,
          userNpis: {
            include: { user: { select: { id: true, name: true, email: true, providerGroupId: true } } },
          },
          _count: {
            select: {
              userNpis: true,
              submissions: true,
              PrepayLetter: true,
              PostpayLetter: true,
              PostpayOtherLetter: true,
            },
          },
          listDetail: { select: { providerName: true } },
          registrationStatus: { select: { providerName: true } },
        },
        orderBy: { npi: 'asc' },
      },
      providerGroups: { orderBy: { name: 'asc' } },
    },
  })
  if (!customer) throw new Response('Customer not found', { status: 404 })

  const events = await prisma.providerEvent.findMany({
    where: { customerId },
    include: {
      provider: { select: { npi: true, name: true } },
      actor: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  // Candidates for assignment: active, non-admin users in this customer
  const assignableUsers = await prisma.user.findMany({
    where: {
      customerId,
      active: true,
      deletedAt: null,
      roles: {
        none: { name: { in: [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN, INTEREX_ROLES.SYSTEM_ADMIN] } },
      },
    },
    select: { id: true, name: true, email: true, providerGroupId: true },
    orderBy: { name: 'asc' },
  })

  // Guard-rail metadata per provider
  const providerEligibility = customer.providers.map(p => {
    const assignedUsers = p.userNpis.map(l => l.user)
    const providerGroupId = p.providerGroupId || null
    const hasProviderGroup = Boolean(providerGroupId)
    const anyAssignedUngrouped = assignedUsers.some(u => !u.providerGroupId)
    const anyAssignedGrouped = assignedUsers.some(u => u.providerGroupId)
    const assignedGroupIds = Array.from(new Set(assignedUsers.map(u => u.providerGroupId).filter(Boolean))) as string[]

    let eligibleUserGroupScope: 'UNGROUPED_ONLY' | 'SPECIFIC_GROUP' = hasProviderGroup ? 'SPECIFIC_GROUP' : 'UNGROUPED_ONLY'
    let groupChangeBlocked = false
    let groupChangeBlockReason: string | null = null
    let userAssignReason: string | null = null

    if (!hasProviderGroup) {
      if (anyAssignedUngrouped) {
        groupChangeBlocked = true
        groupChangeBlockReason = 'NPI has assigned user/s who are not part of a Provider Group. Unassign them first and then assign a Provider Group.'
      }
      if (anyAssignedGrouped) {
        userAssignReason = 'Provider ungrouped: only users without a group can be assigned.'
      }
    } else {
      if (anyAssignedUngrouped) {
        userAssignReason = 'Provider is in a group but has ungrouped users assigned (remove or add them to the group).'
      }
    }

    return {
      id: p.id,
      providerGroupId,
      eligibleUserGroupScope,
      groupChangeBlocked,
      groupChangeBlockReason,
      userAssignReason,
      assignedGroupIds,
      anyAssignedUngrouped,
    }
  })

  const providerGroupMismatches = customer.providers
    .filter(p => p.userNpis.some(link => link.user.providerGroupId && link.user.providerGroupId !== p.providerGroupId))
    .map(p => ({
      id: p.id,
      npi: p.npi,
      name: p.name,
      providerGroupId: p.providerGroupId,
      userGroups: Array.from(
        new Set(
          p.userNpis
            .map(l => l.user.providerGroupId)
            .filter((g): g is string => Boolean(g) && g !== p.providerGroupId),
        ),
      ),
    }))

  const { toast, headers } = await getToast(request)

  return data(
    {
      user,
      customer,
      searchParams,
      toast,
      events,
      assignableUsers,
      providerGroupMismatches,
      providerEligibility,
    },
    { headers: headers ?? undefined },
  )
}

export async function action({ request, params }: ActionFunctionArgs) {
  const [
    { redirectWithToast },
    { pcgGetUserNpis, pcgAddProviderNpi },
  ] = await Promise.all([
    import('#app/utils/toast.server.ts'),
    import('#app/services/pcg-hih.server.ts'),
  ])

  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, roles: { select: { name: true } } },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })

  // Only System Admins may post here
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const customerId = params.customerId
  if (!customerId) throw new Response('Customer ID is required', { status: 400 })

  const rolesCsv = user.roles.map(r => r.name).join(',')
  const org = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } })
  const orgName = org?.name ?? ''

  const formData = await request.formData()
  const intent = String(formData.get('intent') || '')

  const baseUrl = `/admin/customer-manage/${customerId}/providers`

  if (intent === 'fetch-remote-npis') {
    try {
      const list = await pcgGetUserNpis()
      try {
        await writeAudit({
          userId,
          rolesCsv,
          customerId,
          action: 'PROVIDER_FETCH_REMOTE_NPIS',
          success: true,
          message: 'Fetched provider NPIs from PCG',
          payload: { total: list?.total, page: list?.page, pageSize: list?.pageSize },
          route: baseUrl,
        })
      } catch {}
      return data({ pcgNpis: list })
    } catch (err: any) {
      try {
        await writeAudit({
          userId,
          rolesCsv,
          customerId,
          action: 'PROVIDER_FETCH_REMOTE_NPIS',
          success: false,
          message: 'Failed to fetch provider NPIs from PCG',
          payload: { error: String(err?.message || err) },
          route: baseUrl,
        })
      } catch {}
      return data({ pcgError: err?.message ?? 'Failed to fetch NPIs from PCG.' }, { status: 500 })
    }
  }

  if (intent === 'create') {
    const submission = parseWithZod(formData, { schema: CreateProviderSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { npi, name } = submission.value
    const providerGroupIdRaw = submission.value.providerGroupId
    const providerGroupId = providerGroupIdRaw && providerGroupIdRaw.length > 0 ? providerGroupIdRaw : null

    // Only block if NPI exists for THIS customer
    const existingProvider = await prisma.provider.findFirst({ where: { npi, customerId } })
    if (existingProvider) {
      return data(
        { result: submission.reply({ fieldErrors: { npi: ['This NPI is already registered for this customer'] } }) },
        { status: 400 },
      )
    }

    // Try to add in PCG; tolerate duplicates
    let pcgAddOkOrDuplicate = false
    try {
      await pcgAddProviderNpi({ providerNPI: npi, customerName: orgName })
      pcgAddOkOrDuplicate = true
      try {
        await writeAudit({
          userId,
          rolesCsv,
          customerId,
          action: 'PCG_ADD_PROVIDER_NPI',
          entityId: null,
          success: true,
          message: 'PCG AddProviderNPI ok',
          payload: { npi, customerName: orgName },
          route: baseUrl,
        })
      } catch {}
    } catch (err: any) {
      const msg = String(err?.message || '')
      const duplicate = /(already|exist|registered|duplicate|present)/i.test(msg)
      if (!duplicate) {
        await logProviderEvent({
          providerId: 'unknown',
          customerId,
          actorId: userId,
          kind: 'PCG_ADD_ERROR',
          message: 'PCG AddProviderNPI failed',
          payload: { npi, orgName, error: msg },
        }).catch(() => {})
        await writeAudit({
          userId,
          rolesCsv,
          customerId,
          action: 'PCG_ADD_PROVIDER_NPI',
          entityId: null,
          success: false,
          message: 'PCG AddProviderNPI failed',
          payload: { npi, customerName: orgName, error: msg },
          route: baseUrl,
        }).catch(() => {})
        return data({ result: submission.reply({ formErrors: [msg || 'Failed to add NPI in PCG.'] }) }, { status: 400 })
      } else {
        pcgAddOkOrDuplicate = true
        await writeAudit({
          userId,
          rolesCsv,
          customerId,
          action: 'PCG_ADD_PROVIDER_NPI',
          entityId: null,
          success: true,
          message: 'PCG AddProviderNPI duplicate (already present)',
          payload: { npi, customerName: orgName },
          route: baseUrl,
        }).catch(() => {})
      }
    }

    if (providerGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({ where: { id: providerGroupId, customerId } })
      if (!providerGroup) {
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
          { status: 400 },
        )
      }
    }

    const created = await prisma.provider.create({ data: { npi, name, customerId, providerGroupId, active: true } })

    await logProviderEvent({
      providerId: created.id,
      customerId,
      actorId: userId,
      kind: 'PCG_ADD_ATTEMPT',
      message: 'PCG Add Provider NPI - api call attempted',
      payload: { npi, customerName: orgName },
    })
    await logProviderEvent({
      providerId: created.id,
      customerId,
      actorId: userId,
      kind: 'CREATED',
      message: `Provider created (${npi})`,
      payload: { name, providerGroupId },
    })
    if (providerGroupId) {
      await logProviderEvent({
        providerId: created.id,
        customerId,
        actorId: userId,
        kind: 'GROUP_ASSIGNED',
        message: `Assigned to group ${providerGroupId}`,
        payload: { field: 'providerGroupId', to: providerGroupId },
      })
    }

    await writeAudit({
      userId,
      rolesCsv,
      customerId,
      action: 'PROVIDER_CREATE',
      entityId: created.id,
      success: true,
      message: `Provider created (${npi})`,
      payload: { npi, name, providerGroupId, pcgAddAttempted: pcgAddOkOrDuplicate },
      route: baseUrl,
    }).catch(() => {})

    return redirectWithToast(baseUrl, {
      type: 'success',
      title: 'Provider NPI created',
      description: `NPI ${npi} (${name}) has been added.`,
    })
  }

  if (intent === 'update') {
    const submission = parseWithZod(formData, { schema: UpdateProviderSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { providerId, name, providerGroupId, active } = submission.value
    const newGroupId = providerGroupId && providerGroupId.length > 0 ? providerGroupId : null

    const existingProvider = await prisma.provider.findFirst({ where: { id: providerId, customerId } })
    if (!existingProvider) {
      return redirectWithToast(baseUrl, {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized to edit this provider.',
      })
    }

    if (newGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({ where: { id: newGroupId, customerId } })
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
      data: { name, providerGroupId: newGroupId, ...(typeof active !== 'undefined' ? { active } : {}) },
    })

    if (nameChanged) {
      await logProviderEvent({
        providerId,
        customerId,
        actorId: userId,
        kind: 'UPDATED',
        message: `Name: "${oldName || '\u2014'}" \u2192 "${name || '\u2014'}"`,
        payload: { field: 'name', from: oldName, to: name },
      })
    }
    if (groupChanged) {
      await logProviderEvent({
        providerId,
        customerId,
        actorId: userId,
        kind: newGroupId ? 'GROUP_ASSIGNED' : 'GROUP_UNASSIGNED',
        message: newGroupId ? `Assigned to group ${newGroupId}` : 'Unassigned from provider group',
        payload: { field: 'providerGroupId', from: oldGroupId, to: newGroupId },
      })
    }
    if (activeChanged) {
      await logProviderEvent({
        providerId,
        customerId,
        actorId: userId,
        kind: active ? 'ACTIVATED' : 'INACTIVATED',
        message: active ? 'Provider activated (via edit)' : 'Provider inactivated (via edit)',
      })
    }

    await writeAudit({
      userId,
      rolesCsv,
      customerId,
      action: 'PROVIDER_UPDATE',
      entityId: providerId,
      success: true,
      message: 'Provider updated',
      meta: { changed: [
        ...(nameChanged ? ['name'] : []),
        ...(groupChanged ? ['providerGroupId'] : []),
        ...(activeChanged ? ['active'] : []),
      ] },
      payload: { name, providerGroupId: newGroupId, ...(typeof active !== 'undefined' ? { active } : {}) },
      route: baseUrl,
    }).catch(() => {})

    return redirectWithToast(baseUrl, {
      type: 'success',
      title: 'Provider NPI updated',
      description: `NPI ${existingProvider.npi} (${name}) has been updated successfully.`,
    })
  }

  if (intent === 'toggle-active') {
    const submission = parseWithZod(formData, { schema: ToggleActiveSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { providerId, active } = submission.value
    const provider = await prisma.provider.findFirst({ where: { id: providerId, customerId } })
    if (!provider) {
      return redirectWithToast(baseUrl, {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized.',
      })
    }
    await prisma.provider.update({ where: { id: providerId }, data: { active } })
    await logProviderEvent({
      providerId,
      customerId,
      actorId: userId,
      kind: active ? 'ACTIVATED' : 'INACTIVATED',
      message: active ? 'Provider activated' : 'Provider inactivated',
    })
    await writeAudit({
      userId,
      rolesCsv,
      customerId,
      action: 'PROVIDER_TOGGLE_ACTIVE',
      entityId: providerId,
      success: true,
      message: active ? 'Activated' : 'Inactivated',
      payload: { active },
      route: baseUrl,
    }).catch(() => {})
    return redirectWithToast(baseUrl, {
      type: 'success',
      title: active ? 'Activated' : 'Inactivated',
      description: `NPI ${provider.npi} has been ${active ? 'activated' : 'inactivated'}.`,
    })
  }

  if (intent === 'update-group') {
    const submission = parseWithZod(formData, { schema: UpdateGroupSchema })
    if (submission.status !== 'success') {
      return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
    }
    const { providerId, providerGroupId } = submission.value
    const newGroupId = providerGroupId && providerGroupId.length > 0 ? providerGroupId : null

    const provider = await prisma.provider.findFirst({
      where: { id: providerId, customerId },
      select: { id: true, npi: true, providerGroupId: true, userNpis: { select: { id: true, user: { select: { providerGroupId: true } } } } },
    })
    if (!provider) {
      return redirectWithToast(baseUrl, {
        type: 'error',
        title: 'Provider not found',
        description: 'Provider not found or not authorized.',
      })
    }

    if (newGroupId) {
      const groupOk = await prisma.providerGroup.findFirst({ where: { id: newGroupId, customerId }, select: { id: true } })
      if (!groupOk) {
        return redirectWithToast(baseUrl, {
          type: 'error',
          title: 'Invalid group',
          description: 'Selected provider group is invalid.',
        })
      }
      // Guard Rail: cannot add group if any assigned users are ungrouped and provider currently has no group
      const anyUngroupedUsers = provider.userNpis.some(l => !l.user.providerGroupId)
      if (anyUngroupedUsers && !provider.providerGroupId) {
        await writeAudit({
          userId,
          rolesCsv,
          customerId,
          action: 'PROVIDER_UPDATE',
          entityId: provider.id,
          success: false,
          message: 'Blocked group assignment: ungrouped users exist',
          payload: { providerId: provider.id, attemptedGroupId: newGroupId, reason: 'UNGROUPED_USER_BLOCK' },
          route: baseUrl,
        }).catch(() => {})
        return redirectWithToast(baseUrl, {
          type: 'error',
          title: 'Group assignment blocked',
          description: 'Cannot assign a group while ungrouped users are assigned. Move users into a group first.',
        })
      }
    }

    const oldGroupId = provider.providerGroupId
    if (oldGroupId === newGroupId) {
      return redirectWithToast(baseUrl, {
        type: 'success',
        title: 'No changes',
        description: 'Provider group unchanged.',
      })
    }

    await prisma.provider.update({ where: { id: provider.id }, data: { providerGroupId: newGroupId } })
    await logProviderEvent({
      providerId: provider.id,
      customerId,
      actorId: userId,
      kind: newGroupId ? 'GROUP_ASSIGNED' : 'GROUP_UNASSIGNED',
      message: newGroupId ? `Assigned to group ${newGroupId}` : 'Unassigned from provider group',
      payload: { field: 'providerGroupId', from: oldGroupId, to: newGroupId },
    })
    await writeAudit({
      userId,
      rolesCsv,
      customerId,
      action: 'PROVIDER_UPDATE',
      entityId: provider.id,
      success: true,
      message: newGroupId ? 'Provider group assigned' : 'Provider group unassigned',
      payload: { providerGroupId: newGroupId },
      meta: { changed: ['providerGroupId'] },
      route: baseUrl,
    }).catch(() => {})
    return redirectWithToast(baseUrl, {
      type: 'success',
      title: newGroupId ? 'Group assigned' : 'Group removed',
      description: `NPI ${provider.npi} ${newGroupId ? 'assigned to group' : 'unassigned from group'}.`,
    })
  }

  if (intent === 'delete') {
    const providerId = String(formData.get('providerId') || '')
    const baseUrl = `/admin/customer-manage/${customerId}/providers`
    if (!providerId) {
      return redirectWithToast(baseUrl, { type: 'error', title: 'Missing provider', description: 'Provider id is required.' })
    }
    const provider = await prisma.provider.findFirst({
      where: { id: providerId, customerId },
      select: {
        id: true,
        npi: true,
        name: true,
        _count: { select: { userNpis: true, submissions: true, PrepayLetter: true, PostpayLetter: true, PostpayOtherLetter: true } },
      },
    })
    if (!provider) {
      return redirectWithToast(baseUrl, { type: 'error', title: 'Provider not found', description: 'Provider not found or not authorized.' })
    }
    // Safety: cannot delete if there are dependent records
    if (
      provider._count.userNpis > 0 ||
      provider._count.submissions > 0 ||
      provider._count.PrepayLetter > 0 ||
      provider._count.PostpayLetter > 0 ||
      provider._count.PostpayOtherLetter > 0
    ) {
      await writeAudit({
        userId,
        rolesCsv,
        customerId,
        action: 'PROVIDER_DELETE',
        entityId: provider.id,
        success: false,
        message: 'Delete blocked due to dependent records',
        payload: { counts: provider._count },
        route: baseUrl,
      }).catch(() => {})
      return redirectWithToast(baseUrl, {
        type: 'error',
        title: 'Delete blocked',
        description: 'This NPI cannot be deleted because it has assigned users, submissions, or letters.',
      })
    }

    // Delete provider and cascade removes userNpis and provider events due to onDelete: Cascade
    await prisma.provider.delete({ where: { id: provider.id } })

    await logProviderEvent({
      providerId: provider.id,
      customerId,
      actorId: userId,
      kind: 'UPDATED',
      message: 'Provider deleted',
      payload: { npi: provider.npi, name: provider.name },
    }).catch(() => {})

    await writeAudit({
      userId,
      rolesCsv,
      customerId,
      action: 'PROVIDER_DELETE',
      entityId: provider.id,
      success: true,
      message: `Provider deleted (${provider.npi})`,
      payload: { npi: provider.npi, name: provider.name },
      route: baseUrl,
    }).catch(() => {})

    return redirectWithToast(baseUrl, {
      type: 'success',
      title: 'Provider deleted',
      description: `NPI ${provider.npi} has been deleted.`,
    })
  }

  if (intent === 'update-user-assignment' || intent === 'bulk-update-user-assignments') {
    const providerId = String(formData.get('providerId') || '')
    if (!providerId) {
      return redirectWithToast(baseUrl, { type: 'error', title: 'Missing provider', description: 'Provider id is required.' })
    }
    const provider = await prisma.provider.findFirst({
      where: { id: providerId, customerId },
      select: { id: true, providerGroupId: true, npi: true, userNpis: { select: { id: true, user: { select: { providerGroupId: true, roles: { select: { name: true } }, name: true, email: true } } } } },
    })
    if (!provider) {
      return redirectWithToast(baseUrl, { type: 'error', title: 'Provider not found', description: 'Provider not found or not authorized.' })
    }

    const assignUserIds = formData.getAll('assignUserIds').map(v => String(v)).filter(Boolean)
    const unassignLinkIds = formData.getAll('unassignLinkIds').map(v => String(v)).filter(Boolean)
    const unassign = formData.get('unassign') === 'true'
    const userAssignId = String(formData.get('userId') || '')

    const auditAttempt = async (success: boolean, payload: any, message: string) => {
      await writeAudit({
        userId,
        rolesCsv,
        customerId,
        action: 'PROVIDER_ASSIGN_USER_ATTEMPT',
        entityId: provider.id,
        success,
        message,
        payload,
        route: baseUrl,
      }).catch(() => {})
    }

    // Single unassign flow
    if (intent === 'update-user-assignment') {
      if (unassign) {
        const linkId = String(formData.get('linkId') || '')
        if (!linkId) {
          return redirectWithToast(baseUrl, { type: 'error', title: 'Missing assignment', description: 'Assignment link id required to unassign.' })
        }
        await prisma.userNpi.delete({ where: { id: linkId } })
        return redirectWithToast(baseUrl, { type: 'success', title: 'User unassigned', description: `User removed from NPI ${provider.npi}.` })
      }

      if (!userAssignId) {
        return redirectWithToast(baseUrl, { type: 'error', title: 'Missing user', description: 'Please select a user to assign.' })
      }

      const targetUser = await prisma.user.findFirst({
        where: { id: userAssignId, customerId },
        select: { id: true, providerGroupId: true, name: true, email: true, roles: { select: { name: true } } },
      })
      if (!targetUser) {
        return redirectWithToast(baseUrl, { type: 'error', title: 'User not found', description: 'User not found or not authorized.' })
      }
      if (targetUser.roles?.some(r => [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN, INTEREX_ROLES.SYSTEM_ADMIN].includes(r.name))) {
        await auditAttempt(false, { providerId: provider.id, targetUserId: targetUser.id, reason: 'ADMIN_ROLE' }, 'Blocked admin assignment attempt')
        return redirectWithToast(baseUrl, { type: 'error', title: 'Invalid assignment', description: 'Administrators cannot be directly assigned to NPIs.' })
      }
      if (!provider.providerGroupId && targetUser.providerGroupId) {
        await auditAttempt(false, { providerId: provider.id, targetUserId: targetUser.id, reason: 'PROVIDER_UNGROUPED_USER_GROUPED' }, 'Blocked assignment: provider ungrouped, user grouped')
        return redirectWithToast(baseUrl, { type: 'error', title: 'Invalid assignment', description: 'This NPI has no group. You can only assign users who are not in a group.' })
      }
      if (provider.providerGroupId && provider.providerGroupId !== targetUser.providerGroupId) {
        await auditAttempt(false, { providerId: provider.id, targetUserId: targetUser.id, providerGroupId: provider.providerGroupId, userGroupId: targetUser.providerGroupId, reason: 'GROUP_MISMATCH' }, 'Blocked assignment: provider grouped, user different or ungrouped')
        return redirectWithToast(baseUrl, { type: 'error', title: 'Group mismatch', description: 'User must belong to the same provider group as the NPI.' })
      }
      const existing = await prisma.userNpi.findFirst({ where: { userId: targetUser.id, providerId: provider.id } })
      if (existing) {
        return redirectWithToast(baseUrl, { type: 'message', title: 'Already assigned', description: 'Selected user is already assigned to this NPI.' })
      }
      await prisma.userNpi.create({ data: { userId: targetUser.id, providerId: provider.id } })
      await auditAttempt(true, { providerId: provider.id, targetUserId: targetUser.id }, 'User assigned to provider')
      return redirectWithToast(baseUrl, { type: 'success', title: 'User assigned', description: `Assigned ${targetUser.name || targetUser.email} to NPI ${provider.npi}.` })
    }

    // Bulk flow
    if (assignUserIds.length === 0 && unassignLinkIds.length === 0) {
      return redirectWithToast(baseUrl, { type: 'message', title: 'No changes', description: 'You did not select any users to assign or unassign.' })
    }
    const assignedSummary: string[] = []
    const unassignedSummary: string[] = []
    const failedSummary: string[] = []

    for (const uid of assignUserIds) {
      const existing = await prisma.userNpi.findFirst({ where: { userId: uid, providerId: provider.id } })
      if (existing) {
        failedSummary.push('Already assigned user skipped')
        continue
      }
      const targetUser = await prisma.user.findFirst({
        where: { id: uid, customerId },
        select: { id: true, name: true, email: true, providerGroupId: true, roles: { select: { name: true } } },
      })
      if (!targetUser) {
        failedSummary.push('User not found')
        continue
      }
      if (targetUser.roles?.some(r => [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN, INTEREX_ROLES.SYSTEM_ADMIN].includes(r.name))) {
        failedSummary.push(`${targetUser.name || targetUser.email}: admin blocked`)
        await auditAttempt(false, { providerId: provider.id, targetUserId: targetUser.id, reason: 'ADMIN_ROLE' }, 'Blocked admin assignment attempt')
        continue
      }
      if (!provider.providerGroupId && targetUser.providerGroupId) {
        failedSummary.push(`${targetUser.name || targetUser.email}: grouped user into ungrouped provider`)
        await auditAttempt(false, { providerId: provider.id, targetUserId: targetUser.id, reason: 'PROVIDER_UNGROUPED_USER_GROUPED' }, 'Blocked assignment: provider ungrouped, user grouped')
        continue
      }
      if (provider.providerGroupId && provider.providerGroupId !== targetUser.providerGroupId) {
        failedSummary.push(`${targetUser.name || targetUser.email}: group mismatch`)
        await auditAttempt(false, { providerId: provider.id, targetUserId: targetUser.id, providerGroupId: provider.providerGroupId, userGroupId: targetUser.providerGroupId, reason: 'GROUP_MISMATCH' }, 'Blocked assignment: provider grouped, user different or ungrouped')
        continue
      }
      try {
        await prisma.userNpi.create({ data: { userId: targetUser.id, providerId: provider.id } })
        assignedSummary.push(targetUser.name || targetUser.email || targetUser.id)
        await auditAttempt(true, { providerId: provider.id, targetUserId: targetUser.id }, 'User assigned to provider (bulk)')
      } catch {
        failedSummary.push(`${targetUser.name || targetUser.email || targetUser.id}: error`)
      }
    }

    if (unassignLinkIds.length > 0) {
      const links = await prisma.userNpi.findMany({ where: { id: { in: unassignLinkIds }, providerId: provider.id }, select: { id: true, user: { select: { name: true, email: true } } } })
      for (const link of links) {
        try {
          await prisma.userNpi.delete({ where: { id: link.id } })
          unassignedSummary.push(link.user.name || link.user.email || link.id)
        } catch {
          failedSummary.push(`${link.user.name || link.user.email || link.id}: unassign error`)
        }
      }
    }

    const parts: string[] = []
    if (assignedSummary.length) parts.push(`Assigned ${assignedSummary.length}`)
    if (unassignedSummary.length) parts.push(`Unassigned ${unassignedSummary.length}`)
    if (failedSummary.length) parts.push(`Failed ${failedSummary.length}`)
    const title = parts.join(' • ') || 'No changes'
    const description = [
      assignedSummary.length ? `Assigned: ${assignedSummary.slice(0, 5).join(', ')}${assignedSummary.length > 5 ? '…' : ''}` : null,
      unassignedSummary.length ? `Unassigned: ${unassignedSummary.slice(0, 5).join(', ')}${unassignedSummary.length > 5 ? '…' : ''}` : null,
      failedSummary.length ? `Skipped: ${failedSummary.slice(0, 5).join('; ')}${failedSummary.length > 5 ? '…' : ''}` : null,
    ].filter(Boolean).join(' | ')

    return redirectWithToast(baseUrl, {
      type: failedSummary.length && !assignedSummary.length && !unassignedSummary.length ? 'message' : 'success',
      title: title || 'User assignments',
      description: description || 'Bulk user assignment operation completed.',
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function AdminCustomerProvidersPage() {
  const { user, customer, searchParams, toast, events, assignableUsers, providerGroupMismatches, providerEligibility } =
    useLoaderData<typeof loader>()
  const [urlSearchParams, setUrlSearchParams] = useSearchParams()
  const isPending = useIsPending()

  type PcgNpisPayload = { total: number; pageSize: number; page: number; npis: string[] }
  type ActionData = { pcgNpis: PcgNpisPayload } | { pcgError: string } | { result: any } | { error: string }
  const actionData = useActionData<ActionData>()

  useToast(toast)

  const [drawerState, setDrawerState] = React.useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    providerId?: string
  }>({ isOpen: false, mode: 'create' })
  const [openGroupProviderId, setOpenGroupProviderId] = React.useState<string | null>(null)
  const [openUserProviderId, setOpenUserProviderId] = React.useState<string | null>(null)

  // keep drawer in sync with *live* URLSearchParams
  React.useEffect(() => {
    const action = urlSearchParams.get('action') || ''
    const providerId = urlSearchParams.get('providerId') || ''
    if (action === 'create') setDrawerState({ isOpen: true, mode: 'create' })
    else if (action === 'edit' && providerId) setDrawerState({ isOpen: true, mode: 'edit', providerId })
    else setDrawerState({ isOpen: false, mode: 'create' })
  }, [urlSearchParams])

  const openDrawer = (mode: 'create' | 'edit', providerId?: string) => {
    setDrawerState({ isOpen: true, mode, providerId })
    const newParams = new URLSearchParams(urlSearchParams)
    newParams.set('action', mode)
    if (providerId) newParams.set('providerId', providerId)
    else newParams.delete('providerId')
    setUrlSearchParams(newParams)
  }
  const closeDrawer = () => {
    setDrawerState({ isOpen: false, mode: 'create' })
    const newParams = new URLSearchParams(urlSearchParams)
    newParams.delete('action')
    newParams.delete('providerId')
    setUrlSearchParams(newParams)
  }

  const selectedProvider = drawerState.providerId ? customer.providers.find(p => p.id === drawerState.providerId) : null
  const lastResult = actionData && 'result' in actionData ? actionData.result : undefined

  const [createForm, createFields] = useForm({
    id: 'create-provider-form',
    constraint: getZodConstraint(CreateProviderSchema),
    lastResult,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateProviderSchema })
    },
  })

  const [editForm, editFields] = useForm({
    id: 'edit-provider-form',
    constraint: getZodConstraint(UpdateProviderSchema),
    lastResult,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateProviderSchema })
    },
  })

  const baseUrl = `/admin/customer-manage/${customer.id}/providers`

  return (
    <>
      <LoadingOverlay show={Boolean(isPending)} title="Processing…" message="Please don't refresh or close this tab." />

      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
        <InterexLayout
          user={user}
          title={`${customer.name} - Providers & NPIs`}
          subtitle={`Managing ${customer.providers.length} providers`}
          currentPath={baseUrl}
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
                      to={baseUrl}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Clear
                    </Link>
                  )}
                </Form>
              </div>

              {/* Provider Group mismatch banner */}
              {providerGroupMismatches?.length > 0 && (
                <div className="border border-amber-300 bg-amber-50 rounded-md p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <Icon name="warning" className="h-5 w-5 text-amber-600 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-amber-800">Provider Group Alignment Needed</p>
                      <p className="text-xs text-amber-700 mt-1">The following NPIs have assigned users whose provider group differs from (or is missing on) the NPI. Assign the NPI to the appropriate provider group for consistency.</p>
                    </div>
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr className="text-left text-amber-700">
                          <th className="py-1 pr-4 font-semibold">NPI</th>
                          <th className="py-1 pr-4 font-semibold">Name</th>
                          <th className="py-1 pr-4 font-semibold">Current Group</th>
                          <th className="py-1 pr-4 font-semibold">User Groups</th>
                          <th className="py-1 font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {providerGroupMismatches.map(m => {
                          const singleCandidate = m.userGroups.length === 1 ? m.userGroups[0] : ''
                          return (
                            <tr key={m.id} className="border-t border-amber-200">
                              <td className="py-1 pr-4 font-mono text-amber-900">{m.npi}</td>
                              <td className="py-1 pr-4 text-amber-900 truncate max-w-[160px]">{m.name || '—'}</td>
                              <td className="py-1 pr-4 text-amber-900">{m.providerGroupId ? (customer.providerGroups.find(g => g.id === m.providerGroupId)?.name || 'Unknown') : '— None —'}</td>
                              <td className="py-1 pr-4">
                                <div className="flex flex-col gap-0.5">
                                  {m.userGroups.map(gid => {
                                    const gName = customer.providerGroups.find(g => g.id === gid)?.name || gid
                                    return (
                                      <span key={gid} className="inline-block bg-white border border-amber-300 rounded px-1.5 py-0.5 text-[10px] text-amber-800">{gName}</span>
                                    )
                                  })}
                                </div>
                              </td>
                              <td className="py-1">
                                <Form method="post" className="flex items-center gap-2">
                                  <input type="hidden" name="intent" value="update-group" />
                                  <input type="hidden" name="providerId" value={m.id} />
                                  <select name="providerGroupId" defaultValue={singleCandidate} className="border border-amber-300 bg-white rounded px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-500">
                                    <option value="">Select group…</option>
                                    {customer.providerGroups.map(g => (
                                      <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                  </select>
                                  <button type="submit" className="px-2 py-0.5 rounded bg-amber-600 text-white text-[11px] hover:bg-amber-700">Apply</button>
                                </Form>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Provider NPIs List */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900">Provider NPIs</h2>
                      <p className="text-sm text-gray-500">{customer.providers.length} total providers</p>
                    </div>
                    <div className="flex space-x-3">
                      <button onClick={() => openDrawer('create')} className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700">
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
                    <p className="text-gray-500 mb-6">{searchParams.search ? `No providers match your search "${searchParams.search}".` : 'Get started by adding your first provider NPI.'}</p>
                    <button onClick={() => openDrawer('create')} className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700">
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      Add Provider NPI
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <div className="max-h-[600px] overflow-y-auto">
                      <table className="w-full divide-y divide-gray-200 table-auto">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPI</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Name</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Group</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Assign User</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Edit</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Group</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Activate / Deactivate NPI</th>
                            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Delete</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {customer.providers.map(provider => {
                            const eligibility = providerEligibility.find(pe => pe.id === provider.id)
                            const displayName = provider.listDetail?.providerName || provider.registrationStatus?.providerName || provider.name || 'No name'

                            const eligibleUsers = (assignableUsers as any[]).filter((u: any) => {
                              // Provider grouped: user must be in same group
                              if (provider.providerGroupId) {
                                if (u.providerGroupId !== provider.providerGroupId) return false
                              } else {
                                // Provider ungrouped: only users without a group
                                if (u.providerGroupId) return false
                              }
                              // De-dup current assignments
                              return !provider.userNpis.some((l: any) => l.userId === u.id)
                            })
                            const hasEligibleNewUser = eligibleUsers.length > 0

                            return (
                              <tr key={provider.id} className="hover:bg-gray-50">
                                <td className="px-6 py-4 whitespace-nowrap"><div className="text-sm font-medium text-gray-900">{provider.npi}</div></td>
                                <td className="px-6 py-4">
                                  <div className="text-sm text-gray-900">{displayName}</div>
                                  {displayName !== (provider.name || '') ? (<div className="text-xs text-gray-500">synced from eMDR/PCG</div>) : null}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap"><div className="text-sm text-gray-900">{provider.providerGroup?.name || '-'}</div></td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-center">
                                  {provider.userNpis.length === 0 ? (
                                    <span className="text-gray-400 text-xs">None</span>
                                  ) : (
                                    <div className="flex flex-col items-center gap-1">
                                      {provider.userNpis.map((link: any) => (
                                        <span key={link.id} className="text-xs text-gray-700">{link.user.name || link.user.email}</span>
                                      ))}
                                    </div>
                                  )}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                                  <div className="relative">
                                    {openUserProviderId === provider.id ? (
                                      <div className="absolute z-20 -left-2 top-0 bg-white border rounded-lg shadow p-3 w-[300px]">
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="text-xs font-medium text-gray-700 flex items-center gap-1"><Icon name="avatar" className="h-4 w-4 text-blue-600" />Manage Assignment</span>
                                          <button type="button" onClick={() => setOpenUserProviderId(null)} className="text-gray-400 hover:text-gray-600" title="Close"><Icon name="cross-1" className="h-3 w-3" /></button>
                                        </div>
                                        {eligibleUsers.length === 0 && provider.userNpis.length === 1 ? (
                                          (() => {
                                            const singleLink = provider.userNpis[0]
                                            return (
                                              <div className="space-y-3">
                                                <div className="max-h-32 overflow-y-auto border rounded-md p-1.5 space-y-1 bg-gray-50">
                                                  {eligibleUsers.length > 0 ? (
                                                    eligibleUsers.map((u: any) => (
                                                      <label key={u.id} className="flex items-center gap-1 text-[11px] text-gray-700 px-1 py-0.5 rounded hover:bg-white">
                                                        <input type="checkbox" name="assignUserIds" value={u.id} className="h-3 w-3" />
                                                        <span className="truncate" title={u.name || u.email}>{u.name || u.email}</span>
                                                      </label>
                                                    ))
                                                  ) : (
                                                    <div className="text-[10px] text-amber-600 px-1 py-0.5">No eligible users (group alignment)</div>
                                                  )}
                                                </div>
                                                <Form method="post" onSubmit={() => setTimeout(() => setOpenUserProviderId(null), 0)} className="flex flex-col gap-2">
                                                  <input type="hidden" name="intent" value="bulk-update-user-assignments" />
                                                  <input type="hidden" name="providerId" value={provider.id} />
                                                  <input type="hidden" name="unassignLinkIds" value={singleLink?.id || ''} />
                                                  <div className="text-[11px] bg-gray-50 border rounded px-2 py-1 flex flex-col gap-1 max-w-full overflow-hidden">
                                                    <span className="whitespace-normal break-words leading-snug break-all hyphens-auto" style={{wordBreak:'break-word'}} title={singleLink?.user.name || singleLink?.user.email}>{singleLink?.user.name || singleLink?.user.email}</span>
                                                    <span className="text-red-500 text-[10px] font-medium">Will be unassigned</span>
                                                  </div>
                                                  <div className="flex justify-between pt-1 border-t">
                                                    <button type="button" onClick={() => setOpenUserProviderId(null)} className="px-2 py-1 rounded-md border border-gray-300 bg-white text-gray-600 text-[11px] hover:bg-gray-50">Cancel</button>
                                                    <button type="submit" className="px-3 py-1 rounded-md bg-red-600 text-white text-[11px] hover:bg-red-700">Unassign User</button>
                                                  </div>
                                                </Form>
                                              </div>
                                            )
                                          })()
                                        ) : (
                                          <Form method="post" className="space-y-3" onSubmit={() => setTimeout(() => setOpenUserProviderId(null), 0)}>
                                            <input type="hidden" name="intent" value="bulk-update-user-assignments" />
                                            <input type="hidden" name="providerId" value={provider.id} />
                                            <div className="space-y-1">
                                              <div className="flex items-center justify-between">
                                                <label className="text-[11px] font-medium text-gray-600 flex items-center gap-1">Assign Users <span className="inline-block px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[9px]">ADD</span></label>
                                                <span className="text-[10px] text-gray-400 cursor-help inline-flex items-center gap-0.5" title={eligibility?.userAssignReason ? eligibility.userAssignReason : (provider.providerGroupId ? 'Only users in this provider group are eligible.' : 'Only users without a provider group are eligible.')}>
                                                  <Icon name="info" className="h-3 w-3" />
                                                  {eligibleUsers.length === 0 && <span className="text-[9px]">None</span>}
                                                </span>
                                              </div>
                                              <div className="max-h-32 overflow-y-auto border rounded-md p-1.5 space-y-1 bg-gray-50">
                                                {eligibleUsers.length > 0 ? (
                                                  eligibleUsers.map((u: any) => (
                                                    <label key={u.id} className="flex items-center gap-1 text-[11px] text-gray-700 px-1 py-0.5 rounded hover:bg-white">
                                                      <input type="checkbox" name="assignUserIds" value={u.id} className="h-3 w-3" />
                                                      <span className="truncate" title={u.name || u.email}>{u.name || u.email}</span>
                                                    </label>
                                                  ))
                                                ) : (
                                                  <div className="text-[10px] text-amber-600 px-1 py-0.5">No eligible users (group alignment)</div>
                                                )}
                                              </div>
                                            </div>
                                            <div className="space-y-1">
                                              <div className="flex items-center justify-between">
                                                <label className="text-[11px] font-medium text-gray-600 flex items-center gap-1">Currently Assigned <span className="inline-block px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[9px]">REMOVE</span></label>
                                                {provider.userNpis.length > 0 && (<span className="text-[10px] text-gray-400">{provider.userNpis.length}</span>)}
                                              </div>
                                              <div className="max-h-32 overflow-y-auto border rounded-md p-1.5 space-y-1 bg-gray-50">
                                                {provider.userNpis.length > 0 ? (
                                                  provider.userNpis.map((link: any) => (
                                                    <label key={link.id} className="flex items-center gap-1 text-[11px] text-gray-700 px-1 py-0.5 rounded hover:bg-white">
                                                      <input type="checkbox" name="unassignLinkIds" value={link.id} className="h-3 w-3" />
                                                      <span className="truncate" title={link.user.name || link.user.email}>{link.user.name || link.user.email}</span>
                                                    </label>
                                                  ))
                                                ) : (
                                                  <div className="text-[10px] text-gray-400 px-1 py-0.5">None</div>
                                                )}
                                              </div>
                                            </div>
                                            <div className="flex justify-between items-center pt-1 border-t">
                                              <button type="button" onClick={() => setOpenUserProviderId(null)} className="px-2 py-1 rounded-md border border-gray-300 bg-white text-gray-600 text-[11px] hover:bg-gray-50">Cancel</button>
                                              <button type="submit" className="px-3 py-1 rounded-md bg-blue-600 text-white text-[11px] hover:bg-blue-700">Apply Changes</button>
                                            </div>
                                          </Form>
                                        )}
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={!hasEligibleNewUser && provider.userNpis.length === 0}
                                        onClick={() => (hasEligibleNewUser || provider.userNpis.length > 0) ? setOpenUserProviderId(provider.id) : undefined}
                                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500 ${
                                          provider.userNpis.length
                                            ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                                            : 'bg-emerald-50 text-emerald-700 border-emerald-200 ' + (hasEligibleNewUser ? 'hover:bg-emerald-100' : 'opacity-50 cursor-not-allowed')
                                        }`}
                                        title={!hasEligibleNewUser && provider.userNpis.length === 0 ? (provider.providerGroupId ? 'No users in this provider group available to assign.' : 'No ungrouped users available to assign.') : undefined}
                                      >
                                        <Icon name="avatar" className="h-4 w-4" />
                                        {provider.userNpis.length ? 'Manage' : 'Assign'}
                                      </button>
                                    )}
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-center">
                                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${provider.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                                    {provider.active ? 'Active' : 'Inactive'}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-center">
                                  <button onClick={() => openDrawer('edit', provider.id)} className="text-blue-600 hover:text-blue-800 p-1" title="Edit provider">
                                    <Icon name="pencil-1" className="h-4 w-4" />
                                  </button>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                                  <div className="relative">
                                    {openGroupProviderId === provider.id ? (
                                      <div className="absolute z-20 -left-2 top-0 bg-white border rounded-lg shadow p-3 w-64">
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="text-xs font-medium text-gray-700 flex items-center gap-1"><Icon name="hero:user-group" className="h-4 w-4 text-indigo-600" />{provider.providerGroup?.name ? 'Change Group' : 'Assign Group'}</span>
                                          <button type="button" onClick={() => setOpenGroupProviderId(null)} className="text-gray-400 hover:text-gray-600" title="Close"><Icon name="cross-1" className="h-3 w-3" /></button>
                                        </div>
                                        <Form method="post" className="space-y-2">
                                          <input type="hidden" name="intent" value="update-group" />
                                          <input type="hidden" name="providerId" value={provider.id} />
                                          <select name="providerGroupId" defaultValue={provider.providerGroupId || ''} className="w-full border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
                                            <option value="">— No group —</option>
                                            {customer.providerGroups.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
                                          </select>
                                          <div className="flex justify-end gap-2 pt-1">
                                            <button type="button" onClick={() => setOpenGroupProviderId(null)} className="px-2 py-1 rounded-md border border-gray-300 bg-white text-gray-600 text-[11px] hover:bg-gray-50">Cancel</button>
                                            <button type="submit" className="px-2 py-1 rounded-md bg-indigo-600 text-white text-[11px] hover:bg-indigo-700">Save</button>
                                          </div>
                                        </Form>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={Boolean(!provider.providerGroupId && providerEligibility.find(pe => pe.id === provider.id)?.groupChangeBlocked)}
                                        onClick={() => !(providerEligibility.find(pe => pe.id === provider.id)?.groupChangeBlocked) ? setOpenGroupProviderId(provider.id) : undefined}
                                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500 ${
                                          provider.providerGroup ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100' : 'bg-emerald-50 text-emerald-700 border-emerald-200 ' + (providerEligibility.find(pe => pe.id === provider.id)?.groupChangeBlocked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-100')
                                        }`}
                                        title={providerEligibility.find(pe => pe.id === provider.id)?.groupChangeBlocked ? (providerEligibility.find(pe => pe.id === provider.id)?.groupChangeBlockReason || 'Cannot assign group due to guard rails.') : (provider.providerGroup ? 'Change provider group' : 'Assign provider group')}
                                      >
                                        <Icon name="hero:user-group" className="h-4 w-4" />
                                        {provider.providerGroup?.name ? 'Manage' : 'Assign'}
                                      </button>
                                    )}
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-center">
                                  <Form method="post" className="inline">
                                    <input type="hidden" name="intent" value="toggle-active" />
                                    <input type="hidden" name="providerId" value={provider.id} />
                                    <input type="hidden" name="active" value={(!provider.active).toString()} />
                                    <button type="submit" className={`p-1 ${provider.active ? 'text-amber-600 hover:text-amber-800' : 'text-green-600 hover:text-green-800'}`} title={provider.active ? 'Mark Inactive' : 'Activate'}>
                                      <Icon name={provider.active ? 'lock-closed' : 'lock-open-1'} className="h-4 w-4" />
                                    </button>
                                  </Form>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-center">
                                  {(() => {
                                    const counts = (provider as any)._count || {}
                                    const hasDependents = Boolean(counts.userNpis || counts.submissions || counts.PrepayLetter || counts.PostpayLetter || counts.PostpayOtherLetter)
                                    if (hasDependents) {
                                      return (
                                        <span className="text-gray-300" title="Cannot delete: has assigned users, submissions, or letters">
                                          <Icon name="trash" className="h-4 w-4" />
                                        </span>
                                      )
                                    }
                                    return (
                                      <Form method="post" className="inline">
                                        <input type="hidden" name="intent" value="delete" />
                                        <input type="hidden" name="providerId" value={provider.id} />
                                        <button
                                          type="submit"
                                          className="text-red-600 hover:text-red-800 p-1"
                                          title="Delete provider"
                                          onClick={(e) => {
                                            if (!confirm(`Are you sure you want to delete \"${provider.name || ''}\" (NPI: ${provider.npi})? This action cannot be undone.`)) {
                                              e.preventDefault()
                                            }
                                          }}
                                        >
                                          <Icon name="trash" className="h-4 w-4" />
                                        </button>
                                      </Form>
                                    )
                                  })()}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
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
                        <p className="text-2xl font-bold text-green-600">{customer.providers.filter(p => p.active).length}</p>
                      </div>
                    </div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="avatar" className="h-8 w-8 text-purple-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-purple-900">Assigned Users</p>
                        <p className="text-2xl font-bold text-purple-600">{customer.providers.reduce((sum, p) => sum + (p as any)._count.userNpis, 0)}</p>
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
                        <tr><td colSpan={6} className="px-4 py-6 text-sm text-gray-500">No activity yet.</td></tr>
                      ) : (
                        events.map((ev: any) => (
                          <tr key={ev.id}>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">{new Date(ev.createdAt).toLocaleString()}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{ev.provider?.npi}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{ev.provider?.name ?? '—'}</td>
                            <td className="px-4 py-3 whitespace-nowrap"><span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">{ev.kind}</span>{ev.message ? <span className="ml-2 text-sm text-gray-700">{ev.message}</span> : null}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{ev.actor?.name || ev.actor?.email || '—'}</td>
                            <td className="px-4 py-3 text-sm"><JsonViewer data={ev.payload} /></td>
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
            <Field labelProps={{ children: 'National Provider Identifier (NPI) *' }} inputProps={{ ...getInputProps(createFields.npi!, { type: 'text' }), placeholder: 'Enter 10-digit NPI number' }} errors={createFields.npi?.errors} />
            <Field labelProps={{ children: 'Provider Name *' }} inputProps={{ ...getInputProps(createFields.name!, { type: 'text' }), placeholder: 'e.g., Dr. John Smith' }} errors={createFields.name?.errors} />
            <SelectField labelProps={{ children: 'Provider Group (Optional)' }} selectProps={{ ...getInputProps(createFields.providerGroupId!, { type: 'text' }), defaultValue: '' }} errors={createFields.providerGroupId?.errors}>
              <option value="">— No group —</option>
              {customer.providerGroups.map(group => (<option key={group.id} value={group.id}>🏥 {group.name}</option>))}
            </SelectField>
          </div>
          <ErrorList errors={createForm.errors} id={createForm.errorId} />
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" onClick={closeDrawer} className="px-4 py-2 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Cancel</button>
            <StatusButton status={createForm.status ?? 'idle'} type="submit" className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700">Add Provider NPI</StatusButton>
          </div>
        </Form>
      </Drawer>

      {/* Edit Provider Drawer */}
      <Drawer isOpen={drawerState.isOpen && drawerState.mode === 'edit'} onClose={closeDrawer} title="Edit Provider NPI" size="md">
        {selectedProvider ? (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="providerId" value={selectedProvider.id} />
            <div className="space-y-6">
              <Field labelProps={{ children: 'NPI' }} inputProps={{ value: selectedProvider.npi, readOnly: true }} />
              <Field labelProps={{ children: 'Provider Name *' }} inputProps={{ ...getInputProps(editFields.name!, { type: 'text' }), defaultValue: selectedProvider.name || '' }} errors={editFields.name?.errors} />
              <SelectField labelProps={{ children: 'Provider Group' }} selectProps={{ ...getInputProps(editFields.providerGroupId!, { type: 'text' }), defaultValue: selectedProvider.providerGroupId || '' }} errors={editFields.providerGroupId?.errors}>
                <option value="">— No group —</option>
                {customer.providerGroups.map(group => (<option key={group.id} value={group.id}>🏥 {group.name}</option>))}
              </SelectField>
              <div className="flex items-center gap-2">
                <input id="active" name="active" type="checkbox" defaultChecked={selectedProvider.active} className="h-4 w-4 text-indigo-600 border-gray-300 rounded" />
                <label htmlFor="active" className="text-sm text-gray-700">Active</label>
              </div>
            </div>
            <ErrorList errors={editForm.errors} id={editForm.errorId} />
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={closeDrawer} className="px-4 py-2 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Cancel</button>
              <StatusButton status={editForm.status ?? 'idle'} type="submit" className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700">Save Changes</StatusButton>
            </div>
          </Form>
        ) : null}
      </Drawer>
    </>
  )
}

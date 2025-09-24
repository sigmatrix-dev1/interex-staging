import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { useState, useEffect, useMemo } from 'react'
import { data, useLoaderData, Form, useSearchParams, useActionData, type LoaderFunctionArgs, type ActionFunctionArgs , Link  } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { useToast } from '#app/components/toaster.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { ManualPasswordSection } from '#app/components/user-management/manual-password-section.tsx'
import { audit as auditEvent } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { sendUserRegistrationEmail } from '#app/utils/emails/send-user-registration.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'

// Username constraints for helpers
const USERNAME_MIN_LENGTH = 3
const USERNAME_MAX_LENGTH = 32
const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/

const CreateUserSchema = z.object({
  intent: z.literal('create'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  username: z.string().min(USERNAME_MIN_LENGTH, 'Username must be at least 3 characters'),
  role: z.enum(['customer-admin', 'provider-group-admin', 'basic-user']),
  providerGroupId: z.string().optional(),
  active: z.boolean().default(true),
})

const UpdateUserSchema = z.object({
  intent: z.literal('update'),
  userId: z.string().min(1, 'User ID is required'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['customer-admin', 'provider-group-admin', 'basic-user']),
  providerGroupId: z.string().optional(),
  active: z.boolean().default(true),
})

const DeleteUserSchema = z.object({
  intent: z.literal('delete'),
  userId: z.string().min(1, 'User ID is required'),
  confirm: z.string().min(1, 'Confirmation required'),
})

const ResetPasswordSchema = z.object({
  intent: z.literal('reset-password'),
  userId: z.string().min(1, 'User ID is required'),
  mode: z.enum(['auto', 'manual']),
  manualPassword: z.string().optional(),
})

const AssignNpisSchema = z.object({
  intent: z.literal('assign-npis'),
  userId: z.string().min(1),
  providerIds: z.array(z.string()).default([]),
})

const CheckAvailabilitySchema = z.object({
  intent: z.literal('check-availability'),
  field: z.enum(['email', 'username']),
  value: z.string().min(1),
})

const SetActiveSchema = z.object({
  intent: z.literal('set-active'),
  userId: z.string().min(1),
  status: z.enum(['active', 'inactive']),
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateUserSchema,
  UpdateUserSchema,
  DeleteUserSchema,
  ResetPasswordSchema,
  AssignNpisSchema,
  CheckAvailabilitySchema,
  SetActiveSchema,
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

  // Get customer with comprehensive user data
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
            select: { users: true, providers: true }
          }
        },
        orderBy: { name: 'asc' }
      },
      providers: {
        select: {
          id: true,
          npi: true,
          name: true,
          providerGroup: {
            select: { id: true, name: true }
          }
        },
        orderBy: [{ providerGroupId: 'asc' }, { npi: 'asc' }]
      },
      users: {
        where: searchTerm ? {
          OR: [
            { name: { contains: searchTerm } },
            { email: { contains: searchTerm } },
            { username: { contains: searchTerm } },
          ]
        } : {},
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          active: true,
          createdAt: true,
          roles: {
            select: { name: true }
          },
          providerGroup: {
            select: { id: true, name: true }
          },
          userNpis: {
            select: {
              provider: {
                select: {
                  id: true,
                  npi: true,
                  name: true,
                  providerGroupId: true
                }
              }
            }
          }
        },
        orderBy: { name: 'asc' }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  // Get available roles (exclude system-admin for customer users)
  const roles = await prisma.role.findMany({
    select: { id: true, name: true },
    where: {
      name: { in: ['customer-admin', 'provider-group-admin', 'basic-user'] }
    },
    orderBy: { name: 'asc' }
  })

  const { toast, headers } = await getToast(request)

  return data({ 
    user,
    customer,
    roles,
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

  // Small helper to write audit events consistently for this page
  async function writeAudit(input: {
    action:
      | 'USER_CREATE' | 'USER_CREATE_ATTEMPT'
      | 'USER_UPDATE' | 'USER_UPDATE_ATTEMPT'
      | 'USER_DELETE' | 'USER_DELETE_ATTEMPT' | 'USER_DELETE_BLOCKED'
      | 'USER_SET_ACTIVE' | 'USER_SET_ACTIVE_ATTEMPT'
      | 'USER_RESET_PASSWORD' | 'USER_RESET_PASSWORD_ATTEMPT'
      | 'USER_ASSIGN_NPIS' | 'USER_ASSIGN_NPIS_ATTEMPT'
    targetUserId?: string | null
    success: boolean
    message?: string | null
    metadata?: Record<string, any> | null
  }) {
    try {
      await auditEvent.admin({
        action: input.action,
        status: input.success ? 'SUCCESS' : 'FAILURE',
        actorType: 'USER',
        actorId: userId,
        customerId,
        entityType: 'USER',
        entityId: input.targetUserId ?? null,
        summary: input.message ?? null,
        metadata: input.metadata ?? undefined,
      })
    } catch {}
  }

  if (submission.status !== 'success') {
    await writeAudit({ action: 'USER_UPDATE_ATTEMPT', success: false, message: 'Validation failed (discriminated union)', metadata: { issues: (submission as any).error?.issues } })
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const action = submission.value

  // Live availability check (AJAX style)
  if (submission.status === 'success' && submission.value.intent === 'check-availability') {
    const { field, value } = submission.value
    if (field === 'email') {
      const exists = !!(await prisma.user.findUnique({ where: { email: value.toLowerCase() } }))
      return data<{ exists: boolean }>({ exists })
    }
    if (field === 'username') {
      const exists = !!(await prisma.user.findUnique({ where: { username: value.toLowerCase() } }))
      return data<{ exists: boolean }>({ exists })
    }
  }

  // Handle create action
  if (action.intent === 'create') {
    const { name, email, username, role, providerGroupId, active } = action
    await writeAudit({ action: 'USER_CREATE_ATTEMPT', success: true, message: 'Attempt create user', metadata: { name, email, username, role, providerGroupId, active } })

    // Check if email or username already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    })

    if (existingUser) {
      await writeAudit({ action: 'USER_CREATE_ATTEMPT', success: false, message: 'Email/username exists', metadata: { name, email, username } })
      return data(
        { 
          result: submission.reply({
            fieldErrors: {
              ...(existingUser.email === email && { email: ['Email already exists'] }),
              ...(existingUser.username === username && { username: ['Username already exists'] }),
            }
          })
        },
        { status: 400 }
      )
    }

    // Generate a compliant temporary password (regenerate until complexity satisfied, max 5 tries)
    let temporaryPassword = generateTemporaryPassword()
    {
      const { validatePasswordComplexity } = await import('#app/utils/password-policy.server.ts')
      for (let i = 0; i < 5; i++) {
        const { ok } = validatePasswordComplexity(temporaryPassword)
        if (ok) break
        temporaryPassword = generateTemporaryPassword()
      }
    }

    // Create the user
    const newUser = await prisma.user.create({
      data: {
  name,
  email: email.toLowerCase(),
  username: username.toLowerCase(),
        active,
        customerId,
        providerGroupId: providerGroupId || null,
        roles: {
          connect: { name: role }
        },
        password: {
          create: {
            hash: hashPassword(temporaryPassword)
          }
        }
      },
      include: {
        providerGroup: {
          select: { name: true }
        }
      }
    })

  // Ensure mustChangePassword flag set (separate update to bypass any outdated type defs)
  await (prisma as any).user.update({ where: { id: newUser.id }, data: { mustChangePassword: true } })

  // Get customer information for email
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true }
    })

    if (!customer) {
      return data(
        { error: 'Customer not found' },
        { status: 404 }
      )
    }

    // Send welcome email to the new user
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
    
    try {
      await sendUserRegistrationEmail({
        to: email.toLowerCase(),
        userName: name,
        userRole: role,
        customerName: customer.name,
        tempPassword: temporaryPassword,
        loginUrl,
        username: username.toLowerCase(),
        providerGroupName: newUser.providerGroup?.name,
      })
      console.log(`✅ Registration email sent to ${email}`)
    } catch (error) {
      console.error(`❌ Failed to send registration email to ${email}:`, error)
      // Don't fail the user creation if email fails
    }

    await writeAudit({ action: 'USER_CREATE', success: true, targetUserId: newUser.id, message: 'User created', metadata: { name, email, username, role, providerGroupId, active } })
    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success',
      title: 'User created',
      description: `${name} has been created successfully and a welcome email has been sent.`,
    })
  }

  // Handle update action
  if (action.intent === 'update') {
    const { userId: targetUserId, name, role, providerGroupId, active } = action
    await writeAudit({ action: 'USER_UPDATE_ATTEMPT', success: true, targetUserId, message: 'Attempt update user', metadata: { name, role, providerGroupId, active } })

    // Verify the target user belongs to the same customer
    const targetUser = await prisma.user.findFirst({
      where: {
        id: targetUserId,
        customerId,
      },
      include: {
        roles: { select: { name: true } },
        userNpis: { select: { providerId: true } }
      }
    })

    if (!targetUser) {
      await writeAudit({ action: 'USER_UPDATE_ATTEMPT', success: false, targetUserId, message: 'User not found' })
      return data(
        { error: 'User not found or not authorized to edit this user' },
        { status: 404 }
      )
    }

    // Prevent editing system admins
    const isTargetSystemAdmin = targetUser.roles.some(role => role.name === 'system-admin')
    if (isTargetSystemAdmin) {
      await writeAudit({ action: 'USER_UPDATE_ATTEMPT', success: false, targetUserId, message: 'Cannot edit system administrators' })
      return data(
        { error: 'Cannot edit system administrators' },
        { status: 403 }
      )
    }

    // Validate provider group exists and belongs to customer
    if (providerGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({
        where: {
          id: providerGroupId,
          customerId,
        }
      })

      if (!providerGroup) {
        await writeAudit({ action: 'USER_UPDATE_ATTEMPT', success: false, targetUserId, message: 'Invalid provider group' })
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group'] } }) },
          { status: 400 }
        )
      }
    }

    // Update the user
    const before = { name: targetUser.name, active: (targetUser as any).active, roles: targetUser.roles?.map(r => r.name) }
    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        name,
        active,
        providerGroupId: providerGroupId || null,
        roles: {
          set: [{ name: role }]
        }
      }
    })
    await writeAudit({ action: 'USER_UPDATE', success: true, targetUserId, message: 'User updated', metadata: { before, after: { name, active, role, providerGroupId: providerGroupId || null } } })

    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success',
      title: 'User updated',
      description: `${name} has been updated successfully.`,
    })
  }

  // Handle password reset action
  if (action.intent === 'reset-password') {
    const { userId: targetUserId, mode } = action
    await writeAudit({ action: 'USER_RESET_PASSWORD_ATTEMPT', success: true, targetUserId, message: 'Attempt reset password', metadata: { mode } })
    const manualPassword = mode === 'manual' ? action.manualPassword : undefined

    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, customerId },
      include: { roles: { select: { name: true } }, customer: { select: { name: true } } },
    })
    if (!targetUser) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
        type: 'error', title: 'User not found', description: 'Unable to reset password.'
      })
    }
    let newPassword = mode === 'auto' ? generateTemporaryPassword() : (manualPassword ?? '').trim()
    {
      const { validatePasswordComplexity } = await import('#app/utils/password-policy.server.ts')
      if (mode === 'manual') {
        const { ok, errors } = validatePasswordComplexity(newPassword)
        if (!ok) {
          return data({ result: submission.reply({ fieldErrors: { manualPassword: errors } }) }, { status: 400 })
        }
      } else {
        for (let i = 0; i < 5; i++) {
          const { ok } = validatePasswordComplexity(newPassword)
            if (ok) break
          newPassword = generateTemporaryPassword()
        }
      }
    }
    const passwordHash = hashPassword(newPassword)
    await prisma.password.upsert({
      where: { userId: targetUserId },
      create: { userId: targetUserId, hash: passwordHash },
      update: { hash: passwordHash },
    })
    await prisma.session.deleteMany({ where: { userId: targetUserId } })
    await (prisma as any).user.update({ where: { id: targetUserId }, data: { mustChangePassword: true } })
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
    try {
      await sendUserRegistrationEmail({
        to: targetUser.email,
        userName: targetUser.name || targetUser.username,
        userRole: targetUser.roles[0]?.name || 'user',
  customerName: targetUser.customer?.name || '',
        tempPassword: newPassword,
        loginUrl,
        username: targetUser.username,
        providerGroupName: undefined,
      })
    } catch (e) { console.error('Failed to send reset email', e) }
    await writeAudit({ action: 'USER_RESET_PASSWORD', success: true, targetUserId, message: 'Password reset completed', metadata: { mode } })
    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success', title: 'Password reset', description: 'A new password has been emailed.'
    })
  }

  // Assign NPIs
  if (action.intent === 'assign-npis') {
    const { userId: targetUserId, providerIds } = action
    await writeAudit({ action: 'USER_ASSIGN_NPIS_ATTEMPT', success: true, targetUserId, message: 'Attempt assign NPIs', metadata: { providerIdsCount: providerIds?.length ?? 0 } })
    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, customerId },
      include: { providerGroup: { select: { id: true } }, userNpis: { select: { providerId: true } } },
    })
    if (!targetUser) {
      await writeAudit({ action: 'USER_ASSIGN_NPIS_ATTEMPT', success: false, targetUserId, message: 'User not found' })
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'User not found', description: 'Unable to assign NPIs.' })
    }
    // Validate providers belong to same customer
    const providersForValidation = await prisma.provider.findMany({
      where: { id: { in: providerIds }, customerId }, select: { id: true, providerGroupId: true }
    })
    const fetchedIds = providersForValidation.map(p => p.id)
    const missingIds = providerIds.filter(id => !fetchedIds.includes(id))
    if (missingIds.length > 0) {
      await writeAudit({ action: 'USER_ASSIGN_NPIS_ATTEMPT', success: false, targetUserId, message: 'Invalid NPI ids supplied', metadata: { missingIdsCount: missingIds.length } })
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Invalid NPIs', description: 'Some selected NPIs are not valid.' })
    }
    if (targetUser.providerGroup?.id) {
      const mismatched = providersForValidation.filter(p => p.providerGroupId !== targetUser.providerGroup!.id)
      if (mismatched.length > 0) {
        return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Group mismatch', description: 'All NPIs must match user group.' })
      }
    } else {
      const groupedPicked = providersForValidation.filter(p => p.providerGroupId)
      if (groupedPicked.length > 0) {
        return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Grouped NPIs disallowed', description: 'User without group cannot have grouped NPIs.' })
      }
    }
    await prisma.userNpi.deleteMany({ where: { userId: targetUserId } })
    if (providerIds.length) {
      await prisma.userNpi.createMany({ data: providerIds.map(id => ({ userId: targetUserId, providerId: id })) })
    }
    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'success', title: 'NPIs updated', description: 'NPI assignments saved.' })
  }

  // Activate/Deactivate
  if (action.intent === 'set-active') {
    const { userId: targetUserId, status } = action
    const targetUser = await prisma.user.findFirst({ where: { id: targetUserId, customerId }, include: { roles: { select: { name: true } }, userNpis: { select: { providerId: true } } } })
    if (!targetUser) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'User not found', description: 'Unable to update status.' })
    }
    if (status === 'inactive' && targetUser.userNpis.length > 0) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Unassign NPIs', description: 'Remove all NPIs before deactivation.' })
    }
    await prisma.user.update({ where: { id: targetUserId }, data: { active: status === 'active' } })
    if (status === 'inactive') await prisma.session.deleteMany({ where: { userId: targetUserId } })
    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'success', title: status === 'inactive' ? 'User deactivated' : 'User activated', description: 'Status updated.' })
  }

  // Handle delete action
  if (action.intent === 'delete') {
    const { userId: targetUserId, confirm } = action

    // Verify the target user belongs to the same customer
    const targetUser = await prisma.user.findFirst({
      where: {
        id: targetUserId,
        customerId,
      },
      include: {
        roles: { select: { name: true } }
      }
    })

    if (!targetUser) {
      return data(
        { error: 'User not found or not authorized to delete this user' },
        { status: 404 }
      )
    }

    // Prevent deleting system admins
    const isTargetSystemAdmin = targetUser.roles.some(role => role.name === 'system-admin')
    if (isTargetSystemAdmin) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
        type: 'error',
        title: 'Cannot delete user',
        description: 'Cannot delete system administrators.',
      })
    }

    if (targetUserId === user.id) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Cannot delete self', description: 'You cannot delete your own account.' })
    }

    // Must confirm exact username
    if (confirm.toLowerCase() !== targetUser.username.toLowerCase()) {
      return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Confirmation mismatch', description: 'Type the exact username to confirm deletion.' })
    }

    // Guard: cannot delete last customer-admin
    const targetIsCustomerAdmin = targetUser.roles.some(r => r.name === 'customer-admin')
    if (targetIsCustomerAdmin) {
      const remainingAdminCount = await prisma.user.count({ where: { customerId, id: { not: targetUserId }, roles: { some: { name: 'customer-admin' } } } })
      if (remainingAdminCount === 0) {
        return redirectWithToast(`/admin/customer-manage/${customerId}/users`, { type: 'error', title: 'Cannot delete last admin', description: 'Assign another customer-admin before deleting this one.' })
      }
    }

    // HARD DELETE (reverted from earlier soft-delete approach): remove sessions then delete user
    const userName = targetUser.name || targetUser.username
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { userId: targetUserId } }),
      prisma.user.delete({ where: { id: targetUserId } }),
    ])

    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success',
      title: 'User deleted',
      description: `${userName} has been permanently removed.`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerUsersManagementPage() {
  const { user, customer, roles, searchTerm, toast } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  const isPending = useIsPending()
  
  useToast(toast)
  // Component mount trace
  useEffect(() => {
    console.log('[DELLOG] CustomerUsersManagementPage mounted')
    return () => console.log('[DELLOG] CustomerUsersManagementPage unmounted')
  }, [])
  useEffect(() => {
    console.log('[DELLOG] users count', customer.users.length)
  }, [customer.users.length])
  
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit' | 'reset-password' | 'assign-npis'
    userId?: string
  }>({ isOpen: false, mode: 'create' })

  // Delete modal state
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; userId?: string; username?: string; name?: string; confirmValue: string }>(
    { isOpen: false, confirmValue: '' }
  )

  // Trace confirmValue updates (for debugging input behavior)
  useEffect(() => {
    if (deleteModal.isOpen) console.log('[DELLOG] confirmValue ->', deleteModal.confirmValue)
  }, [deleteModal.confirmValue, deleteModal.isOpen])

  // Console log modal open/close (no state writes to avoid loops)
  useEffect(() => {
    if (deleteModal.isOpen) console.log('[DELLOG][modal] open', { userId: deleteModal.userId, username: deleteModal.username })
    else console.log('[DELLOG][modal] close')
  }, [deleteModal.isOpen, deleteModal.userId, deleteModal.username])

  // Close delete modal automatically on successful navigation (toast change or users length change)
  useEffect(() => {
    if (deleteModal.isOpen) {
      // Heuristic: if the modal references a userId that's no longer present, close it
      if (deleteModal.userId && !customer.users.some(u => u.id === deleteModal.userId)) {
        setDeleteModal(s => ({ ...s, isOpen: false, confirmValue: '' }))
      }
    }
  }, [customer.users.length, deleteModal.isOpen, deleteModal.userId, customer.users])

  // Availability helpers
  const [emailValue, setEmailValue] = useState('')
  const [usernameValue, setUsernameValue] = useState('')
  const [emailExists, setEmailExists] = useState<boolean | null>(null)
  const [usernameExists, setUsernameExists] = useState<boolean | null>(null)
  const [checkingEmail, setCheckingEmail] = useState(false)
  const [checkingUsername, setCheckingUsername] = useState(false)

  function debounce<F extends (...a: any[]) => void>(fn: F, ms: number) { let t: any; return (...args: any[]) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), ms) } }
  type AvailabilityResponse = { exists: boolean }
  const debouncedCheckEmail = useMemo(() => debounce(async (v: string) => {
    if (!v) { setEmailExists(null); return }
    setCheckingEmail(true)
    try {
      const fd = new FormData(); fd.set('intent', 'check-availability'); fd.set('field', 'email'); fd.set('value', v)
      const res = await fetch(window.location.pathname, { method: 'POST', body: fd })
      const json = (await res.json()) as AvailabilityResponse
      setEmailExists(json.exists)
    } catch { setEmailExists(null) } finally { setCheckingEmail(false) }
  }, 350), [])
  const debouncedCheckUsername = useMemo(() => debounce(async (v: string) => {
    if (!v) { setUsernameExists(null); return }
    setCheckingUsername(true)
    try {
      const fd = new FormData(); fd.set('intent', 'check-availability'); fd.set('field', 'username'); fd.set('value', v)
      const res = await fetch(window.location.pathname, { method: 'POST', body: fd })
      const json = (await res.json()) as AvailabilityResponse
      setUsernameExists(json.exists)
    } catch { setUsernameExists(null) } finally { setCheckingUsername(false) }
  }, 350), [])

  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue.trim() || '')
  const userLen = usernameValue.trim().length
  const usernameOkLen = userLen >= USERNAME_MIN_LENGTH && userLen <= USERNAME_MAX_LENGTH
  const usernameOkChars = USERNAME_REGEX.test(usernameValue.trim() || '')

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.get('action')
    const userId = searchParams.get('userId')
    if (action === 'add') setDrawerState({ isOpen: true, mode: 'create' })
    else if (action === 'edit' && userId) setDrawerState({ isOpen: true, mode: 'edit', userId })
    else if (action === 'reset' && userId) setDrawerState({ isOpen: true, mode: 'reset-password', userId })
    else if (action === 'assign-npis' && userId) setDrawerState({ isOpen: true, mode: 'assign-npis', userId })
    else setDrawerState({ isOpen: false, mode: 'create' })
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'edit' | 'reset-password' | 'assign-npis', userId?: string) => {
    const newParams = new URLSearchParams(searchParams)
    if (mode === 'create') newParams.set('action', 'add')
    else if (mode === 'edit') newParams.set('action', 'edit')
    else if (mode === 'reset-password') newParams.set('action', 'reset')
    else if (mode === 'assign-npis') newParams.set('action', 'assign-npis')
    if (userId) newParams.set('userId', userId)
    if (process.env.NODE_ENV === 'development') {
      console.log('[DELLOG][openDrawer]', { mode, userId })
    }
    setSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('action')
    newParams.delete('userId')
    setSearchParams(newParams)
  }

  const selectedUser = drawerState.userId 
    ? customer.users.find(u => u.id === drawerState.userId)
    : null

  const [createForm, createFields] = useForm({
    id: 'create-user-form',
    constraint: getZodConstraint(CreateUserSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateUserSchema })
    },
  })

  const [editForm, editFields] = useForm({
    id: 'edit-user-form',
    constraint: getZodConstraint(UpdateUserSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateUserSchema })
    },
  })

  const [createSelectedRole, setCreateSelectedRole] = useState<string>('')
  const [editSelectedRole, setEditSelectedRole] = useState<string>('')
  const [resetMode, setResetMode] = useState<'auto' | 'manual'>('auto')
  useEffect(() => { if (drawerState.mode === 'reset-password') setResetMode('auto') }, [drawerState.mode])

  // NPI assignment state
  const [selectedNpis, setSelectedNpis] = useState<string[]>([])
  const [npiSearchTerm, setNpiSearchTerm] = useState('')
  useEffect(() => {
    if (drawerState.mode === 'assign-npis' && selectedUser) {
      const current = selectedUser.userNpis?.map((un: any) => un.provider.id) || []
      setSelectedNpis(current)
    }
  }, [drawerState.mode, selectedUser])
  const getAvailableNpis = () => customer.providers.filter((p: any) => {
    if (npiSearchTerm && !p.npi.includes(npiSearchTerm) && !(p.name && p.name.toLowerCase().includes(npiSearchTerm.toLowerCase()))) return false
    return true
  })
  const toggleNpiSelection = (id: string) => setSelectedNpis(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  const removeNpiFromSelection = (id: string) => setSelectedNpis(prev => prev.filter(i => i !== id))

  return (
    <>
  {/* Main content area */}
  <div>
        <InterexLayout 
          user={user}
          title={`User Management - ${customer.name}`}
          subtitle={`Managing ${customer.users.length} users for ${customer.name}`}
          currentPath={`/admin/customer-manage/${customer.id}/users`}
          actions={
            <div className="flex items-center space-x-2">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                System Admin
              </span>
              <Link
                to={`/admin/customer-manage/${customer.id}`}
                className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
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
                      placeholder="Search users..."
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
                      to={`/admin/customer-manage/${customer.id}/users`}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Clear
                    </Link>
                  )}
                </Form>
              </div>

              {/* Users List */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900">Users</h2>
                      <p className="text-sm text-gray-500">{customer.users.length} total users</p>
                    </div>
                    <div className="flex space-x-3">
                      <button
                        onClick={() => openDrawer('create')}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        Add User
                      </button>
                    </div>
                  </div>
                </div>
                
                {customer.users.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Icon name="avatar" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No users found</h3>
                    <p className="text-gray-500 mb-6">
                      {searchTerm 
                        ? `No users match your search criteria "${searchTerm}".`
                        : 'Get started by creating your first user.'
                      }
                    </p>
                    <button
                      onClick={() => openDrawer('create')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                    >
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      Add User
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
                            Email
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Username
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Roles
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reset</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assign NPIs</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {customer.users.map((userItem: any) => (
                          <tr key={userItem.id} className={`hover:bg-gray-50 ${!userItem.active ? 'opacity-70' : ''}`}>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm font-medium text-gray-900">{userItem.name}</div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">{userItem.email}</div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">{userItem.username}</div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex flex-wrap gap-1">
                                {userItem.roles.map((role: any) => (
                                  <span
                                    key={role.name}
                                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                      role.name === 'customer-admin' 
                                        ? 'bg-blue-100 text-blue-800'
                                        : role.name === 'provider-group-admin'
                                        ? 'bg-green-100 text-green-800'
                                        : 'bg-gray-100 text-gray-800'
                                    }`}
                                  >
                                    {role.name.replace('-', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                userItem.active 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-gray-100 text-gray-800'
                              }`}>
                                {userItem.active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                              <div className="flex items-center gap-2">
                                <button onClick={() => openDrawer('edit', userItem.id)} className="text-blue-600 hover:text-blue-800 p-1" title="Edit user">
                                  <Icon name="pencil-1" className="h-4 w-4" />
                                </button>
                                <Form method="post" className="inline">
                                  <input type="hidden" name="intent" value="set-active" />
                                  <input type="hidden" name="userId" value={userItem.id} />
                                  <input type="hidden" name="status" value={userItem.active ? 'inactive' : 'active'} />
                                  <button type="submit" className={`p-1 ${userItem.active ? 'text-red-600 hover:text-red-800' : 'text-green-600 hover:text-green-800'}`} title={userItem.active ? 'Deactivate user' : 'Activate user'}>
                                    <Icon name={userItem.active ? 'lock-closed' : 'lock-open-1'} className="h-4 w-4" />
                                  </button>
                                </Form>
                                {(() => {
                                  const isSystemAdmin = userItem.roles.some((r: any) => r.name === 'system-admin')
                                  const isCustomerAdmin = userItem.roles.some((r: any) => r.name === 'customer-admin')
                                  const isSelf = userItem.id === user.id
                                  let lastCustomerAdmin = false
                                  if (isCustomerAdmin) {
                                    const others = customer.users.filter((u: any) => u.id !== userItem.id && u.roles.some((r: any) => r.name === 'customer-admin'))
                                    lastCustomerAdmin = others.length === 0
                                  }
                                  let disabledReason: string | null = null
                                  if (isSystemAdmin) disabledReason = 'Cannot delete system administrators'
                                  else if (isSelf) disabledReason = 'You cannot delete your own account'
                                  else if (lastCustomerAdmin) disabledReason = 'Cannot delete the last customer-admin'
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (disabledReason) return
                                        console.log('[DELLOG][openDeleteModal]', { id: userItem.id, username: userItem.username, name: userItem.name })
                                        setDeleteModal({ isOpen: true, userId: userItem.id, username: userItem.username, name: userItem.name, confirmValue: '' })
                                      }}
                                      className={`p-1 flex items-center rounded ${disabledReason ? 'text-gray-300 cursor-not-allowed' : 'text-red-600 hover:text-red-800'}`}
                                      title={disabledReason || 'Delete user'}
                                      aria-disabled={disabledReason ? 'true' : 'false'}
                                    >
                                      <Icon name="trash" className="h-4 w-4" />
                                      <span className="sr-only">Delete</span>
                                    </button>
                                  )
                                })()}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                              <button onClick={() => openDrawer('reset-password', userItem.id)} className="text-indigo-600 hover:text-indigo-800 p-1" title="Reset password"><Icon name="reset" className="h-4 w-4" /></button>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                              <button onClick={() => openDrawer('assign-npis', userItem.id)} className="text-green-600 hover:text-green-800 p-1" title="Assign NPIs"><Icon name="file-text" className="h-4 w-4" /></button>
                            </td>
                            {/** Delete column cell removed; delete now in Actions column */}
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
                      <Icon name="avatar" className="h-8 w-8 text-blue-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-blue-900">Total Users</p>
                        <p className="text-2xl font-bold text-blue-600">{customer.users.length}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-green-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="check" className="h-8 w-8 text-green-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-green-900">Active Users</p>
                        <p className="text-2xl font-bold text-green-600">
                          {customer.users.filter((u: any) => u.active).length}
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-yellow-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="file-text" className="h-8 w-8 text-yellow-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-yellow-900">With NPIs</p>
                        <p className="text-2xl font-bold text-yellow-600">
                          {customer.users.filter((u: any) => u.userNpis.length > 0).length}
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

      {/* Create User Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'create'}
        onClose={closeDrawer}
        title="Add New User"
        size="md"
      >
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <Field
              labelProps={{ children: 'Full Name' }}
              inputProps={{
                ...getInputProps(createFields.name, { type: 'text' }),
                placeholder: 'John Doe',
              }}
              errors={createFields.name.errors}
            />
            <Field
              labelProps={{ children: 'Email' }}
              inputProps={{
                ...getInputProps(createFields.email, { type: 'email' }),
                placeholder: 'john@example.com',
                onChange: e => { const v = e.currentTarget.value; setEmailValue(v); debouncedCheckEmail(v) },
                onBlur: e => debouncedCheckEmail(e.currentTarget.value),
              }}
              errors={createFields.email.errors}
            />
            {emailExists === true && <p className="mt-0.5 text-xs text-red-600">Email already exists</p>}
            <div className="text-[11px] leading-5">
              <ul className="space-y-0.5">
                <li className={emailLooksValid ? 'text-green-600' : 'text-gray-500'}>{emailLooksValid ? '✓' : '•'} Valid email format</li>
                <li className={emailExists === true ? 'text-red-600' : emailExists === false ? 'text-green-600' : 'text-gray-500'}>
                  {checkingEmail ? '… checking availability' : emailExists === true ? '✗ Email already in use' : emailExists === false ? '✓ Email available' : '• Will check availability'}
                </li>
              </ul>
            </div>

            <Field
              labelProps={{ children: 'Username' }}
              inputProps={{
                ...getInputProps(createFields.username, { type: 'text' }),
                placeholder: 'jdoe',
                onChange: e => { const v = e.currentTarget.value; setUsernameValue(v); debouncedCheckUsername(v) },
                onBlur: e => debouncedCheckUsername(e.currentTarget.value),
              }}
              errors={createFields.username.errors}
            />
            {usernameExists === true && <p className="mt-0.5 text-xs text-red-600">Username already exists</p>}
            <div className="text-[11px] leading-5">
              <ul className="space-y-0.5">
                <li className={usernameOkLen ? 'text-green-600' : 'text-gray-500'}>{usernameOkLen ? '✓' : '•'} {USERNAME_MIN_LENGTH}–{USERNAME_MAX_LENGTH} characters</li>
                <li className={usernameOkChars ? 'text-green-600' : 'text-gray-500'}>{usernameOkChars ? '✓' : '•'} Letters, numbers, underscores</li>
                <li className={usernameExists === true ? 'text-red-600' : usernameExists === false ? 'text-green-600' : 'text-gray-500'}>
                  {checkingUsername ? '… checking availability' : usernameExists === true ? '✗ Username taken' : usernameExists === false ? '✓ Username available' : '• Will check availability'}
                </li>
              </ul>
            </div>

            <SelectField
              labelProps={{ children: 'Role' }}
              selectProps={{
                ...getInputProps(createFields.role, { type: 'text' }),
                onChange: (e) => setCreateSelectedRole(e.target.value),
                required: true,
              }}
              errors={createFields.role.errors}
            >
              <option value="" disabled>Choose role...</option>
              {roles.map((role) => (
                <option key={role.id} value={role.name}>
                  {role.name.replace('-', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                </option>
              ))}
            </SelectField>

            {createSelectedRole === 'provider-group-admin' && (
              <SelectField
                labelProps={{ children: 'Provider Group' }}
                selectProps={{
                  ...getInputProps(createFields.providerGroupId, { type: 'text' }),
                }}
                errors={createFields.providerGroupId.errors}
              >
                <option value="">No Provider Group</option>
                {customer.providerGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </SelectField>
            )}

            <div className="flex items-center space-x-3">
              <input
                {...getInputProps(createFields.active, { type: 'checkbox' })}
                defaultChecked={true}
                className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
              />
              <label htmlFor={createFields.active.id} className="text-sm font-medium text-gray-900">
                Active User
              </label>
            </div>

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
                Create User
              </StatusButton>
            </div>
          </div>
        </Form>
      </Drawer>

      {/* Edit User Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'edit'}
        onClose={closeDrawer}
        title={`Edit ${selectedUser?.name || 'User'}`}
        size="md"
      >
        {selectedUser && (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="userId" value={selectedUser.id} />
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'Full Name' }}
                inputProps={{
                  ...getInputProps(editFields.name, { type: 'text' }),
                  defaultValue: selectedUser.name || '',
                }}
                errors={editFields.name.errors}
              />

              <Field
                labelProps={{ children: 'Email (Read-only)' }}
                inputProps={{
                  type: 'text',
                  value: selectedUser.email,
                  disabled: true,
                  className: 'bg-gray-50 text-gray-500',
                }}
              />

              <Field
                labelProps={{ children: 'Username (Read-only)' }}
                inputProps={{
                  type: 'text',
                  value: selectedUser.username,
                  disabled: true,
                  className: 'bg-gray-50 text-gray-500',
                }}
              />

              <SelectField
                labelProps={{ children: 'Role' }}
                selectProps={{
                  ...getInputProps(editFields.role, { type: 'text' }),
                  defaultValue: selectedUser.roles[0]?.name,
                  onChange: (e) => setEditSelectedRole(e.target.value),
                  required: true,
                }}
                errors={editFields.role.errors}
              >
                <option value="" disabled>Choose role...</option>
                {roles.filter(role => role.name !== 'system-admin').map((role) => (
                  <option key={role.id} value={role.name}>
                    {role.name.replace('-', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                  </option>
                ))}
              </SelectField>

              {(editSelectedRole === 'provider-group-admin' || (!editSelectedRole && selectedUser.roles[0]?.name === 'provider-group-admin')) && (
                <SelectField
                  labelProps={{ children: 'Provider Group' }}
                  selectProps={{
                    ...getInputProps(editFields.providerGroupId, { type: 'text' }),
                    defaultValue: selectedUser.providerGroup?.id || '',
                  }}
                  errors={editFields.providerGroupId.errors}
                >
                  <option value="">No Provider Group</option>
                  {customer.providerGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </SelectField>
              )}

              <div className="flex items-center space-x-3">
                <input
                  {...getInputProps(editFields.active, { type: 'checkbox' })}
                  defaultChecked={selectedUser.active}
                  className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                />
                <label htmlFor={editFields.active.id} className="text-sm font-medium text-gray-900">
                  Active User
                </label>
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
                  Update User
                </StatusButton>
              </div>
            </div>
          </Form>
        )}
      </Drawer>

      {/* Reset Password Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'reset-password'}
        onClose={closeDrawer}
        title={`Reset Password${selectedUser ? ` — ${selectedUser.name}` : ''}`}
        size="md"
      >
        {selectedUser && (
          <Form method="post">
            <input type="hidden" name="intent" value="reset-password" />
            <input type="hidden" name="userId" value={selectedUser.id} />
            <div className="space-y-6">
              <div className="bg-gray-50 rounded-lg p-4 text-sm">
                <div className="grid grid-cols-2 gap-4">
                  <div><span className="text-gray-500">User:</span><span className="ml-2 font-medium">{selectedUser.name}</span></div>
                  <div><span className="text-gray-500">Username:</span><span className="ml-2 font-medium">{selectedUser.username}</span></div>
                  <div className="col-span-2"><span className="text-gray-500">Email:</span><span className="ml-2 font-medium">{selectedUser.email}</span></div>
                </div>
              </div>
              <fieldset>
                <legend className="text-sm font-medium text-gray-900 mb-2">Password mode</legend>
                <div className="space-y-2">
                  <label className="inline-flex items-center gap-2">
                    <input type="radio" name="mode" value="auto" defaultChecked onChange={() => setResetMode('auto')} />
                    <span className="text-sm text-gray-700">Auto-generate a strong password</span>
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="radio" name="mode" value="manual" onChange={() => setResetMode('manual')} />
                    <span className="text-sm text-gray-700">Manually set a password</span>
                  </label>
                </div>
              </fieldset>
              {resetMode === 'manual' && (
                <div>
                  <ManualPasswordSection name="manualPassword" />
                  {(() => {
                    const errs = (actionData && 'result' in actionData && (actionData as any).result?.fieldErrors?.manualPassword) as
                      | string[]
                      | undefined
                    return errs && errs.length ? (
                      <ul className="mt-1 text-xs text-red-600 space-y-0.5">
                        {errs.map(e => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    ) : null
                  })()}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                <button type="button" onClick={closeDrawer} className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                <StatusButton type="submit" disabled={isPending} status={isPending ? 'pending' : 'idle'} className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700">Reset & Email Password</StatusButton>
              </div>
            </div>
          </Form>
        )}
      </Drawer>

      {/* Assign NPIs Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'assign-npis'}
        onClose={closeDrawer}
        title={`Assign NPIs to ${selectedUser?.name || 'User'}`}
        size="lg"
      >
        {selectedUser && (
          <Form method="post">
            <input type="hidden" name="intent" value="assign-npis" />
            <input type="hidden" name="userId" value={selectedUser.id} />
            {selectedNpis.map(id => <input key={id} type="hidden" name="providerIds" value={id} />)}
            <div className="space-y-6">
              <div className="bg-gray-50 rounded-lg p-4 text-sm">
                <div className="grid grid-cols-2 gap-4">
                  <div><span className="text-gray-500">Name:</span><span className="ml-2 font-medium">{selectedUser.name}</span></div>
                  <div><span className="text-gray-500">Current NPIs:</span><span className="ml-2 font-medium">{selectedNpis.length}</span></div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Search NPIs</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Icon name="magnifying-glass" className="h-5 w-5 text-gray-400" /></div>
                  <input type="text" value={npiSearchTerm} onChange={e => setNpiSearchTerm(e.target.value)} placeholder="Search by NPI or provider name" className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md" />
                </div>
              </div>
              <div className="border border-gray-300 rounded-lg max-h-64 overflow-y-auto divide-y divide-gray-200">
                {getAvailableNpis().length === 0 ? (
                  <div className="p-4 text-center text-gray-500">No NPIs available.</div>
                ) : getAvailableNpis().map((p: any) => (
                  <div key={p.id} className={`p-3 cursor-pointer hover:bg-gray-50 ${selectedNpis.includes(p.id) ? 'bg-blue-50' : ''}`} onClick={() => toggleNpiSelection(p.id)}>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={selectedNpis.includes(p.id)} onChange={() => toggleNpiSelection(p.id)} className="h-4 w-4 text-blue-600 border-gray-300 rounded" />
                      <div className="text-sm"><span className="font-mono">{p.npi}</span>{p.name && <span className="ml-2 text-gray-600">- {p.name}</span>}</div>
                    </div>
                  </div>
                ))}
              </div>
              {selectedNpis.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Selected NPIs ({selectedNpis.length})</label>
                  <div className="flex flex-wrap gap-2 p-3 bg-blue-50 rounded-lg">
                    {selectedNpis.map(id => {
                      const provider = customer.providers.find((p: any) => p.id === id)
                      if (!provider) return null
                      return (
                        <div key={id} className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-blue-100 text-blue-800">
                          <span className="font-mono mr-1">{provider.npi}</span>
                          {provider.name && <span>{provider.name.length > 18 ? provider.name.slice(0,18)+'…' : provider.name}</span>}
                          <button type="button" onClick={() => removeNpiFromSelection(id)} className="ml-2 text-blue-600 hover:text-blue-800"><Icon name="cross-1" className="h-3 w-3" /></button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                <button type="button" onClick={closeDrawer} className="inline-flex justify-center py-2 px-4 border border-gray-300 rounded-md text-sm bg-white text-gray-700 hover:bg-gray-50">Cancel</button>
                <StatusButton type="submit" disabled={isPending} status={isPending ? 'pending' : 'idle'} className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700">Save NPI Changes</StatusButton>
              </div>
            </div>
          </Form>
        )}
      </Drawer>

      {/* Delete confirmation modal */}
      {deleteModal.isOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDeleteModal(s => ({ ...s, isOpen: false, confirmValue: '' }))} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <Form
              method="post"
              replace
              className="w-full max-w-md rounded-lg bg-white shadow-xl flex flex-col"
              onSubmit={(e) => {
                try {
                  const fd = new FormData(e.currentTarget)
                  console.log('[DELLOG][submit]', Object.fromEntries(fd.entries()))
                } catch (err) {
                  console.error('[DELLOG][submit][err]', err)
                }
              }}
            >
              <input type="hidden" name="intent" value="delete" />
              {deleteModal.userId && <input type="hidden" name="userId" value={deleteModal.userId} />}
              <div className="px-5 py-4 border-b border-gray-200">
                <h3 id="delete-user-title" className="text-sm font-semibold text-red-700 flex items-center gap-2">
                  <Icon name="warning" className="h-4 w-4" /> Delete User
                </h3>
              </div>
              <div className="px-5 py-4 text-sm space-y-4">
                <p>You are about to permanently delete <strong>{deleteModal.name}</strong>. This action cannot be undone.</p>
                <ul className="list-disc pl-5 space-y-1 text-gray-600 text-xs">
                  <li>All sessions will be terminated.</li>
                  <li>NPI assignments will be removed.</li>
                  <li>If this is the last customer admin, deletion is blocked.</li>
                </ul>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1" htmlFor="delete-confirm-input">Type the username to confirm</label>
                  <input
                    id="delete-confirm-input"
                    name="confirm"
                    type="text"
                    autoFocus
                    onFocus={() => console.log('[DELLOG] confirm input focus')}
                    value={deleteModal.confirmValue}
                    onChange={e => {
                      const v = e.currentTarget.value // capture before React pools the event
                      console.log('[DELLOG][confirm.onChange]', v)
                      setDeleteModal(s => ({ ...s, confirmValue: v }))
                    }}
                    onBlur={() => console.log('[DELLOG] confirm input blur')}
                    className="w-full border rounded-md px-3 py-2 text-sm"
                    placeholder={deleteModal.username}
                  />
                </div>
                {deleteModal.username && deleteModal.confirmValue && deleteModal.confirmValue.toLowerCase() !== deleteModal.username.toLowerCase() && (
                  <p className="text-xs text-red-600">Entered value does not match <code>{deleteModal.username}</code>.</p>
                )}
              </div>
              {(() => {
                const targetMatch = deleteModal.username ? deleteModal.confirmValue.toLowerCase() === deleteModal.username.toLowerCase() : false
                const disabled = !targetMatch || isPending || !deleteModal.userId
                return (
                  <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setDeleteModal(s => ({ ...s, isOpen: false, confirmValue: '' }))}
                      className="inline-flex justify-center py-2 px-3 rounded-md border border-gray-300 text-sm bg-white text-gray-700 hover:bg-gray-50"
                    // Extra guard: ensure we never submit stale confirm by syncing hidden input purposely (redundant but safe)
                    >
                      Cancel
                    </button>
                    <StatusButton
                      type="submit"
                      disabled={disabled}
                      status={isPending ? 'pending' : 'idle'}
                      className="inline-flex justify-center py-2 px-4 rounded-md text-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-40"
                    >
                      Delete User
                    </StatusButton>
                  </div>
                )
              })()}
            </Form>
          </div>
        </div>
      )}
      {/* (debug panel removed) */}
    </>
  )
}

// Manual password section component (shared style)
// Local ManualPasswordSection removed in favor of shared component

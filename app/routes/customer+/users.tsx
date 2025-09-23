// app/routes/customer+/users.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import React, { useState, useEffect } from 'react'
import {
    data,
    useLoaderData,
    Form,
    useSearchParams,
    useActionData,
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    Link,
} from 'react-router'
import { z } from 'zod'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { useToast } from '#app/components/toaster.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { sendAdminPasswordManualResetEmail } from '#app/utils/emails/send-admin-password-manual-reset.server.ts'
import { sendUserRegistrationEmail } from '#app/utils/emails/send-user-registration.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import {
    USERNAME_MIN_LENGTH,
    USERNAME_MAX_LENGTH,
} from '#app/utils/user-validation.ts'

// Local username character rule (same as UsernameSchema)
const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/

const CreateUserSchema = z.object({
    intent: z.literal('create'),
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email address'),
    username: z.string().min(3, 'Username must be at least 3 characters'),
    role: z.enum(['customer-admin', 'provider-group-admin', 'basic-user']),
    providerGroupId: z.string().optional(),
})

const UpdateUserSchema = z.object({
    intent: z.literal('update'),
    userId: z.string().min(1, 'User ID is required'),
    name: z.string().min(1, 'Name is required'),
    role: z.enum(['customer-admin', 'provider-group-admin', 'basic-user']),
    providerGroupId: z.string().optional(),
})

const AssignNpisSchema = z.object({
    intent: z.literal('assign-npis'),
    userId: z.string().min(1, 'User ID is required'),
    providerIds: z.array(z.string()).default([]),
})

// ✅ One reset action
const ResetPasswordSchema = z.object({
    intent: z.literal('reset-password'),
    userId: z.string().min(1, 'User ID is required'),
    mode: z.enum(['auto', 'manual']),
    manualPassword: z.string().optional(),
})

// ✅ New: Activate/Deactivate user
const SetActiveSchema = z.object({
    intent: z.literal('set-active'),
    userId: z.string().min(1, 'User ID is required'),
    status: z.enum(['active', 'inactive']),
})

// Lightweight schema for live availability checks
const CheckAvailabilitySchema = z.object({
    intent: z.literal('check-availability'),
    field: z.enum(['email', 'username']),
    value: z.string().min(1),
})

const ActionSchema = z.discriminatedUnion('intent', [
    CreateUserSchema,
    UpdateUserSchema,
    AssignNpisSchema,
    CheckAvailabilitySchema,
    ResetPasswordSchema,
    SetActiveSchema,
])

export async function loader({ request }: LoaderFunctionArgs) {
    try {
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

        // Parse search parameters safely
        const url = new URL(request.url)
        const searchTerm = url.searchParams.get('search') || ''

        // Visible roles depend on who is viewing
        const visibleRoles = isCustomerAdmin
            ? ['customer-admin', 'provider-group-admin', 'basic-user']
            : ['provider-group-admin', 'basic-user']

        // Build search conditions for users based on role scope
        const userWhereConditions: any = {
            customerId: user.customerId,
            roles: {
                some: {
                    name: { in: visibleRoles },
                },
            },
        }

        // Provider group admins can only see users in their provider group
        if (isProviderGroupAdmin && !isCustomerAdmin) {
            userWhereConditions.providerGroupId = user.providerGroupId
        }

        if (searchTerm) {
            userWhereConditions.OR = [
                { name: { contains: searchTerm } },
                { email: { contains: searchTerm } },
                { username: { contains: searchTerm } },
            ]
        }

        // Get customer data with provider groups and filtered users
        const customer = await prisma.customer.findUnique({
            where: { id: user.customerId },
            include: {
                providerGroups: {
                    where: isProviderGroupAdmin && !isCustomerAdmin ? { id: user.providerGroupId! } : {},
                    include: {
                        _count: { select: { users: true, providers: true } },
                    },
                },
                providers: {
                    where: isProviderGroupAdmin && !isCustomerAdmin ? { providerGroupId: user.providerGroupId! } : {},
                    include: { providerGroup: { select: { id: true, name: true } } },
                    orderBy: [{ providerGroupId: 'asc' }, { npi: 'asc' }],
                },
                users: {
                    where: userWhereConditions,
                    include: {
                        roles: { select: { name: true } },
                        providerGroup: { select: { id: true, name: true} },
                        userNpis: {
                            include: {
                                provider: { select: { id: true, npi: true, name: true, providerGroupId: true } },
                            },
                        },
                    },
                    orderBy: { name: 'asc' },
                },
            },
        })

        if (!customer) {
            throw new Response('Customer not found', { status: 404 })
        }

        const { toast, headers } = await getToast(request)
        return data({ user, customer, toast, searchTerm }, { headers: headers ?? undefined })
    } catch (error) {
        if (error instanceof Response && error.status === 302) {
            throw error
        }
        console.error('Error in customer users loader:', error)
        throw new Response('Internal Server Error', { status: 500 })
    }
}

export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
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

    const formData = await request.formData()
    const submission = parseWithZod(formData, { schema: ActionSchema })

    if (submission.status !== 'success') {
        return data(
            { result: submission.reply() },
            { status: submission.status === 'error' ? 400 : 200 },
        )
    }

    const action = submission.value

    // Live availability check
    if (action.intent === 'check-availability') {
        const { field, value } = action
        if (field === 'email') {
            const exists = !!(await prisma.user.findUnique({ where: { email: value.toLowerCase() } }))
            return data<{ exists: boolean }>({ exists })
        }
        if (field === 'username') {
            const exists = !!(await prisma.user.findUnique({ where: { username: value.toLowerCase() } }))
            return data<{ exists: boolean }>({ exists })
        }
    }

    // Create
    if (action.intent === 'create') {
        const { name, email, username, role, providerGroupId } = action

        // Only Customer Admin can create another Customer Admin
        if (role === 'customer-admin' && !isCustomerAdmin) {
            return data({ error: 'Only customer administrators can create customer administrators.' }, { status: 403 })
        }

        // Email exists
        const existingUser = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        })
        if (existingUser) {
            return data(
                { result: submission.reply({ fieldErrors: { email: ['Email already exists'] } }) },
                { status: 400 },
            )
        }

        // Username exists
        const existingUsername = await prisma.user.findUnique({
            where: { username: username.toLowerCase() },
        })
        if (existingUsername) {
            return data(
                { result: submission.reply({ fieldErrors: { username: ['Username already exists'] } }) },
                { status: 400 },
            )
        }

        // Provider group rules
        let effectiveProviderGroupId: string | null = providerGroupId || null
        if (role === 'customer-admin') {
            effectiveProviderGroupId = null
        } else if (isProviderGroupAdmin && !isCustomerAdmin) {
            if (!providerGroupId || providerGroupId !== user.providerGroupId) {
                return data(
                    {
                        result: submission.reply({
                            fieldErrors: { providerGroupId: ['You can only create users in your assigned provider group'] },
                        }),
                    },
                    { status: 400 },
                )
            }
        }

        // Validate provider group exists and belongs to customer (when provided)
        if (effectiveProviderGroupId) {
            const providerGroup = await prisma.providerGroup.findFirst({
                where: { id: effectiveProviderGroupId, customerId: user.customerId },
            })
            if (!providerGroup) {
                return data(
                    { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
                    { status: 400 },
                )
            }
        }

        // Generate temporary password
        const temporaryPassword = generateTemporaryPassword()

        // Create the user
        const newUser = await prisma.user.create({
            data: {
                name,
                email: email.toLowerCase(),
                username: username.toLowerCase(),
                customerId: user.customerId,
                providerGroupId: effectiveProviderGroupId,
                roles: { connect: { name: role } },
                password: { create: { hash: hashPassword(temporaryPassword) } },
            },
            include: { providerGroup: { select: { name: true } } },
        })

        // Get customer information for email
        const customer = await prisma.customer.findUnique({
            where: { id: user.customerId! },
            select: { name: true },
        })
        if (!customer) throw new Response('Customer not found', { status: 404 })

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
        }

        console.log(`New user created: ${email} with temporary password: ${temporaryPassword}`)

        return redirectWithToast('/customer/users', {
            type: 'success',
            title: 'User created',
            description: `${name} has been created successfully and a welcome email has been sent.`,
        })
    }

    // Update
    if (action.intent === 'update') {
        const { userId: targetUserId, name, role, providerGroupId } = action

        const targetUser = await prisma.user.findFirst({
            where: { id: targetUserId, customerId: user.customerId },
            include: { roles: { select: { name: true } }, userNpis: { select: { providerId: true } } },
        })
        if (!targetUser) {
            return data({ error: 'User not found or not authorized to edit this user' }, { status: 404 })
        }

        const targetIsCustomerAdmin = targetUser.roles.some(r => r.name === 'customer-admin')

        // Only Customer Admins can edit Customer Admins
        if (!isCustomerAdmin && targetIsCustomerAdmin) {
            return data({ error: 'Only customer administrators can edit customer administrators' }, { status: 403 })
        }

        // Only Customer Admin can assign the customer-admin role
        if (role === 'customer-admin' && !isCustomerAdmin) {
            return data({ error: 'Only customer administrators can assign the customer-admin role' }, { status: 403 })
        }

        // Provider group admin scope validation
        if (isProviderGroupAdmin && !isCustomerAdmin) {
            if (targetUser.providerGroupId !== user.providerGroupId) {
                return data({ error: 'You can only edit users in your assigned provider group' }, { status: 403 })
            }
            if (providerGroupId && providerGroupId !== user.providerGroupId) {
                return data(
                    { result: submission.reply({ fieldErrors: { providerGroupId: ['You can only assign users to your provider group'] } }) },
                    { status: 400 },
                )
            }
        }

        // Validate provider group when role is not customer-admin
        const effectiveProviderGroupId = role === 'customer-admin' ? null : providerGroupId || null
        if (effectiveProviderGroupId) {
            const providerGroup = await prisma.providerGroup.findFirst({
                where: { id: effectiveProviderGroupId, customerId: user.customerId },
            })
            if (!providerGroup) {
                return data(
                    { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
                    { status: 400 },
                )
            }
        }

        await prisma.user.update({
            where: { id: targetUserId },
            data: {
                name,
                providerGroupId: effectiveProviderGroupId,
                roles: { set: [{ name: role }] },
            },
        })

        return redirectWithToast('/customer/users', {
            type: 'success',
            title: 'User updated',
            description: `${name} has been updated successfully.`,
        })
    }

    // Assign NPIs
    if (action.intent === 'assign-npis') {
        const { userId: targetUserId, providerIds } = action

        const targetUser = await prisma.user.findFirst({
            where: { id: targetUserId, customerId: user.customerId, roles: { some: { name: 'basic-user' } } },
            include: { roles: { select: { name: true } }, providerGroup: { select: { id: true, name: true } } },
        })
        if (!targetUser) {
            return data({ error: 'User not found or not authorized to assign NPIs to this user' }, { status: 404 })
        }

        if (isProviderGroupAdmin && !isCustomerAdmin) {
            if (targetUser.providerGroupId !== user.providerGroupId) {
                return data({ error: 'You can only assign NPIs to users in your assigned provider group' }, { status: 403 })
            }
        }

        // Fetch providers for validation (guard rails)
        const providersForValidation = await prisma.provider.findMany({
            where: { id: { in: providerIds }, customerId: user.customerId, active: true },
            select: { id: true, providerGroupId: true },
        })
        const fetchedIds = providersForValidation.map(p => p.id)
        const missingIds = providerIds.filter(pid => !fetchedIds.includes(pid))
        if (missingIds.length > 0) {
            return data({ error: 'Some selected NPIs are not active or do not belong to this customer' }, { status: 400 })
        }

        // Guard Rail: If user has NO provider group, they may only be assigned NPIs with NO provider group
        if (!targetUser.providerGroupId) {
            const groupedPicked = providersForValidation.filter(p => p.providerGroupId)
            if (groupedPicked.length > 0) {
                return data({ error: 'Cannot assign grouped NPIs to a user without a provider group' }, { status: 400 })
            }
        }
        // Guard Rail: If user HAS a provider group, all NPIs must be in that same group
        if (targetUser.providerGroupId) {
            const mismatched = providersForValidation.filter(p => p.providerGroupId !== targetUser.providerGroupId)
            if (mismatched.length > 0) {
                return data({ error: 'All NPIs must belong to the user\'s provider group' }, { status: 400 })
            }
        }

        await prisma.userNpi.deleteMany({ where: { userId: targetUserId } })
        if (providerIds.length > 0) {
            await prisma.userNpi.createMany({ data: providerIds.map(providerId => ({ userId: targetUserId, providerId })) })
        }

        return redirectWithToast('/customer/users', {
            type: 'success',
            title: 'NPIs assigned',
            description: `${providerIds.length} NPIs have been assigned to ${targetUser.name}.`,
        })
    }

    // Reset password
    if (action.intent === 'reset-password') {
        const { userId: targetUserId, mode } = action
        const manualPassword = action.mode === 'manual' ? action.manualPassword : undefined

        const targetUser = await prisma.user.findFirst({
            where: { id: targetUserId, customerId: user.customerId },
            include: { roles: { select: { name: true } }, customer: { select: { name: true } } },
        })
        if (!targetUser) {
            return redirectWithToast('/customer/users', {
                type: 'error',
                title: 'User not found',
                description: 'Unable to reset password. Please refresh and try again.',
            })
        }

        const targetIsCustomerAdmin = targetUser.roles.some(r => r.name === 'customer-admin')
        if (targetIsCustomerAdmin && !isCustomerAdmin) {
            return redirectWithToast('/customer/users', {
                type: 'error',
                title: 'Not allowed',
                description: 'Only customer administrators can reset passwords for customer administrators.',
            })
        }

        if (isProviderGroupAdmin && !isCustomerAdmin) {
            if (targetUser.providerGroupId !== user.providerGroupId) {
                return redirectWithToast('/customer/users', {
                    type: 'error',
                    title: 'Wrong scope',
                    description: 'You can only reset passwords for users in your provider group.',
                })
            }
        }

        if (mode === 'manual') {
            const pwd = (manualPassword ?? '').trim()
            if (pwd.length < 8) {
                return data(
                    { result: submission.reply({ fieldErrors: { manualPassword: ['Password must be at least 8 characters'] } }) },
                    { status: 400 },
                )
            }
        }

        const newPassword = mode === 'auto' ? generateTemporaryPassword() : (manualPassword ?? '')
        const passwordHash = hashPassword(newPassword)

        await prisma.password.upsert({
            where: { userId: targetUserId },
            create: { userId: targetUserId, hash: passwordHash },
            update: { hash: passwordHash },
        })
        await prisma.session.deleteMany({ where: { userId: targetUserId } })

        const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
        await sendAdminPasswordManualResetEmail({
            to: targetUser.email,
            recipientName: targetUser.name || targetUser.username,
            requestedByName: user.name ?? undefined,
            customerName: targetUser.customer?.name ?? undefined,
            username: targetUser.username,
            tempPassword: newPassword,
            loginUrl,
        })

        return redirectWithToast('/customer/users', {
            type: 'success',
            title: 'Password reset',
            description: `A new ${mode === 'auto' ? 'temporary' : 'manual'} password was emailed to ${targetUser.email}.`,
        })
    }

    // ✅ Activate / Deactivate (soft off-boarding)
    if (action.intent === 'set-active') {
        const { userId: targetUserId, status } = action

        const targetUser = await prisma.user.findFirst({
            where: { id: targetUserId, customerId: user.customerId },
            include: { roles: { select: { name: true } }, userNpis: { select: { providerId: true } } },
        })
        if (!targetUser) {
            return redirectWithToast('/customer/users', {
                type: 'error',
                title: 'User not found',
                description: 'Unable to update user status. Please refresh and try again.',
            })
        }

        // Don’t allow self de/activation
        if (targetUserId === user.id) {
            return redirectWithToast('/customer/users', {
                type: 'error',
                title: 'Not allowed',
                description: 'You cannot change the active status of your own account.',
            })
        }

        const targetIsCustomerAdmin = targetUser.roles.some(r => r.name === 'customer-admin')

        // Scope checks
        if (!isCustomerAdmin && isProviderGroupAdmin) {
            if (targetIsCustomerAdmin) {
                return redirectWithToast('/customer/users', {
                    type: 'error',
                    title: 'Not allowed',
                    description: 'Only customer administrators can change status of customer administrators.',
                })
            }
            if (targetUser.providerGroupId !== user.providerGroupId) {
                return redirectWithToast('/customer/users', {
                    type: 'error',
                    title: 'Wrong scope',
                    description: 'You can only change status for users in your provider group.',
                })
            }
        }

        const makeActive = status === 'active'

        // Guard: cannot deactivate while NPIs assigned
        if (!makeActive && targetUser.userNpis.length > 0) {
            return redirectWithToast('/customer/users', {
                type: 'error',
                title: 'Unassign NPIs first',
                description: `${targetUser.name ?? targetUser.username} still has ${targetUser.userNpis.length} assigned NPI${targetUser.userNpis.length === 1 ? '' : 's'}. Remove all assignments before deactivation.`,
            })
        }

        await prisma.user.update({
            where: { id: targetUserId },
            data: { active: makeActive },
        })

        // Kill sessions when deactivating
        if (!makeActive) {
            await prisma.session.deleteMany({ where: { userId: targetUserId } })
        }

        return redirectWithToast('/customer/users', {
            type: 'success',
            title: makeActive ? 'User activated' : 'User deactivated',
            description: makeActive
                ? `${targetUser.name ?? targetUser.username} can log in again.`
                : `${targetUser.name ?? targetUser.username} has been signed out and can no longer log in.`,
        })
    }

    return data({ error: 'Invalid action' }, { status: 400 })
}

export default function CustomerUsersPage() {
    const { user, customer, toast, searchTerm } = useLoaderData<typeof loader>()
    const actionData = useActionData<typeof action>()
    const [searchParams, setSearchParams] = useSearchParams()
    const isPending = useIsPending()
    useToast(toast)

    const [drawerState, setDrawerState] = useState<{
        isOpen: boolean
        mode: 'create' | 'edit' | 'assign-npis' | 'reset-password'
        userId?: string
    }>({ isOpen: false, mode: 'create' })

    // Helper/availability states for Create drawer
    const [nameValue, setNameValue] = useState('')
    const [emailValue, setEmailValue] = useState('')
    const [usernameValue, setUsernameValue] = useState('')

    const [emailExists, setEmailExists] = useState<boolean | null>(null)
    const [usernameExists, setUsernameExists] = useState<boolean | null>(null)

    const [checkingEmail, setCheckingEmail] = useState(false)
    const [checkingUsername, setCheckingUsername] = useState(false)

    // debounce helper
    function debounce<F extends (...args: any[]) => void>(fn: F, ms: number) {
        let t: ReturnType<typeof setTimeout> | null = null
        return (...args: Parameters<F>) => {
            if (t) clearTimeout(t)
            t = setTimeout(() => fn(...args), ms)
        }
    }

    type AvailabilityResponse = { exists: boolean }

    // debounced availability checks to the same route
    const debouncedCheckEmail = React.useMemo(
        () =>
            debounce(async (value: string) => {
                if (!value) {
                    setEmailExists(null)
                    return
                }
                setCheckingEmail(true)
                try {
                    const fd = new FormData()
                    fd.set('intent', 'check-availability')
                    fd.set('field', 'email')
                    fd.set('value', value)
                    const res = await fetch('/customer/users', { method: 'POST', body: fd })
                    const jsonUnknown = (await res.json()) as unknown
                    const exists =
                        jsonUnknown && typeof (jsonUnknown as any).exists === 'boolean'
                            ? ((jsonUnknown as AvailabilityResponse).exists as boolean)
                            : null
                    setEmailExists(exists)
                } catch {
                    setEmailExists(null)
                } finally {
                    setCheckingEmail(false)
                }
            }, 350),
        [],
    )

    const debouncedCheckUsername = React.useMemo(
        () =>
            debounce(async (value: string) => {
                if (!value) {
                    setUsernameExists(null)
                    return
                }
                setCheckingUsername(true)
                try {
                    const fd = new FormData()
                    fd.set('intent', 'check-availability')
                    fd.set('field', 'username')
                    fd.set('value', value)
                    const res = await fetch('/customer/users', { method: 'POST', body: fd })
                    const jsonUnknown = (await res.json()) as unknown
                    const exists =
                        jsonUnknown && typeof (jsonUnknown as any).exists === 'boolean'
                            ? ((jsonUnknown as AvailabilityResponse).exists as boolean)
                            : null
                    setUsernameExists(exists)
                } catch {
                    setUsernameExists(null)
                } finally {
                    setCheckingUsername(false)
                }
            }, 350),
        [],
    )

    // computed booleans for helpers
    const nameOkLen = nameValue.trim().length >= 3 && nameValue.trim().length <= 40
    const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue.trim() || '')
    const userLen = usernameValue.trim().length
    const usernameOkLen = userLen >= USERNAME_MIN_LENGTH && userLen <= USERNAME_MAX_LENGTH
    const usernameOkChars = USERNAME_REGEX.test(usernameValue.trim() || '')

    // Handle URL parameters for drawer state
    useEffect(() => {
        const action = searchParams.get('action')
        const userId = searchParams.get('userId')

        if (action === 'add') {
            setDrawerState({ isOpen: true, mode: 'create' })
            // reset helpers when opening create drawer
            setNameValue('')
            setEmailValue('')
            setUsernameValue('')
            setEmailExists(null)
            setUsernameExists(null)
            setCheckingEmail(false)
            setCheckingUsername(false)
        } else if (action === 'edit' && userId) {
            setDrawerState({ isOpen: true, mode: 'edit', userId })
        } else if (action === 'assign-npis' && userId) {
            setDrawerState({ isOpen: true, mode: 'assign-npis', userId })
        } else if (action === 'reset' && userId) {
            setDrawerState({ isOpen: true, mode: 'reset-password', userId })
        } else {
            setDrawerState({ isOpen: false, mode: 'create' })
        }
    }, [searchParams])

    const openDrawer = (mode: 'create' | 'edit' | 'assign-npis' | 'reset-password', userId?: string) => {
        const newParams = new URLSearchParams(searchParams)
        if (mode === 'create') newParams.set('action', 'add')
        else if (mode === 'edit') newParams.set('action', 'edit')
        else if (mode === 'assign-npis') newParams.set('action', 'assign-npis')
        else if (mode === 'reset-password') newParams.set('action', 'reset')
        if (userId) newParams.set('userId', userId)
        setSearchParams(newParams)
    }

    const closeDrawer = () => {
        const newParams = new URLSearchParams(searchParams)
        newParams.delete('action')
        newParams.delete('userId')
        setSearchParams(newParams)
    }

    const selectedUser = drawerState.userId ? customer.users.find(u => u.id === drawerState.userId) : null

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
        defaultValue: selectedUser
            ? {
                name: selectedUser.name,
                role: (selectedUser.roles[0]?.name as 'customer-admin' | 'provider-group-admin' | 'basic-user') ?? 'basic-user',
                providerGroupId: selectedUser.providerGroup?.id || '',
            }
            : undefined,
    })

    // Reset form
    const [resetForm, resetFields] = useForm({
        id: 'reset-password-form',
        constraint: getZodConstraint(ResetPasswordSchema),
        lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: ResetPasswordSchema })
        },
        defaultValue: { mode: 'auto' },
    })

    // Track selected role and provider group for NPI filtering / UI
    const [createSelectedRole, setCreateSelectedRole] = useState<string>('')
    const [createSelectedProviderGroup, setCreateSelectedProviderGroup] = useState<string>('')
    const [editSelectedRole, setEditSelectedRole] = useState<string>(selectedUser?.roles[0]?.name || '')
    const [editSelectedProviderGroup, setEditSelectedProviderGroup] = useState<string>(
        selectedUser?.providerGroup?.id || '',
    )

    // Reset mode local state for conditional field
    const [resetMode, setResetMode] = useState<'auto' | 'manual'>('auto')
    useEffect(() => {
        if (drawerState.mode === 'reset-password') setResetMode('auto')
    }, [drawerState.mode])

    // NPI Assignment state
    const [selectedNpis, setSelectedNpis] = useState<string[]>([])
    const [npiSearchTerm, setNpiSearchTerm] = useState('')

    // Keep original assigned NPI ids for change detection
    const [originalNpis, setOriginalNpis] = useState<string[]>([])
    // Initialize NPI assignments when user changes
    useEffect(() => {
        if (drawerState.mode === 'assign-npis' && selectedUser) {
            const currentNpis = selectedUser.userNpis?.map(un => un.provider.id) || []
            setSelectedNpis(currentNpis)
            setOriginalNpis(currentNpis)
        }
    }, [drawerState.mode, selectedUser])

    // Get available NPIs for assignment based on user's provider group
    const getAvailableNpis = () => {
        if (!selectedUser) return []
        return customer.providers.filter(p => {
            if (!p.active) return false
            // If user has group -> provider must be in same group
            if (selectedUser.providerGroupId) {
                if (p.providerGroupId !== selectedUser.providerGroupId) return false
            } else {
                // User ungrouped -> only ungrouped providers
                if (p.providerGroupId) return false
            }
            if (
                npiSearchTerm &&
                !p.npi.includes(npiSearchTerm) &&
                !(p.name && p.name.toLowerCase().includes(npiSearchTerm.toLowerCase()))
            ) {
                return false
            }
            return true
        })
    }

    const toggleNpiSelection = (providerId: string) => {
        setSelectedNpis(prev => (prev.includes(providerId) ? prev.filter(id => id !== providerId) : [...prev, providerId]))
    }

    const removeNpiFromSelection = (providerId: string) => {
        setSelectedNpis(prev => prev.filter(id => id !== providerId))
    }

    const viewerIsCustomerAdmin = user.roles.some(r => r.name === 'customer-admin')
    const viewerIsProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin')

    // ✅ Activate/Deactivate modal state
    const [statusModal, setStatusModal] = useState<{
        isOpen: boolean
        userId?: string
        userName?: string | null
        nextStatus: 'active' | 'inactive'
        acknowledged: boolean
        npiCount: number
    }>({ isOpen: false, nextStatus: 'inactive', acknowledged: false, npiCount: 0 })

    function openStatusModal(u: { id: string; name: string | null; active: boolean; userNpis?: any[] }) {
        setStatusModal({
            isOpen: true,
            userId: u.id,
            userName: u.name ?? 'User',
            nextStatus: u.active ? 'inactive' : 'active',
            acknowledged: false,
            npiCount: u.userNpis ? u.userNpis.length : 0,
        })
    }
    function closeStatusModal() {
        setStatusModal(s => ({ ...s, isOpen: false }))
    }

    return (
        <>
            {/* Main content area - blur when drawer is open */}
            <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
                <InterexLayout
                    user={user}
                    title="User Management"
                    subtitle={`Customer: ${customer.name}`}
                    showBackButton={true}
                    backTo="/customer"
                    currentPath="/customer/users"
                >
                    {/* Full-width container (no max width), minimal horizontal padding */}
                    <div className="w-full max-w-none px-2 sm:px-4 lg:px-6 py-6">
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
                                            to="/customer/users"
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
                                            {searchTerm ? `No users match your search criteria "${searchTerm}".` : 'Get started by creating your first user.'}
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
                                    // Scrollable area: horizontal + vertical with sticky header
                                    <div className="overflow-x-auto">
                                        <div className="max-h-[70vh] overflow-y-auto">
                                            <table className="min-w-[1500px] w-full divide-y divide-gray-200">
                                                <thead className="bg-gray-50 sticky top-0 z-10">
                                                <tr>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Name
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Username
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Roles
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Customer
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Provider Group
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        NPIs
                                                    </th>
                                                    {/* New Status + action columns */}
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Status
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Edit
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Assign&nbsp;NPIs
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Reset&nbsp;Password
                                                    </th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Activate/Deactivate
                                                    </th>
                                                </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-gray-200">
                                                {customer.users.map(userItem => {
                                                    const isTargetCustomerAdmin = userItem.roles.some(r => r.name === 'customer-admin')
                                                    const inViewerGroup =
                                                        !viewerIsProviderGroupAdmin ||
                                                        viewerIsCustomerAdmin ||
                                                        (user.providerGroupId && userItem.providerGroup?.id === user.providerGroupId)

                                                    const canReset =
                                                        viewerIsCustomerAdmin ||
                                                        (viewerIsProviderGroupAdmin && !isTargetCustomerAdmin && inViewerGroup)

                                                    const canToggle =
                                                        viewerIsCustomerAdmin ||
                                                        (viewerIsProviderGroupAdmin && !isTargetCustomerAdmin && inViewerGroup)

                                                    const isBasic = userItem.roles.some(r => r.name === 'basic-user')

                                                    return (
                                                        <tr
                                                            key={userItem.id}
                                                            className={`hover:bg-gray-50 ${!userItem.active ? 'bg-gray-50 opacity-60' : ''}`}
                                                        >
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="text-sm font-medium text-gray-900">{userItem.name}</div>
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="text-sm text-gray-900">{userItem.username}</div>
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="flex flex-wrap gap-1">
                                                                    {userItem.roles.map(role => (
                                                                        <span
                                                                            key={role.name}
                                                                            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                                                                        >
                                        {role.name.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                      </span>
                                                                    ))}
                                                                </div>
                                                            </td>

                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="text-sm text-gray-900">{customer.name}</div>
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="text-sm text-gray-900">{userItem.providerGroup?.name ?? '-'}</div>
                                                            </td>

                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="max-w-48">
                                                                    {userItem.userNpis && userItem.userNpis.length > 0 ? (
                                                                        <div className="space-y-1">
                                                                            {userItem.userNpis.slice(0, 3).map(userNpi => (
                                                                                <div key={userNpi.provider.id} className="text-xs">
                                                                                    <span className="font-mono text-gray-900">{userNpi.provider.npi}</span>
                                                                                    {userNpi.provider.name && (
                                                                                        <span className="text-gray-600 ml-1">
                                                - {userNpi.provider.name.length > 15 ? `${userNpi.provider.name.substring(0, 15)}...` : userNpi.provider.name}
                                              </span>
                                                                                    )}
                                                                                </div>
                                                                            ))}
                                                                            {userItem.userNpis.length > 3 && (
                                                                                <div className="text-xs text-gray-500">+{userItem.userNpis.length - 3} more</div>
                                                                            )}
                                                                        </div>
                                                                    ) : (
                                                                        <span className="text-xs text-gray-400">No NPIs assigned</span>
                                                                    )}
                                                                </div>
                                                            </td>

                                                            {/* Status pill */}
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                  <span
                                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                          userItem.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'
                                      }`}
                                  >
                                    {userItem.active ? 'Active' : 'Inactive'}
                                  </span>
                                                            </td>

                                                            {/* Edit column */}
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                                <button
                                                                    onClick={() => openDrawer('edit', userItem.id)}
                                                                    className="inline-flex items-center px-2.5 py-1 rounded-md text-blue-700 hover:text-blue-900 hover:bg-blue-50"
                                                                    title="Edit user"
                                                                >
                                                                    <Icon name="pencil-1" className="h-4 w-4 mr-1" />
                                                                    Edit
                                                                </button>
                                                            </td>

                                                            {/* Assign NPIs column */}
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                                {isBasic ? (
                                                                    <button
                                                                        onClick={() => openDrawer('assign-npis', userItem.id)}
                                                                        className="inline-flex items-center px-2.5 py-1 rounded-md text-green-700 hover:text-green-900 hover:bg-green-50"
                                                                        title="Assign NPIs"
                                                                    >
                                                                        <Icon name="file-text" className="h-4 w-4 mr-1" />
                                                                        Assign
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </td>

                                                            {/* Reset Password column */}
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                                {canReset && userItem.id !== user.id ? (
                                                                    <button
                                                                        onClick={() => openDrawer('reset-password', userItem.id)}
                                                                        className="inline-flex items-center px-2.5 py-1 rounded-md text-indigo-700 hover:text-indigo-900 hover:bg-indigo-50"
                                                                        title="Reset password"
                                                                    >
                                                                        <Icon name="reset" className="h-4 w-4 mr-1" />
                                                                        Reset
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </td>

                                                            {/* Activate/Deactivate column */}
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                                {canToggle && userItem.id !== user.id ? (
                                                                    <button
                                                                        onClick={() => openStatusModal(userItem as any)}
                                                                        className={`inline-flex items-center px-2.5 py-1 rounded-md ${
                                                                            userItem.active
                                                                                ? 'text-red-700 hover:text-red-900 hover:bg-red-50'
                                                                                : 'text-green-700 hover:text-green-900 hover:bg-green-50'
                                                                        }`}
                                                                        title={userItem.active ? 'Deactivate user' : 'Activate user'}
                                                                    >
                                                                        <Icon name={userItem.active ? 'lock-closed' : 'lock-open-1'} className="h-4 w-4 mr-1" />
                                                                        {userItem.active ? 'Deactivate' : 'Activate'}
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
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
                                                    {customer.users.filter(u => u.active).length}
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-yellow-50 rounded-lg p-4">
                                        <div className="flex items-center">
                                            <Icon name="clock" className="h-8 w-8 text-yellow-600 mr-3" />
                                            <div>
                                                <p className="text-sm font-medium text-yellow-900">Inactive Users</p>
                                                <p className="text-2xl font-bold text-yellow-600">
                                                    {customer.users.filter(u => !u.active).length}
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
            <Drawer isOpen={drawerState.isOpen && drawerState.mode === 'create'} onClose={closeDrawer} title="Add New User" size="md">
                <Form method="post" {...getFormProps(createForm)}>
                    <input type="hidden" name="intent" value="create" />
                    <div className="space-y-6">
                        {/* Name (compact helper) */}
                        <div className="space-y-1">
                            <Field
                                labelProps={{ children: 'Full Name' }}
                                inputProps={{
                                    ...getInputProps(createFields.name, { type: 'text' }),
                                    placeholder: 'John Doe',
                                    onChange: e => setNameValue(e.currentTarget.value),
                                }}
                                errors={createFields.name.errors}
                            />
                            <div className="text-[11px] leading-5">
                                <ul className="space-y-0.5">
                                    <li className={nameOkLen ? 'text-green-600' : 'text-gray-500'}>{nameOkLen ? '✓' : '•'} 3–40 characters</li>
                                    <li className="text-gray-500">• Leading/trailing spaces are trimmed</li>
                                </ul>
                            </div>
                        </div>

                        {/* Email */}
                        <div className="space-y-1">
                            <Field
                                labelProps={{ children: 'Email' }}
                                inputProps={{
                                    ...getInputProps(createFields.email, { type: 'email' }),
                                    placeholder: 'john@example.com',
                                    onChange: e => {
                                        const v = e.currentTarget.value
                                        setEmailValue(v)
                                        debouncedCheckEmail(v)
                                    },
                                    onBlur: e => debouncedCheckEmail(e.currentTarget.value),
                                }}
                                errors={createFields.email.errors}
                            />
                            {emailExists === true && <p className="mt-0.5 text-xs text-red-600">Email already exists</p>}
                            <div className="text-[11px] leading-5">
                                <ul className="space-y-0.5">
                                    <li className={emailLooksValid ? 'text-green-600' : 'text-gray-500'}>
                                        {emailLooksValid ? '✓' : '•'} Must be a valid email (e.g. name@domain.com)
                                    </li>
                                    <li className="text-gray-500">• Stored in lowercase</li>
                                    <li
                                        className={
                                            emailExists === true ? 'text-red-600' : emailExists === false ? 'text-green-600' : 'text-gray-500'
                                        }
                                    >
                                        {checkingEmail
                                            ? '… checking availability'
                                            : emailExists === true
                                                ? '✗ Email already in use'
                                                : emailExists === false
                                                    ? '✓ Email available'
                                                    : '• Will check availability automatically'}
                                    </li>
                                </ul>
                            </div>
                        </div>

                        {/* Username */}
                        <div className="space-y-1">
                            <Field
                                labelProps={{ children: 'Username' }}
                                inputProps={{
                                    ...getInputProps(createFields.username, { type: 'text' }),
                                    placeholder: 'johndoe',
                                    className: 'lowercase',
                                    onChange: e => {
                                        const v = e.currentTarget.value
                                        setUsernameValue(v)
                                        debouncedCheckUsername(v)
                                    },
                                    onBlur: e => debouncedCheckUsername(e.currentTarget.value),
                                }}
                                errors={createFields.username.errors}
                            />
                            {usernameExists === true && <p className="mt-0.5 text-xs text-red-600">Username already exists</p>}
                            <div className="text-[11px] leading-5">
                                <ul className="space-y-0.5">
                                    <li className={usernameOkLen ? 'text-green-600' : 'text-gray-500'}>
                                        {usernameOkLen ? '✓' : '•'} {USERNAME_MIN_LENGTH}–{USERNAME_MAX_LENGTH} characters
                                    </li>
                                    <li className={usernameOkChars ? 'text-green-600' : 'text-gray-500'}>
                                        {usernameOkChars ? '✓' : '•'} Letters (A–Z, a–z), numbers (0–9), underscores (_)
                                    </li>
                                    <li className="text-gray-500">• Stored in lowercase</li>
                                    <li
                                        className={
                                            usernameExists === true ? 'text-red-600' : usernameExists === false ? 'text-green-600' : 'text-gray-500'
                                        }
                                    >
                                        {checkingUsername
                                            ? '… checking availability'
                                            : usernameExists === true
                                                ? '✗ Username already in use'
                                                : usernameExists === false
                                                    ? '✓ Username available'
                                                    : '• Will check availability automatically'}
                                    </li>
                                </ul>
                            </div>
                        </div>

                        <SelectField
                            labelProps={{ children: 'Role' }}
                            selectProps={{
                                ...getInputProps(createFields.role, { type: 'text' }),
                                onChange: e => setCreateSelectedRole(e.target.value),
                            }}
                            errors={createFields.role.errors}
                        >
                            <option value="" disabled>
                                Choose user role...
                            </option>
                            {viewerIsCustomerAdmin && <option value="customer-admin">🛡️ Customer Admin</option>}
                            <option value="provider-group-admin">👥 Provider Group Admin</option>
                            <option value="basic-user">👤 Basic User</option>
                        </SelectField>

                        <SelectField
                            labelProps={{ children: 'Provider Group (Optional)' }}
                            selectProps={{
                                ...getInputProps(createFields.providerGroupId, { type: 'text' }),
                                value: createSelectedRole === 'customer-admin' ? '' : createSelectedProviderGroup,
                                onChange: e => setCreateSelectedProviderGroup(e.target.value),
                                disabled: createSelectedRole === 'customer-admin',
                            }}
                            errors={createFields.providerGroupId.errors}
                        >
                            <option value="">🚫 No provider group</option>
                            {customer.providerGroups.map(group => (
                                <option key={group.id} value={group.id}>
                                    🏥 {group.name} ({group._count.providers} providers)
                                </option>
                            ))}
                        </SelectField>

                        <ErrorList id={createForm.errorId} errors={createForm.errors} />

                        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
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
                            <div className="mt-1 text-xs text-gray-500">• Stored in lowercase — change requires admin migration</div>

                            <Field
                                labelProps={{ children: 'Username (Read-only)' }}
                                inputProps={{
                                    type: 'text',
                                    value: selectedUser.username,
                                    disabled: true,
                                    className: 'bg-gray-50 text-gray-500',
                                }}
                            />
                            <div className="mt-1 text-xs text-gray-500">
                                • Lowercase; letters, numbers, underscores; {USERNAME_MIN_LENGTH}–{USERNAME_MAX_LENGTH} chars
                            </div>

                            <SelectField
                                labelProps={{ children: 'Role' }}
                                selectProps={{
                                    ...getInputProps(editFields.role, { type: 'text' }),
                                    defaultValue: selectedUser.roles[0]?.name,
                                    onChange: e => setEditSelectedRole(e.target.value),
                                }}
                                errors={editFields.role.errors}
                            >
                                {viewerIsCustomerAdmin && <option value="customer-admin">🛡️ Customer Admin</option>}
                                <option value="provider-group-admin">👥 Provider Group Admin</option>
                                <option value="basic-user">👤 Basic User</option>
                            </SelectField>

                            <SelectField
                                labelProps={{ children: 'Provider Group' }}
                                selectProps={{
                                    ...getInputProps(editFields.providerGroupId, { type: 'text' }),
                                    value: editSelectedRole === 'customer-admin' ? '' : editSelectedProviderGroup,
                                    onChange: e => setEditSelectedProviderGroup(e.target.value),
                                    disabled: editSelectedRole === 'customer-admin',
                                }}
                                errors={editFields.providerGroupId.errors}
                            >
                                <option value="">🚫 No provider group</option>
                                {customer.providerGroups.map(group => (
                                    <option key={group.id} value={group.id}>
                                        🏥 {group.name} ({group._count.providers} providers)
                                    </option>
                                ))}
                            </SelectField>

                            <ErrorList id={editForm.errorId} errors={editForm.errors} />

                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
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
                        {selectedNpis.map(providerId => (
                            <input key={providerId} type="hidden" name="providerIds" value={providerId} />
                        ))}

                        <div className="space-y-6">
                            {/* User Info */}
                            <div className="bg-gray-50 rounded-lg p-4">
                                <h3 className="text-sm font-medium text-gray-900 mb-2">User Information</h3>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <span className="text-gray-500">Name:</span>
                                        <span className="ml-2 font-medium">{selectedUser.name}</span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500">Role:</span>
                                        <span className="ml-2 font-medium">
                      {selectedUser.roles[0]?.name.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500">Customer:</span>
                                        <span className="ml-2 font-medium">{customer.name}</span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500">Provider Group:</span>
                                        <span className="ml-2 font-medium">{selectedUser.providerGroup?.name || 'None'}</span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500">Current NPIs:</span>
                                        <span className="ml-2 font-medium">{selectedUser.userNpis?.length || 0}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Selected NPIs */}
                            {selectedNpis.length > 0 && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Selected NPIs ({selectedNpis.length})
                                    </label>
                                    <div className="flex flex-wrap gap-2 p-3 bg-blue-50 rounded-lg min-h-[60px]">
                                        {selectedNpis.map(providerId => {
                                            const provider = customer.providers.find(p => p.id === providerId)
                                            if (!provider) return null
                                            return (
                                                <div key={providerId} className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-blue-100 text-blue-800">
                                                    <span className="font-mono mr-1">{provider.npi}</span>
                                                    {provider.name && (
                                                        <span className="text-blue-600">
                              - {provider.name.length > 20 ? `${provider.name.substring(0, 20)}...` : provider.name}
                            </span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeNpiFromSelection(providerId)}
                                                        className="ml-2 text-blue-600 hover:text-blue-800"
                                                    >
                                                        <Icon name="cross-1" className="h-3 w-3" />
                                                    </button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* NPI Search */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Search NPIs</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Icon name="magnifying-glass" className="h-5 w-5 text-gray-400" />
                                    </div>
                                    <input
                                        type="text"
                                        value={npiSearchTerm}
                                        onChange={e => setNpiSearchTerm(e.target.value)}
                                        placeholder="Search by NPI or provider name..."
                                        className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md leading-5 bg-white text-gray-900 placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                    />
                                </div>
                            </div>

                            {/* Available NPIs */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <span>
                                        Available NPIs
                                        {selectedUser.providerGroupId && (
                                            <span className="text-gray-500 font-normal"> (from {selectedUser.providerGroup?.name})</span>
                                        )}
                                    </span>
                                    <span
                                        className="text-xs text-gray-400 cursor-help inline-flex items-center gap-1"
                                        title={selectedUser.providerGroupId
                                            ? 'Only NPIs in the user\'s provider group are eligible.'
                                            : 'User has no provider group: only ungrouped NPIs are eligible.'}
                                    >
                                        <Icon name="gear" className="h-3 w-3" />
                                        <span className="hidden sm:inline">Rules</span>
                                    </span>
                                </label>
                                <div className="border border-gray-300 rounded-lg max-h-64 overflow-y-auto">
                                    {getAvailableNpis().length === 0 ? (
                                        <div className="p-4 text-center text-gray-500">
                                            {npiSearchTerm ? 'No NPIs match your search criteria.' : 'No NPIs available.'}
                                        </div>
                                    ) : (
                                        <div className="divide-y divide-gray-200">
                                            {getAvailableNpis().map(provider => (
                                                <div
                                                    key={provider.id}
                                                    className={`p-3 hover:bg-gray-50 cursor-pointer ${
                                                        selectedNpis.includes(provider.id) ? 'bg-blue-50' : ''
                                                    }`}
                                                    onClick={() => toggleNpiSelection(provider.id)}
                                                >
                                                    <div className="flex items-center space-x-3">
                                                        <input
                                                            type="checkbox"
                                                            checked={!!selectedNpis.includes(provider.id)}
                                                            onChange={() => toggleNpiSelection(provider.id)}
                                                            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                                        />
                                                        <div>
                                                            <div className="text-sm font-medium text-gray-900">
                                                                <span className="font-mono">{provider.npi}</span>
                                                                {provider.name && <span className="ml-2 text-gray-600">- {provider.name}</span>}
                                                            </div>
                                                            {provider.providerGroup && (
                                                                <div className="text-xs text-gray-500">Group: {provider.providerGroup.name}</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/** Unsaved changes indicator & actions */}
                            {drawerState.mode === 'assign-npis' && (
                                <div className="text-xs text-gray-500 flex items-center gap-2 px-1">
                                    {(() => {
                                        const orig = new Set(originalNpis)
                                        const curr = new Set(selectedNpis)
                                        const added = [...curr].filter(id => !orig.has(id))
                                        const removed = [...orig].filter(id => !curr.has(id))
                                        if (added.length === 0 && removed.length === 0) return <span>No changes</span>
                                        return (
                                            <span>
                                                Pending changes: {added.length > 0 && <><span className="text-green-600 font-medium">+{added.length}</span> added</>} {added.length > 0 && removed.length > 0 && ' / '} {removed.length > 0 && <><span className="text-red-600 font-medium">-{removed.length}</span> removed</>}
                                            </span>
                                        )
                                    })()}
                                </div>
                            )}

                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSelectedNpis(originalNpis)
                                    }}
                                    disabled={(() => {
                                        const orig = originalNpis
                                        if (orig.length !== selectedNpis.length) return false
                                        const s = new Set(selectedNpis)
                                        return orig.every(id => s.has(id))
                                    })()}
                                    className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-600 bg-white hover:bg-gray-50 disabled:opacity-40"
                                >
                                    Reset
                                </button>
                                <button
                                    type="button"
                                    onClick={closeDrawer}
                                    className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                >
                                    Cancel
                                </button>
                                <StatusButton
                                    type="submit"
                                    disabled={(() => {
                                        if (isPending) return true
                                        const orig = originalNpis
                                        if (orig.length !== selectedNpis.length) return false
                                        const s = new Set(selectedNpis)
                                        return orig.every(id => s.has(id)) // no changes
                                    })()}
                                    status={isPending ? 'pending' : 'idle'}
                                    className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
                                >
                                    {(() => {
                                        const orig = new Set(originalNpis)
                                        const curr = new Set(selectedNpis)
                                        const added = [...curr].filter(id => !orig.has(id)).length
                                        const removed = [...orig].filter(id => !curr.has(id)).length
                                        if (added === 0 && removed === 0) return 'No Changes'
                                        if (added > 0 && removed === 0) return added === 1 ? 'Assign 1 NPI' : `Assign ${added} NPIs`
                                        if (removed > 0 && added === 0) return removed === 1 ? 'Unassign 1 NPI' : `Unassign ${removed} NPIs`
                                        return 'Save NPI Changes'
                                    })()}
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
                    <Form method="post" {...getFormProps(resetForm)}>
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
                                        <input
                                            {...getInputProps(resetFields.mode, { type: 'radio' })}
                                            type="radio"
                                            name={resetFields.mode.name}
                                            value="auto"
                                            defaultChecked
                                            onChange={() => setResetMode('auto')}
                                        />
                                        <span className="text-sm text-gray-700">Auto-generate a strong password</span>
                                    </label>
                                    <label className="inline-flex items-center gap-2">
                                        <input
                                            {...getInputProps(resetFields.mode, { type: 'radio' })}
                                            type="radio"
                                            name={resetFields.mode.name}
                                            value="manual"
                                            onChange={() => setResetMode('manual')}
                                        />
                                        <span className="text-sm text-gray-700">Manually set a password</span>
                                    </label>
                                </div>
                            </fieldset>

                            {resetMode === 'manual' && (
                                <Field
                                    labelProps={{ children: 'New Password' }}
                                    inputProps={{
                                        ...getInputProps(resetFields.manualPassword, { type: 'password' }),
                                        name: 'manualPassword',
                                        placeholder: 'Enter a password (min 8 characters)',
                                        minLength: 8,
                                        required: true,
                                        autoComplete: 'new-password',
                                    }}
                                    errors={resetFields.manualPassword.errors}
                                />
                            )}

                            <ErrorList id={resetForm.errorId} errors={resetForm.errors} />

                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                                <button
                                    type="button"
                                    onClick={closeDrawer}
                                    className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                >
                                    Cancel
                                </button>
                                <StatusButton
                                    type="submit"
                                    disabled={isPending}
                                    status={isPending ? 'pending' : 'idle'}
                                    className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                >
                                    Reset & Email Password
                                </StatusButton>
                            </div>
                        </div>
                    </Form>
                )}
            </Drawer>

            {/* ✅ Caution modal for Activate/Deactivate */}
            {statusModal.isOpen && (
                <div className="fixed inset-0 z-50">
                    {/* backdrop */}
                    <div
                        className="absolute inset-0 bg-black/30"
                        onClick={closeStatusModal}
                        aria-hidden="true"
                    />
                    {/* panel */}
                    <div className="absolute inset-0 flex items-center justify-center p-4">
                        <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
                            <div className="px-5 py-4 border-b border-gray-200">
                                {statusModal.nextStatus === 'inactive' && statusModal.npiCount > 0 ? (
                                    <h3 className="text-sm font-semibold text-yellow-800 flex items-center gap-2">
                                        <Icon name="alert-triangle" className="h-4 w-4 text-yellow-500" /> Cannot Deactivate User
                                    </h3>
                                ) : (
                                    <h3 className="text-sm font-semibold text-gray-900">
                                        {statusModal.nextStatus === 'inactive' ? 'Deactivate User' : 'Activate User'}
                                    </h3>
                                )}
                            </div>

                            <div className="px-5 py-4 space-y-3 text-sm text-gray-700">
                                {statusModal.nextStatus === 'inactive' && statusModal.npiCount > 0 ? (
                                    <p>
                                        <strong>{statusModal.userName}</strong> cannot be deactivated while they still have assigned NPIs.
                                    </p>
                                ) : (
                                    <p>
                                        You are about to <strong>{statusModal.nextStatus === 'inactive' ? 'deactivate' : 'activate'}</strong>{' '}
                                        <span className="font-medium">{statusModal.userName}</span>.
                                    </p>
                                )}

                                {statusModal.nextStatus === 'inactive' ? (
                                    statusModal.npiCount > 0 ? (
                                        <div className="space-y-3">
                                            <div className="p-3 border border-yellow-300 bg-yellow-50 rounded-md text-yellow-800 text-xs">
                                                <strong>Action required:</strong> This user still has <span className="font-semibold">{statusModal.npiCount}</span> assigned NPI{statusModal.npiCount === 1 ? '' : 's'}. You must unassign all NPIs before deactivation is allowed.
                                            </div>
                                            <ul className="list-disc pl-5 space-y-1">
                                                <li>Unassign all NPIs using the Assign NPIs action.</li>
                                                <li>Return here to deactivate once assignments are cleared.</li>
                                            </ul>
                                        </div>
                                    ) : (
                                        <ul className="list-disc pl-5 space-y-1">
                                            <li>The user will be signed out from all devices immediately.</li>
                                            <li>The user will not be able to log in until reactivated.</li>
                                            <li>No data will be deleted; you can reactivate at any time.</li>
                                        </ul>
                                    )
                                ) : (
                                    <ul className="list-disc pl-5 space-y-1">
                                        <li>The user will be able to log in again.</li>
                                    </ul>
                                )}

                                {!(statusModal.nextStatus === 'inactive' && statusModal.npiCount > 0) && (
                                    <label className="mt-2 inline-flex items-start gap-2">
                                        <input
                                            type="checkbox"
                                            className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            checked={statusModal.acknowledged}
                                            onChange={e => setStatusModal(s => ({ ...s, acknowledged: e.currentTarget.checked }))}
                                        />
                                        <span>
                                            {statusModal.nextStatus === 'inactive' && statusModal.npiCount > 0
                                                ? 'Unassign all NPIs first — deactivation is currently blocked.'
                                                : 'I understand the impact of this action.'}
                                        </span>
                                    </label>
                                )}
                            </div>

                            <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={closeStatusModal}
                                    className="inline-flex justify-center py-2 px-3 rounded-md border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50"
                                >
                                    Close
                                </button>
                                {statusModal.nextStatus === 'inactive' && statusModal.npiCount > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            closeStatusModal();
                                            openDrawer('assign-npis', statusModal.userId);
                                        }}
                                        className="inline-flex justify-center py-2 px-3 rounded-md border border-blue-200 text-sm text-blue-700 bg-blue-50 hover:bg-blue-100"
                                    >
                                        Manage NPI Assignments
                                    </button>
                                ) : (
                                    <Form method="post">
                                        <input type="hidden" name="intent" value="set-active" />
                                        <input type="hidden" name="userId" value={statusModal.userId} />
                                        <input type="hidden" name="status" value={statusModal.nextStatus} />
                                        <StatusButton
                                            type="submit"
                                            disabled={!statusModal.acknowledged || isPending}
                                            status={isPending ? 'pending' : 'idle'}
                                            className={`inline-flex justify-center py-2 px-3 rounded-md text-sm text-white ${
                                                statusModal.nextStatus === 'inactive'
                                                    ? 'bg-red-600 hover:bg-red-700'
                                                    : 'bg-green-600 hover:bg-green-700'
                                            }`}
                                            onClick={() => setTimeout(closeStatusModal, 0)}
                                        >
                                            {statusModal.nextStatus === 'inactive' ? 'Deactivate User' : 'Activate User'}
                                        </StatusButton>
                                    </Form>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}

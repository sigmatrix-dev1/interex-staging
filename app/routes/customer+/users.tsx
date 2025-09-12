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
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import { sendUserRegistrationEmail } from '#app/utils/emails/send-user-registration.server.ts'
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
    // allow creating customer-admin
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

const DeleteUserSchema = z.object({
    intent: z.literal('delete'),
    userId: z.string().min(1, 'User ID is required'),
})

const AssignNpisSchema = z.object({
    intent: z.literal('assign-npis'),
    userId: z.string().min(1, 'User ID is required'),
    providerIds: z.array(z.string()).default([]),
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
    DeleteUserSchema,
    AssignNpisSchema,
    CheckAvailabilitySchema,
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
                        providerGroup: { select: { id: true, name: true } },
                        userNpis: {
                            include: {
                                provider: {
                                    select: { id: true, npi: true, name: true, providerGroupId: true },
                                },
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

    // Handle create action
    if (action.intent === 'create') {
        const { name, email, username, role, providerGroupId } = action

        // Only Customer Admin can create another Customer Admin
        if (role === 'customer-admin' && !isCustomerAdmin) {
            return data({ error: 'Only customer administrators can create customer administrators.' }, { status: 403 })
        }

        // Check if email already exists
        const existingUser = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        })
        if (existingUser) {
            return data(
                { result: submission.reply({ fieldErrors: { email: ['Email already exists'] } }) },
                { status: 400 },
            )
        }

        // Check if username already exists
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

    // Handle update action
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

    // Handle delete action
    if (action.intent === 'delete') {
        const { userId: targetUserId } = action

        const targetUser = await prisma.user.findFirst({
            where: {
                id: targetUserId,
                customerId: user.customerId,
                roles: { some: { name: { in: ['customer-admin', 'provider-group-admin', 'basic-user'] } } },
            },
            include: { roles: { select: { name: true } } },
        })
        if (!targetUser) {
            return data({ error: 'User not found or not authorized to delete this user' }, { status: 404 })
        }

        if (isProviderGroupAdmin && !isCustomerAdmin) {
            if (targetUser.providerGroupId !== user.providerGroupId) {
                return redirectWithToast('/customer/users', {
                    type: 'error',
                    title: 'Cannot delete user',
                    description: 'You can only delete users in your assigned provider group.',
                })
            }
        }

        // Keep protection: cannot delete customer admins
        const isTargetCustomerAdmin = targetUser.roles.some(role => role.name === 'customer-admin')
        if (isTargetCustomerAdmin) {
            return redirectWithToast('/customer/users', {
                type: 'error',
                title: 'Cannot delete user',
                description: 'Cannot delete customer administrators.',
            })
        }

        await prisma.userNpi.deleteMany({ where: { userId: targetUserId } })
        await prisma.userImage.deleteMany({ where: { userId: targetUserId } })
        const userName = targetUser.name
        await prisma.user.delete({ where: { id: targetUserId } })

        return redirectWithToast('/customer/users', {
            type: 'success',
            title: 'User deleted',
            description: `${userName} has been deleted successfully.`,
        })
    }

    // Handle assign NPIs action
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

        const whereConditions: any = { id: { in: providerIds }, customerId: user.customerId, active: true }
        if (targetUser.providerGroupId) {
            whereConditions.providerGroupId = targetUser.providerGroupId
        } else if (isProviderGroupAdmin && !isCustomerAdmin) {
            whereConditions.providerGroupId = user.providerGroupId
        }

        const validProviders = await prisma.provider.findMany({ where: whereConditions, select: { id: true } })
        const validProviderIds = validProviders.map(p => p.id)
        const invalidProviderIds = providerIds.filter(id => !validProviderIds.includes(id))
        if (invalidProviderIds.length > 0) {
            return data({ error: 'Some selected NPIs are not valid for this user' }, { status: 400 })
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
        mode: 'create' | 'edit' | 'assign-npis'
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
        } else {
            setDrawerState({ isOpen: false, mode: 'create' })
        }
    }, [searchParams])

    const openDrawer = (mode: 'create' | 'edit' | 'assign-npis', userId?: string) => {
        const newParams = new URLSearchParams(searchParams)
        if (mode === 'create') newParams.set('action', 'add')
        else if (mode === 'edit') newParams.set('action', 'edit')
        else if (mode === 'assign-npis') newParams.set('action', 'assign-npis')
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

    // Track selected role and provider group for NPI filtering / UI
    const [createSelectedRole, setCreateSelectedRole] = useState<string>('')
    const [createSelectedProviderGroup, setCreateSelectedProviderGroup] = useState<string>('')
    const [editSelectedRole, setEditSelectedRole] = useState<string>(selectedUser?.roles[0]?.name || '')
    const [editSelectedProviderGroup, setEditSelectedProviderGroup] = useState<string>(
        selectedUser?.providerGroup?.id || '',
    )

    // NPI Assignment state
    const [selectedNpis, setSelectedNpis] = useState<string[]>([])
    const [npiSearchTerm, setNpiSearchTerm] = useState('')

    // Initialize NPI assignments when user changes
    useEffect(() => {
        if (drawerState.mode === 'assign-npis' && selectedUser) {
            const currentNpis = selectedUser.userNpis?.map(un => un.provider.id) || []
            setSelectedNpis(currentNpis)
        }
    }, [drawerState.mode, selectedUser])

    // Get available NPIs for assignment based on user's provider group
    const getAvailableNpis = () => {
        if (!selectedUser) return []
        if (selectedUser.providerGroupId) {
            return customer.providers.filter(
                p =>
                    p.providerGroupId === selectedUser.providerGroupId &&
                    p.active &&
                    (npiSearchTerm === '' ||
                        p.npi.includes(npiSearchTerm) ||
                        (p.name && p.name.toLowerCase().includes(npiSearchTerm.toLowerCase()))),
            )
        }
        return customer.providers.filter(
            p =>
                p.active &&
                (npiSearchTerm === '' ||
                    p.npi.includes(npiSearchTerm) ||
                    (p.name && p.name.toLowerCase().includes(npiSearchTerm.toLowerCase()))),
        )
    }

    const toggleNpiSelection = (providerId: string) => {
        setSelectedNpis(prev => (prev.includes(providerId) ? prev.filter(id => id !== providerId) : [...prev, providerId]))
    }

    const removeNpiFromSelection = (providerId: string) => {
        setSelectedNpis(prev => prev.filter(id => id !== providerId))
    }

    const viewerIsCustomerAdmin = user.roles.some(r => r.name === 'customer-admin')

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
                                    <div className="overflow-hidden">
                                        <table className="min-w-full divide-y divide-gray-200">
                                            <thead className="bg-gray-50">
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
                                                {/* NEW: Customer + Provider Group */}
                                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Customer
                                                </th>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Provider Group
                                                </th>
                                                {/* Existing columns */}
                                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    NPIs
                                                </th>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Actions
                                                </th>
                                            </tr>
                                            </thead>
                                            <tbody className="bg-white divide-y divide-gray-200">
                                            {customer.users.map(userItem => (
                                                <tr key={userItem.id} className="hover:bg-gray-50">
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

                                                    {/* NEW: Customer & Provider Group cells */}
                                                    <td className="px-6 py-4 whitespace-nowrap">
                                                        <div className="text-sm text-gray-900">{customer.name}</div>
                                                    </td>
                                                    <td className="px-6 py-4 whitespace-nowrap">
                                                        <div className="text-sm text-gray-900">{userItem.providerGroup?.name ?? 'No provider group'}</div>
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
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                                        <div className="flex items-center space-x-2">
                                                            <button
                                                                onClick={() => openDrawer('edit', userItem.id)}
                                                                className="text-blue-600 hover:text-blue-800 p-1"
                                                                title="Edit user"
                                                            >
                                                                <Icon name="pencil-1" className="h-4 w-4" />
                                                            </button>

                                                            {/* NPI Assignment for basic users */}
                                                            {userItem.roles.some(role => role.name === 'basic-user') && (
                                                                <button
                                                                    onClick={() => openDrawer('assign-npis', userItem.id)}
                                                                    className="text-green-600 hover:text-green-800 p-1"
                                                                    title="Assign NPIs"
                                                                >
                                                                    <Icon name="file-text" className="h-4 w-4" />
                                                                </button>
                                                            )}

                                                            {userItem.id !== user.id && (
                                                                <Form method="post" className="inline">
                                                                    <input type="hidden" name="intent" value="delete" />
                                                                    <input type="hidden" name="userId" value={userItem.id} />
                                                                    <button
                                                                        type="submit"
                                                                        className="text-red-600 hover:text-red-800 p-1"
                                                                        title="Delete user"
                                                                        onClick={e => {
                                                                            if (!confirm(`Are you sure you want to delete "${userItem.name}"? This action cannot be undone.`)) {
                                                                                e.preventDefault()
                                                                            }
                                                                        }}
                                                                    >
                                                                        <Icon name="trash" className="h-4 w-4" />
                                                                    </button>
                                                                </Form>
                                                            )}

                                                            {userItem.id === user.id && (
                                                                <span className="text-gray-400" title="Cannot delete your own account">
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

            {/* NPI Assignment Drawer */}
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

                            {/* Selected NPIs - Bubble UI */}
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

                            {/* Available NPIs List */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Available NPIs
                                    {selectedUser.providerGroupId && (
                                        <span className="text-gray-500 font-normal"> (from {selectedUser.providerGroup?.name})</span>
                                    )}
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
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex-1">
                                                            <div className="flex items-center space-x-3">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={selectedNpis.includes(provider.id)}
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
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

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
                                    className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                                >
                                    Assign NPIs
                                </StatusButton>
                            </div>
                        </div>
                    </Form>
                )}
            </Drawer>
        </>
    )
}

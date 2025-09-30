// app/routes/admin+/users.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { useState, useEffect, type Dispatch, type SetStateAction } from 'react'
import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    data,
    useLoaderData,
    Link,
    Form,
    useSearchParams,
    useActionData,
} from 'react-router'
import { z } from 'zod'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Button } from '#app/components/ui/button.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { prepareVerification } from '#app/routes/_auth+/verify.server.ts'
import { audit } from '#app/services/audit.server.ts'
import { requireUserId, checkIsCommonPassword } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { sendAdminPasswordManualResetEmail } from '#app/utils/emails/send-admin-password-manual-reset.server.ts'
import { sendAdminPasswordResetLinkEmail } from '#app/utils/emails/send-admin-password-reset-link.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { disableTwoFactorForUser } from '#app/utils/twofa.server.ts'

// NEW: password helpers + email senders + verification prep

const CreateUserSchema = z.object({
    email: z.string().email('Invalid email address'),
    username: z.string().min(3, 'Username must be at least 3 characters'),
    name: z.string().min(1, 'Name is required').optional(),
    customerId: z.string().optional(),
    roleId: z.string().optional(),
    active: z.boolean().default(true),
})

// NEW: admin reset schemas
const SendResetLinkSchema = z.object({
    intent: z.literal('send-reset-link'),
    userId: z.string().min(1, 'User ID is required'),
})

const ManualResetSchema = z.object({
    intent: z.literal('manual-reset'),
    userId: z.string().min(1, 'User ID is required'),
})

// Admin-only: Reset user's 2FA (disable and clear secret)
const ResetTwoFASchema = z.object({
    intent: z.literal('reset-2fa'),
    userId: z.string().min(1, 'User ID is required'),
})

// Delete flow (GitHub-style confirm by username)
const DeleteUserSchema = z.object({
    intent: z.literal('delete'),
    userId: z.string().min(1, 'User ID is required'),
    confirm: z.string().min(1, 'Confirmation required'),
})

// Optional helpers used in blocked-delete guidance
const SetActiveSchema = z.object({
    intent: z.literal('set-active'),
    userId: z.string().min(1),
    status: z.enum(['active', 'inactive']),
})
const DeactivateAndUnassignSchema = z.object({
    intent: z.literal('deactivate-and-unassign'),
    userId: z.string().min(1),
})

// --- FIX: make each branch a ZodObject with 'intent' key (no .and / intersection)
const CreateUserActionSchema = CreateUserSchema.extend({
    intent: z.literal('create'),
})

// Discriminated union for action routing
const ActionSchema = z.discriminatedUnion('intent', [
    CreateUserActionSchema,
    SendResetLinkSchema,
    ManualResetSchema,
    ResetTwoFASchema,
    DeleteUserSchema,
    SetActiveSchema,
    DeactivateAndUnassignSchema,
])

function CreateUserForm({
                            customers,
                            roles,
                            drawerState,
                            actionData,
                            closeDrawer,
                        }: {
    customers: { id: string; name: string }[]
    roles: { id: string; name: string }[]
    drawerState: { isOpen: boolean; preselectedCustomerId?: string }
    actionData: any
    closeDrawer: () => void
}) {
    const isPending = useIsPending()

    const [form, fields] = useForm({
        id: 'create-user-form',
        constraint: getZodConstraint(CreateUserSchema),
        lastResult: actionData?.result,
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: CreateUserSchema })
        },
        shouldRevalidate: 'onBlur',
        defaultValue: {
            email: '',
            username: '',
            name: '',
            customerId: drawerState.preselectedCustomerId || '',
            roleId: '',
            active: true,
        },
    })

    return (
        <Form method="post" {...getFormProps(form)}>
            <input type="hidden" name="intent" value="create" />
            <div className="space-y-6">
                <Field
                    labelProps={{ children: 'Email Address' }}
                    inputProps={{
                        ...getInputProps(fields.email, { type: 'email' }),
                        placeholder: 'user@example.com',
                    }}
                    errors={fields.email.errors}
                />

                <Field
                    labelProps={{ children: 'Username' }}
                    inputProps={{
                        ...getInputProps(fields.username, { type: 'text' }),
                        placeholder: 'username',
                    }}
                    errors={fields.username.errors}
                />

                <Field
                    labelProps={{ children: 'Full Name (Optional)' }}
                    inputProps={{
                        ...getInputProps(fields.name, { type: 'text' }),
                        placeholder: 'John Doe',
                    }}
                    errors={fields.name.errors}
                />

                {drawerState.preselectedCustomerId ? (
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Customer
                        </label>
                        <div className="mt-1 px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-900">
                            🏢 {customers.find(c => c.id === drawerState.preselectedCustomerId)?.name || 'Selected Customer'}
                        </div>
                        <input type="hidden" name="customerId" value={drawerState.preselectedCustomerId} />
                        <p className="mt-1 text-xs text-gray-500">
                            Customer is preselected and cannot be changed
                        </p>
                    </div>
                ) : (
                    <SelectField
                        labelProps={{ children: 'Customer' }}
                        selectProps={{
                            ...getInputProps(fields.customerId, { type: 'text' }),
                            required: true,
                        }}
                        errors={fields.customerId.errors}
                    >
                        <option value="" disabled>
                            Choose customer...
                        </option>
                        {customers.map(customer => (
                            <option key={customer.id} value={customer.id}>
                                🏢 {customer.name}
                            </option>
                        ))}
                    </SelectField>
                )}

                <SelectField
                    labelProps={{ children: 'Role (Optional)' }}
                    selectProps={{
                        ...getInputProps(fields.roleId, { type: 'text' }),
                    }}
                    errors={fields.roleId.errors}
                >
                    <option value="" disabled>
                        Choose role...
                    </option>
                    <option value="">🚫 No role assigned</option>
                    {roles.map(role => (
                        <option key={role.id} value={role.id}>
                            👤 {role.name}
                        </option>
                    ))}
                </SelectField>

                <div className="flex items-center space-x-3">
                    <input
                        {...getInputProps(fields.active, { type: 'checkbox' })}
                        defaultChecked={true}
                        className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                    />
                    <label htmlFor={fields.active.id} className="text-sm font-medium text-gray-900">
                        Active User
                    </label>
                </div>

                <ErrorList id={form.errorId} errors={form.errors} />

                <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
                    <button
                        type="button"
                        onClick={closeDrawer}
                        className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        Cancel
                    </button>
                    <StatusButton
                        type="submit"
                        disabled={isPending}
                        status={isPending ? 'pending' : 'idle'}
                        className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        Create User
                    </StatusButton>
                </div>
            </div>
        </Form>
    )
}

export async function loader({ request }: LoaderFunctionArgs) {
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

    // Get customers and roles for dropdowns (needed for drawer)
    // System admins cannot create other system admins
    const [users, customers, roles] = await Promise.all([
        prisma.user.findMany({
            select: {
                id: true,
                name: true,
                email: true,
                username: true,
                createdAt: true,
                active: true,
                twoFactorEnabled: true,
                customer: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                roles: {
                    select: {
                        name: true,
                    },
                },
                userNpis: {
                    select: {
                        provider: {
                            select: {
                                npi: true,
                                name: true,
                            },
                        },
                    },
                },
            },
            orderBy: [{ customer: { name: 'asc' } }, { name: 'asc' }],
        }),
        prisma.customer.findMany({
            select: { id: true, name: true },
            where: { active: true },
            orderBy: { name: 'asc' },
        }),
        prisma.role.findMany({
            select: { id: true, name: true },
            where: {
                // Exclude system-admin role from selection
                NOT: { name: 'system-admin' },
            },
            orderBy: { name: 'asc' },
        }),
    ])

    return data({ user, users, customers, roles })
}

export async function action({ request }: ActionFunctionArgs) {
    const adminUserId = await requireUserId(request)
    const admin = await prisma.user.findUnique({
        where: { id: adminUserId },
        select: {
            id: true,
            name: true,
            email: true,
            roles: { select: { name: true } },
        },
    })

    if (!admin) {
        throw new Response('Unauthorized', { status: 401 })
    }

    requireRoles(admin, [INTEREX_ROLES.SYSTEM_ADMIN])

    const formData = await request.formData()
    const submission = parseWithZod(formData, { schema: ActionSchema })

    if (submission.status !== 'success') {
        return data(
            { result: submission.reply() },
            { status: submission.status === 'error' ? 400 : 200 },
        )
    }

    // ====== CREATE USER (existing behavior) ======
    if (submission.value.intent === 'create') {
        const { email, username, name, customerId, roleId, active } = submission.value

        // Prevent system admins from creating other system admins
        if (roleId) {
            const selectedRole = await prisma.role.findUnique({
                where: { id: roleId },
                select: { name: true },
            })

            if (selectedRole?.name === 'system-admin') {
                return data(
                    {
                        result: submission.reply({
                            fieldErrors: {
                                roleId: ['System administrators cannot create other system administrators'],
                            },
                        }),
                    },
                    { status: 400 },
                )
            }
        }

        // Check if email or username already exists
        const existingUser = await prisma.user.findFirst({
            where: {
                OR: [{ email }, { username }],
            },
        })

        if (existingUser) {
            return data(
                {
                    result: submission.reply({
                        fieldErrors: {
                            ...(existingUser.email === email && { email: ['Email already exists'] }),
                            ...(existingUser.username === username && { username: ['Username already exists'] }),
                        },
                    }),
                },
                { status: 400 },
            )
        }

        // Generate a strong temporary password and ensure it's not pwned.
        let tempPassword = generateTemporaryPassword()
        // Regenerate up to a few times if it appears in breach data (very unlikely)
        for (let i = 0; i < 3; i++) {
            const compromised = await checkIsCommonPassword(tempPassword)
            if (!compromised) break
            tempPassword = generateTemporaryPassword()
        }
        const passwordHash = hashPassword(tempPassword)

    const created = await (prisma as any).user.create({
            data: {
                email,
                username,
                name: name || null,
                active,
                customerId: customerId || null,
                mustChangePassword: true,
                roles: roleId
                    ? {
                        connect: { id: roleId },
                    }
                    : undefined,
                password: { create: { hash: passwordHash } },
            },
            select: {
                id: true,
                name: true,
                email: true,
                username: true,
                customer: { select: { name: true } },
            },
        })

        // Email the temporary password to the user (reuse manual reset template for consistency)
        const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
        void sendAdminPasswordManualResetEmail({
            to: created.email,
            recipientName: created.name || created.username,
            requestedByName: admin.name ?? undefined,
            customerName: created.customer?.name ?? undefined,
            username: created.username,
            tempPassword,
            loginUrl,
        })

        return redirectWithToast('/admin/users', {
            type: 'success',
            title: 'User created',
            description: `${name || username} created. Temporary password emailed; user must change it at first login.`,
        })
    }

    // ====== SEND RESET LINK (AUTO) ======
    if (submission.value.intent === 'send-reset-link') {
        const { userId } = submission.value

        const targetUser = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                name: true,
                email: true,
                username: true,
                customer: { select: { name: true } },
            },
        })

        if (!targetUser) {
            return redirectWithToast('/admin/users', {
                type: 'error',
                title: 'User not found',
                description: 'Unable to send reset link. Please refresh and try again.',
            })
        }

        // Prepare verification (10 minutes)
        const period = 10 * 60
        const { verifyUrl, otp } = await prepareVerification({
            period,
            request,
            type: 'reset-password',
            // We can target by username (reset flow accepts email or username)
            target: targetUser.username,
        })

        // Send the email
        await sendAdminPasswordResetLinkEmail({
            to: targetUser.email,
            recipientName: targetUser.name || targetUser.username,
            requestedByName: admin.name ?? undefined,
            customerName: targetUser.customer?.name ?? undefined,
            resetUrl: verifyUrl.toString(),
            otp,
            expiresInMinutes: Math.floor(period / 60),
        })

        // Optional: security event
        await prisma.securityEvent.create({
            data: {
                kind: 'PASSWORD_RESET_LINK_SENT',
                message: 'Admin sent a password reset link',
                userId: targetUser.id,
                userEmail: targetUser.email,
                success: true,
                reason: 'ADMIN_TRIGGERED',
            },
        })

        return redirectWithToast('/admin/users', {
            type: 'success',
            title: 'Reset link sent',
            description: `An email with a reset link was sent to ${targetUser.email}.`,
        })
    }

    // ====== MANUAL RESET (TEMP PASSWORD) ======
    if (submission.value.intent === 'manual-reset') {
        const { userId } = submission.value

        const targetUser = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                name: true,
                email: true,
                username: true,
                customer: { select: { name: true } },
            },
        })

        if (!targetUser) {
            return redirectWithToast('/admin/users', {
                type: 'error',
                title: 'User not found',
                description: 'Unable to reset password. Please refresh and try again.',
            })
        }

        // Generate strong temporary password
        const tempPassword = generateTemporaryPassword()
        const passwordHash = hashPassword(tempPassword)

        // Upsert password (covers accounts created via social/passkey without Password row)
        await prisma.password.upsert({
            where: { userId },
            create: { userId, hash: passwordHash },
            update: { hash: passwordHash },
        })

        // Flag user to force password change on next login
        // Cast to any in case Prisma client not regenerated yet with new field
    await (prisma as any).user.update({
            where: { id: userId },
            data: { mustChangePassword: true },
            select: { id: true },
        })

        // Invalidate all sessions for this user
        await prisma.session.deleteMany({ where: { userId } })

        // Send email with the temp password
        const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
        await sendAdminPasswordManualResetEmail({
            to: targetUser.email,
            recipientName: targetUser.name || targetUser.username,
            requestedByName: admin.name ?? undefined,
            customerName: targetUser.customer?.name ?? undefined,
            username: targetUser.username,
            tempPassword,
            loginUrl,
        })

        // Optional: security event
        await prisma.securityEvent.create({
            data: {
                kind: 'PASSWORD_MANUAL_RESET',
                message: 'Admin manually reset user password',
                userId: targetUser.id,
                userEmail: targetUser.email,
                success: true,
                reason: 'ADMIN_TRIGGERED',
            },
        })

        return redirectWithToast('/admin/users', {
            type: 'success',
            title: 'Password reset',
            description: `A new temporary password was emailed to ${targetUser.email}.`,
        })
    }

    // ====== RESET 2FA (admin-only) ======
    if (submission.value.intent === 'reset-2fa') {
        const { userId } = submission.value

        const targetUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, name: true, username: true, customer: { select: { id: true, name: true } } },
        })

        if (!targetUser) {
            return redirectWithToast('/admin/users', {
                type: 'error',
                title: 'User not found',
                description: 'Unable to reset 2FA. Please refresh and try again.',
            })
        }

    // Disable 2FA via helper, clear secret and flag
        await disableTwoFactorForUser(userId)

        // Delete any existing verification records of type '2fa' to fully reset
        try {
            await prisma.verification.deleteMany({
                where: { target: userId, type: '2fa' },
            })
        } catch {
            // ignore if table/records differ; best-effort cleanup
        }

        // Invalidate all sessions for extra security
        await prisma.session.deleteMany({ where: { userId } })

        // Audit: Admin initiated 2FA reset
        await audit.admin({
            action: 'TWO_FACTOR_RESET',
            actorType: 'USER',
            actorId: adminUserId,
            actorDisplay: admin.name || admin.email || null,
            customerId: targetUser.customer?.id ?? null,
            chainKey: targetUser.customer?.id || 'global',
            entityType: 'User',
            entityId: targetUser.id,
            summary: `Admin reset 2FA for user ${targetUser.username}`,
            metadata: { targetUser: { id: targetUser.id, email: targetUser.email, username: targetUser.username } },
        })

        return redirectWithToast('/admin/users', {
            type: 'success',
            title: '2FA reset',
            description: `2FA has been reset for ${targetUser.name || targetUser.username}.`,
        })
    }

    // ====== SET ACTIVE / INACTIVE (used by delete-block guidance) ======
    if (submission.value.intent === 'set-active') {
        const { userId, status } = submission.value
        const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        })
        if (!target) {
            return redirectWithToast('/admin/users', { type: 'error', title: 'User not found', description: 'Unable to update status.' })
        }
        await prisma.user.update({ where: { id: userId }, data: { active: status === 'active' } })
        if (status === 'inactive') await prisma.session.deleteMany({ where: { userId } })
        return redirectWithToast('/admin/users', { type: 'success', title: status === 'inactive' ? 'User deactivated' : 'User activated', description: 'Status updated.' })
    }

    // ====== DEACTIVATE AND UNASSIGN ALL NPIs ======
    if (submission.value.intent === 'deactivate-and-unassign') {
        const { userId } = submission.value
        const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        })
        if (!target) {
            return redirectWithToast('/admin/users', { type: 'error', title: 'User not found', description: 'Unable to deactivate.' })
        }
        await prisma.$transaction([
            prisma.userNpi.deleteMany({ where: { userId } }),
            prisma.user.update({ where: { id: userId }, data: { active: false } }),
            prisma.session.deleteMany({ where: { userId } }),
        ])
        return redirectWithToast('/admin/users', { type: 'success', title: 'User deactivated', description: 'All NPIs unassigned and user marked inactive.' })
    }

    // ====== DELETE USER (GitHub-style confirmation) ======
    if (submission.value.intent === 'delete') {
        const { userId: targetUserId, confirm } = submission.value

        // Fetch target with roles and customer linkage
        const targetUser = await prisma.user.findUnique({
            where: { id: targetUserId },
            include: { roles: { select: { name: true } }, customer: { select: { id: true, name: true } } },
        })

        if (!targetUser) {
            return data({ error: 'User not found' }, { status: 404 })
        }

        // Prevent deleting system admins
        const isTargetSystemAdmin = targetUser.roles.some(r => r.name === 'system-admin')
        if (isTargetSystemAdmin) {
            return redirectWithToast('/admin/users', {
                type: 'error',
                title: 'Cannot delete user',
                description: 'Cannot delete system administrators.',
            })
        }

        // No self-delete
        if (targetUserId === adminUserId) {
            return redirectWithToast('/admin/users', { type: 'error', title: 'Cannot delete self', description: 'You cannot delete your own account.' })
        }

        // Must confirm exact username
        if (confirm.toLowerCase() !== (targetUser.username || '').toLowerCase()) {
            return redirectWithToast('/admin/users', { type: 'error', title: 'Confirmation mismatch', description: 'Type the exact username to confirm deletion.' })
        }

        // If customer-admin, ensure not the last for their customer
        const isCustomerAdmin = targetUser.roles.some(r => r.name === 'customer-admin')
        if (isCustomerAdmin && targetUser.customer?.id) {
            const remainingAdminCount = await prisma.user.count({
                where: { customerId: targetUser.customer.id, id: { not: targetUserId }, roles: { some: { name: 'customer-admin' } } },
            })
            if (remainingAdminCount === 0) {
                return redirectWithToast('/admin/users', { type: 'error', title: 'Cannot delete last admin', description: 'Assign another customer-admin before deleting this one.' })
            }
        }

        // Preflight FK usage across system
        const displayName = targetUser.name || targetUser.username
        const [submissionCount, uploadCount, eventCount] = await Promise.all([
            prisma.submission.count({ where: { creatorId: targetUserId } }),
            prisma.submissionDocument.count({ where: { uploaderId: targetUserId } }),
            prisma.providerEvent.count({ where: { actorId: targetUserId } }),
        ])

        if (submissionCount > 0 || uploadCount > 0 || eventCount > 0) {
            return data({
                deleteBlocked: {
                    userId: targetUserId,
                    userName: displayName,
                    submissions: submissionCount,
                    documents: uploadCount,
                    events: eventCount,
                    cause: 'fk-refs' as const,
                },
            })
        }

        // Hard delete: remove sessions then delete user
        await prisma.$transaction([
            prisma.session.deleteMany({ where: { userId: targetUserId } }),
            prisma.user.delete({ where: { id: targetUserId } }),
        ])

        return redirectWithToast('/admin/users', {
            type: 'success',
            title: 'User deleted',
            description: `${displayName} has been permanently removed.`,
        })
    }

    // Fallback (should never hit)
    return redirectWithToast('/admin/users', {
        type: 'error',
        title: 'Invalid action',
        description: 'Please try again.',
    })
}

export default function AdminUsers() {
    const { user, users, customers, roles } = useLoaderData<typeof loader>()
    const actionData = useActionData<typeof action>()
    const [searchParams, setSearchParams] = useSearchParams()
    const isPending = useIsPending()
    const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; userId?: string; username?: string; name?: string; confirmValue: string }>({ isOpen: false, confirmValue: '' })

    // Get current customer filter from URL
    const filterCustomerId = searchParams.get('filter')
    const isSystemFilter = filterCustomerId === 'system'
    const currentCustomer = filterCustomerId && !isSystemFilter ? customers.find(c => c.id === filterCustomerId) : undefined

    // Filter users by current customer if selected; if 'system', show users without a customer
    const filteredUsers = filterCustomerId
        ? isSystemFilter
            ? (users as any[]).filter((u: any) => !u.customer)
            : (users as any[]).filter((u: any) => u.customer?.id === filterCustomerId)
        : (users as any[])

    const [drawerState, setDrawerState] = useState<{
        isOpen: boolean
        preselectedCustomerId?: string
    }>({ isOpen: false })

    // Handle URL parameters for drawer state
    useEffect(() => {
        const action = searchParams.get('action')
        const drawerCustomerId = searchParams.get('customerId') // For drawer customer selection

        if (action === 'add') {
            // When adding a user, use the customer ID from the drawer action
            setDrawerState({
                isOpen: true,
                preselectedCustomerId: drawerCustomerId ? drawerCustomerId : undefined,
            })
        } else {
            setDrawerState({ isOpen: false })
        }
    }, [searchParams])

    const openDrawer = (preselectedCustomerId?: string) => {
        const newParams = new URLSearchParams(searchParams)
        newParams.set('action', 'add')

        // Use provided customer ID, or current customer filter, or none
        const customerToUse = preselectedCustomerId || filterCustomerId
        if (customerToUse) {
            newParams.set('customerId', customerToUse)
        }
        setSearchParams(newParams)
    }

    const closeDrawer = () => {
        const newParams = new URLSearchParams(searchParams)
        newParams.delete('action')
        newParams.delete('customerId')
        setSearchParams(newParams)
    }

    // Auto-close delete modal after successful deletion (user id disappears from users list)
    useEffect(() => {
        if (!deleteModal.isOpen || !deleteModal.userId) return
        const stillExists = (users as any[]).some((u: any) => u.id === deleteModal.userId)
        if (!stillExists) {
            setDeleteModal(s => ({ ...s, isOpen: false, confirmValue: '' }))
        }
    }, [users, deleteModal.isOpen, deleteModal.userId])

    return (
        <InterexLayout
            user={user}
            title={currentCustomer ? `User Management - ${currentCustomer.name}` : 'User Management'}
            subtitle={currentCustomer ? `Manage users for ${currentCustomer.name}` : 'Manage users across all customers'}
            currentPath="/admin/users"
            actions={
                <div className="flex items-center space-x-2">
                    {currentCustomer && (
                        <Link
                            to="/admin/dashboard"
                            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                        >
                            <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
                            Back to Dashboard
                        </Link>
                    )}
                    {/* Quick access: Create System Admin (only visible to system admins – route already protected) */}
                    <Link
                        to="/admin/system-admin/new"
                        className="inline-flex items-center px-3 py-2 border border-red-300 shadow-sm text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50"
                        title="Create a new global System Administrator"
                    >
                        <Icon name="shield" className="-ml-1 mr-2 h-4 w-4" />
                        New System Admin
                    </Link>
                    <select
                        value={filterCustomerId || ''}
                        onChange={e => {
                            const newParams = new URLSearchParams(searchParams)
                            if (e.target.value) {
                                newParams.set('filter', e.target.value)
                            } else {
                                newParams.delete('filter')
                            }
                            newParams.delete('action') // Close drawer when switching customers
                            setSearchParams(newParams)
                        }}
                        className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                        <option value="">All Customers</option>
                        <option value="system">System</option>
                        {customers.map(customer => (
                            <option key={customer.id} value={customer.id}>
                                {customer.name}
                            </option>
                        ))}
                    </select>
                    <Button onClick={() => openDrawer()}>
                        <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                        Add User
                    </Button>
                    <Link
                        to="/admin/dashboard"
                        className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                        <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
                        Back to Dashboard
                    </Link>
                </div>
            }
        >
            {/* Main content area - blur when drawer is open */}
            <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
                <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
                    {/* Summary Stats */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                        <div className="bg-white overflow-hidden shadow rounded-lg">
                            <div className="p-5">
                                <div className="flex items-center">
                                    <div className="flex-shrink-0">
                                        <Icon name="avatar" className="h-6 w-6 text-blue-600" />
                                    </div>
                                    <div className="ml-3 w-0 flex-1">
                                        <dl>
                                            <dt className="text-sm font-medium text-gray-500 truncate">
                                                {currentCustomer ? `${currentCustomer.name} Users` : 'Total Users'}
                                            </dt>
                                            <dd className="text-lg font-medium text-gray-900">{filteredUsers.length}</dd>
                                        </dl>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white overflow-hidden shadow rounded-lg">
                            <div className="p-5">
                                <div className="flex items-center">
                                    <div className="flex-shrink-0">
                                        <Icon name="file-text" className="h-6 w-6 text-green-600" />
                                    </div>
                                    <div className="ml-3 w-0 flex-1">
                                        <dl>
                                            <dt className="text-sm font-medium text-gray-500 truncate">With Customers</dt>
                                            <dd className="text-lg font-medium text-gray-900">
                                                {filteredUsers.filter((u: any) => u.customer).length}
                                            </dd>
                                        </dl>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white overflow-hidden shadow rounded-lg">
                            <div className="p-5">
                                <div className="flex items-center">
                                    <div className="flex-shrink-0">
                                        <Icon name="check" className="h-6 w-6 text-yellow-600" />
                                    </div>
                                    <div className="ml-3 w-0 flex-1">
                                        <dl>
                                            <dt className="text-sm font-medium text-gray-500 truncate">With NPIs</dt>
                                            <dd className="text-lg font-medium text-gray-900">
                                                {filteredUsers.filter((u: any) => u.userNpis.length > 0).length}
                                            </dd>
                                        </dl>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Users Table */}
                    <div className="bg-white shadow overflow-hidden sm:rounded-md">
                        <div className="px-4 py-5 sm:px-6">
                            <h3 className="text-lg leading-6 font-medium text-gray-900">
                                {currentCustomer ? `${currentCustomer.name} Users` : 'All Users'}
                            </h3>
                            <p className="mt-1 max-w-2xl text-sm text-gray-500">
                                {currentCustomer
                                    ? `User management for ${currentCustomer.name}`
                                    : 'System-wide user management across all customers.'}
                            </p>
                        </div>
                        <ul className="divide-y divide-gray-200">
                            {(filteredUsers as any[]).map((userItem: any) => (
                                <li key={userItem.id}>
                                    <div className="px-4 py-4 sm:px-6">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center">
                                                <div className="flex-shrink-0">
                                                    <Icon name="avatar" className="h-8 w-8 text-gray-400" />
                                                </div>
                                                <div className="ml-4">
                                                    <div className="flex items-center">
                                                        <p className="text-sm font-medium text-gray-900">
                                                            {userItem.name || userItem.username}
                                                        </p>
                                                        {userItem.roles.map((role: any) => (
                                                            <span
                                                                key={role.name}
                                                                className={`ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                                                    role.name === 'system-admin'
                                                                        ? 'bg-red-100 text-red-800'
                                                                        : role.name === 'customer-admin'
                                                                            ? 'bg-blue-100 text-blue-800'
                                                                            : role.name === 'provider-group-admin'
                                                                                ? 'bg-green-100 text-green-800'
                                                                                : 'bg-gray-100 text-gray-800'
                                                                }`}
                                                            >
                                {role.name}
                              </span>
                                                        ))}
                                                        {!userItem.customer && (
                                                            <span
                                                                className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800"
                                                                title="User is not assigned to any customer"
                                                            >
                                                                system
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-sm text-gray-500">{userItem.email}</p>
                                                    <div className="mt-1 flex items-center text-sm text-gray-500">
                                                        {userItem.customer && (
                                                            <>
                                                                <Icon name="file-text" className="h-4 w-4 mr-1" />
                                                                <span className="mr-4">{userItem.customer.name}</span>
                                                            </>
                                                        )}
                                                        {userItem.userNpis.length > 0 && (
                                                            <>
                                                                <Icon name="check" className="h-4 w-4 mr-1" />
                                                                <span>
                                  {userItem.userNpis.length} NPI
                                                                    {userItem.userNpis.length > 1 ? 's' : ''}
                                </span>
                                                            </>
                                                        )}
                                                        <span className={`ml-4 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${userItem.twoFactorEnabled ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                                                            {userItem.twoFactorEnabled ? '2FA enabled' : '2FA not set'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Right-hand column: joined date + admin actions */}
                                            <div className="flex items-center space-x-3">
                                                <p className="text-sm text-gray-500">
                                                    Joined {new Date(userItem.createdAt).toLocaleDateString()}
                                                </p>

                                                {/* Admin: Send reset link */}
                                                <Form method="post" className="inline">
                                                    <input type="hidden" name="intent" value="send-reset-link" />
                                                    <input type="hidden" name="userId" value={userItem.id} />
                                                    <button
                                                        type="submit"
                                                        className="inline-flex items-center px-3 py-1.5 border border-transparent rounded-md shadow-sm text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none"
                                                        title="Send password reset link"
                                                    >
                                                        {/* FIX: use an allowed icon name */}
                                                        <Icon name="reset" className="h-4 w-4 mr-1" />
                                                        Send reset link
                                                    </button>
                                                </Form>

                                                {/* Admin: Manual reset (temp password) */}
                                                <Form method="post" className="inline">
                                                    <input type="hidden" name="intent" value="manual-reset" />
                                                    <input type="hidden" name="userId" value={userItem.id} />
                                                    <button
                                                        type="submit"
                                                        className="inline-flex items-center px-3 py-1.5 border border-transparent rounded-md shadow-sm text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 focus:outline-none"
                                                        title="Set a temporary password and email it to the user"
                                                        onClick={e => {
                                                            if (
                                                                !confirm(
                                                                    `Manually reset password for "${userItem.name || userItem.username}"? This will sign them out everywhere.`,
                                                                )
                                                            ) {
                                                                e.preventDefault()
                                                            }
                                                        }}
                                                    >
                                                        {/* FIX: use an allowed icon name */}
                                                        <Icon name="lock-open-1" className="h-4 w-4 mr-1" />
                                                        Manual reset
                                                    </button>
                                                </Form>

                                                {/* Admin: Reset 2FA */}
                                                <Form method="post" className="inline">
                                                    <input type="hidden" name="intent" value="reset-2fa" />
                                                    <input type="hidden" name="userId" value={userItem.id} />
                                                    <button
                                                        type="submit"
                                                        className="inline-flex items-center px-3 py-1.5 border border-transparent rounded-md shadow-sm text-xs font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none"
                                                        title="Reset two-factor authentication for this user"
                                                        onClick={e => {
                                                            if (
                                                                !confirm(
                                                                    `Reset 2FA for "${userItem.name || userItem.username}"? This will disable 2FA and sign them out everywhere.`,
                                                                )
                                                            ) {
                                                                e.preventDefault()
                                                            }
                                                        }}
                                                    >
                                                        <Icon name="shield-warning" className="h-4 w-4 mr-1" />
                                                        Reset 2FA
                                                    </button>
                                                </Form>

                                                {/* Admin: Delete user (GitHub-style confirm) */}
                                                {(() => {
                                                    const isSystemAdmin = userItem.roles.some((r: any) => r.name === 'system-admin')
                                                    const isSelf = userItem.id === user.id
                                                    const disabledReason = isSystemAdmin
                                                        ? 'Cannot delete system administrators'
                                                        : !userItem.active
                                                            ? 'Cannot delete inactive users'
                                                            : isSelf
                                                                ? 'You cannot delete your own account'
                                                                : null
                                                    return (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                if (disabledReason) return
                                                                setDeleteModal({ isOpen: true, userId: userItem.id, username: userItem.username, name: userItem.name || userItem.username, confirmValue: '' })
                                                            }}
                                                            className={`inline-flex items-center px-3 py-1.5 border border-transparent rounded-md shadow-sm text-xs font-medium ${disabledReason ? 'text-gray-300 cursor-not-allowed' : 'text-white bg-red-600 hover:bg-red-700'}`}
                                                            title={disabledReason || 'Delete user'}
                                                            aria-disabled={disabledReason ? 'true' : 'false'}
                                                        >
                                                            <Icon name="trash" className="h-4 w-4 mr-1" />
                                                            Delete
                                                        </button>
                                                    )
                                                })()}
                                            </div>
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>

            {/* Create User Drawer */}
            <Drawer isOpen={drawerState.isOpen} onClose={closeDrawer} title="Add New User" size="md">
                <CreateUserForm
                    key={`create-user-${drawerState.preselectedCustomerId || 'none'}`}
                    customers={customers}
                    roles={roles}
                    drawerState={drawerState}
                    actionData={actionData}
                    closeDrawer={closeDrawer}
                />
            </Drawer>
            <AdminUsersDeleteModal state={deleteModal} setState={setDeleteModal as unknown as Dispatch<SetStateAction<{ isOpen: boolean; userId?: string; username?: string; name?: string; confirmValue: string }>>} allUsers={filteredUsers as any[]} actionData={actionData} isPending={isPending} />
        </InterexLayout>
    )
}

export function AdminUsersDeleteModal({
    state,
    setState,
    allUsers,
    actionData,
    isPending,
}: {
    state: { isOpen: boolean; userId?: string; username?: string; name?: string; confirmValue: string }
    setState: Dispatch<SetStateAction<{ isOpen: boolean; userId?: string; username?: string; name?: string; confirmValue: string }>>
    allUsers: any[]
    actionData: any
    isPending: boolean
}) {
    if (!state.isOpen) return null
    const userWithNpis = state.userId ? allUsers.find(u => u.id === state.userId) : undefined
    const blocked = actionData && (actionData as any).deleteBlocked
    const blockedForThis = blocked && blocked.userId === state.userId ? blocked : null
    const targetMatch = state.username ? state.confirmValue.toLowerCase() === state.username.toLowerCase() : false
    const disabled = !targetMatch || isPending || !state.userId || Boolean(blockedForThis)
    return (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
            <div className="absolute inset-0 bg-black/40" onClick={() => setState(s => ({ ...s, isOpen: false, confirmValue: '' }))} />
            <div className="absolute inset-0 flex items-center justify-center p-4">
                <Form method="post" replace className="w-full max-w-md rounded-lg bg-white shadow-xl flex flex-col">
                    <input type="hidden" name="intent" value="delete" />
                    {state.userId && <input type="hidden" name="userId" value={state.userId} />}
                    <div className="px-5 py-4 border-b border-gray-200">
                        <h3 id="delete-user-title" className="text-sm font-semibold text-red-700 flex items-center gap-2">
                            <Icon name="warning" className="h-4 w-4" /> Delete User
                        </h3>
                    </div>
                    <div className="px-5 py-4 text-sm space-y-4">
                        <p>
                            You are about to permanently delete <strong>{state.name}</strong>. This action cannot be undone.
                        </p>
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
                                value={state.confirmValue}
                                onChange={e => {
                                    const v = e.currentTarget.value
                                    setState(s => ({ ...s, confirmValue: v }))
                                }}
                                className="w-full border rounded-md px-3 py-2 text-sm"
                                placeholder={state.username}
                            />
                        </div>
                        {blockedForThis ? (
                            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3">
                                <div className="flex">
                                    <div className="flex-shrink-0"><Icon name="warning" className="h-4 w-4 text-yellow-600" /></div>
                                    <div className="ml-2 text-xs">
                                        <p className="text-yellow-800"><strong>Cannot delete {blockedForThis.userName}</strong></p>
                                        <p className="text-yellow-700 mt-1">
                                            Deletion is blocked because this user has {(() => {
                                                const pieces: string[] = []
                                                if (blockedForThis.submissions) pieces.push(`${blockedForThis.submissions} submission${blockedForThis.submissions === 1 ? '' : 's'}`)
                                                if (blockedForThis.documents) pieces.push(`${blockedForThis.documents} uploaded document${blockedForThis.documents === 1 ? '' : 's'}`)
                                                if (blockedForThis.events) pieces.push(`${blockedForThis.events} provider event${blockedForThis.events === 1 ? '' : 's'}`)
                                                return pieces.length ? pieces.join(', ') : 'linked records'
                                            })()}.
                                            Please deactivate the user instead.
                                        </p>
                                        <div className="mt-2 flex gap-2">
                                            {userWithNpis?.userNpis?.length ? (
                                                <Form method="post" className="inline">
                                                    <input type="hidden" name="intent" value="deactivate-and-unassign" />
                                                    <input type="hidden" name="userId" value={blockedForThis.userId} />
                                                    <StatusButton status={isPending ? 'pending' : 'idle'} type="submit" className="bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded-md">Unassign NPIs & Deactivate</StatusButton>
                                                </Form>
                                            ) : (
                                                <Form method="post" className="inline">
                                                    <input type="hidden" name="intent" value="set-active" />
                                                    <input type="hidden" name="userId" value={blockedForThis.userId} />
                                                    <input type="hidden" name="status" value="inactive" />
                                                    <StatusButton status={isPending ? 'pending' : 'idle'} type="submit" className="bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded-md">Deactivate user</StatusButton>
                                                </Form>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                        {state.username && state.confirmValue && state.confirmValue.toLowerCase() !== state.username.toLowerCase() && (
                            <p className="text-xs text-red-600">Entered value does not match <code>{state.username}</code>.</p>
                        )}
                    </div>
                    <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={() => setState(s => ({ ...s, isOpen: false, confirmValue: '' }))}
                            className="inline-flex justify-center py-2 px-3 rounded-md border border-gray-300 text-sm bg-white text-gray-700 hover:bg-gray-50"
                        >
                            Cancel
                        </button>
                        <StatusButton type="submit" disabled={disabled} status={isPending ? 'pending' : 'idle'} className="inline-flex justify-center py-2 px-4 rounded-md text-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-40">
                            Delete User
                        </StatusButton>
                    </div>
                </Form>
            </div>
        </div>
    )
}

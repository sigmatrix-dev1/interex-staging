// app/routes/admin+/customers.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { useState, useEffect } from 'react'
import { data, useLoaderData, Form, useSearchParams, useActionData, type LoaderFunctionArgs, type ActionFunctionArgs , Link, useNavigation  } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { useToast } from '#app/components/toaster.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { sendTemporaryPasswordEmail } from '#app/utils/emails/send-temporary-password.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import { UsernameSchema, EmailSchema } from '#app/utils/user-validation.ts'

const CreateCustomerSchema = z.object({
  intent: z.literal('create'),
  name: z.string().min(1, 'Customer name is required'),
  description: z.string().optional().default(''),
  baaNumber: z.string().optional(),
  adminName: z.string().min(1, 'Admin name is required'),
  adminEmail: EmailSchema,
  adminUsername: UsernameSchema,
})

// Note: Update flow not implemented in this route; schema removed to avoid unused var warnings

const AddAdminSchema = z.object({
  intent: z.literal('add-admin'),
  customerId: z.string().min(1, 'Customer ID is required'),
  adminName: z.string().min(1, 'Admin name is required'),
  adminEmail: EmailSchema,
  adminUsername: UsernameSchema,
})

const DeleteCustomerSchema = z.object({
  intent: z.literal('delete'),
  customerId: z.string().min(1, 'Customer ID is required'),
  confirmName: z.string().min(1, 'Confirmation is required'),
})

const UpdateCustomerSchema = z.object({
  intent: z.literal('update'),
  customerId: z.string().min(1, 'Customer ID is required'),
  name: z.string().min(1, 'Customer name is required'),
  description: z.string().optional().default(''),
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateCustomerSchema,
  AddAdminSchema,
  DeleteCustomerSchema,
  UpdateCustomerSchema,
])

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require system admin role
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  // Parse search parameters
  const url = new URL(request.url)
  const searchTerm = url.searchParams.get('search') || ''

  // Build search conditions
  const whereConditions: any = {}
  if (searchTerm) {
    whereConditions.OR = [
      { name: { contains: searchTerm } },
      { description: { contains: searchTerm } },
      { baaNumber: { contains: searchTerm } },
    ]
  }

  // Get basic customer information only (no internal details)
  const customers = await prisma.customer.findMany({
    where: whereConditions,
    select: {
      id: true,
      name: true,
      description: true,
      baaNumber: true,
      active: true,
      createdAt: true,
      _count: {
        select: { 
          users: {
            where: {
              roles: {
                some: { name: 'customer-admin' }
              }
            }
          }
        }
      }
    },
    orderBy: { name: 'asc' }
  })

  const { toast, headers } = await getToast(request)

  return data({ user, customers, toast, searchTerm }, { headers: headers ?? undefined })
}

export async function action({ request }: ActionFunctionArgs) {
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

  // Require system admin role
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: ActionSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const action = submission.value

  // Handle create customer action
  if (action.intent === 'create') {
    const { name, description, baaNumber, adminName, adminEmail, adminUsername } = action

    // Check if customer name already exists
    const existingCustomer = await prisma.customer.findFirst({
      where: { name }
    })

    if (existingCustomer) {
      return data(
        { result: submission.reply({ fieldErrors: { name: ['Customer name already exists'] } }) },
        { status: 400 }
      )
    }

    // Check if BAA number already exists (if provided)
    if (baaNumber) {
      const existingBaa = await prisma.customer.findFirst({
        where: { baaNumber }
      })

      if (existingBaa) {
        return data(
          { result: submission.reply({ fieldErrors: { baaNumber: ['BAA number already exists'] } }) },
          { status: 400 }
        )
      }
    }

    // Check if admin email already exists
    const existingAdminEmail = await prisma.user.findUnique({
      where: { email: adminEmail }
    })

    if (existingAdminEmail) {
      return data(
        { result: submission.reply({ fieldErrors: { adminEmail: ['Email already exists'] } }) },
        { status: 400 }
      )
    }

    // Check if admin username already exists
    const existingAdminUsername = await prisma.user.findUnique({
      where: { username: adminUsername }
    })

    if (existingAdminUsername) {
      return data(
        { result: submission.reply({ fieldErrors: { adminUsername: ['Username already exists'] } }) },
        { status: 400 }
      )
    }

    // Generate temporary password for admin
    const temporaryPassword = generateTemporaryPassword()

    // Create customer and admin in a transaction
  await prisma.$transaction(async (tx) => {
      // Create customer
      const customer = await tx.customer.create({
        data: {
          name,
          description: description || '',
          baaNumber: baaNumber || null,
          baaDate: baaNumber ? new Date() : null,
        }
      })

      // Create customer admin
      await tx.user.create({
        data: {
          name: adminName,
          email: adminEmail,
          username: adminUsername,
          customerId: customer.id,
          roles: {
            connect: { name: 'customer-admin' }
          },
          password: {
            create: {
              hash: hashPassword(temporaryPassword)
            }
          }
        }
      })

      // return shape omitted; callers don't need it
    })

    // Send email with temporary password and login URL
    const loginUrl = `${new URL(request.url).origin}/login`
    const emailResult = await sendTemporaryPasswordEmail({
      to: adminEmail,
      adminName,
      customerName: name,
      username: adminUsername,
      tempPassword: temporaryPassword,
      loginUrl,
    })

    if (!emailResult.success) {
      console.error('Failed to send temporary password email:', emailResult.error)
      // Continue with success even if email fails - show password in toast
    }

    return redirectWithToast('/admin/customers', {
      type: 'success',
      title: 'Customer created',
      description: emailResult.success 
        ? `${name} has been created with admin ${adminName}. Login credentials sent via email.`
        : `${name} has been created with admin ${adminName}. Temporary password: ${temporaryPassword}`,
    })
  }

  // Handle add admin action
  if (action.intent === 'add-admin') {
    const { customerId, adminName, adminEmail, adminUsername } = action

    // Verify customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    })

    if (!customer) {
      return data(
        { error: 'Customer not found' },
        { status: 404 }
      )
    }

    // Check if admin email already exists
    const existingAdminEmail = await prisma.user.findUnique({
      where: { email: adminEmail }
    })

    if (existingAdminEmail) {
      return data(
        { result: submission.reply({ fieldErrors: { adminEmail: ['Email already exists'] } }) },
        { status: 400 }
      )
    }

    // Check if admin username already exists
    const existingAdminUsername = await prisma.user.findUnique({
      where: { username: adminUsername }
    })

    if (existingAdminUsername) {
      return data(
        { result: submission.reply({ fieldErrors: { adminUsername: ['Username already exists'] } }) },
        { status: 400 }
      )
    }

    // Generate temporary password for admin
    const temporaryPassword = generateTemporaryPassword()

    // Create customer admin
    await prisma.user.create({
      data: {
        name: adminName,
        email: adminEmail,
        username: adminUsername,
        customerId: customer.id,
        roles: {
          connect: { name: 'customer-admin' }
        },
        password: {
          create: {
            hash: hashPassword(temporaryPassword)
          }
        }
      }
    })

    // Send email with temporary password and login URL
    const loginUrl = `${new URL(request.url).origin}/login`
    const emailResult = await sendTemporaryPasswordEmail({
      to: adminEmail,
      adminName,
      customerName: customer.name,
      username: adminUsername,
      tempPassword: temporaryPassword,
      loginUrl,
    })

    if (!emailResult.success) {
      console.error('Failed to send temporary password email:', emailResult.error)
      // Continue with success even if email fails - show password in toast
    }


    return redirectWithToast('/admin/customers', {
      type: 'success',
      title: 'Admin added',
      description: emailResult.success
        ? `${adminName} has been added as admin for ${customer.name}. Login credentials sent via email.`
        : `${adminName} has been added as admin for ${customer.name}. Temporary password: ${temporaryPassword}`,
    })
  }

  // Handle update customer action
  if (action.intent === 'update') {
    const { customerId, name, description } = action

    const existing = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!existing) {
      return data({ error: 'Customer not found' }, { status: 404 })
    }

    // Enforce unique name constraint if changing name
    if (name && name !== existing.name) {
      const nameConflict = await prisma.customer.findFirst({
        where: { name, NOT: { id: customerId } },
      })
      if (nameConflict) {
        return data(
          {
            result: submission.reply({
              fieldErrors: { name: ['Customer name already exists'] },
            }),
          },
          { status: 400 },
        )
      }
    }

    await prisma.customer.update({
      where: { id: customerId },
      data: { name, description: description || '' },
    })

    await audit.admin({
      action: 'CUSTOMER_UPDATE',
      actorType: 'USER',
      actorId: user.id,
      customerId,
      entityType: 'Customer',
      entityId: customerId,
      summary: `Updated customer: ${existing.name}${existing.name !== name ? ` -> ${name}` : ''}`,
      status: 'SUCCESS',
    })

    return redirectWithToast('/admin/customers', {
      type: 'success',
      title: 'Customer updated',
      description: `${name} has been saved.`,
    })
  }

  // Handle delete customer action (with elevated override if description contains "Test-Customer")
  if (action.intent === 'delete') {
    const { customerId, confirmName } = action

    // Fetch the customer with minimal fields we need
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, description: true },
    })
    if (!customer) {
      return data({ error: 'Customer not found' }, { status: 404 })
    }

    const isElevatedDelete = (customer.description || '').includes('Test-Customer')

    // Extra guard: require exact name confirmation like GitHub
    if (confirmName !== customer.name) {
      return redirectWithToast('/admin/customers', {
        type: 'error',
        title: 'Confirmation did not match',
        description: `Type the exact customer name: ${customer.name}`,
      })
    }

    if (!isElevatedDelete) {
      // New policy: only customers explicitly marked as "Test-Customer" can be deleted.
      return redirectWithToast('/admin/customers', {
        type: 'error',
        title: 'Delete blocked',
        description:
          'Only customers marked as "Test-Customer" in the description can be deleted. You can edit the customer to add this marker if this is a test record.',
      })
    }

    // Elevated delete: forcefully remove all related data regardless of dependencies
    try {
      await prisma.$transaction(async (tx) => {
        // Submissions (will cascade submission documents & events)
        await tx.submission.deleteMany({ where: { customerId } })

        // Provider events for this customer
        await tx.providerEvent.deleteMany({ where: { customerId } })

        // Letters for this customer
        await tx.prepayLetter.deleteMany({ where: { customerId } })
        await tx.postpayLetter.deleteMany({ where: { customerId } })
        await tx.postpayOtherLetter.deleteMany({ where: { customerId } })

        // Providers (will cascade userNpis, provider list/registration snapshots)
        await tx.provider.deleteMany({ where: { customerId } })

        // Provider groups
        await tx.providerGroup.deleteMany({ where: { customerId } })

        // Users: deactivate, clear sessions, randomize passwords, and detach from customer
        const users = await tx.user.findMany({ where: { customerId }, select: { id: true } })
        const userIds = users.map(u => u.id)
        if (userIds.length) {
          await tx.session.deleteMany({ where: { userId: { in: userIds } } })
          for (const id of userIds) {
            const temp = generateTemporaryPassword()
            await tx.password.upsert({
              where: { userId: id },
              update: { hash: hashPassword(temp) },
              create: { userId: id, hash: hashPassword(temp) },
            })
          }
          await tx.user.updateMany({
            where: { id: { in: userIds } },
            data: {
              active: false,
              deletedAt: new Date(),
              customerId: null,
              providerGroupId: null,
              mustChangePassword: true,
            },
          })
        }

        // Finally, the customer
        await tx.customer.delete({ where: { id: customerId } })
      })

      await audit.admin({
        action: 'CUSTOMER_DELETE_FORCE',
        actorType: 'USER',
        actorId: user.id,
        customerId,
        entityType: 'Customer',
        entityId: customerId,
        summary: `Force-deleted Test-Customer: ${customer.name}; deactivated and sanitized all users`,
        status: 'SUCCESS',
      })

      return redirectWithToast('/admin/customers', {
        type: 'success',
        title: 'Customer force-deleted',
        description: `${customer.name} (Test-Customer) and all dependent data have been removed.`,
      })
    } catch (error) {
      console.error('Force delete customer failed', error)
      await audit.admin({
        action: 'CUSTOMER_DELETE_FORCE',
        actorType: 'USER',
        actorId: user.id,
        customerId,
        entityType: 'Customer',
        entityId: customerId,
        summary: `Force delete failed for: ${customer.name}`,
        status: 'FAILURE',
        message: error instanceof Error ? error.message : String(error),
      })
      return redirectWithToast('/admin/customers', {
        type: 'error',
        title: 'Delete failed',
        description: 'Could not delete the customer. Please check server logs.',
      })
    }
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function AdminCustomersPage() {
  const { user, customers, toast, searchTerm } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  const isPending = useIsPending()
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  
  useToast(toast)
  
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'add-admin' | 'edit'
    customerId?: string
  }>({ isOpen: false, mode: 'create' })

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.get('action')
    const customerId = searchParams.get('customerId')
    
    if (action === 'add') {
      setDrawerState({ isOpen: true, mode: 'create' })
    } else if (action === 'add-admin' && customerId) {
      setDrawerState({ isOpen: true, mode: 'add-admin', customerId })
    } else if (action === 'edit' && customerId) {
      setDrawerState({ isOpen: true, mode: 'edit', customerId })
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'add-admin' | 'edit', customerId?: string) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('action', mode === 'create' ? 'add' : mode === 'add-admin' ? 'add-admin' : 'edit')
    if (customerId) newParams.set('customerId', customerId)
    setSearchParams(newParams)
  }

  const closeDrawer = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('action')
    newParams.delete('customerId')
    setSearchParams(newParams)
  }

  const selectedCustomer = drawerState.customerId 
    ? customers.find(c => c.id === drawerState.customerId)
    : null

  const [createForm, createFields] = useForm({
    id: 'create-customer-form',
    constraint: getZodConstraint(CreateCustomerSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateCustomerSchema })
    },
  })

  const [addAdminForm, addAdminFields] = useForm({
    id: 'add-admin-form',
    constraint: getZodConstraint(AddAdminSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: AddAdminSchema })
    },
  })

  const [editForm, editFields] = useForm({
    id: 'edit-customer-form',
    constraint: getZodConstraint(UpdateCustomerSchema),
    lastResult: actionData && 'result' in actionData ? actionData.result : undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateCustomerSchema })
    },
  })

  return (
    <>
      {/* Main content area - blur when drawer is open */}
      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
        <InterexLayout 
          user={user}
          title="Customer Management"
          subtitle="System Administration"
          showBackButton={true}
          backTo="/admin/dashboard"
          currentPath="/admin/customers"
          backGuardEnabled={true}
          backGuardLogoutUrl="/logout"
          backGuardRedirectTo="/login"
          backGuardMessage="Going back will log you out. Continue?"
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
                      placeholder="Search customers..."
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
                      to="/admin/customers"
                      className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Clear
                    </Link>
                  )}
                </Form>
              </div>

              {/* Customers List */}
              <div className="bg-white shadow rounded-lg flex flex-col">
                <div className="px-6 py-4 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900">Customers</h2>
                      <p className="text-sm text-gray-500">{customers.length} total customers</p>
                    </div>
                    <div className="flex space-x-3">
                      <button
                        onClick={() => openDrawer('create')}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        Add Customer
                      </button>
                    </div>
                  </div>
                </div>
                
                {customers.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No customers found</h3>
                    <p className="text-gray-500 mb-6">
                      {searchTerm 
                        ? `No customers match your search criteria "${searchTerm}".`
                        : 'Get started by creating your first customer.'
                      }
                    </p>
                    <button
                      onClick={() => openDrawer('create')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                    >
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      Add Customer
                    </button>
                  </div>
                ) : (
                  <div className="overflow-auto max-h-[70vh]">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead>
                        <tr>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Customer
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            BAA Number
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Admins  
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Created
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Status
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Add Admin
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Edit
                          </th>
                          <th className="sticky top-0 z-10 bg-blue-900 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                            Delete
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {customers.map((customer) => (
                          <tr key={customer.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="text-sm font-medium text-gray-900">{customer.name}</div>
                                  {customer.description?.includes('Test-Customer') ? (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-800 border border-red-200">
                                      Test-Customer
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-sm text-gray-500">{customer.description}</div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">
                                {customer.baaNumber || <span className="text-gray-400">—</span>}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-sm text-gray-900">
                                {customer._count.users} admin{customer._count.users !== 1 ? 's' : ''}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="text-xs text-gray-500">
                                Created {new Date(customer.createdAt).toLocaleDateString()}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                customer.active 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-gray-100 text-gray-800'
                              }`}>
                                {customer.active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                              <button
                                onClick={() => openDrawer('add-admin', customer.id)}
                                className="text-green-600 hover:text-green-800 p-1"
                                title="Add admin"
                              >
                                <Icon name="plus" className="h-4 w-4" />
                              </button>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                              <button
                                onClick={() => openDrawer('edit', customer.id)}
                                className="text-blue-600 hover:text-blue-800 p-1"
                                title="Edit customer"
                              >
                                <Icon name="pencil-2" className="h-4 w-4" />
                              </button>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                              {customer.description?.includes('Test-Customer') ? (
                                <button
                                  type="button"
                                  className="text-red-600 hover:text-red-800 p-1"
                                  title="Delete customer"
                                  onClick={() => {
                                    setConfirmDelete({ id: customer.id, name: customer.name })
                                    setConfirmText('')
                                  }}
                                >
                                  <Icon name="trash" className="h-4 w-4" />
                                </button>
                              ) : (
                                <span className="text-gray-400">—</span>
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
                      <Icon name="file-text" className="h-8 w-8 text-blue-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-blue-900">Total Customers</p>
                        <p className="text-2xl font-bold text-blue-600">{customers.length}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-green-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="check" className="h-8 w-8 text-green-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-green-900">Active Customers</p>
                        <p className="text-2xl font-bold text-green-600">
                          {customers.filter(c => c.active).length}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-purple-50 rounded-lg p-4">
                    <div className="flex items-center">
                      <Icon name="avatar" className="h-8 w-8 text-purple-600 mr-3" />
                      <div>
                        <p className="text-sm font-medium text-purple-900">Total Admins</p>
                        <p className="text-2xl font-bold text-purple-600">
                          {customers.reduce((sum, c) => sum + c._count.users, 0)}
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

      {/* Create Customer Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'create'}
        onClose={closeDrawer}
        title="Add New Customer"
        size="lg"
      >
        <Form method="post" {...getFormProps(createForm)}>
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-6">
            <div className="border-b border-gray-200 pb-4">
              <h3 className="text-lg font-medium text-gray-900">Customer Information</h3>
              <p className="text-sm text-gray-500">Basic information about the customer organization.</p>
            </div>

            <Field
              labelProps={{ children: 'Customer Name' }}
              inputProps={{
                ...getInputProps(createFields.name, { type: 'text' }),
                placeholder: 'HealthTech Solutions',
              }}
              errors={createFields.name.errors}
            />

            <Field
              labelProps={{ children: 'Description (Optional)' }}
              inputProps={{
                ...getInputProps(createFields.description, { type: 'text' }),
                placeholder: 'Brief description of the customer organization',
              }}
              errors={createFields.description.errors}
            />

            <Field
              labelProps={{ children: 'BAA Number (Optional)' }}
              inputProps={{
                ...getInputProps(createFields.baaNumber, { type: 'text' }),
                placeholder: 'BAA-2024-001',
              }}
              errors={createFields.baaNumber.errors}
            />

            <div className="border-b border-gray-200 pb-4 pt-4">
              <h3 className="text-lg font-medium text-gray-900">Customer Administrator</h3>
              <p className="text-sm text-gray-500">The admin user who will manage this customer organization.</p>
            </div>

            <Field
              labelProps={{ children: 'Admin Full Name' }}
              inputProps={{
                ...getInputProps(createFields.adminName, { type: 'text' }),
                placeholder: 'Jane Smith',
              }}
              errors={createFields.adminName.errors}
            />

            <Field
              labelProps={{ children: 'Admin Email' }}
              inputProps={{
                ...getInputProps(createFields.adminEmail, { type: 'email' }),
                placeholder: 'jane.smith@healthtech.com',
              }}
              errors={createFields.adminEmail.errors}
            />

            <Field
              labelProps={{ children: 'Admin Username' }}
              inputProps={{
                ...getInputProps(createFields.adminUsername, { type: 'text' }),
                placeholder: 'janesmith',
              }}
              errors={createFields.adminUsername.errors}
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
                Create Customer
              </StatusButton>
            </div>
          </div>
        </Form>
      </Drawer>

      {/* Add Admin Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'add-admin'}
        onClose={closeDrawer}
        title={`Add Admin to ${selectedCustomer?.name || 'Customer'}`}
        size="md"
      >
        {selectedCustomer && (
          <Form method="post" {...getFormProps(addAdminForm)}>
            <input type="hidden" name="intent" value="add-admin" />
            <input type="hidden" name="customerId" value={selectedCustomer.id} />
            <div className="space-y-6">                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <Icon name="question-mark-circled" className="h-5 w-5 text-blue-400" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-blue-800">
                      Adding Admin to {selectedCustomer.name}
                    </h3>
                    <div className="mt-2 text-sm text-blue-700">
                      <p>The new admin will receive an email with temporary password and login instructions.</p>
                    </div>
                  </div>
                </div>
              </div>

              <Field
                labelProps={{ children: 'Admin Full Name' }}
                inputProps={{
                  ...getInputProps(addAdminFields.adminName, { type: 'text' }),
                  placeholder: 'John Doe',
                }}
                errors={addAdminFields.adminName.errors}
              />

              <Field
                labelProps={{ children: 'Admin Email' }}
                inputProps={{
                  ...getInputProps(addAdminFields.adminEmail, { type: 'email' }),
                  placeholder: 'john.doe@example.com',
                }}
                errors={addAdminFields.adminEmail.errors}
              />

              <Field
                labelProps={{ children: 'Admin Username' }}
                inputProps={{
                  ...getInputProps(addAdminFields.adminUsername, { type: 'text' }),
                  placeholder: 'johndoe',
                }}
                errors={addAdminFields.adminUsername.errors}
              />

              <ErrorList id={addAdminForm.errorId} errors={addAdminForm.errors} />

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
                  className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                >
                  Add Admin
                </StatusButton>
              </div>
            </div>
          </Form>
        )}
      </Drawer>

      {/* Edit Customer Drawer */}
      <Drawer
        isOpen={drawerState.isOpen && drawerState.mode === 'edit'}
        onClose={closeDrawer}
        title={`Edit ${selectedCustomer?.name || 'Customer'}`}
        size="lg"
      >
        {selectedCustomer && (
          <Form method="post" {...getFormProps(editForm)}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="customerId" value={selectedCustomer.id} />
            <div className="space-y-6">
              <div className="border-b border-gray-200 pb-4">
                <h3 className="text-lg font-medium text-gray-900">Customer Details</h3>
                <p className="text-sm text-gray-500">Update the customer information below.</p>
              </div>

              <Field
                labelProps={{ children: 'Customer Name' }}
                inputProps={{
                  ...getInputProps(editFields.name, { type: 'text' }),
                  defaultValue: selectedCustomer.name,
                }}
                errors={editFields.name.errors}
              />

              <Field
                labelProps={{ children: 'Description (Optional)' }}
                inputProps={{
                  ...getInputProps(editFields.description, { type: 'text' }),
                  defaultValue: selectedCustomer.description ?? '',
                }}
                errors={editFields.description.errors}
              />

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

      <CustomersDeleteModal
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        confirmText={confirmText}
        setConfirmText={setConfirmText}
      />
    </>
  )
}

// Delete Confirmation Modal (GitHub-style: type exact name)
export function CustomersDeleteModal({
  confirmDelete,
  setConfirmDelete,
  confirmText,
  setConfirmText,
}: {
  confirmDelete: { id: string; name: string } | null
  setConfirmDelete: (v: { id: string; name: string } | null) => void
  confirmText: string
  setConfirmText: (v: string) => void
}) {
  const navigation = useNavigation()
  const isDeleting = navigation.state === 'submitting' && navigation.formData?.get('intent') === 'delete'
  if (!confirmDelete) return null
  const match = confirmText.trim() === confirmDelete.name
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => { if (!isDeleting) setConfirmDelete(null) }} />
      <div role="dialog" aria-modal="true" aria-busy={isDeleting || undefined} className="relative z-10 w-full max-w-lg mx-4 rounded-lg bg-white shadow-xl ring-1 ring-black/10">
        <div className="px-6 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="mt-1 text-red-600">
              <Icon name="warning-triangle" className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Delete customer</h3>
              <p className="mt-1 text-sm text-gray-600">
                You are about to permanently delete
                <span className="font-semibold"> {confirmDelete.name}</span>.
                This action cannot be undone and will remove all related data for this customer.
              </p>
              <p className="mt-3 text-sm text-gray-700">
                Please type the customer name <span className="font-mono font-semibold">{confirmDelete.name}</span> to confirm.
              </p>
              <Form method="post" replace className="mt-3 space-y-3">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="customerId" value={confirmDelete.id} />
                <input
                  type="text"
                  autoFocus
                  name="confirmName"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={confirmDelete.name}
                  disabled={isDeleting}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:bg-gray-100 disabled:text-gray-400"
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    className={
                      (isDeleting
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-gray-50') +
                      ' inline-flex items-center rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700'
                    }
                    disabled={isDeleting}
                    onClick={() => { if (!isDeleting) setConfirmDelete(null) }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!match || isDeleting}
                    className={
                      (match && !isDeleting
                        ? 'bg-red-600 hover:bg-red-700 text-white'
                        : 'bg-red-200 text-red-600 cursor-not-allowed') +
                      ' inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold shadow-sm'
                    }
                    title="Confirm deletion"
                  >
                    {isDeleting ? (
                      <svg className="-ml-0.5 mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                      </svg>
                    ) : (
                      <Icon name="trash" className="-ml-0.5 mr-2 h-4 w-4" />
                    )}
                    {isDeleting ? 'Deleting…' : 'Permanently delete'}
                  </button>
                </div>
              </Form>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

import { data, useLoaderData, Form, useSearchParams, useActionData } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
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
import { sendTemporaryPasswordEmail } from '#app/utils/emails/send-temporary-password.server.ts'

const CreateCustomerSchema = z.object({
  intent: z.literal('create'),
  name: z.string().min(1, 'Customer name is required'),
  description: z.string().optional().default(''),
  baaNumber: z.string().optional(),
  adminName: z.string().min(1, 'Admin name is required'),
  adminEmail: z.string().email('Invalid email address'),
  adminUsername: z.string().min(3, 'Username must be at least 3 characters'),
})

const UpdateCustomerSchema = z.object({
  intent: z.literal('update'),
  customerId: z.string().min(1, 'Customer ID is required'),
  name: z.string().min(1, 'Customer name is required'),
  description: z.string().optional().default(''),
  baaNumber: z.string().optional(),
})

const AddAdminSchema = z.object({
  intent: z.literal('add-admin'),
  customerId: z.string().min(1, 'Customer ID is required'),
  adminName: z.string().min(1, 'Admin name is required'),
  adminEmail: z.string().email('Invalid email address'),
  adminUsername: z.string().min(3, 'Username must be at least 3 characters'),
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateCustomerSchema,
  AddAdminSchema,
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
    const result = await prisma.$transaction(async (tx) => {
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
      const admin = await tx.user.create({
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

      return { customer, admin }
    })

    // Send email with temporary password and login URL
    const loginUrl = `${new URL(request.url).origin}/login`
    const emailResult = await sendTemporaryPasswordEmail({
      to: adminEmail,
      adminName,
      customerName: name,
      tempPassword: temporaryPassword,
      loginUrl,
    })

    if (!emailResult.success) {
      console.error('Failed to send temporary password email:', emailResult.error)
      // Continue with success even if email fails - show password in toast
    }

    // TODO: Remove temporary password from success message once email is working
    console.log(`New customer "${name}" created with admin: ${adminEmail}`)
    console.log(`Admin temporary password: ${temporaryPassword}`)
    console.log(`Login URL: ${loginUrl}`)

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
      tempPassword: temporaryPassword,
      loginUrl,
    })

    if (!emailResult.success) {
      console.error('Failed to send temporary password email:', emailResult.error)
      // Continue with success even if email fails - show password in toast
    }

    // TODO: Remove temporary password from success message once email is working
    console.log(`New admin for "${customer.name}": ${adminEmail}`)
    console.log(`Admin temporary password: ${temporaryPassword}`)
    console.log(`Login URL: ${loginUrl}`)

    return redirectWithToast('/admin/customers', {
      type: 'success',
      title: 'Admin added',
      description: emailResult.success
        ? `${adminName} has been added as admin for ${customer.name}. Login credentials sent via email.`
        : `${adminName} has been added as admin for ${customer.name}. Temporary password: ${temporaryPassword}`,
    })
  }

  return data({ error: 'Invalid action' }, { status: 400 })
}

export default function AdminCustomersPage() {
  const { user, customers, toast, searchTerm } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  const isPending = useIsPending()
  
  useToast(toast)
  
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'add-admin'
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
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'add-admin', customerId?: string) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('action', mode === 'create' ? 'add' : 'add-admin')
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
              <div className="bg-white shadow rounded-lg">
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
                  <div className="overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Customer
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            BAA Number
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Admins  
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {customers.map((customer) => (
                          <tr key={customer.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div>
                                <div className="text-sm font-medium text-gray-900">{customer.name}</div>
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
                              <div className="flex items-center space-x-2">
                                <button
                                  onClick={() => openDrawer('add-admin', customer.id)}
                                  className="text-green-600 hover:text-green-800 p-1"
                                  title="Add admin"
                                >
                                  <Icon name="plus" className="h-4 w-4" />
                                </button>
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
    </>
  )
}

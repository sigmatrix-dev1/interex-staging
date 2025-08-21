import { data, useLoaderData, Form, useSearchParams, useActionData } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Link } from 'react-router'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList, SelectField } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { useState, useEffect } from 'react'
import { redirectWithToast, getToast } from '#app/utils/toast.server.ts'
import { useToast } from '#app/components/toaster.tsx'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { sendUserRegistrationEmail } from '#app/utils/emails/send-user-registration.server.ts'

const CreateUserSchema = z.object({
  intent: z.literal('create'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  username: z.string().min(3, 'Username must be at least 3 characters'),
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
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateUserSchema,
  UpdateUserSchema,
  DeleteUserSchema,
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

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const action = submission.value

  // Handle create action
  if (action.intent === 'create') {
    const { name, email, username, role, providerGroupId, active } = action

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
            }
          })
        },
        { status: 400 }
      )
    }

    // Generate temporary password
    const temporaryPassword = generateTemporaryPassword()

    // Create the user
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        username,
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
        to: email,
        userName: name,
        userRole: role,
        customerName: customer.name,
        tempPassword: temporaryPassword,
        loginUrl,
        username,
        providerGroupName: newUser.providerGroup?.name,
      })
      console.log(`✅ Registration email sent to ${email}`)
    } catch (error) {
      console.error(`❌ Failed to send registration email to ${email}:`, error)
      // Don't fail the user creation if email fails
    }

    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success',
      title: 'User created',
      description: `${name} has been created successfully and a welcome email has been sent.`,
    })
  }

  // Handle update action
  if (action.intent === 'update') {
    const { userId: targetUserId, name, role, providerGroupId, active } = action

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
      return data(
        { error: 'User not found or not authorized to edit this user' },
        { status: 404 }
      )
    }

    // Prevent editing system admins
    const isTargetSystemAdmin = targetUser.roles.some(role => role.name === 'system-admin')
    if (isTargetSystemAdmin) {
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
        return data(
          { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group'] } }) },
          { status: 400 }
        )
      }
    }

    // Update the user
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

    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success',
      title: 'User updated',
      description: `${name} has been updated successfully.`,
    })
  }

  // Handle delete action
  if (action.intent === 'delete') {
    const { userId: targetUserId } = action

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

    // Delete related records first (cascade delete)
    await prisma.userNpi.deleteMany({
      where: { userId: targetUserId }
    })

    await prisma.userImage.deleteMany({
      where: { userId: targetUserId }
    })

    // Delete the user
    const userName = targetUser.name
    await prisma.user.delete({
      where: { id: targetUserId }
    })

    return redirectWithToast(`/admin/customer-manage/${customerId}/users`, {
      type: 'success',
      title: 'User deleted',
      description: `${userName} has been deleted successfully.`,
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
  
  const [drawerState, setDrawerState] = useState<{
    isOpen: boolean
    mode: 'create' | 'edit'
    userId?: string
  }>({ isOpen: false, mode: 'create' })

  // Handle URL parameters for drawer state
  useEffect(() => {
    const action = searchParams.get('action')
    const userId = searchParams.get('userId')
    
    if (action === 'add') {
      setDrawerState({ isOpen: true, mode: 'create' })
    } else if (action === 'edit' && userId) {
      setDrawerState({ isOpen: true, mode: 'edit', userId })
    } else {
      setDrawerState({ isOpen: false, mode: 'create' })
    }
  }, [searchParams])

  const openDrawer = (mode: 'create' | 'edit', userId?: string) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('action', mode === 'create' ? 'add' : 'edit')
    if (userId) newParams.set('userId', userId)
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

  return (
    <>
      {/* Main content area - blur when drawer is open */}
      <div className={`transition-all duration-300 ${drawerState.isOpen ? 'blur-sm' : 'blur-none'}`}>
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
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {customer.users.map((userItem: any) => (
                          <tr key={userItem.id} className="hover:bg-gray-50">
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
                              <div className="flex items-center space-x-2">
                                <button
                                  onClick={() => openDrawer('edit', userItem.id)}
                                  className="text-blue-600 hover:text-blue-800 p-1"
                                  title="Edit user"
                                >
                                  <Icon name="pencil-1" className="h-4 w-4" />
                                </button>
                                
                                <Form method="post" className="inline">
                                  <input type="hidden" name="intent" value="delete" />
                                  <input type="hidden" name="userId" value={userItem.id} />
                                  <button
                                    type="submit"
                                    className="text-red-600 hover:text-red-800 p-1"
                                    title="Delete user"
                                    onClick={(e) => {
                                      if (!confirm(`Are you sure you want to delete "${userItem.name}"? This action cannot be undone.`)) {
                                        e.preventDefault()
                                      }
                                    }}
                                  >
                                    <Icon name="trash" className="h-4 w-4" />
                                  </button>
                                </Form>
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
              }}
              errors={createFields.email.errors}
            />

            <Field
              labelProps={{ children: 'Username' }}
              inputProps={{
                ...getInputProps(createFields.username, { type: 'text' }),
                placeholder: 'jdoe',
              }}
              errors={createFields.username.errors}
            />

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
    </>
  )
}

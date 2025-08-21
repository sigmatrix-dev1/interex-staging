import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { data, useLoaderData, Link, Form, useSearchParams, useActionData } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Button } from '#app/components/ui/button.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { useState, useEffect } from 'react'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList, SelectField, CheckboxField } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'

const CreateUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  username: z.string().min(3, 'Username must be at least 3 characters'),
  name: z.string().min(1, 'Name is required').optional(),
  customerId: z.string().optional(),
  roleId: z.string().optional(),
  active: z.boolean().default(true),
})

function CreateUserForm({ 
  customers, 
  roles, 
  drawerState, 
  actionData, 
  closeDrawer 
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
            <input
              type="hidden"
              name="customerId"
              value={drawerState.preselectedCustomerId}
            />
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
            <option value="" disabled>Choose customer...</option>
            {customers.map((customer) => (
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
          <option value="" disabled>Choose role...</option>
          <option value="">🚫 No role assigned</option>
          {roles.map((role) => (
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
      orderBy: [
        { customer: { name: 'asc' } },
        { name: 'asc' },
      ],
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
        NOT: { name: 'system-admin' }
      },
      orderBy: { name: 'asc' },
    }),
  ])

  return data({ user, users, customers, roles })
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

  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: CreateUserSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { email, username, name, customerId, roleId, active } = submission.value

  // Prevent system admins from creating other system admins
  if (roleId) {
    const selectedRole = await prisma.role.findUnique({
      where: { id: roleId },
      select: { name: true }
    })
    
    if (selectedRole?.name === 'system-admin') {
      return data(
        { 
          result: submission.reply({
            fieldErrors: {
              roleId: ['System administrators cannot create other system administrators']
            }
          })
        },
        { status: 400 }
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
          }
        })
      },
      { status: 400 }
    )
  }

  await prisma.user.create({
    data: {
      email,
      username,
      name: name || null,
      active,
      customerId: customerId || null,
      roles: roleId ? {
        connect: { id: roleId },
      } : undefined,
    },
  })

  return redirectWithToast('/admin/users', {
    type: 'success',
    title: 'User created',
    description: `${name || username} has been created successfully.`,
  })
}

export default function AdminUsers() {
  const { user, users, customers, roles } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams, setSearchParams] = useSearchParams()
  
  // Get current customer filter from URL
  const filterCustomerId = searchParams.get('filter')
  const currentCustomer = filterCustomerId ? customers.find(c => c.id === filterCustomerId) : undefined
  
  // Filter users by current customer if selected
  const filteredUsers = filterCustomerId 
    ? users.filter(u => u.customer?.id === filterCustomerId)
    : users
  
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
        preselectedCustomerId: drawerCustomerId ? drawerCustomerId : undefined 
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

  return (
    <InterexLayout 
      user={user}
      title={currentCustomer ? `User Management - ${currentCustomer.name}` : "User Management"}
      subtitle={currentCustomer ? `Manage users for ${currentCustomer.name}` : "Manage users across all customers"}
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
          <select
            value={filterCustomerId || ''}
            onChange={(e) => {
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
            {customers.map((customer) => (
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
                      {filteredUsers.filter(u => u.customer).length}
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
                      {filteredUsers.filter(u => u.userNpis.length > 0).length}
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
            {filteredUsers.map((userItem) => (
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
                          {userItem.roles.map(role => (
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
                              <span>{userItem.userNpis.length} NPI{userItem.userNpis.length > 1 ? 's' : ''}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <p className="text-sm text-gray-500">
                        Joined {new Date(userItem.createdAt).toLocaleDateString()}
                      </p>
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
      <Drawer
        isOpen={drawerState.isOpen}
        onClose={closeDrawer}
        title="Add New User"
        size="md"
      >
        <CreateUserForm 
          key={`create-user-${drawerState.preselectedCustomerId || 'none'}`}
          customers={customers}
          roles={roles}
          drawerState={drawerState}
          actionData={actionData}
          closeDrawer={closeDrawer}
        />
      </Drawer>
    </InterexLayout>
  )
}

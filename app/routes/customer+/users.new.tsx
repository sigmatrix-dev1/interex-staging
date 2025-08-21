import { data, redirect, useLoaderData } from 'react-router'
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
import { useState } from 'react'

const CreateUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  username: z.string().min(3, 'Username must be at least 3 characters'),
  role: z.enum(['provider-group-admin', 'basic-user']),
  providerGroupId: z.string().optional(),
  npiIds: z.array(z.string()).optional().default([]),
})

export async function loader({ request }: LoaderFunctionArgs) {
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

  // Require customer admin role
  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const userRoles = user.roles.map(r => r.name)
  const isCustomerAdmin = userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
  const isProviderGroupAdmin = userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)

  // Get customer data with provider groups and providers
  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
    include: {
      providerGroups: {
        include: {
          _count: {
            select: { providers: true }
          }
        }
      },
      providers: {
        // Provider group admins can only see providers in their group
        where: isProviderGroupAdmin && !isCustomerAdmin 
          ? { providerGroupId: user.providerGroupId! }
          : {},
        include: {
          providerGroup: { select: { id: true, name: true } }
        },
        orderBy: [{ providerGroupId: 'asc' }, { npi: 'asc' }]
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  return data({ user, customer })
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: CreateUserSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { name, email, username, role, providerGroupId, npiIds } = submission.value

  // Check if email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email }
  })

  if (existingUser) {
    return data(
      { result: submission.reply({ fieldErrors: { email: ['Email already exists'] } }) },
      { status: 400 }
    )
  }

  // Check if username already exists
  const existingUsername = await prisma.user.findUnique({
    where: { username }
  })

  if (existingUsername) {
    return data(
      { result: submission.reply({ fieldErrors: { username: ['Username already exists'] } }) },
      { status: 400 }
    )
  }

  // Validate provider group exists and belongs to customer
  if (providerGroupId) {
    const providerGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId: user.customerId,
      }
    })

    if (!providerGroup) {
      return data(
        { result: submission.reply({ fieldErrors: { providerGroupId: ['Invalid provider group selected'] } }) },
        { status: 400 }
      )
    }
  }

  // Validate NPI assignments for basic users
  if (role === 'basic-user' && npiIds && npiIds.length > 0) {
    // Verify all NPIs exist and belong to the customer
    const validNpis = await prisma.provider.findMany({
      where: {
        id: { in: npiIds },
        customerId: user.customerId,
      },
      select: { id: true }
    })

    if (validNpis.length !== npiIds.length) {
      return data(
        { result: submission.reply({ fieldErrors: { npiIds: ['One or more selected NPIs are invalid'] } }) },
        { status: 400 }
      )
    }
  }

  // Generate temporary password
  const temporaryPassword = generateTemporaryPassword()

  // Create the user
  const newUser = await prisma.user.create({
    data: {
      name,
      email,
      username,
      customerId: user.customerId,
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
      roles: { select: { name: true } },
      providerGroup: { select: { name: true } }
    }
  })

  // Create NPI assignments for basic users
  if (role === 'basic-user' && npiIds && npiIds.length > 0) {
    await prisma.userNpi.createMany({
      data: npiIds.map(npiId => ({
        userId: newUser.id,
        providerId: npiId,
      }))
    })
  }

  // TODO: In production, send an email with the temporary password
  console.log(`New user created: ${email} with temporary password: ${temporaryPassword}`)

  return redirect('/customer/users')
}

export default function NewUserPage() {
  const { user, customer } = useLoaderData<typeof loader>()
  const isPending = useIsPending()

  // Debug logging
  console.log('Customer data:', { 
    customerName: customer.name,
    providerGroupsCount: customer.providerGroups.length,
    providersCount: customer.providers.length,
    providers: customer.providers.map(p => ({ 
      id: p.id, 
      npi: p.npi, 
      name: p.name,
      providerGroupId: p.providerGroupId,
      providerGroup: p.providerGroup 
    }))
  })

  // Track selected role and provider group for NPI filtering
  const [selectedRole, setSelectedRole] = useState<string>('')
  const [selectedProviderGroup, setSelectedProviderGroup] = useState<string>('')

  // Get available NPIs based on selected provider group
  const getAvailableNPIs = (providerGroupId: string) => {
    // Customer admin users can see all providers, others are already filtered in the loader
    let availableProviders = customer.providers
    
    // If a specific provider group is selected, filter further
    if (providerGroupId) {
      availableProviders = availableProviders.filter(provider => 
        provider.providerGroupId === providerGroupId
      )
    }
    
    return availableProviders
  }

  const [form, fields] = useForm({
    id: 'create-user-form',
    constraint: getZodConstraint(CreateUserSchema),
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateUserSchema })
    },
  })

  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-4">
              <Link to="/customer/users" className="text-gray-400 hover:text-gray-600">
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Add New User</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">Customer: {customer.name}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white shadow rounded-lg p-6">
          <form method="post" {...getFormProps(form)}>
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'Full Name' }}
                inputProps={{
                  ...getInputProps(fields.name, { type: 'text' }),
                  placeholder: 'John Doe',
                }}
                errors={fields.name.errors}
              />

              <Field
                labelProps={{ children: 'Email' }}
                inputProps={{
                  ...getInputProps(fields.email, { type: 'email' }),
                  placeholder: 'john@example.com',
                }}
                errors={fields.email.errors}
              />

              <Field
                labelProps={{ children: 'Username' }}
                inputProps={{
                  ...getInputProps(fields.username, { type: 'text' }),
                  placeholder: 'johndoe',
                }}
                errors={fields.username.errors}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Role
                </label>
                <select
                  {...getInputProps(fields.role, { type: 'text' })}
                  onChange={(e) => {
                    console.log('Role selected:', e.target.value)
                    setSelectedRole(e.target.value)
                  }}
                  className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                >
                  <option value="">Select a role</option>
                  <option value="provider-group-admin">Provider Group Admin</option>
                  <option value="basic-user">Basic User</option>
                </select>
                <ErrorList errors={fields.role.errors} />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Provider Group (Optional)
                </label>
                <select
                  {...getInputProps(fields.providerGroupId, { type: 'text' })}
                  onChange={(e) => setSelectedProviderGroup(e.target.value)}
                  className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                >
                  <option value="">Select a provider group</option>
                  {customer.providerGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group._count.providers} providers)
                    </option>
                  ))}
                </select>
                <ErrorList errors={fields.providerGroupId.errors} />
              </div>

              {/* NPI Selection for Basic Users */}
              {(() => {
                console.log('Checking NPI section render:', { selectedRole, isBasicUser: selectedRole === 'basic-user' })
                return selectedRole === 'basic-user'
              })() && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Assigned NPIs (Optional)
                  </label>
                  <div className="max-h-40 overflow-y-auto border border-gray-300 rounded-md p-2 space-y-2">
                    {getAvailableNPIs(selectedProviderGroup).length > 0 ? (
                      getAvailableNPIs(selectedProviderGroup).map((provider) => (
                        <label key={provider.id} className="flex items-center space-x-3">
                          <input
                            type="checkbox"
                            name="npiIds"
                            value={provider.id}
                            className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                          />
                          <span className="text-sm">
                            <span className="font-mono font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded">
                              {provider.npi || 'No NPI'}
                            </span>
                            {provider.name && (
                              <span className="text-gray-700 font-medium"> - {provider.name}</span>
                            )}
                            {provider.providerGroup && (
                              <span className="text-xs text-gray-500 ml-2">
                                ({provider.providerGroup.name})
                              </span>
                            )}
                          </span>
                        </label>
                      ))
                    ) : (
                      <p className="text-sm text-gray-500">
                        {customer.providers.length === 0 
                          ? 'No NPIs available for this customer'
                          : selectedProviderGroup 
                            ? 'No NPIs available in the selected provider group'
                            : 'All available NPIs are shown above'
                        }
                      </p>
                    )}
                  </div>
                  <ErrorList errors={fields.npiIds?.errors} />
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
                <Link
                  to="/customer/users"
                  className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </Link>
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
          </form>
        </div>

        <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex">
            <Icon name="question-mark-circled" className="h-5 w-5 text-blue-400" />
            <div className="ml-3">
              <p className="text-sm text-blue-700">
                <strong>Note:</strong> A temporary password will be generated for the new user. 
                In production, this password should be sent via email. The user will need to change 
                their password on first login.
              </p>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

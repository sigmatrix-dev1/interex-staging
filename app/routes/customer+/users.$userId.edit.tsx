import { data, useLoaderData, redirect } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { Button } from '#app/components/ui/button.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Link } from 'react-router'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { useState } from 'react'

const EditUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  username: z.string().min(3, 'Username must be at least 3 characters'),
  role: z.enum(['provider-group-admin', 'basic-user']),
  providerGroupId: z.string().optional().transform(val => val === '' ? undefined : val),
  npiIds: z.array(z.string()).optional().default([]),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const { userId: targetUserId } = params

  if (!targetUserId) {
    throw new Response('User ID is required', { status: 400 })
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      providerGroupId: true,
      roles: { select: { name: true } },
    },
  })

  if (!currentUser) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require customer admin role
  requireRoles(currentUser, [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN])

  if (!currentUser.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  // Get the target user to edit
  const targetUser = await prisma.user.findFirst({
    where: {
      id: targetUserId,
      customerId: currentUser.customerId,
      roles: {
        some: {
          name: {
            in: ['provider-group-admin', 'basic-user']
          }
        }
      }
    },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      providerGroupId: true,
      roles: { select: { name: true } },
      userNpis: {
        select: {
          providerId: true,
          provider: {
            select: {
              id: true,
              npi: true,
              name: true,
              providerGroup: { select: { id: true, name: true } }
            }
          }
        }
      }
    }
  })

  if (!targetUser) {
    throw new Response('User not found or not authorized to edit this user', { status: 404 })
  }

  const userRoles = currentUser.roles.map(r => r.name)
  const isCustomerAdmin = userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
  const isProviderGroupAdmin = userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)

  // Get customer data with provider groups and providers
  const customer = await prisma.customer.findUnique({
    where: { id: currentUser.customerId },
    include: {
      providerGroups: {
        select: {
          id: true,
          name: true,
          _count: {
            select: { providers: true }
          }
        }
      },
      providers: {
        // Provider group admins can only see providers in their group
        where: isProviderGroupAdmin && !isCustomerAdmin 
          ? { providerGroupId: currentUser.providerGroupId! }
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

  return data({ 
    currentUser, 
    targetUser, 
    customer 
  })
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const { userId: targetUserId } = params

  if (!targetUserId) {
    throw new Response('User ID is required', { status: 400 })
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      providerGroupId: true,
      roles: { select: { name: true } },
    },
  })

  if (!currentUser) {
    throw new Response('Unauthorized', { status: 401 })
  }

  requireRoles(currentUser, [INTEREX_ROLES.CUSTOMER_ADMIN, INTEREX_ROLES.PROVIDER_GROUP_ADMIN])

  if (!currentUser.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: EditUserSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { name, email, username, role, providerGroupId, npiIds } = submission.value

  // Verify the target user exists and belongs to the same customer
  const targetUser = await prisma.user.findFirst({
    where: {
      id: targetUserId,
      customerId: currentUser.customerId,
      roles: {
        some: {
          name: {
            in: ['provider-group-admin', 'basic-user']
          }
        }
      }
    },
    include: {
      roles: { select: { name: true } }
    }
  })

  if (!targetUser) {
    return data(
      { result: submission.reply({ formErrors: ['User not found or not authorized to edit this user'] }) },
      { status: 404 }
    )
  }

  // Validate NPI assignments for basic users
  if (role === 'basic-user' && npiIds && npiIds.length > 0) {
    // Verify all NPIs exist and belong to the customer
    const validNpis = await prisma.provider.findMany({
      where: {
        id: { in: npiIds },
        customerId: currentUser.customerId,
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

  // Check if email or username already exists (excluding current user)
  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email }, { username }],
      NOT: { id: targetUserId }
    }
  })

  if (existingUser) {
    const fieldErrors: Record<string, string[]> = {}
    if (existingUser.email === email) {
      fieldErrors.email = ['Email already exists']
    }
    if (existingUser.username === username) {
      fieldErrors.username = ['Username already exists']
    }
    
    return data(
      { 
        result: submission.reply({
          fieldErrors
        })
      },
      { status: 400 }
    )
  }

  // Validate provider group belongs to customer (if provided)
  if (providerGroupId) {
    const providerGroup = await prisma.providerGroup.findFirst({
      where: {
        id: providerGroupId,
        customerId: currentUser.customerId
      }
    })

    if (!providerGroup) {
      return data(
        { 
          result: submission.reply({
            fieldErrors: {
              providerGroupId: ['Invalid provider group']
            }
          })
        },
        { status: 400 }
      )
    }
  }

  // For basic users, provider group is required
  if (role === 'basic-user' && !providerGroupId) {
    return data(
      { 
        result: submission.reply({
          fieldErrors: {
            providerGroupId: ['Provider group is required for basic users']
          }
        })
      },
      { status: 400 }
    )
  }

  // Update the user
  const updateData: any = {
    name,
    email,
    username,
    providerGroupId: (role === 'basic-user' || role === 'provider-group-admin') 
      ? (providerGroupId || null) 
      : null,
  }

  // Handle role updates
  const currentRoleName = targetUser.roles[0]?.name
  if (currentRoleName && currentRoleName !== role) {
    updateData.roles = {
      disconnect: { name: currentRoleName },
      connect: { name: role }
    }
  } else if (!currentRoleName) {
    updateData.roles = {
      connect: { name: role }
    }
  }

  await prisma.user.update({
    where: { id: targetUserId },
    data: updateData
  })

  // Handle NPI assignments for basic users
  if (role === 'basic-user') {
    // First, remove all existing NPI assignments
    await prisma.userNpi.deleteMany({
      where: { userId: targetUserId }
    })

    // Then, add new NPI assignments if any
    if (npiIds && npiIds.length > 0) {
      await prisma.userNpi.createMany({
        data: npiIds.map(npiId => ({
          userId: targetUserId,
          providerId: npiId,
        }))
      })
    }
  } else {
    // If user is not a basic user, remove all NPI assignments
    await prisma.userNpi.deleteMany({
      where: { userId: targetUserId }
    })
  }

  return redirect('/customer/users')
}

export default function EditUserPage() {
  const { currentUser, targetUser, customer } = useLoaderData<typeof loader>()
  const isPending = useIsPending()

  // Debug logging
  console.log('Edit User Debug:', {
    targetUser: {
      id: targetUser.id,
      name: targetUser.name,
      role: targetUser.roles[0]?.name,
      providerGroupId: targetUser.providerGroupId,
      currentNpis: targetUser.userNpis.length,
      npiDetails: targetUser.userNpis.map(n => ({ providerId: n.providerId, npi: n.provider.npi }))
    },
    customer: {
      providersCount: customer.providers.length,
      providerGroupsCount: customer.providerGroups.length
    }
  })

  // Track selected role and provider group for NPI filtering
  const [selectedRole, setSelectedRole] = useState<string>(
    (targetUser.roles[0]?.name === 'provider-group-admin' || targetUser.roles[0]?.name === 'basic-user') 
      ? targetUser.roles[0].name 
      : 'basic-user'
  )
  const [selectedProviderGroup, setSelectedProviderGroup] = useState<string>(targetUser.providerGroupId || '')

  // Get available NPIs based on selected provider group
  const getAvailableNPIs = (providerGroupId: string) => {
    let availableProviders = customer.providers
    
    // If a specific provider group is selected, filter further
    if (providerGroupId) {
      availableProviders = availableProviders.filter(provider => 
        provider.providerGroupId === providerGroupId
      )
    }
    
    return availableProviders
  }

  // Get assigned NPIs filtered by provider group
  const getAssignedNPIs = (providerGroupId: string) => {
    let assignedNpis = targetUser.userNpis
    
    // If a specific provider group is selected, filter assigned NPIs to that group
    if (providerGroupId) {
      assignedNpis = assignedNpis.filter(userNpi => 
        userNpi.provider.providerGroup?.id === providerGroupId
      )
    }
    
    return assignedNpis
  }

  // Get currently assigned NPI IDs
  const currentNpiIds = targetUser.userNpis.map(userNpi => userNpi.providerId)

  const [form, fields] = useForm({
    id: 'edit-user-form',
    constraint: getZodConstraint(EditUserSchema),
    defaultValue: {
      name: targetUser.name || '',
      email: targetUser.email || '',
      username: targetUser.username || '',
      role: (targetUser.roles[0]?.name === 'provider-group-admin' || targetUser.roles[0]?.name === 'basic-user') 
        ? targetUser.roles[0].name as 'provider-group-admin' | 'basic-user'
        : 'basic-user',
      providerGroupId: targetUser.providerGroupId || '',
      npiIds: currentNpiIds,
    },
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: EditUserSchema })
    },
  })

  const showProviderGroupField = selectedRole === 'provider-group-admin' || selectedRole === 'basic-user'

  return (
    <InterexLayout user={currentUser}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-4">
              <Link 
                to="/customer/users" 
                className="text-gray-500 hover:text-gray-700"
              >
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Edit User</h1>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="bg-white shadow rounded-lg p-6">
          <form method="post" {...getFormProps(form)} key={targetUser.id}>
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'Full Name' }}
                inputProps={{
                  ...getInputProps(fields.name, { type: 'text' }),
                  placeholder: 'Enter full name',
                }}
                errors={fields.name.errors}
              />

              <Field
                labelProps={{ children: 'Email Address' }}
                inputProps={{
                  ...getInputProps(fields.email, { type: 'email' }),
                  placeholder: 'Enter email address',
                }}
                errors={fields.email.errors}
              />

              <Field
                labelProps={{ children: 'Username' }}
                inputProps={{
                  ...getInputProps(fields.username, { type: 'text' }),
                  placeholder: 'Enter username',
                }}
                errors={fields.username.errors}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Role
                </label>
                <select
                  {...getInputProps(fields.role, { type: 'text' })}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="provider-group-admin">Provider Group Admin</option>
                  <option value="basic-user">Basic User</option>
                </select>
                <ErrorList errors={fields.role.errors} />
              </div>

              {showProviderGroupField && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Provider Group {selectedRole === 'basic-user' ? '(Required)' : ''}
                  </label>
                  <select
                    {...getInputProps(fields.providerGroupId, { type: 'text' })}
                    onChange={(e) => setSelectedProviderGroup(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    required={selectedRole === 'basic-user'}
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
              )}

              {/* NPI Section for Basic Users */}
              {(selectedRole === 'basic-user' || targetUser.roles[0]?.name === 'basic-user') && (
                <div className="space-y-4">
                  <div className="border-t border-gray-200 pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-medium text-gray-900">NPI Assignments</h3>
                      <div className="text-sm text-gray-500">
                        {selectedProviderGroup ? (
                          <>
                            {getAssignedNPIs(selectedProviderGroup).length} assigned in {customer.providerGroups.find(g => g.id === selectedProviderGroup)?.name}
                            <span className="ml-2 text-xs">({targetUser.userNpis.length} total)</span>
                          </>
                        ) : (
                          `${targetUser.userNpis.length} currently assigned`
                        )}
                      </div>
                    </div>
                    
                    {/* Current Assignments Display - Always show for Basic Users if they have assignments */}
                    {targetUser.roles[0]?.name === 'basic-user' && targetUser.userNpis.length > 0 && (
                      <div className="mb-6">
                        <h4 className="text-md font-medium text-gray-700 mb-2">
                          {selectedProviderGroup ? (
                            <>Currently Assigned NPIs in {customer.providerGroups.find(g => g.id === selectedProviderGroup)?.name}:</>
                          ) : (
                            'Currently Assigned NPIs:'
                          )}
                        </h4>
                        <div className="space-y-2">
                          {/* Show assigned NPIs - all if no provider group selected, filtered if one is selected */}
                          {(selectedProviderGroup ? getAssignedNPIs(selectedProviderGroup) : targetUser.userNpis).map((userNpi) => (
                            <div key={userNpi.providerId} className="flex items-center space-x-3 p-3 bg-green-50 border border-green-200 rounded-md">
                              <div className="flex items-center">
                                <Icon name="check" className="h-4 w-4 text-green-600 mr-2" />
                              </div>
                              <div className="flex-1">
                                <span className="font-mono font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded">
                                  {userNpi.provider.npi}
                                </span>
                                {userNpi.provider.name && (
                                  <span className="text-gray-700 font-medium ml-2">- {userNpi.provider.name}</span>
                                )}
                                {userNpi.provider.providerGroup && (
                                  <span className="text-xs text-gray-500 ml-2">
                                    ({userNpi.provider.providerGroup.name})
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        
                        {/* Show message if user has NPIs but none in selected provider group */}
                        {selectedProviderGroup && getAssignedNPIs(selectedProviderGroup).length === 0 && targetUser.userNpis.length > 0 && (
                          <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-md">
                            <p className="text-sm text-blue-700">
                              This user has {targetUser.userNpis.length} assigned NPI(s), but none in the selected provider group "{customer.providerGroups.find(g => g.id === selectedProviderGroup)?.name}".
                              <br />
                              <span className="text-xs">Clear the provider group filter to see all assigned NPIs.</span>
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Show NPI selection only when role is Basic User */}
                    {selectedRole === 'basic-user' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {targetUser.userNpis.length > 0 ? 'Modify NPI Assignments' : 'Select NPIs to Assign'}
                        </label>
                        <div className="max-h-60 overflow-y-auto border border-gray-300 rounded-md p-3 space-y-3">
                          {getAvailableNPIs(selectedProviderGroup).length > 0 ? (
                            getAvailableNPIs(selectedProviderGroup).map((provider) => (
                              <label key={provider.id} className="flex items-center space-x-3 hover:bg-gray-50 p-2 rounded-md">
                                <input
                                  type="checkbox"
                                  name="npiIds"
                                  value={provider.id}
                                  defaultChecked={currentNpiIds.includes(provider.id)}
                                  className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                                />
                                <span className="text-sm flex-1">
                                  <span className="font-mono font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded">
                                    {provider.npi || 'No NPI'}
                                  </span>
                                  {provider.name && (
                                    <span className="text-gray-700 font-medium ml-2"> - {provider.name}</span>
                                  )}
                                  {provider.providerGroup && (
                                    <span className="text-xs text-gray-500 ml-2">
                                      ({provider.providerGroup.name})
                                    </span>
                                  )}
                                  {currentNpiIds.includes(provider.id) && (
                                    <span className="inline-flex items-center ml-2 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                      Currently Assigned
                                    </span>
                                  )}
                                </span>
                              </label>
                            ))
                          ) : (
                            <p className="text-sm text-gray-500 text-center py-4">
                              {customer.providers.length === 0 
                                ? 'No NPIs available for this customer'
                                : selectedProviderGroup 
                                  ? 'No NPIs available in the selected provider group'
                                  : 'Select a provider group to filter NPIs, or view all available NPIs'
                              }
                            </p>
                          )}
                        </div>
                        <ErrorList errors={fields.npiIds?.errors} />
                        <p className="mt-2 text-sm text-gray-500">
                          💡 Tip: Use the Provider Group dropdown above to filter NPIs by group. Check/uncheck boxes to modify assignments.
                        </p>
                      </div>
                    )}

                    {/* Message when user is not Basic User but has NPIs */}
                    {selectedRole !== 'basic-user' && targetUser.userNpis.length > 0 && (
                      <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                        <div className="flex">
                          <Icon name="question-mark-circled" className="h-5 w-5 text-yellow-400" />
                          <div className="ml-3">
                            <p className="text-sm text-yellow-700">
                              <strong>Note:</strong> Changing this user's role from "Basic User" will remove all NPI assignments.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <ErrorList errors={form.errors} />

              <div className="flex justify-end space-x-3">
                <Link
                  to="/customer/users"
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </Link>
                <StatusButton
                  type="submit"
                  status={isPending ? 'pending' : 'idle'}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Update User
                </StatusButton>
              </div>
            </div>
          </form>
        </div>
      </div>
    </InterexLayout>
  )
}

import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { data, useLoaderData, Form, Link, redirect } from 'react-router'
import { z } from 'zod'
import { parseWithZod, getZodConstraint } from '@conform-to/zod'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'

const UpdateProviderGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  description: z.string().max(500, 'Description must be less than 500 characters').optional(),
  active: z.boolean().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      customerId: true,
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

  const providerGroupId = params.providerGroupId
  if (!providerGroupId) {
    throw new Response('Provider group ID is required', { status: 400 })
  }

  // Get provider group data
  const providerGroup = await prisma.providerGroup.findFirst({
    where: {
      id: providerGroupId,
      customerId: user.customerId,
    },
    include: {
      customer: { select: { name: true } },
      users: {
        include: {
          roles: { select: { name: true } }
        }
      },
      providers: true,
      _count: {
        select: { users: true, providers: true }
      }
    }
  })

  if (!providerGroup) {
    throw new Response('Provider group not found', { status: 404 })
  }

  return data({ user, providerGroup })
}

export async function action({ request, params }: ActionFunctionArgs) {
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

  const providerGroupId = params.providerGroupId
  if (!providerGroupId) {
    throw new Response('Provider group ID is required', { status: 400 })
  }

  // Verify the provider group belongs to the customer
  const existingProviderGroup = await prisma.providerGroup.findFirst({
    where: {
      id: providerGroupId,
      customerId: user.customerId,
    }
  })

  if (!existingProviderGroup) {
    throw new Response('Provider group not found or not authorized to edit this provider group', { status: 404 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: UpdateProviderGroupSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { name, description, active } = submission.value

  // Check if the new name conflicts with another provider group (excluding current one)
  if (name !== existingProviderGroup.name) {
    const nameConflict = await prisma.providerGroup.findFirst({
      where: {
        name,
        customerId: user.customerId,
        id: { not: providerGroupId }
      }
    })

    if (nameConflict) {
      return data(
        { 
          result: submission.reply({
            fieldErrors: {
              name: ['Provider group name already exists']
            }
          })
        },
        { status: 400 }
      )
    }
  }

  // Update the provider group
  await prisma.providerGroup.update({
    where: { id: providerGroupId },
    data: {
      name,
      description: description || '',
      active: active ?? true,
    },
  })

  return redirect('/customer/provider-groups')
}

export default function EditProviderGroupPage() {
  const { user, providerGroup } = useLoaderData<typeof loader>()
  const isPending = useIsPending()

  const [form, fields] = useForm({
    id: 'edit-provider-group-form',
    constraint: getZodConstraint(UpdateProviderGroupSchema),
    defaultValue: {
      name: providerGroup.name,
      description: providerGroup.description,
      active: providerGroup.active,
    },
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpdateProviderGroupSchema })
    },
  })

  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <Link to="/customer/provider-groups" className="text-gray-500 hover:text-gray-700 mr-4">
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Edit Provider Group</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">Customer: {providerGroup.customer.name}</span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                Customer Admin
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="space-y-6">
          {/* Edit Form */}
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-6">
              Provider Group Details
            </h2>
            
            <Form method="post" {...getFormProps(form)}>
              <div className="space-y-6">
                {/* Read-only Customer field */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Customer
                  </label>
                  <div className="mt-1 text-sm text-gray-900 font-medium bg-gray-50 px-3 py-2 border border-gray-300 rounded-md">
                    {providerGroup.customer.name}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Note: You will not be able to change the Customer associated with this Provider Group.
                  </p>
                </div>

                <Field
                  labelProps={{
                    htmlFor: fields.name.id,
                    children: 'Provider Group Name *'
                  }}
                  inputProps={{
                    ...getInputProps(fields.name, { type: 'text' }),
                    placeholder: 'e.g., Cardiology Group, Primary Care North'
                  }}
                  errors={fields.name.errors}
                />

                <Field
                  labelProps={{
                    htmlFor: fields.description.id,
                    children: 'Description'
                  }}
                  inputProps={{
                    ...getInputProps(fields.description, { type: 'text' }),
                    placeholder: 'Optional description of the provider group'
                  }}
                  errors={fields.description.errors}
                />

                <div className="flex items-center">
                  <input
                    {...getInputProps(fields.active, { type: 'checkbox' })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor={fields.active.id} className="ml-2 block text-sm text-gray-900">
                    Active
                  </label>
                </div>
              </div>

              <div className="mt-6 flex justify-between">
                <Link
                  to="/customer/provider-groups"
                  className="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </Link>
                <StatusButton
                  type="submit"
                  status={isPending ? 'pending' : 'idle'}
                  className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Update Provider Group
                </StatusButton>
              </div>
            </Form>
          </div>

          {/* Provider Group Information */}
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Provider Group Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center">
                  <Icon name="avatar" className="h-8 w-8 text-blue-600 mr-3" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">Assigned Users</p>
                    <p className="text-2xl font-bold text-blue-600">{providerGroup._count.users}</p>
                  </div>
                </div>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center">
                  <Icon name="id-card" className="h-8 w-8 text-green-600 mr-3" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">NPIs/Providers</p>
                    <p className="text-2xl font-bold text-green-600">{providerGroup._count.providers}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Assigned Users */}
          {providerGroup.users.length > 0 && (
            <div className="bg-white shadow rounded-lg p-6">
              <h2 className="text-lg font-medium text-gray-900 mb-4">Assigned Users</h2>
              <div className="space-y-3">
                {providerGroup.users.map((user) => (
                  <div key={user.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{user.name}</p>
                      <p className="text-sm text-gray-500">{user.email}</p>
                    </div>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {user.roles[0]?.name.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Assigned Providers */}
          {providerGroup.providers.length > 0 && (
            <div className="bg-white shadow rounded-lg p-6">
              <h2 className="text-lg font-medium text-gray-900 mb-4">Assigned Providers</h2>
              <div className="space-y-3">
                {providerGroup.providers.map((provider) => (
                  <div key={provider.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{provider.name}</p>
                      <p className="text-sm text-gray-500">NPI: {provider.npi}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </InterexLayout>
  )
}

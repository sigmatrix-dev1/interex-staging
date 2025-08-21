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

const EditProviderSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  providerGroupId: z.string().optional().transform(val => val === '' ? undefined : val),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const { providerId } = params

  if (!providerId) {
    throw new Response('Provider ID is required', { status: 400 })
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!currentUser) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require customer admin role
  requireRoles(currentUser, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!currentUser.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  // Get the target provider to edit
  const targetProvider = await prisma.provider.findFirst({
    where: {
      id: providerId,
      customerId: currentUser.customerId,
    },
    select: {
      id: true,
      npi: true,
      name: true,
      providerGroupId: true,
      providerGroup: { select: { id: true, name: true } },
      userNpis: {
        include: {
          user: { select: { id: true, name: true, email: true } }
        }
      }
    }
  })

  if (!targetProvider) {
    throw new Response('Provider not found or not authorized to edit this provider', { status: 404 })
  }

  // Get customer data with provider groups
  const customer = await prisma.customer.findUnique({
    where: { id: currentUser.customerId },
    include: {
      providerGroups: {
        select: {
          id: true,
          name: true,
        }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  return data({ 
    currentUser, 
    targetProvider, 
    customer 
  })
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const { providerId } = params

  if (!providerId) {
    throw new Response('Provider ID is required', { status: 400 })
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!currentUser) {
    throw new Response('Unauthorized', { status: 401 })
  }

  requireRoles(currentUser, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!currentUser.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: EditProviderSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { name, providerGroupId } = submission.value

  // Verify the target provider exists and belongs to the same customer
  const targetProvider = await prisma.provider.findFirst({
    where: {
      id: providerId,
      customerId: currentUser.customerId,
    }
  })

  if (!targetProvider) {
    return data(
      { result: submission.reply({ formErrors: ['Provider not found or not authorized to edit this provider'] }) },
      { status: 404 }
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

  // Update the provider
  await prisma.provider.update({
    where: { id: providerId },
    data: {
      name,
      providerGroupId: providerGroupId || null,
    }
  })

  return redirect('/customer/provider-npis')
}

export default function EditProviderPage() {
  const { currentUser, targetProvider, customer } = useLoaderData<typeof loader>()
  const isPending = useIsPending()

  const [form, fields] = useForm({
    id: 'edit-provider-form',
    constraint: getZodConstraint(EditProviderSchema),
    defaultValue: {
      name: targetProvider.name || '',
      providerGroupId: targetProvider.providerGroupId || '',
    },
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: EditProviderSchema })
    },
  })

  return (
    <InterexLayout user={currentUser}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-4">
              <Link 
                to="/customer/provider-npis" 
                className="text-gray-500 hover:text-gray-700"
              >
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Edit Provider NPI</h1>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="bg-white shadow rounded-lg p-6">
          {/* Provider Info (Read-only) */}
          <div className="mb-8 p-4 bg-gray-50 rounded-lg">
            <h3 className="text-lg font-medium text-gray-900 mb-3">Provider Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">NPI Number</label>
                <div className="mt-1 text-sm text-gray-900 font-mono bg-white px-3 py-2 border border-gray-300 rounded-md">
                  {targetProvider.npi}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  NPI number cannot be edited. If incorrect, delete this provider and create a new one.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Current Assignments</label>
                <div className="mt-1 text-sm text-gray-900">
                  {targetProvider.userNpis.length} user{targetProvider.userNpis.length !== 1 ? 's' : ''} assigned
                </div>
                {targetProvider.userNpis.length > 0 && (
                  <div className="mt-1 text-xs text-gray-500">
                    {targetProvider.userNpis.map(un => un.user.name).join(', ')}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Editable Fields */}
          <form method="post" {...getFormProps(form)}>
            <div className="space-y-6">
              <Field
                labelProps={{ children: 'Provider Name' }}
                inputProps={{
                  ...getInputProps(fields.name, { type: 'text' }),
                  placeholder: 'Enter provider name',
                }}
                errors={fields.name.errors}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Owned Provider Group
                </label>
                <select
                  {...getInputProps(fields.providerGroupId, { type: 'text' })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="">No provider group (unassigned)</option>
                  {customer.providerGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <ErrorList errors={fields.providerGroupId.errors} />
                <p className="mt-1 text-sm text-gray-500">
                  Select the provider group that owns this NPI, or leave unassigned.
                </p>
              </div>

              <ErrorList errors={form.errors} />

              <div className="flex justify-end space-x-3">
                <Link
                  to="/customer/provider-npis"
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </Link>
                <StatusButton
                  type="submit"
                  status={isPending ? 'pending' : 'idle'}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Save Changes
                </StatusButton>
              </div>
            </div>
          </form>
        </div>

        {/* Warning about NPI editing limitations */}
        <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex">
            <Icon name="question-mark-circled" className="h-5 w-5 text-yellow-400 mr-3 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-yellow-800">
                Important Note About NPI Editing
              </h3>
              <div className="mt-2 text-sm text-yellow-700">
                <p>
                  If an incorrect NPI number has been added to the system, this NPI will need to be 
                  completely deleted and recreated, as the NPI number and customer fields are unable to be edited.
                </p>
                <p className="mt-2">
                  Only the provider name and owned provider group can be updated through this form.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

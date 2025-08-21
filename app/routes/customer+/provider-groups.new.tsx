import { data, redirect, useLoaderData } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { Icon } from '#app/components/ui/icon.tsx'
import { Link } from 'react-router'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'

const CreateProviderGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  description: z.string().max(500, 'Description must be less than 500 characters').optional(),
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

  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
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
  const submission = parseWithZod(formData, { schema: CreateProviderGroupSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { name, description } = submission.value

  // Check if provider group name already exists for this customer
  const existingProviderGroup = await prisma.providerGroup.findFirst({
    where: {
      name,
      customerId: user.customerId,
    }
  })

  if (existingProviderGroup) {
    return data(
      { result: submission.reply({ fieldErrors: { name: ['Provider group name already exists'] } }) },
      { status: 400 }
    )
  }

  // Create the provider group
  await prisma.providerGroup.create({
    data: {
      name,
      description: description || '',
      customerId: user.customerId,
    }
  })

  return redirect('/customer/provider-groups')
}

export default function NewProviderGroupPage() {
  const { user, customer } = useLoaderData<typeof loader>()
  const isPending = useIsPending()

  const [form, fields] = useForm({
    id: 'create-provider-group-form',
    constraint: getZodConstraint(CreateProviderGroupSchema),
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateProviderGroupSchema })
    },
  })

  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-4">
              <Link to="/customer/provider-groups" className="text-gray-400 hover:text-gray-600">
                <Icon name="arrow-left" className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Add New Provider Group</h1>
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
                labelProps={{ children: 'Provider Group Name' }}
                inputProps={{
                  ...getInputProps(fields.name, { type: 'text' }),
                  placeholder: 'e.g., Cardiology Group, Primary Care North',
                }}
                errors={fields.name.errors}
              />

              <Field
                labelProps={{ children: 'Description (Optional)' }}
                inputProps={{
                  ...getInputProps(fields.description, { type: 'text' }),
                  placeholder: 'Optional description of the provider group',
                }}
                errors={fields.description.errors}
              />

              <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
                <Link
                  to="/customer/provider-groups"
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
                  Create Provider Group
                </StatusButton>
              </div>
            </div>
          </form>
        </div>
      </div>
    </InterexLayout>
  )
}

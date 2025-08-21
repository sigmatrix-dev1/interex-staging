import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { data, redirect, useLoaderData, Form } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Button } from '#app/components/ui/button.tsx'

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

  // Get customerId from URL params
  const url = new URL(request.url)
  const preselectedCustomerId = url.searchParams.get('customerId')

  // Get customers and provider groups for dropdowns
  const [customers, providerGroups] = await Promise.all([
    prisma.customer.findMany({
      select: { id: true, name: true },
      where: { active: true },
      orderBy: { name: 'asc' },
    }),
    prisma.providerGroup.findMany({
      select: { 
        id: true, 
        name: true,
        customer: { select: { name: true } }
      },
      where: { active: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return data({ user, customers, providerGroups, preselectedCustomerId })
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
  const npi = formData.get('npi')?.toString()
  const name = formData.get('name')?.toString()
  const customerId = formData.get('customerId')?.toString()
  const providerGroupId = formData.get('providerGroupId')?.toString()
  const active = formData.get('active') === 'on'

  if (!npi || !customerId) {
    return data({ error: 'NPI and Customer are required' }, { status: 400 })
  }

  // Validate NPI format (should be 10 digits)
  if (!/^\d{10}$/.test(npi)) {
    return data({ error: 'NPI must be exactly 10 digits' }, { status: 400 })
  }

  // Check if NPI already exists
  const existingProvider = await prisma.provider.findUnique({
    where: { npi },
  })

  if (existingProvider) {
    return data({ error: 'Provider with this NPI already exists' }, { status: 400 })
  }

  await prisma.provider.create({
    data: {
      npi,
      name: name || null,
      active,
      customerId,
      providerGroupId: providerGroupId || null,
    },
  })

  return redirect('/admin/providers')
}

export default function NewProvider() {
  const { user, customers, providerGroups, preselectedCustomerId } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="Add New Provider"
      subtitle="Create a new provider (NPI)"
      currentPath="/admin/providers/new"
      actions={
        <div className="flex space-x-2">
          <Button asChild variant="outline">
            <a href="/admin/providers">
              <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
              Back to Providers
            </a>
          </Button>
        </div>
      }
    >
      <div className="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="bg-white shadow sm:rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <Form method="post">
              <div className="space-y-6">
                <div>
                  <label htmlFor="npi" className="block text-sm font-medium text-gray-700">
                    NPI (National Provider Identifier)
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      name="npi"
                      id="npi"
                      required
                      pattern="\d{10}"
                      maxLength={10}
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="1234567890"
                    />
                  </div>
                  <p className="mt-2 text-sm text-gray-500">
                    Must be exactly 10 digits
                  </p>
                </div>

                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    Provider Name (Optional)
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      name="name"
                      id="name"
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="Dr. John Smith"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="customerId" className="block text-sm font-medium text-gray-700">
                    Customer
                  </label>
                  <div className="mt-1">
                    <select
                      name="customerId"
                      id="customerId"
                      required
                      defaultValue={preselectedCustomerId || ''}
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                    >
                      <option value="">Select a customer</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="providerGroupId" className="block text-sm font-medium text-gray-700">
                    Provider Group (Optional)
                  </label>
                  <div className="mt-1">
                    <select
                      name="providerGroupId"
                      id="providerGroupId"
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                    >
                      <option value="">No provider group</option>
                      {providerGroups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} ({group.customer.name})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex items-center">
                  <input
                    id="active"
                    name="active"
                    type="checkbox"
                    defaultChecked={true}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="active" className="ml-2 block text-sm text-gray-900">
                    Active
                  </label>
                </div>

                <div className="flex justify-end space-x-3">
                  <Button type="button" variant="outline" asChild>
                    <a href="/admin/providers">Cancel</a>
                  </Button>
                  <Button type="submit">
                    <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                    Create Provider
                  </Button>
                </div>
              </div>
            </Form>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

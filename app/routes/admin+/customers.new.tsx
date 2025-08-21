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

  return data({ user })
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
  const name = formData.get('name')?.toString()
  const description = formData.get('description')?.toString()
  const active = formData.get('active') === 'on'

  if (!name) {
    return data({ error: 'Customer name is required' }, { status: 400 })
  }

  await prisma.customer.create({
    data: {
      name,
      description: description || undefined,
      active,
    },
  })

  return redirect('/admin/customers')
}

export default function NewCustomer() {
  const { user } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="Add New Customer"
      subtitle="Create a new customer organization"
      currentPath="/admin/customers/new"
      actions={
        <div className="flex space-x-2">
          <Button asChild variant="outline">
            <a href="/admin/customers">
              <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
              Back to Customers
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
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    Customer Name
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      name="name"
                      id="name"
                      required
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="Enter customer name"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="description" className="block text-sm font-medium text-gray-700">
                    Description (Optional)
                  </label>
                  <div className="mt-1">
                    <textarea
                      name="description"
                      id="description"
                      rows={3}
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="Enter customer description"
                    />
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
                    <a href="/admin/customers">Cancel</a>
                  </Button>
                  <Button type="submit">
                    <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                    Create Customer
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

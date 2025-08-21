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

  // If customerId is provided, redirect to the drawer view
  if (preselectedCustomerId) {
    return redirect(`/admin/users?action=add&customerId=${preselectedCustomerId}`)
  }

  // Get customers and roles for dropdowns
  const [customers, roles] = await Promise.all([
    prisma.customer.findMany({
      select: { id: true, name: true },
      where: { active: true },
      orderBy: { name: 'asc' },
    }),
    prisma.role.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return data({ user, customers, roles, preselectedCustomerId })
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
  const email = formData.get('email')?.toString()
  const username = formData.get('username')?.toString()
  const name = formData.get('name')?.toString()
  const customerId = formData.get('customerId')?.toString()
  const roleId = formData.get('roleId')?.toString()
  const active = formData.get('active') === 'on'

  if (!email || !username) {
    return data({ error: 'Email and username are required' }, { status: 400 })
  }

  // Check if email or username already exists
  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email }, { username }],
    },
  })

  if (existingUser) {
    return data({ error: 'User with this email or username already exists' }, { status: 400 })
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

  return redirect('/admin/users')
}

export default function NewUser() {
  const { user, customers, roles, preselectedCustomerId } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="Add New User"
      subtitle="Create a new user account"
      currentPath="/admin/users/new"
      actions={
        <div className="flex space-x-2">
          <Button asChild variant="outline">
            <a href="/admin/users">
              <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
              Back to Users
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
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                    Email Address
                  </label>
                  <div className="mt-1">
                    <input
                      type="email"
                      name="email"
                      id="email"
                      required
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="user@example.com"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="username" className="block text-sm font-medium text-gray-700">
                    Username
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      name="username"
                      id="username"
                      required
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="username"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    Full Name (Optional)
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      name="name"
                      id="name"
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                      placeholder="John Doe"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="customerId" className="block text-sm font-medium text-gray-700">
                    Customer (Optional)
                  </label>
                  <div className="mt-1">
                    <select
                      name="customerId"
                      id="customerId"
                      defaultValue={preselectedCustomerId || ''}
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                    >
                      <option value="">No customer assigned</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="roleId" className="block text-sm font-medium text-gray-700">
                    Role
                  </label>
                  <div className="mt-1">
                    <select
                      name="roleId"
                      id="roleId"
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                    >
                      <option value="">Select a role</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
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
                    <a href="/admin/users">Cancel</a>
                  </Button>
                  <Button type="submit">
                    <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                    Create User
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

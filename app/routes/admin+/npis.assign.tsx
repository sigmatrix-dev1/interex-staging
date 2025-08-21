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

  // Get users and providers for dropdowns
  const [users, providers] = await Promise.all([
    prisma.user.findMany({
      select: { 
        id: true, 
        name: true, 
        username: true,
        email: true,
        customer: { select: { name: true } }
      },
      where: { active: true },
      orderBy: { name: 'asc' },
    }),
    prisma.provider.findMany({
      select: { 
        id: true, 
        npi: true, 
        name: true,
        customer: { select: { name: true } }
      },
      where: { active: true },
      orderBy: { npi: 'asc' },
    }),
  ])

  return data({ user, users, providers })
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
  const targetUserId = formData.get('userId')?.toString()
  const providerId = formData.get('providerId')?.toString()

  if (!targetUserId || !providerId) {
    return data({ error: 'User and Provider are required' }, { status: 400 })
  }

  // Check if assignment already exists
  const existingAssignment = await prisma.userNpi.findUnique({
    where: {
      userId_providerId: {
        userId: targetUserId,
        providerId,
      },
    },
  })

  if (existingAssignment) {
    return data({ error: 'This user is already assigned to this NPI' }, { status: 400 })
  }

  await prisma.userNpi.create({
    data: {
      userId: targetUserId,
      providerId,
    },
  })

  return redirect('/admin/npis')
}

export default function AssignNpi() {
  const { user, users, providers } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="Assign NPI to User"
      subtitle="Create a new NPI assignment"
      currentPath="/admin/npis/assign"
      actions={
        <div className="flex space-x-2">
          <Button asChild variant="outline">
            <a href="/admin/npis">
              <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
              Back to NPIs
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
                  <label htmlFor="userId" className="block text-sm font-medium text-gray-700">
                    User
                  </label>
                  <div className="mt-1">
                    <select
                      name="userId"
                      id="userId"
                      required
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                    >
                      <option value="">Select a user</option>
                      {users.map((userOption) => (
                        <option key={userOption.id} value={userOption.id}>
                          {userOption.name || userOption.username} ({userOption.email})
                          {userOption.customer && ` - ${userOption.customer.name}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="providerId" className="block text-sm font-medium text-gray-700">
                    Provider (NPI)
                  </label>
                  <div className="mt-1">
                    <select
                      name="providerId"
                      id="providerId"
                      required
                      className="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md"
                    >
                      <option value="">Select a provider</option>
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          NPI: {provider.npi}
                          {provider.name && ` - ${provider.name}`}
                          {` (${provider.customer.name})`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <Icon name="id-card" className="h-5 w-5 text-blue-400" />
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-blue-800">
                        About NPI Assignments
                      </h3>
                      <div className="mt-2 text-sm text-blue-700">
                        <p>
                          Assigning an NPI to a user gives them access to manage submissions and data 
                          for that specific provider. Users can be assigned multiple NPIs.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <Button type="button" variant="outline" asChild>
                    <a href="/admin/npis">Cancel</a>
                  </Button>
                  <Button type="submit">
                    <Icon name="plus" className="-ml-1 mr-2 h-4 w-4" />
                    Assign NPI
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

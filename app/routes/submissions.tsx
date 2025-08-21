import { redirect, type LoaderFunctionArgs } from 'react-router'
import { data, useLoaderData } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      roles: { select: { name: true } },
      userNpis: {
        select: {
          provider: {
            select: {
              id: true,
              npi: true,
              name: true,
            }
          }
        }
      }
    }
  })

  if (!user) {
    throw redirect('/login')
  }

  // Require basic user role
  requireRoles(user, [INTEREX_ROLES.BASIC_USER])

  return data({ user })
}

export default function SubmissionsRoute() {
  const { user } = useLoaderData<typeof loader>()
  
  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-gray-900">Interex Submissions</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">Welcome, {user.name}</span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                Basic User
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* User NPIs */}
        <div className="bg-white overflow-hidden shadow rounded-lg mb-6">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              Your Assigned NPIs
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {user.userNpis.map((userNpi) => (
                <div key={userNpi.provider.id} className="bg-blue-50 p-4 rounded-lg">
                  <div className="text-lg font-semibold text-blue-600">
                    {userNpi.provider.npi}
                  </div>
                  <div className="text-sm text-gray-600">{userNpi.provider.name}</div>
                </div>
              ))}
              {user.userNpis.length === 0 && (
                <div className="col-span-3 text-center text-gray-500">
                  No NPIs assigned. Contact your administrator.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Submissions */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-6 sm:px-0">
            <div className="border-4 border-dashed border-gray-200 rounded-lg p-8">
              <div className="text-center">
                <div className="mx-auto h-12 w-12 text-gray-400">
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <h3 className="mt-2 text-sm font-medium text-gray-900">No submissions</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Get started by creating your first submission.
                </p>
                <div className="mt-6">
                  <button
                    type="button"
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    disabled={user.userNpis.length === 0}
                  >
                    <svg className="-ml-1 mr-2 h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    New Submission
                  </button>
                </div>
                {user.userNpis.length === 0 && (
                  <p className="mt-2 text-xs text-gray-400">
                    You need at least one assigned NPI to create submissions.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

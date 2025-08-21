import { type LoaderFunctionArgs } from 'react-router'
import { data, useLoaderData, Link } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'

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

export default function AdminReports() {
  const { user } = useLoaderData<typeof loader>()

  return (
    <InterexLayout 
      user={user}
      title="System Reports"
      subtitle="Generate system-wide reports and analytics"
      currentPath="/admin/reports"
      actions={
        <Link
          to="/admin/dashboard"
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
        >
          <Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />
          Back to Dashboard
        </Link>
      }
    >
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="bg-white shadow overflow-hidden sm:rounded-lg">
          <div className="px-4 py-5 sm:px-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">System Reports</h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              Generate comprehensive reports across all customers and data.
            </p>
          </div>
          <div className="border-t border-gray-200 px-4 py-5 sm:px-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-md font-medium text-gray-900 mb-2">User Activity Report</h4>
                <p className="text-sm text-gray-600 mb-4">
                  Comprehensive user activity across all customers and time periods.
                </p>
                <button className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700">
                  <Icon name="file-text" className="-ml-1 mr-2 h-4 w-4" />
                  Generate Report
                </button>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-md font-medium text-gray-900 mb-2">Provider Statistics</h4>
                <p className="text-sm text-gray-600 mb-4">
                  Provider and NPI usage statistics across all customers.
                </p>
                <button className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700">
                  <Icon name="cross-1" className="-ml-1 mr-2 h-4 w-4" />
                  Generate Report
                </button>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-md font-medium text-gray-900 mb-2">Submission Analytics</h4>
                <p className="text-sm text-gray-600 mb-4">
                  Submission volume and patterns across all customers and providers.
                </p>
                <button className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700">
                  <Icon name="file-text" className="-ml-1 mr-2 h-4 w-4" />
                  Generate Report
                </button>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-md font-medium text-gray-900 mb-2">System Health</h4>
                <p className="text-sm text-gray-600 mb-4">
                  System performance metrics, errors, and health indicators.
                </p>
                <button className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700">
                  <Icon name="laptop" className="-ml-1 mr-2 h-4 w-4" />
                  Generate Report
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

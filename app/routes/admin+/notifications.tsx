// app/routes/admin+/notifications.tsx
import { type LoaderFunctionArgs, data, useLoaderData, useFetcher, useRevalidator } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

const DAYS = 7

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

  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)

  // Cast prisma to any to access userNotification (Prisma client may not yet have generated types in this session)
  const prismaAny: any = prisma as any
  const [totalNotifications, purgeEligible] = await Promise.all([
    prismaAny.userNotification.count(),
    prismaAny.userNotification.count({ where: { createdAt: { lt: cutoff } } }),
  ])

  return data({ user, stats: { totalNotifications, purgeEligible, cutoff: cutoff.toISOString(), days: DAYS } })
}

export default function AdminNotificationsMaintenance() {
  const { user, stats } = useLoaderData<typeof loader>()
  const fetcher = useFetcher<{ ok: boolean; deleted?: number; message?: string }>()
  const revalidator = useRevalidator()

  const isSubmitting = fetcher.state !== 'idle'

  // After successful purge, refresh stats
  if (fetcher.data?.ok && !isSubmitting) {
    // Trigger revalidation (fire & forget) – explicitly ignore promise
    void revalidator.revalidate()
  }

  return (
    <InterexLayout
      user={user}
      title="Notifications Maintenance"
      subtitle={`Manage & purge user notifications (older than ${stats.days} days)`}
      currentPath="/admin/notifications"
      actions={<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">Admin Tool</span>}
    >
      <div className="max-w-5xl mx-auto py-6 sm:px-6 lg:px-8 space-y-6">
        <section className="bg-white shadow rounded-lg p-6 border border-gray-200">
          <h2 className="text-lg font-medium text-gray-900 flex items-center gap-2"><Icon name="hero:bell" className="h-5 w-5 text-blue-600" /> Notification Stats</h2>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded border bg-gray-50">
              <div className="text-xs uppercase tracking-wide text-gray-500">Total Stored</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{stats.totalNotifications}</div>
            </div>
            <div className="p-4 rounded border bg-gray-50">
              <div className="text-xs uppercase tracking-wide text-gray-500">Eligible (&gt; {stats.days}d)</div>
              <div className={`mt-1 text-2xl font-semibold ${stats.purgeEligible > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{stats.purgeEligible}</div>
            </div>
            <div className="p-4 rounded border bg-gray-50">
              <div className="text-xs uppercase tracking-wide text-gray-500">Cutoff Before</div>
              <div className="mt-1 text-sm font-mono text-gray-900 truncate" title={new Date(stats.cutoff).toLocaleString()}>{new Date(stats.cutoff).toISOString().split('T')[0]}</div>
            </div>
          </div>
        </section>

        <section className="bg-white shadow rounded-lg p-6 border border-gray-200 space-y-4">
          <h2 className="text-lg font-medium text-gray-900 flex items-center gap-2"><Icon name="hero:trash" className="h-5 w-5 text-red-600" /> Purge Old Notifications</h2>
          <p className="text-sm text-gray-600">This removes notifications older than {stats.days} days. Action is audited.</p>
          <fetcher.Form method="post" action="/admin/notifications/purge" className="flex items-center gap-4">
            <button
              type="submit"
              disabled={isSubmitting || stats.purgeEligible === 0}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium shadow-sm border transition disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 ${stats.purgeEligible === 0 ? 'bg-gray-200 text-gray-500 border-gray-300' : 'bg-red-600 text-white border-red-700 hover:bg-red-700'}`}
            >
              <Icon name={isSubmitting ? 'hero:refresh' : 'hero:trash'} className={`h-5 w-5 ${isSubmitting ? 'animate-spin' : ''}`} />
              {isSubmitting ? 'Purging...' : stats.purgeEligible === 0 ? 'Nothing to Purge' : 'Purge Old Notifications'}
            </button>
            {fetcher.data?.message && (
              <span className={`text-sm ${fetcher.data.ok ? 'text-green-600' : 'text-red-600'}`}>{fetcher.data.message}{fetcher.data.deleted != null && ` (Deleted: ${fetcher.data.deleted})`}</span>
            )}
          </fetcher.Form>
        </section>
      </div>
    </InterexLayout>
  )
}

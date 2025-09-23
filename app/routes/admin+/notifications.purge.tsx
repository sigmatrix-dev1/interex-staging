import { data, type ActionFunctionArgs } from 'react-router'
import { purgeOldNotifications } from '#app/services/notifications.server.ts'
import { getUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'

function hasSystemAdminRole(user: { roles: { name: string }[] }) {
  return user.roles.some(r => r.name === INTEREX_ROLES.SYSTEM_ADMIN)
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await getUserId(request)
  if (!userId) return data({ ok: false, error: 'unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, roles: { select: { name: true } } },
  })
  if (!user || !hasSystemAdminRole(user)) {
    return data({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  // Perform purge (older than 7 days handled inside purge function) with audit
  const deleted = await purgeOldNotifications({ manual: true, auditActorId: user.id })
  return data({ ok: true, deleted, message: `Purged ${deleted} notifications` })
}

export async function loader() {
  return data({ ok: false, error: 'POST only' }, { status: 405 })
}

export default function AdminNotificationPurge() {
  return null // not a navigable page; action endpoint only
}

/*
Route: /admin/notifications/purge
Method: POST
Auth: System Admin only
Purpose: Manual fallback to purge stale notifications (>7 days old, dismissed, or expired). Use sparingly; normal pruning is opportunistic.
*/

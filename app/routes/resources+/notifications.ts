import { data, type ActionFunctionArgs } from 'react-router'
import { createUserNotification, dismissUserNotification, markAllUserNotificationsRead, markUserNotificationRead } from '#app/services/notifications.server.ts'
import { getUserId } from '#app/utils/auth.server.ts'

export async function action({ request }: ActionFunctionArgs) {
  const userId = await getUserId(request)
  if (!userId) {
    return data({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const body = await request.json().catch(() => ({})) as any
  const { action } = body
  try {
    if (action === 'create') {
      const created = await createUserNotification({
        userId,
        kind: body.kind,
        title: body.title,
        description: body.description,
        expiresAtMs: body.expiresAt,
      })
      return data({ ok: true, id: created.id })
    }
    if (action === 'markRead') {
      await markUserNotificationRead(userId, body.id)
      return data({ ok: true })
    }
    if (action === 'markAllRead') {
      await markAllUserNotificationsRead(userId)
      return data({ ok: true })
    }
    if (action === 'dismiss') {
      await dismissUserNotification(userId, body.id)
      return data({ ok: true })
    }
    return data({ ok: false, error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return data({ ok: false, error: e.message || 'error' }, { status: 500 })
  }
}

export const loader = async () => data({ ok: true, message: 'POST only' })

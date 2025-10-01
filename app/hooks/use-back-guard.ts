import * as React from 'react'
import { useNotifications } from '#app/components/notifications/notifications.tsx'

type Mode = 'logout' | 'block'

export function useBackGuard(opts: {
  enabled?: boolean
  mode?: Mode
  message?: string // used for confirm() in logout mode
  blockMessage?: string // used for notification in block mode
  logoutUrl?: string
  redirectTo?: string
}) {
  const {
    enabled = false,
    mode = 'logout',
    message = 'For security, going back will log you out. Do you want to continue?',
    blockMessage = 'Back navigation is disabled on this screen.',
    logoutUrl = '/logout',
    redirectTo = '/login',
  } = opts || {}

  const { add } = useNotifications()

  React.useEffect(() => {
    if (!enabled) return

    // Seed a history state so the first Back triggers popstate
    try {
      history.pushState({ _guard: true }, '', window.location.href)
    } catch {
      // ignore
    }

    const onPopState = () => {
      // Immediately push a new state so we remain on the page
      try {
        history.pushState({ _guard: true }, '', window.location.href)
      } catch {
        // ignore
      }

      if (mode === 'block') {
        // Non-blocking in-app notice
        add({ kind: 'warning', title: 'Back disabled', description: blockMessage })
        return
      }

      // Default: logout mode with confirmation
      const ok = window.confirm(message)
      if (!ok) return

      const fd = new FormData()
      fd.append('intent', 'logout')
      const sent = (navigator.sendBeacon && navigator.sendBeacon(logoutUrl, fd)) || false

      if (!sent) {
        void fetch(logoutUrl, { method: 'POST', body: fd, credentials: 'include' }).finally(() => {
          window.location.assign(redirectTo)
        })
      } else {
        window.location.assign(redirectTo)
      }
    }

    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
    }
  }, [enabled, mode, message, blockMessage, logoutUrl, redirectTo, add])
}

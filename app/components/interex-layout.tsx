import * as React from 'react'
import { Outlet } from 'react-router'
import { InterexHeader } from '#app/components/interex-header.tsx'
import { type User } from '#app/utils/role-redirect.server.ts'

interface InterexLayoutProps {
    user: User
    children?: React.ReactNode
    title?: string
    subtitle?: string
    showBackButton?: boolean
    backTo?: string
    actions?: React.ReactNode
    currentPath?: string
    hideBrandBar?: boolean

    /** Enable banking-style back-button guard for this screen */
    backGuardEnabled?: boolean
    /** POST endpoint that destroys the session (defaults to your /logout route) */
    backGuardLogoutUrl?: string
    /** Where to send the user after logout (client-side redirect). Defaults to "/". */
    backGuardRedirectTo?: string
    /** Customize the confirm dialog message */
    backGuardMessage?: string
}

export function InterexLayout({
                                  user,
                                  children,
                                  title,
                                  subtitle,
                                  showBackButton,
                                  backTo,
                                  actions,
                                  currentPath,
                                  hideBrandBar = false,

                                  backGuardEnabled = false,
                                  backGuardLogoutUrl = '/logout',
                                  backGuardRedirectTo = '/',
                                  backGuardMessage = 'For security, going back will log you out. Do you want to continue?',
                              }: InterexLayoutProps) {
    return (
        <div className="min-h-screen w-full bg-gray-50">
            <BackGuard
                enabled={backGuardEnabled}
                logoutUrl={backGuardLogoutUrl}
                redirectTo={backGuardRedirectTo}
                message={backGuardMessage}
            />

            <InterexHeader
                user={user}
                currentPath={currentPath}
                title={title}
                subtitle={subtitle}
                showBackButton={showBackButton}
                backTo={backTo}
                actions={actions}
                hideBrandBar={hideBrandBar}
            />
            <main>{children ?? <Outlet />}</main>
        </div>
    )
}

/** Bank-style Back-button interceptor */
function BackGuard({
                       enabled,
                       logoutUrl,
                       redirectTo,
                       message,
                   }: {
    enabled: boolean
    logoutUrl: string
    redirectTo: string
    message: string
}) {
    React.useEffect(() => {
        if (!enabled) return

        // Seed a state so the first Back triggers popstate
        try {
            history.pushState({ _guard: true }, '', window.location.href)
        } catch {
            // ignore
        }

        const onPopState = () => {
            // Immediately push a new state so we remain on the page while asking
            try {
                history.pushState({ _guard: true }, '', window.location.href)
            } catch {
                // ignore
            }

            const ok = window.confirm(message)
            if (!ok) return

            // Fire a POST to /logout using Beacon (works during navigation/unload)
            const fd = new FormData()
            fd.append('intent', 'logout')
            const sent =
                (navigator.sendBeacon && navigator.sendBeacon(logoutUrl, fd)) || false

            if (!sent) {
                // Fallback if Beacon unavailable/blocked
                fetch(logoutUrl, { method: 'POST', body: fd, credentials: 'include' }).finally(
                    () => window.location.assign(redirectTo),
                )
            } else {
                // Beacon sent—navigate immediately
                window.location.assign(redirectTo)
            }
        }

        window.addEventListener('popstate', onPopState)

        return () => {
            window.removeEventListener('popstate', onPopState)
        }
    }, [enabled, logoutUrl, redirectTo, message])

    return null
}

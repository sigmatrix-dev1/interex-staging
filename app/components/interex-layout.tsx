import * as React from 'react'
import { Outlet, useLocation } from 'react-router'
import { InterexHeader } from '#app/components/interex-header.tsx'
import { useBackGuard } from '#app/hooks/use-back-guard.ts'
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
    /** Choose behavior: 'logout' (default) or 'block' (stay on page and show a notice) */
    backGuardMode?: 'logout' | 'block'
    /** POST endpoint that destroys the session (defaults to your /logout route) */
    backGuardLogoutUrl?: string
    /** Where to send the user after logout (client-side redirect). Defaults to "/". */
    backGuardRedirectTo?: string
    /** Customize the confirm dialog message */
    backGuardMessage?: string
    /** Customize the notification description in 'block' mode */
    backGuardBlockMessage?: string
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

                                  backGuardEnabled = true,
                                  backGuardMode = 'logout',
                                  backGuardLogoutUrl = '/logout',
                                  backGuardRedirectTo = '/login',
                                  backGuardMessage = 'For security, going back will log you out. Do you want to continue?',
                                  backGuardBlockMessage = 'Back navigation is disabled on this screen.',
                              }: InterexLayoutProps) {
    return (
        <div className="min-h-screen w-full bg-gray-50">
            <BackGuard
                enabled={backGuardEnabled}
                mode={backGuardMode}
                logoutUrl={backGuardLogoutUrl}
                redirectTo={backGuardRedirectTo}
                message={backGuardMessage}
                blockMessage={backGuardBlockMessage}
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
function BackGuard({ enabled, mode = 'logout', logoutUrl, redirectTo, message, blockMessage }: {
  enabled: boolean
  mode?: 'logout' | 'block'
  logoutUrl: string
  redirectTo: string
  message: string
  blockMessage?: string
}) {
    const location = useLocation()
    const path = location.pathname
    // Auto-block on submission creation/review/upload steps to avoid logout confirm
    const isSubmissionStep =
        path === '/customer/submissions/new' ||
        /\/customer\/submissions\/[^/]+\/(review|upload)$/.test(path)

    const effectiveMode = isSubmissionStep ? 'block' : mode

    useBackGuard({ enabled, mode: effectiveMode, message, blockMessage, logoutUrl, redirectTo })
  return null
}

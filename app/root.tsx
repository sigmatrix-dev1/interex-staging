import { OpenImgContextProvider } from 'openimg/react'
import {
	data,
	Link,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLoaderData,
	useMatches,
} from 'react-router'
import { HoneypotProvider } from 'remix-utils/honeypot/react'
import { type Route } from './+types/root.ts'
import appleTouchIconAssetUrl from './assets/favicons/apple-touch-icon.png'
import faviconAssetUrl from './assets/favicons/favicon.svg'
import { GeneralErrorBoundary } from './components/error-boundary.tsx'
import { NotificationProvider } from './components/notifications/notifications.tsx'
import { EpicProgress } from './components/progress-bar.tsx'
import { SearchBar } from './components/search-bar.tsx'
import { useToast } from './components/toaster.tsx'
// Removed unused imports (Button, UserDropdown, ThemeSwitch). Keep iconsHref & EpicToaster as used.
import { href as iconsHref } from './components/ui/icon.tsx'
import { useOptionalTheme } from './routes/resources+/theme-switch.tsx'
import { listUserNotifications, serializeForClient } from './services/notifications.server.ts'
import tailwindStyleSheetUrl from './styles/tailwind.css?url'
import { getUserId, logout } from './utils/auth.server.ts'
import { ClientHintCheck, getHints } from './utils/client-hints.tsx'
import { prisma } from './utils/db.server.ts'
import { getEnv } from './utils/env.server.ts'
import { pipeHeaders } from './utils/headers.server.ts'
import { honeypot } from './utils/honeypot.server.ts'
import { combineHeaders, getDomainUrl, getImgSrc } from './utils/misc.tsx'
import { useNonce } from './utils/nonce-provider.ts'
import { type Theme, getTheme } from './utils/theme.server.ts'
import { makeTimings, time } from './utils/timing.server.ts'
import { getToast } from './utils/toast.server.ts'
import { useOptionalUser } from './utils/user.ts'
// (imports reordered by linter)

export const links: Route.LinksFunction = () => {
	return [
		// Preload svg sprite as a resource to avoid render blocking
		{ rel: 'preload', href: iconsHref, as: 'image' },
		{
			rel: 'icon',
			href: '/favicon.ico',
			sizes: '48x48',
		},
		{ rel: 'icon', type: 'image/svg+xml', href: faviconAssetUrl },
		{ rel: 'apple-touch-icon', href: appleTouchIconAssetUrl },
		{
			rel: 'manifest',
			href: '/site.webmanifest',
			crossOrigin: 'use-credentials',
		} as const, // necessary to make typescript happy
		{ rel: 'stylesheet', href: tailwindStyleSheetUrl },
	].filter(Boolean)
}

export const meta: Route.MetaFunction = ({ data }) => {
	return [
		{ title: data ? 'Interex' : 'Error | Interex' },
		{ name: 'description', content: `Healthcare data management platform` },
	]
}

export async function loader({ request }: Route.LoaderArgs) {
	const timings = makeTimings('root loader')
	const userId = await time(() => getUserId(request), {
		timings,
		type: 'getUserId',
		desc: 'getUserId in root',
	})

	const user = userId
		? await time(
				() =>
					prisma.user.findUnique({
						select: {
							id: true,
							name: true,
							username: true,
							image: { select: { objectKey: true } },
							// Include 2FA enabled flag for privileged banner logic
							twoFactorEnabled: true,
							roles: {
								select: {
									name: true,
									permissions: {
										select: { entity: true, action: true, access: true },
									},
								},
							},
						},
						where: { id: userId },
					}),
				{ timings, type: 'find user', desc: 'find user in root' },
			)
		: null
	if (userId && !user) {
		console.info('something weird happened')
		// something weird happened... The user is authenticated but we can't find
		// them in the database. Maybe they were deleted? Let's log them out.
		await logout({ request, redirectTo: '/' })
	}
	const { toast, headers: toastHeaders } = await getToast(request)

	// Load persisted notifications (best-effort, ignore errors)
	let notifications: any[] = []
	if (userId) {
		try {
			const rows = await listUserNotifications({ userId, limit: 50 })
			notifications = rows.map(serializeForClient)
		} catch (e) {
			console.error('Failed to load notifications', e)
		}
	}
	const honeyProps = await honeypot.getInputProps()

	return data(
		{
			user,
			privilegedTwoFaWarning: (() => {
				if (!user) return null
				const roleNames = user.roles.map(r => r.name)
				const isSystemAdmin = roleNames.includes('system-admin')
				// Policy: All non system-admin users MUST have 2FA. If missing => logout enforced earlier or show hard warning.
				const has2FA = !!user.twoFactorEnabled
				if (!has2FA && isSystemAdmin) {
					return {
						message: 'System Admin account without 2FA – please enable Two-Factor Authentication immediately (Settings → Two-Factor).',
						severity: 'warning' as const,
					}
				}
				return null
			})(),
			notifications,
			requestInfo: {
				hints: getHints(request),
				origin: getDomainUrl(request),
				path: new URL(request.url).pathname,
				userPrefs: {
					theme: getTheme(request),
				},
			},
			ENV: getEnv(),
			toast,
			honeyProps,
		},
		{
			headers: combineHeaders(
				{ 'Server-Timing': timings.toString() },
				toastHeaders,
			),
		},
	)
}

export const headers: Route.HeadersFunction = pipeHeaders

function Document({
	children,
	nonce,
	theme = 'light',
	env = {},
}: {
	children: React.ReactNode
	nonce: string
	theme?: Theme
	env?: Record<string, string | undefined>
}) {
	const allowIndexing = ENV.ALLOW_INDEXING !== 'false'
	return (
		<html lang="en" className={`${theme} h-full overflow-x-hidden`}>
			<head>
				<ClientHintCheck nonce={nonce} />
				<Meta />
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width,initial-scale=1" />
				{allowIndexing ? null : (
					<meta name="robots" content="noindex, nofollow" />
				)}
				<Links />
			</head>
			<body className="bg-background text-foreground">
				{children}
				<script
					nonce={nonce}
					dangerouslySetInnerHTML={{
						__html: `window.ENV = ${JSON.stringify(env)}`,
					}}
				/>
				<ScrollRestoration nonce={nonce} />
				<Scripts nonce={nonce} />
			</body>
		</html>
	)
}

export function Layout({ children }: { children: React.ReactNode }) {
	// if there was an error running the loader, data could be missing
	const data = useLoaderData<typeof loader | null>()
	const nonce = useNonce()
	const theme = useOptionalTheme()
	return (
		<Document nonce={nonce} theme={theme} env={data?.ENV}>
			{children}
		</Document>
	)
}

function App() {
	const data = useLoaderData<typeof loader>()
	useOptionalUser() // invoked for potential downstream usage; result unused so no binding
	const matches = useMatches()
	const isOnSearchPage = matches.find((m) => m.id === 'routes/users+/index')
	const searchBar = isOnSearchPage ? null : <SearchBar status="idle" />

	// Show system-admin 2FA warning banner only if present
	const privilegedWarning = data.privilegedTwoFaWarning
	useToast(data.toast)

	// Check if we're on an app page that uses InterexLayout (has its own header)
	const currentPath = matches[matches.length - 1]?.pathname || ''
	const isAppPage = currentPath.startsWith('/customer') || 
	                  currentPath.startsWith('/admin') || 
	                  currentPath.startsWith('/provider') || 
	                  currentPath.startsWith('/submissions') ||
	                  currentPath.startsWith('/settings') ||
	                  currentPath === '/dashboard'

	return (
		<OpenImgContextProvider
			optimizerEndpoint="/resources/images"
			getSrc={getImgSrc}
		>
			<div className="flex min-h-screen flex-col justify-between">
				{/* Only show root header on marketing/public pages */}
				{!isAppPage && (
					<header className="container py-6">
						<nav className="flex flex-wrap items-center justify-between gap-4 sm:flex-nowrap md:gap-8">
							<Logo />


							<div className="block w-full sm:hidden">{searchBar}</div>
						</nav>
					</header>
				)}

				<div className="flex flex-1 flex-col">
					{privilegedWarning && (
						<div className="bg-amber-50 border-b border-amber-300 p-3 text-sm text-amber-900 flex items-start gap-3">
							<span className="font-semibold">Security Notice:</span>
							<span>{privilegedWarning.message}</span>
							<Link to="/settings/profile/two-factor" className="underline font-medium">Enable now →</Link>
						</div>
					)}
					<Outlet />
				</div>


			</div>
			<EpicProgress />
		</OpenImgContextProvider>
	)
}

function Logo() {
	return (
		<Link to="/" className="group grid leading-snug">
			<span className="font-bold text-2xl transition group-hover:translate-x-1 transition-colors: text-blue-900">
				InterEx
			</span>
			<span className="font-medium text-sm transition group-hover:translate-x-1 transition-colors: text-blue-900">
				InterOperability Exchange
			</span>
		</Link>
	)
}

function AppWithProviders() {
  const data = useLoaderData<typeof loader>()
  return (
    <HoneypotProvider {...data.honeyProps}>
      <NotificationProvider initialNotifications={data.notifications}>
        <App />
      </NotificationProvider>
    </HoneypotProvider>
  )
}

export default AppWithProviders

// this is a last resort error boundary. There's not much useful information we
// can offer at this level.
export const ErrorBoundary = GeneralErrorBoundary

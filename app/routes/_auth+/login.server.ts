// app/routes/_auth+/login.server.ts

import { invariant } from '@epic-web/invariant'
import { redirect } from 'react-router'
import { safeRedirect } from 'remix-utils/safe-redirect'
import { getUserId, sessionKey } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { combineResponseInits } from '#app/utils/misc.tsx'
import { getDashboardUrl } from '#app/utils/role-redirect.server.ts'
import { authSessionStorage } from '#app/utils/session.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { verifySessionStorage } from '#app/utils/verification.server.ts'
import { type VerifyFunctionArgs } from './verify.server.ts'

const verifiedTimeKey = 'verified-time'
const unverifiedSessionIdKey = 'unverified-session-id'
const rememberKey = 'remember'

export async function handleNewSession(
	{
		request,
		session,
		redirectTo,
		remember,
		twoFAVerified,
	}: {
		request: Request
		session: { userId: string; id: string; expirationDate: Date }
		redirectTo?: string
		remember: boolean
		twoFAVerified?: boolean
	},
	responseInit?: ResponseInit,
) {
	// Helper to commit auth session and redirect appropriately
	async function commitAndRedirect() {
		const authSession = await authSessionStorage.getSession(
			request.headers.get('cookie'),
		)
		authSession.set(sessionKey, session.id)
		authSession.set(verifiedTimeKey, Date.now())

		// Determine redirect URL based on user role or provided redirectTo
		// Cast for mustChangePassword field until Prisma client types regenerate
		const user = await (prisma as any).user.findUnique({
			where: { id: session.userId },
			select: { id: true, mustChangePassword: true, roles: { select: { name: true } } },
		})

		if (user?.mustChangePassword) {
			return redirect(
				'/change-password',
				combineResponseInits(
					{
						headers: {
							'set-cookie': await authSessionStorage.commitSession(authSession, {
								expires: remember ? session.expirationDate : undefined,
							}),
						},
					},
					responseInit,
				),
			)
		}

		let finalRedirectTo = redirectTo
		if (!finalRedirectTo && user) {
			finalRedirectTo = getDashboardUrl(user as any)
		}

		return redirect(
			safeRedirect(finalRedirectTo),
			combineResponseInits(
				{
					headers: {
						'set-cookie': await authSessionStorage.commitSession(authSession, {
							expires: remember ? session.expirationDate : undefined,
						}),
					},
				},
				responseInit,
			),
		)
	}

	// If already verified via 2FA, or user has no 2FA enabled, commit immediately.
	if (twoFAVerified) {
		return commitAndRedirect()
	}

	const userTwoFA = await prisma.user.findUnique({
		where: { id: session.userId },
		select: { twoFactorEnabled: true },
	})
	const hasUserTwoFA = Boolean(userTwoFA?.twoFactorEnabled)

	if (!hasUserTwoFA) {
		return commitAndRedirect()
	}

	// 2FA is enabled: stash unverified session and send to /2fa with details
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	verifySession.set(unverifiedSessionIdKey, session.id)
	verifySession.set(rememberKey, !!remember)

	const params = new URLSearchParams()
	params.set('userId', session.userId)
	if (redirectTo) params.set('redirectTo', redirectTo)
	if (remember) params.set('remember', 'true')

	return redirect(`/2fa?${params.toString()}`, {
		headers: {
			'set-cookie': await verifySessionStorage.commitSession(verifySession),
		},
	})
}

export async function handleVerification({
	request,
	submission,
}: VerifyFunctionArgs) {
	invariant(
		submission.status === 'success',
		'Submission should be successful by now',
	)
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)

	const remember = verifySession.get(rememberKey)
	const { redirectTo } = submission.value
	const headers = new Headers()
	authSession.set(verifiedTimeKey, Date.now())

	const unverifiedSessionId = verifySession.get(unverifiedSessionIdKey)
	if (unverifiedSessionId) {
		const session = await prisma.session.findUnique({
			select: { expirationDate: true },
			where: { id: unverifiedSessionId },
		})
		if (!session) {
			throw await redirectWithToast('/login', {
				type: 'error',
				title: 'Invalid session',
				description: 'Could not find session to verify. Please try again.',
			})
		}
		authSession.set(sessionKey, unverifiedSessionId)

		headers.append(
			'set-cookie',
			await authSessionStorage.commitSession(authSession, {
				expires: remember ? session.expirationDate : undefined,
			}),
		)
	} else {
		headers.append(
			'set-cookie',
			await authSessionStorage.commitSession(authSession),
		)
	}

	headers.append(
		'set-cookie',
		await verifySessionStorage.destroySession(verifySession),
	)

	// After successful 2FA verification, enforce password change if required
	if (authSession.get(sessionKey)) {
		const sessionId = authSession.get(sessionKey) as string | undefined
		if (sessionId) {
			const session = await prisma.session.findUnique({
				where: { id: sessionId },
				select: { userId: true },
			})
			if (session?.userId) {
					const user = await (prisma as any).user.findUnique({
					where: { id: session.userId },
					select: { mustChangePassword: true },
				})
				if (user?.mustChangePassword) {
					return redirect('/change-password', { headers })
				}
			}
		}
	}

	return redirect(safeRedirect(redirectTo), { headers })
}

export async function shouldRequestTwoFA(request: Request) {
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	if (verifySession.has(unverifiedSessionIdKey)) return true
	const userId = await getUserId(request)
	if (!userId) return false
	// If the user has 2FA (new-only), and it's over two hours since last verification, request 2FA again
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } })
	if (!user?.twoFactorEnabled) return false
	const verifiedTime = authSession.get(verifiedTimeKey) ?? new Date(0)
	const twoHours = 1000 * 60 * 60 * 2
	return Date.now() - verifiedTime > twoHours
}

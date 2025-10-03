// app/routes/_auth+/login.server.ts

import { invariant } from '@epic-web/invariant'
import { redirect } from 'react-router'
import { safeRedirect } from 'remix-utils/safe-redirect'
import { audit } from '#app/services/audit.server.ts'
import { getUserId, sessionKey, isPasswordExpired } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { combineResponseInits } from '#app/utils/misc.tsx'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { getDashboardUrl } from '#app/utils/role-redirect.server.ts'
import { authSessionStorage } from '#app/utils/session.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { verifySessionStorage } from '#app/utils/verification.server.ts'
import { type VerifyFunctionArgs } from './verify.server.ts'

const verifiedTimeKey = 'verified-time'
const unverifiedSessionIdKey = 'unverified-session-id'
const rememberKey = 'remember'
const logoutOthersKey = 'logout-others'

export async function handleNewSession(
	{
		request,
		session,
		redirectTo,
		remember,
		twoFAVerified,
		logoutOthers,
	}: {
		request: Request
		session: { userId: string; id: string; expirationDate: Date }
		redirectTo?: string
		remember: boolean
		twoFAVerified?: boolean
		logoutOthers?: boolean
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

		// If requested, sign out other sessions for this user before committing
		if (logoutOthers) {
			const ctx = await extractRequestContext(request, { requireUser: false })
			const result = await prisma.session.deleteMany({
				where: { userId: session.userId, id: { not: session.id } },
			})
			await audit.auth({
				action: 'LOGOUT_OTHERS_ON_LOGIN',
				actorType: 'USER',
				actorId: session.userId,
				actorIp: ctx.ip ?? null,
				actorUserAgent: ctx.userAgent ?? null,
				summary: 'Logged out other active sessions after login',
				status: 'SUCCESS',
				metadata: { newSessionId: session.id, deletedCount: result.count },
			})
		}

		// Determine redirect URL based on user role or provided redirectTo
		// Cast for mustChangePassword field until Prisma client types regenerate
		const user = await (prisma as any).user.findUnique({
			where: { id: session.userId },
			select: { id: true, mustChangePassword: true, passwordChangedAt: true, roles: { select: { name: true } } },
		})


		// Configure enforcement: default ON in non-test, OFF in test unless explicitly enabled
		const enforceChangePassword =
			process.env.NODE_ENV === 'test'
				? process.env.REQUIRE_PASSWORD_CHANGE_ON_LOGIN === 'true'
				: process.env.REQUIRE_PASSWORD_CHANGE_ON_LOGIN !== 'false'

		if (enforceChangePassword) {
			// If password expired, force change (set flag if missing)
			if (user && isPasswordExpired(user.passwordChangedAt)) {
				if (!user.mustChangePassword) {
					await (prisma as any).user.update({ where: { id: user.id }, data: { mustChangePassword: true } })
				}
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
		// HARD BLOCK policy: all non system-admin users must enable MFA (2FA) before full session.
		// System-admin users are allowed through (warned separately via banner) to avoid locking out emergency access.
		const roles = await prisma.role.findMany({
			where: { users: { some: { id: session.userId } } },
			select: { name: true },
		})
		const isSystemAdmin = roles.some(r => r.name === 'system-admin')
		if (!isSystemAdmin) {
			// Always enforce setup for non-system-admin
			const verifySession = await verifySessionStorage.getSession(
				request.headers.get('cookie'),
			)
			verifySession.set(unverifiedSessionIdKey, session.id)
			verifySession.set(rememberKey, !!remember)

			const params = new URLSearchParams()
			params.set('userId', session.userId)
			if (redirectTo) params.set('redirectTo', redirectTo)
			if (remember) params.set('remember', 'true')

			// Audit enforcement event (idempotent-ish)
			try {
				const ctx = await extractRequestContext(request, { requireUser: false })
				await audit.security({
					action: 'MFA_ENFORCE_BLOCK',
					actorType: 'USER',
					actorId: session.userId,
					actorIp: ctx.ip ?? null,
					actorUserAgent: ctx.userAgent ?? null,
					status: 'INFO',
					summary: 'User redirected to mandatory MFA setup',
					metadata: { reason: 'MFA_REQUIRED_FOR_NON_SYSTEM_ADMIN' },
					chainKey: 'global',
				})
			} catch {}

			return redirect(`/2fa-setup?${params.toString()}`, {
				headers: {
					'set-cookie': await verifySessionStorage.commitSession(verifySession),
				},
			})
		}
		// System-admin without MFA: allow through (commit and redirect); banner + optional warning handled elsewhere
		return commitAndRedirect()
	}

	// 2FA is enabled: stash unverified session and send to /2fa with details
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	verifySession.set(unverifiedSessionIdKey, session.id)
	verifySession.set(rememberKey, !!remember)
	if (logoutOthers) verifySession.set(logoutOthersKey, true)

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
	const shouldLogoutOthers = verifySession.get(logoutOthersKey)
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

		// If requested, sign out other sessions for this user now that 2FA succeeded
		if (shouldLogoutOthers) {
			const current = await prisma.session.findUnique({ where: { id: unverifiedSessionId }, select: { userId: true, id: true } })
			if (current?.userId) {
				const del = await prisma.session.deleteMany({ where: { userId: current.userId, id: { not: current.id } } })
				try {
					const ctx = await extractRequestContext(request, { requireUser: false })
					await audit.auth({
						action: 'LOGOUT_OTHERS_ON_LOGIN',
						actorType: 'USER',
						actorId: current.userId,
						actorIp: ctx.ip ?? null,
						actorUserAgent: ctx.userAgent ?? null,
						status: 'SUCCESS',
						summary: 'Logged out other active sessions after 2FA login',
						metadata: { newSessionId: unverifiedSessionId, deletedCount: del.count },
					})
				} catch {}
			}
		}

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
	const enforceChangePassword =
		process.env.NODE_ENV === 'test'
			? process.env.REQUIRE_PASSWORD_CHANGE_ON_LOGIN === 'true'
			: process.env.REQUIRE_PASSWORD_CHANGE_ON_LOGIN !== 'false'

	if (authSession.get(sessionKey) && enforceChangePassword) {
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

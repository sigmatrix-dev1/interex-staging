// app/utils/auth.server.ts

import crypto from 'node:crypto'
import { type Connection, type Password } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { redirect } from 'react-router'
import { Authenticator } from 'remix-auth'
import { safeRedirect } from 'remix-utils/safe-redirect'
import { audit } from '#app/services/audit.server.ts'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { providers } from './connections.server.ts'
import { prisma } from './db.server.ts'
import { combineHeaders, downloadFile } from './misc.tsx'
import { type ProviderUser } from './providers/provider.ts'
import { authSessionStorage } from './session.server.ts'
import { uploadProfileImage } from './storage.server.ts'

export const SESSION_EXPIRATION_TIME = 1000 * 60 * 60 * 24 * 30
export const getSessionExpirationDate = () =>
    new Date(Date.now() + SESSION_EXPIRATION_TIME)

export const sessionKey = 'sessionId'

export const authenticator = new Authenticator<ProviderUser>()

for (const [providerName, provider] of Object.entries(providers)) {
    const strategy = provider.getAuthStrategy()
    if (strategy) {
        authenticator.use(strategy, providerName)
    }
}

export async function getUserId(request: Request) {
    const authSession = await authSessionStorage.getSession(
        request.headers.get('cookie'),
    )
    const sessionId = authSession.get(sessionKey)
    if (!sessionId) return null

    const session = await prisma.session.findUnique({
        select: { userId: true, expirationDate: true },
        where: { id: sessionId, expirationDate: { gt: new Date() } },
    })

    if (!session?.userId) {
        throw redirect('/', {
            headers: {
                'set-cookie': await authSessionStorage.destroySession(authSession),
            },
        })
    }

    // ✅ Defense in depth: ensure the user tied to this session is still active
    const user = await prisma.user.findUnique({
        where: { id: session.userId },
        // Avoid selecting deletedAt explicitly to stay compatible with any stale generated client.
        select: { id: true, active: true },
    })
    if (!user || !user.active) {
        // kill the session and bounce to home/login
        await prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => {})
        throw redirect('/', {
            headers: {
                'set-cookie': await authSessionStorage.destroySession(authSession),
            },
        })
    }

    return session.userId
}

export async function requireUserId(
    request: Request,
    { redirectTo }: { redirectTo?: string | null } = {},
) {
    const userId = await getUserId(request)
    if (!userId) {
        const requestUrl = new URL(request.url)
        redirectTo =
            redirectTo === null
                ? null
                : (redirectTo ?? `${requestUrl.pathname}${requestUrl.search}`)
        const loginParams = redirectTo ? new URLSearchParams({ redirectTo }) : null
        const loginRedirect = ['/login', loginParams?.toString()]
            .filter(Boolean)
            .join('?')
        throw redirect(loginRedirect)
    }
    return userId
}

export async function requireAnonymous(request: Request) {
    const userId = await getUserId(request)
    if (userId) {
        throw redirect('/')
    }
}

export async function login(
    request: Request,
    {
        username,
        password,
    }: {
    username: string
        password: string
    },
) {
    // Defensive runtime guard: ensure function invoked with correct arguments.
    if (!(request instanceof Request)) {
        throw new Error('login(request, { username, password }) called without a valid Request object')
    }
    const ctx = await extractRequestContext(request, { requireUser: false })
    const verified = await verifyUserPassword({ username }, password)
    if (!verified) {
        // differentiate reason: user missing/inactive vs bad password is not exposed directly here
        await audit.auth({
            action: 'LOGIN_FAILURE',
            actorType: 'USER',
            actorId: undefined,
            actorDisplay: username,
            customerId: null,
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            metadata: { username, reason: 'INVALID_CREDENTIALS' },
            summary: 'Login failed',
            status: 'FAILURE',
        })
        return null
    }

    // On success, reset any soft lock / counters before creating session
    try {
        await (prisma as any).user.update({
            where: { id: verified.id },
            data: { failedLoginCount: 0, softLocked: false },
            select: { id: true },
        })
    } catch {}

    const session = await prisma.session.create({
        select: { id: true, expirationDate: true, userId: true },
        data: {
            expirationDate: getSessionExpirationDate(),
            userId: verified.id,
        },
    })

    await audit.auth({
        action: 'LOGIN_SUCCESS',
        actorType: 'USER',
        actorId: verified.id,
        actorDisplay: username,
        customerId: ctx.customerId ?? null,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        metadata: { username, sessionId: session.id },
        summary: 'Login successful',
        status: 'SUCCESS',
    })
    return session
}

export async function resetUserPassword({
                                            username,
                                            password,
                                        }: {
    username: string
    password: string
}) {
    const hashedPassword = await getPasswordHash(password)
    return prisma.user.update({
        where: { username },
        data: {
            password: {
                update: {
                    hash: hashedPassword,
                },
            },
        },
    })
}

export async function signup({
                                 email,
                                 username,
                                 password,
                                 name,
                             }: {
    email: string
    username: string
    name: string
    password: string
}) {
    const hashedPassword = await getPasswordHash(password)

    const session = await prisma.session.create({
        data: {
            expirationDate: getSessionExpirationDate(),
            user: {
                create: {
                    email: email.toLowerCase(),
                    username: username.toLowerCase(),
                    name,
                    roles: { connect: { name: 'basic-user' } },
                    password: {
                        create: {
                            hash: hashedPassword,
                        },
                    },
                },
            },
        },
        select: { id: true, expirationDate: true },
    })

    return session
}

export async function signupWithConnection({
                                               email,
                                               username,
                                               name,
                                               providerId,
                                               providerName,
                                               imageUrl,
                                           }: {
    email: string
    username: string
    name: string
    providerId: Connection['providerId']
    providerName: Connection['providerName']
    imageUrl?: string
}) {
    const user = await prisma.user.create({
        data: {
            email: email.toLowerCase(),
            username: username.toLowerCase(),
            name,
            roles: { connect: { name: 'basic-user' } },
            connections: { create: { providerId, providerName } },
        },
        select: { id: true },
    })

    if (imageUrl) {
        const imageFile = await downloadFile(imageUrl)
        await prisma.user.update({
            where: { id: user.id },
            data: {
                image: {
                    create: {
                        objectKey: await uploadProfileImage(user.id, imageFile),
                    },
                },
            },
        })
    }

    // Create and return the session
    const session = await prisma.session.create({
        data: {
            expirationDate: getSessionExpirationDate(),
            userId: user.id,
        },
        select: { id: true, expirationDate: true },
    })

    return session
}

export async function logout(
    {
        request,
        redirectTo = '/',
    }: {
        request: Request
        redirectTo?: string
    },
    responseInit?: ResponseInit,
) {
    const ctx = await extractRequestContext(request, { requireUser: false })
    const authSession = await authSessionStorage.getSession(
        request.headers.get('cookie'),
    )
    const sessionId = authSession.get(sessionKey)
    let actorId: string | undefined
    if (sessionId) {
        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: { userId: true },
        })
        actorId = session?.userId || undefined
        void prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => {})
    }

    await audit.auth({
        action: 'LOGOUT',
        actorType: 'USER',
        actorId: actorId,
        actorDisplay: ctx.actorDisplay,
        customerId: ctx.customerId ?? null,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        metadata: { sessionId, redirectTo },
        summary: 'User logout',
        status: 'SUCCESS',
    })

    throw redirect(safeRedirect(redirectTo), {
        ...responseInit,
        headers: combineHeaders(
            { 'set-cookie': await authSessionStorage.destroySession(authSession) },
            responseInit?.headers,
        ),
    })
}

export async function getPasswordHash(password: string) {
    const hash = await bcrypt.hash(password, 10)
    return hash
}

export async function verifyUserPassword(
    where: { username: string } | { id: string },
    password: Password['hash'],
) {
    const userWithPassword = await prisma.user.findUnique({
        where,
        select: { id: true, active: true, password: { select: { hash: true } } },
    })
    if (!userWithPassword || !userWithPassword.password) {
        return null
    }

    // ✅ Block inactive users from authenticating
    if (!userWithPassword.active) {
        return null
    }

    const isValid = await bcrypt.compare(password, userWithPassword.password.hash)
    if (!isValid) {
        return null
    }

    return { id: userWithPassword.id }
}

// ============================================================
// Account lockout helpers
// - Soft lock: 3 consecutive invalid password attempts
// - Hard lock: 3 invalid attempts within 10 seconds
//   (We reuse hardLockedAt as the window start before lock; on lock, it's set to now.)
// ============================================================

export const LOCKOUT_MAX_ATTEMPTS = (() => {
    const raw = process.env.LOCKOUT_MAX_ATTEMPTS
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3
})()
export const LOCKOUT_WINDOW_MS = (() => {
    const raw = process.env.LOCKOUT_WINDOW_SECONDS
    const n = raw ? Number(raw) : NaN
    const sec = Number.isFinite(n) && n > 0 ? n : 10
    return Math.floor(sec * 1000)
})()

export type FailedLoginResult =
    | { status: 'normal'; remainingAttempts: number }
    | { status: 'soft'; remainingAttempts: 0 }
    | { status: 'hard'; remainingAttempts: 0 }

export function remainingAttemptsMessage(remaining: number) {
    if (remaining <= 0) return null
    const plural = remaining === 1 ? '' : 's'
    return `${remaining} attempt${plural} remaining before lock.`
}

/**
 * Applies failed-login updates for a known username and returns the resulting state.
 * If the user does not exist, it no-ops and returns normal.
 */
export async function updateFailedLoginAttempt(username: string): Promise<FailedLoginResult> {
    const now = new Date()
    const user = await (prisma as any).user.findUnique({
        where: { username },
        select: {
            id: true,
            failedLoginCount: true,
            softLocked: true,
            hardLocked: true,
            hardLockedAt: true,
        },
    })
    if (!user) return { status: 'normal', remainingAttempts: 0 }
    if (user.hardLocked) return { status: 'hard', remainingAttempts: 0 }

    // Determine window start for rapid attempts (used only to decide HARD vs SOFT lock)
    let windowStart = user.hardLockedAt ? new Date(user.hardLockedAt) : null
    const windowActive = !!(windowStart && now.getTime() - windowStart.getTime() <= LOCKOUT_WINDOW_MS)
    if (!windowActive) {
        windowStart = now
    }

    // Always increment the consecutive failed counter (do NOT reset when window expires)
    const newCount = (user.failedLoginCount ?? 0) + 1

    // Decide outcome
    if (newCount >= LOCKOUT_MAX_ATTEMPTS) {
        if (windowActive) {
            // Hard lock
            await (prisma as any).user.update({
                where: { id: user.id },
                data: {
                    failedLoginCount: newCount,
                    hardLocked: true,
                    softLocked: false,
                    hardLockedAt: now,
                },
            })
            try {
                await audit.auth({
                    action: 'ACCOUNT_HARD_LOCKED',
                    actorType: 'USER',
                    actorId: user.id,
                    actorDisplay: username,
                    customerId: null,
                    requestId: undefined,
                    traceId: undefined,
                    spanId: undefined,
                    metadata: { username, failedLoginCount: newCount, windowMs: LOCKOUT_WINDOW_MS },
                    summary: 'Account hard locked due to rapid failed logins',
                    status: 'FAILURE',
                })
            } catch {}
            return { status: 'hard', remainingAttempts: 0 }
        } else {
            // Soft lock (consecutive failures reached outside rapid window)
            await (prisma as any).user.update({
                where: { id: user.id },
                data: {
                    failedLoginCount: newCount,
                    softLocked: true,
                    // set/refresh window start for subsequent rapid calculations
                    hardLockedAt: windowStart,
                },
            })
            try {
                await audit.auth({
                    action: 'ACCOUNT_SOFT_LOCKED',
                    actorType: 'USER',
                    actorId: user.id,
                    actorDisplay: username,
                    customerId: null,
                    requestId: undefined,
                    traceId: undefined,
                    spanId: undefined,
                    metadata: { username, failedLoginCount: newCount },
                    summary: 'Account soft locked after multiple failed logins',
                    status: 'WARNING',
                })
            } catch {}
            return { status: 'soft', remainingAttempts: 0 }
        }
    } else {
        // Normal failed increment: keep consecutive count growing; update/refresh window start
        await (prisma as any).user.update({
            where: { id: user.id },
            data: { failedLoginCount: newCount, hardLockedAt: windowStart },
        })
        const remaining = Math.max(0, LOCKOUT_MAX_ATTEMPTS - newCount)
        return { status: 'normal', remainingAttempts: remaining }
    }
}

/**
 * Clears soft lock and failed counter. Does not clear hard lock (admin only).
 */
export async function clearSoftLockAndCounter(userId: string) {
    try {
        await (prisma as any).user.update({
            where: { id: userId },
            data: { failedLoginCount: 0, softLocked: false, hardLockedAt: null },
        })
        try {
            await audit.auth({
                action: 'ACCOUNT_UNLOCKED',
                actorType: 'USER',
                actorId: userId,
                actorDisplay: undefined,
                customerId: null,
                requestId: undefined,
                traceId: undefined,
                spanId: undefined,
                metadata: { reason: 'PASSWORD_RESET_OR_SUCCESSFUL_LOGIN' },
                summary: 'Account unlocked (soft lock cleared)',
                status: 'SUCCESS',
            })
        } catch {}
    } catch {}
}

/**
 * Admin-only: Clears ALL lock state for a user (soft + hard) and resets counters.
 * Optionally records the admin who performed the unlock.
 */
export async function adminUnlockAccount(targetUserId: string, adminUserId?: string) {
    try {
        await (prisma as any).user.update({
            where: { id: targetUserId },
            data: { failedLoginCount: 0, softLocked: false, hardLocked: false, hardLockedAt: null },
        })
        try {
            await audit.auth({
                action: 'ACCOUNT_UNLOCKED_BY_ADMIN',
                actorType: 'USER',
                actorId: adminUserId ?? null,
                actorDisplay: undefined,
                customerId: null,
                requestId: undefined,
                traceId: undefined,
                spanId: undefined,
                entityType: 'USER',
                entityId: targetUserId,
                metadata: { reason: 'ADMIN_UNLOCK' },
                summary: 'Account unlocked by administrator',
                status: 'SUCCESS',
            })
        } catch {}
    } catch {}
}

export function getPasswordHashParts(password: string) {
    const hash = crypto
        .createHash('sha1')
        .update(password, 'utf8')
        .digest('hex')
        .toUpperCase()
    return [hash.slice(0, 5), hash.slice(5)] as const
}

export async function checkIsCommonPassword(password: string) {
    const [prefix, suffix] = getPasswordHashParts(password)

    try {
        const response = await fetch(
            `https://api.pwnedpasswords.com/range/${prefix}`,
            { signal: AbortSignal.timeout(1000) },
        )

        if (!response.ok) return false

        const data = await response.text()
        return data.split(/\r?\n/).some((line) => {
            const [hashSuffix, ignoredPrevalenceCount] = line.split(':')
            return hashSuffix === suffix
        })
    } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
            console.warn('Password check timed out')
            return false
        }

        console.warn('Unknown error during password check', error)
        return false
    }
}

// ============================================================
// Password history & reuse helpers
// Policy: Disallow using any of the last 5 passwords (including current)
// ============================================================

/**
 * Returns true if the provided candidate password matches the user's current
 * password or any of the last 5 historical passwords.
 */
export async function isPasswordReused(userId: string, candidate: string) {
    if (!userId || !candidate) return false
    // Check current password hash first
    const current = await prisma.password.findUnique({ where: { userId }, select: { hash: true } })
    if (current?.hash) {
        const sameAsCurrent = await bcrypt.compare(candidate, current.hash)
        if (sameAsCurrent) return true
    }
    // Check last 5 from history (if table/model exists)
    try {
        const histories: Array<{ id: string; hash: string }> = await (prisma as any).passwordHistory.findMany({
            where: { userId },
            select: { id: true, hash: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
        })
        for (const row of histories) {
            if (row?.hash && (await bcrypt.compare(candidate, row.hash))) {
                return true
            }
        }
    } catch {
        // If the PasswordHistory table is not present or client not generated, fail open on history but we already checked current
        // console.warn('PasswordHistory lookup failed', e)
    }
    return false
}

/**
 * Captures the user's CURRENT password hash into PasswordHistory, then trims
 * history to keep only the 5 most recent entries.
 */
export async function captureCurrentPasswordToHistory(userId: string) {
    if (!userId) return
    const current = await prisma.password.findUnique({ where: { userId }, select: { hash: true } })
    if (!current?.hash) return
    try {
        // Insert current hash into history
        await (prisma as any).passwordHistory.create({ data: { userId, hash: current.hash } })
        // Trim to last 5
        const allIds: Array<{ id: string }> = await (prisma as any).passwordHistory.findMany({
            where: { userId },
            select: { id: true },
            orderBy: { createdAt: 'desc' },
        })
        const extras = allIds.slice(5)
        if (extras.length > 0) {
            await (prisma as any).passwordHistory.deleteMany({ where: { id: { in: extras.map((r) => r.id) } } })
        }
    } catch {
        // If table not present, skip silently (policy enforcement still relies on current hash check)
        // console.warn('PasswordHistory capture failed', e)
    }
}

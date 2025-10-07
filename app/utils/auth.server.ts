// app/utils/auth.server.ts

import crypto from 'node:crypto'
import { type Password } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { redirect } from 'react-router'
import { safeRedirect } from 'remix-utils/safe-redirect'
import { audit } from '#app/services/audit.server.ts'
import { rateLimit } from '#app/utils/rate-limit.server.ts'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { prisma } from './db.server.ts'
import { combineHeaders } from './misc.tsx'
import { authSessionStorage } from './session.server.ts'
// uploadProfileImage no longer needed (OAuth avatar sync removed)

export const SESSION_EXPIRATION_TIME = 1000 * 60 * 60 * 24 * 30
export const getSessionExpirationDate = () =>
    new Date(Date.now() + SESSION_EXPIRATION_TIME)

export const sessionKey = 'sessionId'

// OAuth/passkey providers removed – username/password + mandatory TOTP only.

export async function getUserId(request: Request) {
    const authSession = await authSessionStorage.getSession(
        request.headers.get('cookie'),
    )
    const sessionId = authSession.get(sessionKey)
    if (!sessionId) return null

    const session = await prisma.session.findUnique({
        select: { id: true, userId: true, expirationDate: true },
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

    // Update last active (updatedAt) best-effort and ignore failures
    if (session?.id) {
        void prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } }).catch(() => {})
    }

    // 2FA enforcement consistency, periodic re-verification, and per-request password expiry enforcement (defense in depth)
    try {
        const url = new URL(request.url)
        const pathname = url.pathname
        // Allow-list auth & 2FA related endpoints to avoid redirect loops
        const allowPrefixes = ['/login', '/logout', '/2fa', '/2fa-setup', '/resources', '/change-password']
        const isAllowed = allowPrefixes.some(p => pathname === p || pathname.startsWith(p + '/'))
        if (!isAllowed) {
            // Fetch twoFactorEnabled field (reuse earlier user fetch if expanded in future; here we re-query lightweight)
            const user2fa = await prisma.user.findUnique({ where: { id: session.userId }, select: { twoFactorEnabled: true, passwordChangedAt: true, mustChangePassword: true } })
            const mustReverifyDays = Number(process.env.MFA_REVERIFY_INTERVAL_DAYS || 0)
            const verifiedTime = authSession.get('verified-time') as number | undefined
            const nowMs = Date.now()
            let requireReverify = false
            if (mustReverifyDays > 0 && verifiedTime) {
                const maxAgeMs = mustReverifyDays * 24 * 60 * 60 * 1000
                if (nowMs - verifiedTime > maxAgeMs) requireReverify = true
            } else if (mustReverifyDays > 0 && !verifiedTime) {
                // If policy enabled but no timestamp recorded, force verification
                requireReverify = true
            }

            if (!user2fa?.twoFactorEnabled) {
                // Enforce mandatory MFA enrollment if somehow session exists without it (e.g., policy change after session established)
                throw redirect('/2fa-setup')
            }
            if (requireReverify) {
                // Stash unverified session for reuse by 2FA route just like initial login
                // (We intentionally do not destroy session; 2FA flow will re-set verified-time)
                try {
                    await (prisma as any).securityEvent.create({
                        data: {
                            kind: 'MFA_REVERIFY_REQUIRED',
                            userId: session.userId,
                            success: true,
                            reason: 'MFA_REVERIFY_INTERVAL_EXCEEDED',
                            data: { maxDays: mustReverifyDays },
                        },
                    })
                } catch {}
                throw redirect('/2fa')
            }

            // Always enforce per-request password expiry (hardcoded policy)
            const expired = isPasswordExpired(user2fa?.passwordChangedAt)
            if (expired && pathname !== '/change-password') {
                if (user2fa && !(user2fa as any).mustChangePassword) {
                    try { await prisma.user.update({ where: { id: session.userId }, data: { mustChangePassword: true } }) } catch {}
                }
                try {
                    await (prisma as any).securityEvent.create({
                        data: {
                            kind: 'PASSWORD_EXPIRED_ENFORCED',
                            userId: session.userId,
                            success: true,
                            reason: 'PASSWORD_EXPIRED_REQUEST',
                            data: { onRequest: true },
                        },
                    })
                } catch {}
                throw redirect('/change-password')
            }
        }
    } catch (e) {
        if (e instanceof Response) throw e
        // Swallow unexpected errors to avoid blocking normal auth; optionally log
        // console.warn('2FA enforcement check failed', e)
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
    // Load user record up-front to apply lockout logic atomically
    // Fallback path retained because type generation appears to still mismatch in current build context
    const baseUser = await prisma.user.findUnique({
        where: { username: username.toLowerCase() },
        select: { id: true, active: true },
    })
    let userRecord: { id: string; active: boolean; failedLoginCount: number; lockedUntil: Date | null } | null = null
    if (baseUser) {
        let failedLoginCount = 0
        let lockedUntil: Date | null = null
        try {
            const rows: any = await prisma.$queryRawUnsafe(
                'SELECT failedLoginCount, lockedUntil FROM User WHERE id = ? LIMIT 1',
                baseUser.id,
            )
            const row = Array.isArray(rows) ? rows[0] : rows
            if (row) {
                if (typeof row.failedLoginCount === 'number') failedLoginCount = row.failedLoginCount
                if (row.lockedUntil) lockedUntil = new Date(row.lockedUntil)
            }
        } catch {}
        userRecord = { id: baseUser.id, active: baseUser.active, failedLoginCount, lockedUntil }
    }

    const lockoutEnabled = process.env.LOCKOUT_ENABLED === 'true'
    const now = new Date()
    if (lockoutEnabled && userRecord?.lockedUntil && userRecord.lockedUntil > now) {
        // Still locked
        await audit.auth({
            action: 'LOGIN_LOCKED',
            actorType: 'USER',
            actorId: userRecord.id,
            actorDisplay: username,
            actorIp: ctx.ip ?? null,
            actorUserAgent: ctx.userAgent ?? null,
            customerId: null,
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            metadata: { username, lockedUntil: userRecord.lockedUntil.toISOString() },
            summary: 'Login attempt while account locked',
            status: 'FAILURE',
        })
        // SecurityEvent: locked login attempt
        try {
            await (prisma as any).securityEvent.create({
                data: {
                    kind: 'LOGIN_FAILURE_LOCKED',
                    userId: userRecord.id,
                    userEmail: null,
                    ip: ctx.ip,
                    userAgent: ctx.userAgent,
                    success: false,
                    reason: 'ACCOUNT_LOCKED',
                    data: { username },
                },
            })
        } catch {}
        return null
    }

    // Rate limiting: apply per IP and per username bucket before password verification.
    const ipKey = ctx.ip ? `login:ip:${ctx.ip}` : null
    const userKey = `login:user:${username.toLowerCase()}`
    const limitCapacity = Number(process.env.LOGIN_RL_CAPACITY || 10)
    const refillPerSec = Number(process.env.LOGIN_RL_REFILL_PER_SEC || 0.2) // 1 token per 5s default
    function check(key: string | null) {
        if (!key) return null
        return rateLimit(key, { capacity: limitCapacity, refillPerSec })
    }
    const ipRes = check(ipKey)
    const userRes = check(userKey)
    if ((ipRes && !ipRes.allowed) || (userRes && !userRes.allowed)) {
        const retryMs = Math.max(ipRes?.retryAfterMs || 0, userRes?.retryAfterMs || 0)
        try {
            await (prisma as any).securityEvent.create({
                data: {
                    kind: 'LOGIN_RATE_LIMITED',
                    userId: null,
                    ip: ctx.ip,
                    userAgent: ctx.userAgent,
                    success: false,
                    reason: 'RATE_LIMIT',
                    data: {
                        username,
                        retryAfterMs: retryMs,
                        ipRemaining: ipRes?.remaining,
                        userRemaining: userRes?.remaining,
                    },
                },
            })
        } catch {}
        // Uniform response: behave like generic failure to avoid oracle.
        return null
    }

    const verified = await verifyUserPassword({ username }, password)
    if (!verified) {
        // On failure, increment counters and maybe lock
    if (lockoutEnabled && userRecord?.id) {
            const threshold = Number(process.env.LOCKOUT_THRESHOLD || 10)
            const baseCooldownSec = Number(process.env.LOCKOUT_BASE_COOLDOWN_SEC || 300)
            // naive exponential:  base * 2^(floor(failures/threshold)-1)
            const nextFails = (userRecord.failedLoginCount ?? 0) + 1
            let lockedUntil: Date | null = null
            if (nextFails >= threshold) {
                const multiplier = Math.max(1, Math.floor(nextFails / threshold))
                const cooldownMs = baseCooldownSec * 1000 * Math.pow(2, multiplier - 1)
                lockedUntil = new Date(Date.now() + cooldownMs)
            }
            try {
                const prismaAny = prisma as any
                await prismaAny.user.update({
                    where: { id: userRecord.id },
                    data: { failedLoginCount: { increment: 1 }, lockedUntil },
                    select: { id: true },
                })
                userRecord.failedLoginCount += 1
                userRecord.lockedUntil = lockedUntil ?? null
            } catch {}
            const wasLocked = Boolean(lockedUntil)
            await audit.auth({
                action: lockedUntil ? 'AUTH_LOCKOUT_TRIGGERED' : 'LOGIN_FAILURE',
                actorType: 'USER',
                actorId: userRecord.id,
                actorDisplay: username,
                actorIp: ctx.ip ?? null,
                actorUserAgent: ctx.userAgent ?? null,
                customerId: null,
                requestId: ctx.requestId,
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                metadata: { username, failures: nextFails, threshold, lockedUntil: lockedUntil?.toISOString() },
                summary: lockedUntil ? 'Account locked due to repeated failures' : 'Login failed',
                status: 'FAILURE',
            })
            // SecurityEvent for lockout or failure with lockout enabled path
            try {
                await (prisma as any).securityEvent.create({
                    data: {
                        kind: wasLocked ? 'AUTH_LOCKOUT_TRIGGERED' : 'LOGIN_FAILURE',
                        userId: userRecord.id,
                        userEmail: null,
                        ip: ctx.ip,
                        userAgent: ctx.userAgent,
                        success: false,
                        reason: wasLocked ? 'LOCKOUT' : 'INVALID_CREDENTIALS',
                        data: { username, failures: userRecord.failedLoginCount, threshold },
                    },
                })
            } catch {}
        } else {
            await audit.auth({
                action: 'LOGIN_FAILURE',
                actorType: 'USER',
                actorId: userRecord?.id,
                actorDisplay: username,
                actorIp: ctx.ip ?? null,
                actorUserAgent: ctx.userAgent ?? null,
                customerId: null,
                requestId: ctx.requestId,
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                metadata: { username, reason: 'INVALID_CREDENTIALS' },
                summary: 'Login failed',
                status: 'FAILURE',
            })
        }
        // SecurityEvent: generic login failure outside lockout path
        try {
            await (prisma as any).securityEvent.create({
                data: {
                    kind: 'LOGIN_FAILURE',
                    userId: userRecord?.id || null,
                    userEmail: null,
                    ip: ctx.ip,
                    userAgent: ctx.userAgent,
                    success: false,
                    reason: 'INVALID_CREDENTIALS',
                    data: { username },
                },
            })
        } catch {}
        return null
    }

    // Success: clear failure counters if previously set
    if (lockoutEnabled && userRecord?.id && (userRecord.failedLoginCount > 0 || userRecord.lockedUntil)) {
        try {
            const prismaAny = prisma as any
            await prismaAny.user.update({
                where: { id: userRecord.id },
                data: { failedLoginCount: 0, lockedUntil: null },
                select: { id: true },
            })
        } catch {}
        await audit.auth({
            action: 'AUTH_LOCKOUT_CLEARED',
            actorType: 'USER',
            actorId: userRecord.id,
            actorDisplay: username,
            actorIp: ctx.ip ?? null,
            actorUserAgent: ctx.userAgent ?? null,
            customerId: null,
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            metadata: { username },
            summary: 'Cleared failed login counters after successful auth',
            status: 'SUCCESS',
        })
    }

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
        actorIp: ctx.ip ?? null,
        actorUserAgent: ctx.userAgent ?? null,
        customerId: ctx.customerId ?? null,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        metadata: { username, sessionId: session.id, ip: ctx.ip, userAgent: ctx.userAgent },
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
    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, password: { select: { hash: true } } } })
    if (!user) throw new Error('User not found')
    const reused = await isPasswordReused(user.id, password)
    if (reused) {
        await audit.security({
            action: 'PASSWORD_REUSE_BLOCKED',
            actorType: 'USER',
            actorId: user.id,
            status: 'FAILURE',
            summary: 'Attempted to set a previously used password',
            metadata: { username, policy: { historyLimit: PASSWORD_HISTORY_LIMIT } },
        })
        return null
    }
    // capture current hash to history BEFORE overwriting
    await captureCurrentPasswordToHistory(user.id)
    const hashedPassword = await getPasswordHash(password)
    const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
            passwordChangedAt: new Date(),
            mustChangePassword: false,
            password: { upsert: { update: { hash: hashedPassword }, create: { hash: hashedPassword } } },
        },
        select: { id: true },
    })
    await audit.security({
        action: 'PASSWORD_RESET_SUCCESS',
        actorType: 'USER',
        actorId: user.id,
        status: 'SUCCESS',
        summary: 'Password reset',
        metadata: { username },
    })
    return updated
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
    // No history check on signup (new user) but set passwordChangedAt for expiry tracking

    // Ensure basic-user role exists for isolated test DBs (seed may not have run)
    await prisma.role.upsert({
        where: { name: 'basic-user' },
        update: {},
        create: { name: 'basic-user', description: 'Basic user (auto-created)' },
    })
    const session = await prisma.session.create({
        data: {
            expirationDate: getSessionExpirationDate(),
            user: {
                create: {
                    email: email.toLowerCase(),
                    username: username.toLowerCase(),
                    name,
                    roles: { connect: { name: 'basic-user' } },
                    password: { create: { hash: hashedPassword } },
                    passwordChangedAt: new Date(),
                },
            },
        },
        select: { id: true, expirationDate: true },
    })

    return session
}

// Removed signupWithConnection – external OAuth onboarding no longer supported.

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
        actorIp: ctx.ip ?? null,
        actorUserAgent: ctx.userAgent ?? null,
        customerId: ctx.customerId ?? null,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        metadata: { sessionId, redirectTo, ip: ctx.ip, userAgent: ctx.userAgent },
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

// Password policy helpers: history + expiry (hardcoded)
export const PASSWORD_MAX_AGE_DAYS = 60
export const PASSWORD_HISTORY_LIMIT = 5

export async function isPasswordReused(userId: string, newPlainPassword: string) {
    // Compare against current and last 5 history hashes
    const current = await prisma.password.findUnique({ where: { userId } })
    if (current && await bcrypt.compare(newPlainPassword, current.hash)) return true
    const history = await (prisma as any).passwordHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: PASSWORD_HISTORY_LIMIT,
        select: { hash: true },
    })
    for (const h of history) {
        if (await bcrypt.compare(newPlainPassword, (h as { hash: string }).hash)) return true
    }
    return false
}

export async function captureCurrentPasswordToHistory(userId: string) {
    // Push current hash into history and keep only last PASSWORD_HISTORY_LIMIT entries
    const current = await prisma.password.findUnique({ where: { userId }, select: { hash: true } })
    if (current?.hash) {
        await (prisma as any).passwordHistory.create({ data: { userId, hash: current.hash } })
        // Trim extras beyond limit
        const extra = await (prisma as any).passwordHistory.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            skip: PASSWORD_HISTORY_LIMIT,
            select: { id: true },
        })
        if (extra.length) {
            await (prisma as any).passwordHistory.deleteMany({ where: { id: { in: (extra as Array<{ id: string }>).map((e) => e.id) } } })
        }
    }
}

export function isPasswordExpired(passwordChangedAt: Date | null | undefined) {
    if (!passwordChangedAt) return true
    const ageMs = Date.now() - passwordChangedAt.getTime()
    const maxMs = PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    return ageMs > maxMs
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

    // Allow disabling the breach check entirely (perf / offline) via env.
    if (process.env.PASSWORD_BREACH_CHECK === 'false') return false

    // Allow tuning timeout; default lowered from 1000ms to 600ms to reduce perceived latency.
    const timeoutMs = Number(process.env.PASSWORD_PWNED_TIMEOUT_MS || 600)

    try {
        const response = await fetch(
            `https://api.pwnedpasswords.com/range/${prefix}`,
            { signal: AbortSignal.timeout(timeoutMs) },
        )

        if (!response.ok) return false

        const data = await response.text()
        return data.split(/\r?\n/).some((line) => {
            const [hashSuffix, ignoredPrevalenceCount] = line.split(':')
            return hashSuffix === suffix
        })
    } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
        if (process.env.PASSWORD_BREACH_CHECK_LOG !== 'false') {
            // Preserve legacy message strings so existing tests remain valid.
            if (timedOut) {
                console.warn('Password check timed out')
            } else {
                console.warn('Unknown error during password check', error)
            }
        }
        // Fail open (treat as not common) so we do not block password changes on network issues.
        return false
    }
}

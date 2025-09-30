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
        return null
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

// Password policy helpers: history + expiry
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

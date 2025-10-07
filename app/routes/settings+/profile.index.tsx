import { parseWithZod } from '@conform-to/zod'
import { invariantResponse } from '@epic-web/invariant'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { Img } from 'openimg/react'
import { data, Link, useFetcher, Form, redirect } from 'react-router'
import { z } from 'zod'
import { CsrfInput } from '#app/components/csrf-input.tsx'
import { Field } from '#app/components/forms.tsx'
import { Button } from '#app/components/ui/button.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import { requireUserId, sessionKey } from '#app/utils/auth.server.ts'
import { getOrCreateCsrfToken, assertCsrf } from '#app/utils/csrf.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { cn, getUserImgSrc, useDoubleCheck } from '#app/utils/misc.tsx'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { authSessionStorage } from '#app/utils/session.server.ts'
import { NameSchema, UsernameSchema } from '#app/utils/user-validation.ts'
import { type Route } from './+types/profile.index.ts'

export const handle: SEOHandle = {
    getSitemapEntries: () => null,
}

const ProfileFormSchema = z.object({
    name: NameSchema.nullable().default(null),
    username: UsernameSchema,
})

export async function loader({ request }: Route.LoaderArgs) {
    const userId = await requireUserId(request)
    // Identify the current session id from cookie
    const authSession = await authSessionStorage.getSession(
        request.headers.get('cookie'),
    )
    const currentSessionId = (authSession.get(sessionKey) as string | undefined) || null

    const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            username: true,
            email: true,
            twoFactorEnabled: true,
            image: { select: { objectKey: true } },
            _count: {
                select: {
                    sessions: { where: { expirationDate: { gt: new Date() } } },
                },
            },
        },
    })

    const password = await prisma.password.findUnique({
        select: { userId: true },
        where: { userId },
    })

    // Fetch all active sessions for this user
    const sessions = await prisma.session.findMany({
        where: { userId, expirationDate: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, updatedAt: true, expirationDate: true },
    })

    // Enrich sessions with IP and User-Agent from last LOGIN_SUCCESS audit for that session
    // We fetch recent AUTH events for this user and map by sessionId embedded in metadata
    const authEvents = await prisma.auditEvent.findMany({
        where: { category: 'AUTH', action: 'LOGIN_SUCCESS', actorId: userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { createdAt: true, actorIp: true, actorUserAgent: true, metadata: true },
    })
    const metaBySession: Record<string, { ip?: string | null; userAgent?: string | null; loginAt?: string }> = {}
    for (const ev of authEvents) {
        try {
            const md: any = ev.metadata ? JSON.parse(ev.metadata) : undefined
            const sid: string | undefined = md?.sessionId as string | undefined
            if (sid && !metaBySession[sid]) {
                const mdIp = md && typeof md.ip === 'string' ? (md.ip as string) : undefined
                const mdUa = md && typeof md.userAgent === 'string' ? (md.userAgent as string) : undefined
                metaBySession[sid] = {
                    ip: ev.actorIp ?? mdIp ?? null,
                    userAgent: ev.actorUserAgent ?? mdUa ?? null,
                    loginAt: ev.createdAt?.toISOString?.() ?? undefined,
                }
            }
        } catch {}
    }

    const { token } = await getOrCreateCsrfToken(request)
    return {
        user,
        hasPassword: Boolean(password),
        isTwoFactorEnabled: Boolean(user.twoFactorEnabled),
        sessions: sessions.map((s) => ({
            ...s,
            ip: metaBySession[s.id]?.ip ?? null,
            userAgent: metaBySession[s.id]?.userAgent ?? null,
            loginAt: metaBySession[s.id]?.loginAt ?? null,
        })),
        currentSessionId,
        csrf: token,
    }
    // Note: we intentionally do not set cookie here if unchanged; if new token generated, setCookie will be defined
}

type ProfileActionArgs = {
    request: Request
    userId: string
    formData: FormData
}
const profileUpdateActionIntent = 'update-profile'
const signOutOfSessionsActionIntent = 'sign-out-of-sessions'
const revokeSessionIntent = 'revoke-session'

export async function action({ request }: Route.ActionArgs) {
    const userId = await requireUserId(request)
    const formData = await request.formData()
    await assertCsrf(request, formData)
    const intent = formData.get('intent')
    switch (intent) {
        case profileUpdateActionIntent: {
            return profileUpdateAction({ request, userId, formData })
        }
        case signOutOfSessionsActionIntent: {
            return signOutOfSessionsAction({ request, userId, formData })
        }
        case revokeSessionIntent: {
            return revokeSessionAction({ request, userId, formData })
        }
        default: {
            throw new Response(`Invalid intent "${intent}"`, { status: 400 })
        }
    }
}

export default function EditUserProfile({ loaderData }: Route.ComponentProps) {
    return (
        <div className="flex flex-col gap-12">
            {/* Avatar + edit photo */}
            <div className="flex justify-center">
                <div className="relative size-52">
                    <Img
                        src={getUserImgSrc(loaderData.user.image?.objectKey)}
                        alt={loaderData.user.name ?? loaderData.user.username}
                        className="h-full w-full rounded-full object-cover"
                        width={832}
                        height={832}
                        isAboveFold
                    />
                    <Button
                        asChild
                        variant="outline"
                        className="absolute top-3 -right-3 flex size-10 items-center justify-center rounded-full p-0"
                        title="Edit profile photo"
                    >
                        <Link
                            preventScrollReset
                            to="photo"
                            title="Change profile photo"
                            aria-label="Change profile photo"
                        >
                            <Icon name="camera" className="size-4" />
                        </Link>
                    </Button>
                </div>
            </div>

            {/* Read-only profile fields */}
            <ReadOnlyProfile loaderData={loaderData} />

            {/* divider */}
            <div className="border-foreground col-span-6 my-6 h-1 border-b-[1.5px]" />

            {/* Security items */}
            <div className="col-span-full flex flex-col gap-6">
                <div>
                    <Link
                        to="two-factor"
                        className="flex items-center gap-3 p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                    >
                        {loaderData.isTwoFactorEnabled ? (
                            <>
                                <Icon name="lock-closed" className="size-5 text-green-600" />
                                <div>
                                    <div className="font-medium">Two-Factor Authentication</div>
                                    <div className="text-sm text-gray-500">2FA is enabled</div>
                                </div>
                            </>
                        ) : (
                            <>
                                <Icon name="lock-open-1" className="size-5 text-orange-600" />
                                <div>
                                    <div className="font-medium">Enable Two-Factor Authentication</div>
                                    <div className="text-sm text-gray-500">
                                        Add extra security to your account
                                    </div>
                                </div>
                            </>
                        )}
                    </Link>
                </div>

                <div>
                    <Link
                        to={loaderData.hasPassword ? 'password' : 'password/create'}
                        className="flex items-center gap-3 p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                    >
                        <Icon name="dots-horizontal" className="size-5 text-purple-600" />
                        <div>
                            <div className="font-medium">
                                {loaderData.hasPassword ? 'Change Password' : 'Create a Password'}
                            </div>
                            <div className="text-sm text-gray-500">
                                {loaderData.hasPassword
                                    ? 'Update your current password'
                                    : 'Set up password authentication'}
                            </div>
                        </div>
                    </Link>
                </div>

                <SignOutOfSessions loaderData={loaderData} />

                <ActiveSessionsList loaderData={loaderData} />
            </div>
        </div>
    )
}

/**
 * Read-only view of profile basics (no submit, no save).
 */
function ReadOnlyProfile({
                             loaderData,
                         }: {
    loaderData: Awaited<ReturnType<typeof loader>>
}) {
    return (
        <div className="grid grid-cols-6 gap-x-10">
            <Field
                className="col-span-3"
                labelProps={{ htmlFor: 'username', children: 'Username' }}
                inputProps={{
                    id: 'username',
                    name: 'username',
                    type: 'text',
                    defaultValue: loaderData.user.username,
                    readOnly: true,
                    disabled: true,
                }}
                errors={[]}
            />
            <Field
                className="col-span-3"
                labelProps={{ htmlFor: 'name', children: 'Name' }}
                inputProps={{
                    id: 'name',
                    name: 'name',
                    type: 'text',
                    defaultValue: loaderData.user.name ?? '',
                    readOnly: true,
                    disabled: true,
                }}
                errors={[]}
            />
        </div>
    )
}

/** Kept for completeness; not reachable from UI anymore. */
async function profileUpdateAction({ userId, formData }: ProfileActionArgs) {
    const submission = await parseWithZod(formData, {
        async: true,
        schema: ProfileFormSchema.superRefine(async ({ username }, ctx) => {
            const existingUsername = await prisma.user.findUnique({
                where: { username },
                select: { id: true },
            })
            if (existingUsername && existingUsername.id !== userId) {
                ctx.addIssue({
                    path: ['username'],
                    code: z.ZodIssueCode.custom,
                    message: 'A user already exists with this username',
                })
            }
        }),
    })
    if (submission.status !== 'success') {
        return data(
            { result: submission.reply() },
            { status: submission.status === 'error' ? 400 : 200 },
        )
    }

    const { username, name } = submission.value

    await prisma.user.update({
        select: { username: true },
        where: { id: userId },
        data: { name, username },
    })

    return { result: submission.reply() }
}

async function signOutOfSessionsAction({ request, userId }: ProfileActionArgs) {
    const authSession = await authSessionStorage.getSession(
        request.headers.get('cookie'),
    )
    const sessionId = authSession.get(sessionKey)
    invariantResponse(
        sessionId,
        'You must be authenticated to sign out of other sessions',
    )
    const ctx = await extractRequestContext(request, { requireUser: false })
    const result = await prisma.session.deleteMany({
        where: { userId, id: { not: sessionId } },
    })
    await audit.auth({
        action: 'SESSION_LOGOUT_OTHERS',
        actorType: 'USER',
        actorId: userId,
        actorIp: ctx.ip ?? null,
        actorUserAgent: ctx.userAgent ?? null,
        status: 'SUCCESS',
        summary: 'User signed out of other active sessions',
        metadata: { keptSessionId: sessionId, deletedCount: result.count },
    })
    return { status: 'success' } as const
}

async function revokeSessionAction({ request, userId, formData }: ProfileActionArgs) {
    const sessionIdToDelete = String(formData.get('sessionId') || '')
    if (!sessionIdToDelete) throw new Response('Missing sessionId', { status: 400 })

    const authSession = await authSessionStorage.getSession(
        request.headers.get('cookie'),
    )
    const currentSessionId = (authSession.get(sessionKey) as string | undefined) || null

    // Ensure the session belongs to this user
    const target = await prisma.session.findUnique({ where: { id: sessionIdToDelete }, select: { userId: true } })
    if (!target || target.userId !== userId) throw new Response('Not found', { status: 404 })

    await prisma.session.delete({ where: { id: sessionIdToDelete } })
    // Audit the targeted revoke
    const ctx = await extractRequestContext(request, { requireUser: false })
    await audit.auth({
        action: 'SESSION_REVOKE',
        actorType: 'USER',
        actorId: userId,
        actorIp: ctx.ip ?? null,
        actorUserAgent: ctx.userAgent ?? null,
        status: 'SUCCESS',
        summary: 'User revoked a specific session',
        metadata: { sessionId: sessionIdToDelete, selfRevoked: currentSessionId === sessionIdToDelete },
    })

    // If the user revoked their current session, log them out
    if (currentSessionId && currentSessionId === sessionIdToDelete) {
        authSession.unset(sessionKey)
        return redirect('/login', {
            headers: {
                'set-cookie': await authSessionStorage.commitSession(authSession),
            },
        })
    }
    return { status: 'success' } as const
}

function SignOutOfSessions({
                               loaderData,
                           }: {
    loaderData: Awaited<ReturnType<typeof loader>>
}) {
    const dc = useDoubleCheck()
    const fetcher = useFetcher<typeof signOutOfSessionsAction>()
    const otherSessionsCount = loaderData.user._count.sessions - 1

    return (
        <div className="p-3 rounded-lg border">
            {otherSessionsCount ? (
                <fetcher.Form method="POST" className="flex items-center gap-3">
                    <CsrfInput />
                    <Icon name="exit" className="size-5 text-red-600" />
                    <div className="flex-1">
                        <div className="font-medium">Sign Out Other Sessions</div>
                        <div className="text-sm text-gray-500">
                            You have {otherSessionsCount} other active sessions
                        </div>
                    </div>
                    <StatusButton
                        {...dc.getButtonProps({
                            type: 'submit',
                            name: 'intent',
                            value: signOutOfSessionsActionIntent,
                        })}
                        variant={dc.doubleCheck ? 'destructive' : 'outline'}
                        size="sm"
                        status={
                            fetcher.state !== 'idle'
                                ? 'pending'
                                : (fetcher.data?.status ?? 'idle')
                        }
                    >
                        {dc.doubleCheck ? 'Are you sure?' : 'Sign Out'}
                    </StatusButton>
                </fetcher.Form>
            ) : (
                <div className="flex items-center gap-3">
                    <Icon name="check" className="size-5 text-green-600" />
                    <div>
                        <div className="font-medium">Session Security</div>
                        <div className="text-sm text-gray-500">This is your only active session</div>
                    </div>
                </div>
            )}
        </div>
    )
}

function ActiveSessionsList({
    loaderData,
}: {
    loaderData: Awaited<ReturnType<typeof loader>>
}) {
    const fetcher = useFetcher<typeof revokeSessionAction>()
    const sessions = loaderData.sessions
    if (!sessions?.length) return null

    function formatUserAgent(ua?: string | null) {
        if (!ua) return 'Unknown device'
        const s = ua
        // Detect browser (order matters)
    let browser = 'Unknown'
    let version: string = ''
        // Edge
    let m = s.match(/Edg\/(\d+)/)
    if (m) { browser = 'Edge'; version = m[1] || '' }
        // Opera
    if (browser === 'Unknown') { m = s.match(/OPR\/(\d+)/); if (m) { browser = 'Opera'; version = m[1] || '' } }
        // Firefox
    if (browser === 'Unknown') { m = s.match(/Firefox\/(\d+)/); if (m) { browser = 'Firefox'; version = m[1] || '' } }
        // Chrome (exclude Edge/Opera already matched)
    if (browser === 'Unknown') { m = s.match(/Chrome\/(\d+)/); if (m) { browser = 'Chrome'; version = m[1] || '' } }
        // Safari (Version/x.y present for Safari)
    if (browser === 'Unknown') { m = s.match(/Version\/(\d+).+Safari\//); if (m) { browser = 'Safari'; version = m[1] || '' } }

        // Detect OS
        let os = 'Unknown OS'
        // Windows
        m = s.match(/Windows NT ([0-9.]+)/)
        if (m) {
            const map: Record<string, string> = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7' }
            const v = m[1] || ''
            os = v ? (map[v] || `Windows ${v}`) : 'Windows'
        }
        // macOS
        if (os === 'Unknown OS') {
            m = s.match(/Mac OS X (\d+)[_.](\d+)(?:[_.](\d+))?/)
            if (m) {
                const major = m[1], minor = m[2]
                os = `macOS ${major}.${minor}`
            }
        }
        // iOS
        if (os === 'Unknown OS') {
            m = s.match(/iPhone OS (\d+)[_.](\d+)/)
            if (m) os = `iOS ${m[1]}.${m[2]}`
        }
        // Android
        if (os === 'Unknown OS') {
            m = s.match(/Android (\d+(?:\.\d+)?)/)
            if (m) os = `Android ${m[1]}`
        }

        return `${browser}${version ? ' ' + version : ''} on ${os}`
    }

    function formatET(date: Date) {
        try {
            return new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                dateStyle: 'medium',
                timeStyle: 'medium',
                timeZoneName: 'short', // shows EST/EDT as appropriate
            }).format(date)
        } catch {
            return date.toLocaleString('en-US', { timeZone: 'America/New_York' })
        }
    }

    function isMobile(ua?: string | null) {
        if (!ua) return false
        return /(Mobi|Android|iPhone|iPad|iPod)/i.test(ua)
    }

    return (
        <div className="p-3 rounded-lg border">
            <div className="font-medium mb-2">Active Sessions</div>
            <div className="text-sm text-gray-500 mb-4">Manage where you're signed in. Signing out a session logs that device out.</div>
            <ul className="divide-y">
                {sessions.map((s) => {
                    const isCurrent = s.id === loaderData.currentSessionId
                    const ua = formatUserAgent(s.userAgent)
                    const ip = s.ip || 'Unknown IP'
                    const mobile = isMobile(s.userAgent)
                    const tzLabel = 'ET'
                    const lastActive = s.updatedAt ? new Date(s.updatedAt as any) : new Date(s.createdAt as any)
                    return (
                        <li key={s.id} className="py-3 flex items-start gap-3">
                            <Icon name={mobile ? 'hero:phone' : 'laptop'} className={cn('size-5 mt-1', isCurrent ? 'text-green-600' : 'text-gray-600')} />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="truncate">
                                        <div className="font-medium truncate">{isCurrent ? 'This device' : 'Other device'}</div>
                                        <div className="text-xs text-gray-500 truncate">{ua}</div>
                                    </div>
                                    <div className="shrink-0">
                                        {isCurrent ? (
                                            <Form method="POST">
                                                <CsrfInput />
                                                <input type="hidden" name="intent" value={revokeSessionIntent} />
                                                <input type="hidden" name="sessionId" value={s.id} />
                                                <Button variant="outline" size="sm">Sign out</Button>
                                            </Form>
                                        ) : (
                                            <fetcher.Form method="POST">
                                                <CsrfInput />
                                                <input type="hidden" name="intent" value={revokeSessionIntent} />
                                                <input type="hidden" name="sessionId" value={s.id} />
                                                <StatusButton size="sm" variant="outline" status={fetcher.state !== 'idle' ? 'pending' : (fetcher.data?.status ?? 'idle')}>Sign out</StatusButton>
                                            </fetcher.Form>
                                        )}
                                    </div>
                                </div>
                                <div className="text-xs text-gray-500 mt-1">
                                    <span>IP: {ip}</span>
                                    <span className="mx-2">•</span>
                                    <span>
                                        Signed in: {formatET(s.loginAt ? new Date(s.loginAt) : new Date(s.createdAt as any))} ({tzLabel})
                                    </span>
                                    <span className="mx-2">•</span>
                                    <span>
                                        Last active: {formatET(lastActive)} ({tzLabel})
                                    </span>
                                </div>
                            </div>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

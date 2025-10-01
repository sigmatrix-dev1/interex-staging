import { parseWithZod } from '@conform-to/zod'
import { invariantResponse } from '@epic-web/invariant'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { Img } from 'openimg/react'
import { data, Link, useFetcher } from 'react-router'
import { z } from 'zod'
import { Field } from '#app/components/forms.tsx'
import { Button } from '#app/components/ui/button.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireUserId, sessionKey } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { getUserImgSrc, useDoubleCheck } from '#app/utils/misc.tsx'
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

    return {
        user,
        hasPassword: Boolean(password),
        isTwoFactorEnabled: Boolean(user.twoFactorEnabled),
    }
}

type ProfileActionArgs = {
    request: Request
    userId: string
    formData: FormData
}
const profileUpdateActionIntent = 'update-profile'
const signOutOfSessionsActionIntent = 'sign-out-of-sessions'

export async function action({ request }: Route.ActionArgs) {
    const userId = await requireUserId(request)
    const formData = await request.formData()
    const intent = formData.get('intent')
    switch (intent) {
        case profileUpdateActionIntent: {
            return profileUpdateAction({ request, userId, formData })
        }
        case signOutOfSessionsActionIntent: {
            return signOutOfSessionsAction({ request, userId, formData })
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
    await prisma.session.deleteMany({
        where: { userId, id: { not: sessionId } },
    })
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

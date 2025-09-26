import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { data, Form, redirect, useSearchParams } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireAnonymous } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { verifyTwoFactorToken } from '#app/utils/twofa.server.ts'
import { verifySessionStorage } from '#app/utils/verification.server.ts'
import { handleNewSession } from './login.server.ts'

const TwoFALoginSchema = z.object({
	code: z.string().min(6, 'Verification code must be 6 digits').max(6),
	redirectTo: z.string().optional(),
})

export async function loader({ request }: { request: Request }) {
	await requireAnonymous(request)
	const verifySession = await verifySessionStorage.getSession(request.headers.get('cookie'))
	const unverifiedId = verifySession.get('unverified-session-id') as string | undefined
	if (!unverifiedId) throw redirect('/login')
	const session = await prisma.session.findUnique({ where: { id: unverifiedId }, select: { userId: true } })
	if (!session?.userId) throw redirect('/login')
	const user = await prisma.user.findUnique({
		where: { id: session.userId },
		select: { username: true, twoFactorEnabled: true, twoFactorSecret: true },
	})
	if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
		// If 2FA not configured, send to setup flow
		const url = new URL(request.url)
		return redirect(`/2fa-setup?${url.searchParams.toString()}`)
	}
	return { username: user.username }
}

export async function action({ request }: { request: Request }) {
	await requireAnonymous(request)
	const formData = await request.formData()
	
	const submission = await parseWithZod(formData, {
		schema: TwoFALoginSchema.transform(async (data, ctx) => {
			// Get user and verify 2FA is enabled
			const verifySession = await verifySessionStorage.getSession(request.headers.get('cookie'))
			const unverifiedId = verifySession.get('unverified-session-id') as string | undefined
			if (!unverifiedId) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Invalid or expired verification session',
				})
				return z.NEVER
			}
			const sess = await prisma.session.findUnique({ where: { id: unverifiedId }, select: { userId: true } })
			if (!sess?.userId) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid session' })
				return z.NEVER
			}
			const user = await prisma.user.findUnique({ where: { id: sess.userId }, select: { twoFactorEnabled: true, twoFactorSecret: true } })
			if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: '2FA not configured' })
				return z.NEVER
			}
			// Verify the 2FA code
			const isValid = await verifyTwoFactorToken(user.twoFactorSecret, data.code)
			if (!isValid) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Invalid verification code',
					path: ['code'],
				})
				return z.NEVER
			}
			return { ...data, sessionId: unverifiedId }
		}),
		async: true,
	})

	if (submission.status !== 'success' || !submission.value.sessionId) {
		return data(
			{ result: submission.reply({ hideFields: ['code'] }) },
			{ status: submission.status === 'error' ? 400 : 200 }
		)
	}

	const { sessionId, redirectTo } = submission.value
	// Build minimal session stub; handleNewSession only needs id and userId for redirects, but it refetches user by session id.
	const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true, userId: true, expirationDate: true } })
	if (!session) {
		return data({ result: submission.reply({ formErrors: ['Session expired. Please log in again.'] }) }, { status: 400 })
	}

	// Pull remember from verify session (set during login)
	const verifySession = await verifySessionStorage.getSession(request.headers.get('cookie'))
	const remember = !!verifySession.get('remember')
	return handleNewSession({ request, session, remember, redirectTo, twoFAVerified: true })
}

export default function TwoFALoginPage({ loaderData, actionData }: { loaderData: any; actionData: any }) {
	const { username } = loaderData
	const isPending = useIsPending()
	const [searchParams] = useSearchParams()
	const redirectTo = searchParams.get('redirectTo')

	const [form, fields] = useForm({
		id: '2fa-login',
		constraint: getZodConstraint(TwoFALoginSchema),
	defaultValue: { redirectTo },
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: TwoFALoginSchema })
		},
	})

	return (
		<div className="flex min-h-full flex-col justify-center pt-20 pb-32 bg-gray-50">
			<div className="mx-auto w-full max-w-md px-4 sm:px-0">
				<div className="rounded-2xl border border-gray-200 bg-white/95 shadow-xl ring-1 ring-black/5 backdrop-blur-sm">
					<div className="px-6 py-6 sm:px-8 sm:py-8">
						<div className="flex flex-col gap-3 text-center mb-6">
							<h1 className="text-h2">Two-Factor Authentication</h1>
							<p className="text-body-md text-muted-foreground text-blue-900">
								Enter the 6-digit code from your authenticator app
							</p>
							<p className="text-sm text-gray-500">
								Logging in as: <strong>{username}</strong>
							</p>
						</div>

						<Form method="post" {...getFormProps(form)}>
							<input {...getInputProps(fields.redirectTo, { type: 'hidden' })} />
							
							<Field
								labelProps={{ children: 'Verification Code' }}
								inputProps={{
									...getInputProps(fields.code, { type: 'text' }),
									placeholder: '000000',
									maxLength: 6,
									className: 'text-center text-2xl tracking-widest font-mono',
									autoFocus: true,
									autoComplete: 'one-time-code',
								}}
								errors={fields.code.errors}
							/>

							<ErrorList errors={form.errors} id={form.errorId} />

							<div className="flex flex-col gap-4 pt-4">
								<StatusButton
									className="w-full rounded-md bg-gray-900 text-white shadow-sm hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition"
									status={isPending ? 'pending' : (form.status ?? 'idle')}
									type="submit"
									disabled={isPending}
								>
									Verify & Sign In
								</StatusButton>
								
								<a
									href="/login"
									className="text-center text-sm text-gray-600 hover:text-gray-900"
								>
									← Back to login
								</a>
							</div>
						</Form>
					</div>
				</div>
			</div>
		</div>
	)
}

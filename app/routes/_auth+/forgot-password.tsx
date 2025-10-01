// app/routes/_auth+/forgot-password.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import * as E from '@react-email/components'
import { data, redirect, Link, useFetcher } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList, Field } from '#app/components/forms.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { prisma } from '#app/utils/db.server.ts'
import { sendEmail } from '#app/utils/email.server.ts'
import { checkHoneypot } from '#app/utils/honeypot.server.ts'
import { EmailSchema, UsernameSchema } from '#app/utils/user-validation.ts'
import { type Route } from './+types/forgot-password.ts'
import { prepareVerification } from './verify.server.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const ForgotPasswordSchema = z.object({
	usernameOrEmail: z.union([EmailSchema, UsernameSchema]),
})

export async function action({ request }: Route.ActionArgs) {
	const formData = await request.formData()
	await checkHoneypot(formData)
	const submission = await parseWithZod(formData, {
		schema: ForgotPasswordSchema.superRefine(async (data, ctx) => {
				const user = await (prisma as any).user.findFirst({
					where: {
						OR: [
							{ email: data.usernameOrEmail },
							{ username: data.usernameOrEmail },
						],
					},
					select: { id: true, hardLocked: true },
				})
				if (!user) {
					ctx.addIssue({
						path: ['usernameOrEmail'],
						code: z.ZodIssueCode.custom,
						message: 'No user exists with this username or email',
					})
					return
				}
				if (user.hardLocked) {
					ctx.addIssue({
						path: ['usernameOrEmail'],
						code: z.ZodIssueCode.custom,
						message: 'Password reset is disabled for this account. Please contact your administrator.',
					})
					return
				}
			}),
		async: true,
	})
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}
	const { usernameOrEmail } = submission.value

	const user = await (prisma as any).user.findFirstOrThrow({
		where: { OR: [{ email: usernameOrEmail }, { username: usernameOrEmail }] },
		select: { email: true, username: true, hardLocked: true },
	})

	if (user.hardLocked) {
		return data(
			{ result: submission.reply({ formErrors: ['Password reset is disabled for this account. Please contact your administrator.'] }) },
			{ status: 423 },
		)
	}

	const { verifyUrl, redirectTo, otp } = await prepareVerification({
		period: 10 * 60,
		request,
		type: 'reset-password',
		target: usernameOrEmail,
	})

	const response = await sendEmail({
		to: user.email,
		subject: `Interex Password Reset`,
		react: (
			<ForgotPasswordEmail onboardingUrl={verifyUrl.toString()} otp={otp} />
		),
	})

	if (response.status === 'success') {
		return redirect(redirectTo.toString())
	} else {
		return data(
			{ result: submission.reply({ formErrors: [response.error.message] }) },
			{ status: 500 },
		)
	}
}

function ForgotPasswordEmail({
	onboardingUrl,
	otp,
}: {
	onboardingUrl: string
	otp: string
}) {
	return (
		<E.Html lang="en" dir="ltr">
			<E.Container>
				<h1>
					<E.Text>Interex Password Reset</E.Text>
				</h1>
				<p>
					<E.Text>
						Here's your verification code: <strong>{otp}</strong>
					</E.Text>
				</p>
				<p>
					<E.Text>Or click the link:</E.Text>
				</p>
				<E.Link href={onboardingUrl}>{onboardingUrl}</E.Link>
			</E.Container>
		</E.Html>
	)
}

export const meta: Route.MetaFunction = () => {
	return [{ title: 'Password Recovery for Interex' }]
}

export default function ForgotPasswordRoute() {
	const forgotPassword = useFetcher<typeof action>()

	const [form, fields] = useForm({
		id: 'forgot-password-form',
		constraint: getZodConstraint(ForgotPasswordSchema),
		lastResult: forgotPassword.data?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ForgotPasswordSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	return (
		<div className="container pt-20 pb-32">
			<div className="flex flex-col justify-center">
				<div className="text-center">
					<h1 className="text-h1">Forgot Password</h1>
					<p className="text-body-md text-muted-foreground mt-3">
						No worries, we'll send you reset instructions.
					</p>
				</div>
				<div className="mx-auto mt-16 max-w-sm min-w-full sm:min-w-[368px]">
					{(() => {
						const formErrors = (form.errors ?? []) as string[]
						const usernameErrors = (fields.usernameOrEmail.errors ?? []) as string[]
						const fieldHardLock = usernameErrors.find(e => /disabled|hard\s*lock|locked/i.test(String(e)))
						const isHardLock = Boolean(fieldHardLock) || formErrors.some(e => /disabled|hard\s*lock|locked/i.test(String(e)))
						const hasFormError = formErrors.length > 0
						const showBanner = isHardLock || hasFormError
						if (!showBanner) return null
						const primaryError = hasFormError ? String(formErrors[0] ?? '') : String(fieldHardLock ?? '')
						return (
							<div
								role="alert"
								aria-live="polite"
								className={`${isHardLock ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'} mb-4 rounded-lg border p-4`}
							>
								<div className="flex items-start gap-3">
									<Icon
										name={isHardLock ? 'hero:warning' : 'hero:info'}
										className={`${isHardLock ? 'text-red-600' : 'text-amber-600'} h-5 w-5 mt-0.5`}
									/>
									<div className="space-y-1">
										<div className="font-semibold">
											{isHardLock ? 'Password reset disabled' : 'There was a problem'}
										</div>
										<div className="text-sm leading-5">{primaryError}</div>
										{isHardLock && (
											<div className="text-xs">Please contact your administrator to regain access.</div>
										)}
									</div>
								</div>
							</div>
						)
					})()}
					<forgotPassword.Form method="POST" {...getFormProps(form)}>
						<HoneypotInputs />
						<div>
							<Field
								labelProps={{
									htmlFor: fields.usernameOrEmail.id,
									children: 'Username or Email',
								}}
								inputProps={{
									autoFocus: true,
									...getInputProps(fields.usernameOrEmail, { type: 'text' }),
								}}
							errors={(() => {
								const usernameErrors = (fields.usernameOrEmail.errors ?? []) as string[]
								const isHardLock = usernameErrors.some(e => /disabled|hard\s*lock|locked/i.test(String(e)))
								return isHardLock ? [] : fields.usernameOrEmail.errors
							})()}
							/>
						</div>
						{(() => {
							const formErrors = (form.errors ?? []) as string[]
							const usernameErrors = (fields.usernameOrEmail.errors ?? []) as string[]
							const isHardLock = usernameErrors.some(e => /disabled|hard\s*lock|locked/i.test(String(e))) || formErrors.some(e => /disabled|hard\s*lock|locked/i.test(String(e)))
							const showBanner = isHardLock || formErrors.length > 0
							return <ErrorList errors={showBanner ? [] : form.errors} id={form.errorId} />
						})()}

						<div className="mt-6">
							<StatusButton
								className="w-full"
								status={
									forgotPassword.state === 'submitting'
										? 'pending'
										: (form.status ?? 'idle')
								}
								type="submit"
								disabled={forgotPassword.state !== 'idle'}
							>
								Recover password
							</StatusButton>
						</div>
					</forgotPassword.Form>
					<Link
						to="/login"
						className="text-body-sm mt-11 text-center font-bold"
					>
						Back to Login
					</Link>
				</div>
			</div>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

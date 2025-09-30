// app/routes/_auth+/login.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { useState } from 'react'
import { data, Form, Link, useSearchParams } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CheckboxField, ErrorList, Field } from '#app/components/forms.tsx'
import { Spacer } from '#app/components/spacer.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { login, requireAnonymous, verifyUserPassword } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { checkHoneypot } from '#app/utils/honeypot.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { PasswordSchema, UsernameSchema } from '#app/utils/user-validation.ts'
import { handleNewSession } from './login.server.ts'


export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const LoginFormSchema = z.object({
	username: UsernameSchema,
	password: PasswordSchema,
	redirectTo: z.string().optional(),
	remember: z.coerce.boolean().optional(),
  // When true, user acknowledges that logging in here will sign out other sessions
  confirmLogoutOthers: z.coerce.boolean().optional(),
})

// Passkey auth temporarily removed pending re-introduction with updated UX

export async function loader({ request }: { request: Request }) {
	await requireAnonymous(request)
	return {}
}

export async function action({ request }: { request: Request }) {
	await requireAnonymous(request)
	const formData = await request.formData()
	await checkHoneypot(formData)
	const submission = await parseWithZod(formData, {
		schema: LoginFormSchema,
		async: true,
	})

	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply({ hideFields: ['password'] }) },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { username, password, remember, redirectTo, confirmLogoutOthers } = submission.value

	// First, verify credentials without creating a session so we can decide UX
	const verified = await verifyUserPassword({ username }, password)
	if (!verified) {
		return data(
			{
				result: submission.reply({
					formErrors: ['Invalid username or password'],
					hideFields: ['password'],
				}),
			},
			{ status: 400 },
		)
	}

	// Check if user already has active sessions
	const activeCount = await prisma.session.count({
		where: { userId: verified.id, expirationDate: { gt: new Date() } },
	})

	if (activeCount > 0 && !confirmLogoutOthers) {
		// Ask user to confirm proceeding. Do NOT hide password so they can continue without retyping.
		return data(
			{
				warnExistingSessions: activeCount,
				result: submission.reply({
					formErrors: [
						activeCount === 1
							? 'There is already an active session for this account. Logging in here will sign out the other session.'
							: `There are ${activeCount} active sessions for this account. Logging in here will sign out all other sessions.`,
					],
				}),
			},
			{ status: 200 },
		)
	}

	// Proceed: create new session and then sign out other sessions
	const session = await login(request, { username, password })
	if (!session) {
		// Very unlikely (race), but handle just in case
		return data(
			{
				result: submission.reply({
					formErrors: ['Login failed. Please try again.'],
					hideFields: ['password'],
				}),
			},
			{ status: 400 },
		)
	}

	// Hand off to the shared session flow which:
	// - If 2FA is enabled, sets a verify session and redirects to /verify
	// - Else, commits the auth session and redirects to the dashboard or redirectTo
	return handleNewSession({
		request,
		session,
		remember: remember ?? false,
		redirectTo,
	    logoutOthers: true,
	})
}

export default function LoginPage({ actionData }: { actionData: any }) {
	const isPending = useIsPending()
	const [searchParams] = useSearchParams()
	const redirectTo = searchParams.get('redirectTo')

	const [form, fields] = useForm({
		id: 'login-form',
		constraint: getZodConstraint(LoginFormSchema),
		defaultValue: { redirectTo },
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: LoginFormSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	// 👁️ Show/Hide password toggle
	const [showPassword, setShowPassword] = useState(false)

	const showSessionWarning = Boolean(actionData?.warnExistingSessions)

	return (
		<div className="flex min-h-full flex-col justify-center pt-20 pb-32 bg-gray-50">
			<div className="mx-auto w-full max-w-md px-4 sm:px-0">
				{/* Card wrapper */}
				<div className="rounded-2xl border border-gray-200 bg-white/95 shadow-xl ring-1 ring-black/5 backdrop-blur-sm">
					<div className="px-6 py-6 sm:px-8 sm:py-8">
						<div className="flex flex-col gap-3 text-center">
							<h1 className="text-h2">Welcome back!</h1>
							<p className="text-body-md text-muted-foreground text-blue-900">
								InterEx Login.
							</p>
						</div>
						<Spacer size="xs" />

            {showSessionWarning && (
              <div className="mb-3 rounded border border-amber-300 bg-amber-50 text-amber-900 p-3 text-sm">
                <div className="font-medium">You’re already signed in elsewhere</div>
                <div>
                  Logging in here will sign out your other active session{actionData?.warnExistingSessions > 1 ? 's' : ''}.
                </div>
              </div>
            )}

						<Form method="POST" {...getFormProps(form)}>
							<input type="hidden" name="intent" value="submit" />
							<HoneypotInputs />
							<Field
								labelProps={{ children: 'Username' }}
								inputProps={{
									...getInputProps(fields.username, { type: 'text' }),
									autoFocus: true,
									className:
										'lowercase block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm ' +
										'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ' +
										'hover:border-gray-400 transition',
									autoComplete: 'username',
								}}
								errors={fields.username.errors}
							/>

							{/* Password field with eye toggle */}
							<div className="mb-4">
								<label className="block text-sm font-medium text-gray-700">
									Password
								</label>
								<div className="relative mt-1">
									<input
										{...getInputProps(fields.password, {
											type: showPassword ? 'text' : 'password',
										})}
										autoComplete="current-password"
										className={
											'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-gray-900 shadow-sm ' +
											'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ' +
											'hover:border-gray-400 transition'
										}
									/>
									<button
										type="button"
										onClick={() => setShowPassword(!showPassword)}
										className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700 focus:outline-none"
										tabIndex={-1}
										aria-label={showPassword ? 'Hide password' : 'Show password'}
									>
										{showPassword ? (
											<EyeIcon className="h-5 w-5 text-gray-500" />
										) : (
											<EyeSlashIcon className="h-5 w-5 text-gray-500" />
										)}
									</button>
								</div>
								{fields.password.errors?.length ? (
									<p className="mt-1 text-sm text-red-600">
										{fields.password.errors[0]}
									</p>
								) : null}
							</div>

							<div className="flex justify-between">
								<CheckboxField
									labelProps={{
										htmlFor: fields.remember.id,
										children: 'Remember me',
									}}
									buttonProps={getInputProps(fields.remember, {
										type: 'checkbox',
									})}
									errors={fields.remember.errors}
								/>
								<div>
									<Link
										to="/forgot-password"
										className="text-body-xs font-semibold"
									>
										Forgot password?
									</Link>
								</div>
							</div>

							<input
								{...getInputProps(fields.redirectTo, { type: 'hidden' })}
							/>
							<ErrorList errors={form.errors} id={form.errorId} />

							{/* Confirmation flag so second submit proceeds and logs out others */}
							{showSessionWarning && (
								<input type="hidden" name="confirmLogoutOthers" value="true" />
							)}

							<div className="flex items-center justify-between gap-6 pt-3">
								<StatusButton
									className="w-full rounded-md bg-gray-900 text-white shadow-sm
													 hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500
													 focus:ring-offset-2 transition"
									status={isPending ? 'pending' : (form.status ?? 'idle')}
									type="submit"
									disabled={isPending}
								>
									{showSessionWarning ? 'Continue and sign out others' : 'Log in'}
								</StatusButton>
							</div>
						</Form>
					</div>
				</div>
			</div>
		</div>
	)
}

// (passkey response schema removed with temporary passkey UI removal)

export const meta = () => {
	return [{ title: 'Login to Interex' }]
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

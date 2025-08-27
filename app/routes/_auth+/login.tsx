import { redirect } from '@remix-run/node'
import { Form, Link, useNavigate, useSearchParams } from 'react-router'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { startAuthentication } from '@simplewebauthn/browser'
import { useOptimistic, useState, useTransition } from 'react'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CheckboxField, ErrorList, Field } from '#app/components/forms.tsx'
import { Spacer } from '#app/components/spacer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { login, requireAnonymous } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import {
	ProviderConnectionForm,
	providerNames,
} from '#app/utils/connections.tsx'
import { checkHoneypot } from '#app/utils/honeypot.server.ts'
import { getErrorMessage, useIsPending } from '#app/utils/misc.tsx'
import { PasswordSchema, UsernameSchema } from '#app/utils/user-validation.ts'
import { handleNewSession } from './login.server.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const LoginFormSchema = z.object({
	username: UsernameSchema,
	password: PasswordSchema,
	redirectTo: z.string().optional(),
	remember: z.boolean().optional(),
})

const AuthenticationOptionsSchema = z.object({
	options: z.object({ challenge: z.string() }),
}) satisfies z.ZodType<{ options: PublicKeyCredentialRequestOptionsJSON }>

export async function loader({ request }: { request: Request }) {
	await requireAnonymous(request)
	return {}
}

export async function action({ request }: { request: Request }) {
	await requireAnonymous(request)
	const formData = await request.formData()
	await checkHoneypot(formData)
	const submission: any = await parseWithZod(formData, {
		schema: (intent) =>
			LoginFormSchema.transform(async (data, ctx) => {
				if (intent !== null) return { ...data, session: null }

				const session = await login(data)
				if (!session) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'Invalid username or password',
					})
					return z.NEVER
				}

				// Check if user has 2FA enabled
				const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { twoFactorEnabled: true } })
				if (user?.twoFactorEnabled) {
					return {
						result: submission?.reply ? submission.reply({ hideFields: ['password'] }) : undefined,
						redirectTo2FA: `/auth/2fa?userId=${session.userId}`
					}
				}

				return { ...data, session }
			}),
		async: true,
	})

	if (submission.value?.redirectTo2FA) {
		return redirect(submission.value.redirectTo2FA)
	}

	if (submission.status !== 'success' || !submission.value.session) {
		return {
			result: submission.reply({ hideFields: ['password'] }),
			status: submission.status === 'error' ? 400 : 200,
		}
	}

	const { session, remember, redirectTo } = submission.value

	return handleNewSession({
		request,
		session,
		remember: remember ?? false,
		redirectTo,
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

	const [showPassword, setShowPassword] = useState(false)

	return (
		<div className="flex min-h-screen flex-col">
			<div className="relative flex-1">
				<div className="absolute inset-0 -z-10 overflow-hidden">
					<svg
						className="absolute left-[calc(50%-11rem)] -z-10 transform-gpu overflow-visible rotate-[30deg] scale-[1.375] sm:left-[calc(50%-30rem)]"
						viewBox="0 0 404 384"
						aria-hidden="true"
					>
						<defs>
							<pattern
								id="f0b8f7a1-1f3b-4a4f-8e6f-efaeec6e6f3e"
								x="0"
								y="30"
								width=".135"
								height=".112"
								patternUnits="userSpaceOnUse"
							>
								<circle cx="1" cy="1" r=".6" fill="currentColor" />
							</pattern>
						</defs>
						<rect
							width="100%"
							height="100%"
							fill="url(#f0b8f7a1-1f3b-4a4f-8e6f-efaeec6e6f3e)"
						/>
					</svg>
					<svg
						className="absolute right-[calc(50%-7rem)] -z-10 -translate-x-1/2 rotate-[30deg] scale-[1.375] sm:right-[calc(50%+10rem)]"
						viewBox="0 0 404 384"
						aria-hidden="true"
					>
						<defs>
							<pattern
								id="f0b8f7a1-1f3b-4a4f-8e6f-efaeec6e6f3e"
								x="0"
								y="30"
								width=".135"
								height=".112"
								patternUnits="userSpaceOnUse"
							>
								<circle cx="1" cy="1" r=".6" fill="currentColor" />
							</pattern>
						</defs>
						<rect
							width="100%"
							height="100%"
							fill="url(#f0b8f7a1-1f3b-4a4f-8e6f-efaeec6e6f3e)"
						/>
					</svg>
				</div>
				<div className="flex h-full flex-col justify-center px-6 py-32">
					<div className="mx-auto max-w-sm">
						<h1 className="text-center text-3xl font-bold leading-tight text-gray-900">
							Sign in to your account
						</h1>

						<div className="mt-8 space-y-4">
							<Form
								method="post"
								{...getFormProps(form)}
								className="rounded-lg bg-white p-6 shadow-md"
							>
								{/* Username field */}
								<div className="mb-4">
									<label className="block text-sm font-medium text-gray-700">
										Username
									</label>
									<input
										{...getInputProps(fields.username, { type: 'text' })}
										autoFocus
										className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 hover:border-gray-400 transition"
										autoComplete="username"
									/>
									{fields.username.errors?.length ? (
										<p className="mt-1 text-sm text-red-600">
											{fields.username.errors[0]}
										</p>
									) : null}
								</div>

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

								<div className="flex items-center justify-between gap-6 pt-3">
									<StatusButton
										className="w-full rounded-md bg-gray-900 text-white shadow-sm
												 hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500
												 focus:ring-offset-2 transition"
										status={isPending ? 'pending' : (form.status ?? 'idle')}
										type="submit"
										disabled={isPending}
									>
										Log in
									</StatusButton>
								</div>
							</Form>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}

const VerificationResponseSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('success'),
		location: z.string(),
	}),
	z.object({
		status: z.literal('error'),
		error: z.string(),
	}),
])

function PasskeyLogin({
						  redirectTo,
						  remember,
					  }: {
	redirectTo: string | null
	remember: boolean
}) {
	const [isPending] = useTransition()
	const [error, setError] = useState<string | null>(null)
	const [passkeyMessage, setPasskeyMessage] = useOptimistic<string | null>(
		'Login with a passkey',
	)
	const navigate = useNavigate()

	async function handlePasskeyLogin() {
		try {
			setPasskeyMessage('Generating Authentication Options')
			// Get authentication options from the server
			const optionsResponse = await fetch('/webauthn/authentication')
			const json = await optionsResponse.json()
			const { options } = AuthenticationOptionsSchema.parse(json)

			setPasskeyMessage('Requesting your authorization')
			const authResponse = await startAuthentication({ optionsJSON: options })
			setPasskeyMessage('Verifying your passkey')

			// Verify the authentication with the server
			const verificationResponse = await fetch('/webauthn/authentication', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ authResponse, remember, redirectTo }),
			})

			const verificationJson = await verificationResponse.json().catch(() => ({
				status: 'error',
				error: 'Unknown error',
			}))

			const parsedResult =
				VerificationResponseSchema.safeParse(verificationJson)
			if (!parsedResult.success) {
				throw new Error(parsedResult.error.message)
			} else if (parsedResult.data.status === 'error') {
				throw new Error(parsedResult.data.error)
			}
			const { location } = parsedResult.data

			setPasskeyMessage("You're logged in! Navigating...")
			await navigate(location ?? '/')
		} catch (e) {
			const errorMessage = getErrorMessage(e)
			setError(`Failed to authenticate with passkey: ${errorMessage}`)
		}
	}

	return (
		<form action={handlePasskeyLogin}>
			<StatusButton
				id="passkey-login-button"
				aria-describedby="passkey-login-button-error"
				className="w-full"
				status={isPending ? 'pending' : error ? 'error' : 'idle'}
				type="submit"
				disabled={isPending}
			>
				<span className="inline-flex items-center gap-1.5">
					<Icon name="passkey" />
					<span>{passkeyMessage}</span>
				</span>
			</StatusButton>
			<div className="mt-2">
				<ErrorList errors={[error]} id="passkey-login-button-error" />
			</div>
		</form>
	)
}

// Remove Route.MetaFunction reference
export const meta = () => {
	return [{ title: 'Login to Interex' }]
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

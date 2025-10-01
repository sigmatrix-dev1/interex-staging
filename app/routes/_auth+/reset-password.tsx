// app/routes/_auth+/reset-password.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { EyeIcon, EyeSlashIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { useState } from 'react'
import { data, redirect, Form } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList } from '#app/components/forms.tsx'
import { Alert } from '#app/components/ui/alert.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import {
	checkIsCommonPassword,
	requireAnonymous,
	resetUserPassword,
	isPasswordReused,
	captureCurrentPasswordToHistory,
	clearSoftLockAndCounter,
} from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'
import { PASSWORD_REQUIREMENTS } from '#app/utils/password-requirements.ts'
import { PasswordAndConfirmPasswordSchema } from '#app/utils/user-validation.ts'
import { verifySessionStorage } from '#app/utils/verification.server.ts'
import { type Route } from './+types/reset-password.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export const resetPasswordUsernameSessionKey = 'resetPasswordUsername'

const ResetPasswordSchema = PasswordAndConfirmPasswordSchema

async function requireResetPasswordUsername(request: Request) {
	await requireAnonymous(request)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const resetPasswordUsername = verifySession.get(
		resetPasswordUsernameSessionKey,
	)
	if (typeof resetPasswordUsername !== 'string' || !resetPasswordUsername) {
		throw redirect('/login')
	}
	return resetPasswordUsername
}

export async function loader({ request }: Route.LoaderArgs) {
	const resetPasswordUsername = await requireResetPasswordUsername(request)
	return { resetPasswordUsername }
}

export async function action({ request }: Route.ActionArgs) {
	const resetPasswordUsername = await requireResetPasswordUsername(request)
	const formData = await request.formData()
	const submission = await parseWithZod(formData, {
		schema: ResetPasswordSchema.superRefine(async ({ password }, ctx) => {
			// Enforce new complexity
			const { ok, errors } = validatePasswordComplexity(password)
			if (!ok) {
				errors.forEach(msg => ctx.addIssue({ path: ['password'], code: 'custom', message: msg }))
			}
			// Hard block if password found in breaches
			if (ok) { // only if complexity passed to avoid extra network
				const isCommonPassword = await checkIsCommonPassword(password)
				if (isCommonPassword) {
					ctx.addIssue({
						path: ['password'],
						code: 'custom',
						message: 'Password appears in breach data; choose another.',
					})
				}
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
	const { password } = submission.value

	// Enforce last-5 reuse rule: map username to userId -> check -> capture history -> update
	const target = await prisma.user.findUnique({ where: { username: resetPasswordUsername }, select: { id: true } })
	if (target?.id) {
		if (await isPasswordReused(target.id, password)) {
			return data({ result: submission.reply({ fieldErrors: { password: ['New password cannot match any of the last 5.'] } }) }, { status: 400 })
		}
		await captureCurrentPasswordToHistory(target.id)
	}

	await resetUserPassword({ username: resetPasswordUsername, password })
	// Clear mustChangePassword flag & set passwordChangedAt
	// Cast for mustChangePassword until Prisma types updated
	await (prisma as any).user.update({
		where: { username: resetPasswordUsername },
		data: { mustChangePassword: false, passwordChangedAt: new Date() },
		select: { id: true },
	})
	const verifySession = await verifySessionStorage.getSession()

	// Clear any soft lock flags for this user (by id)
	try {
		const u = await prisma.user.findUnique({ where: { username: resetPasswordUsername }, select: { id: true } })
		if (u?.id) await clearSoftLockAndCounter(u.id)
	} catch {}
	return redirect('/login', {
		headers: {
			'set-cookie': await verifySessionStorage.destroySession(verifySession),
		},
	})
}

export const meta: Route.MetaFunction = () => {
	return [{ title: 'Reset Password | Interex' }]
}

export default function ResetPasswordPage({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const isPending = useIsPending()

	// Local state for show/hide and live validation display
	const [showPassword, setShowPassword] = useState(false)
	const [showConfirm, setShowConfirm] = useState(false)
	const [passwordInput, setPasswordInput] = useState('')
	const [confirmInput, setConfirmInput] = useState('')

	const [form, fields] = useForm({
		id: 'reset-password',
		constraint: getZodConstraint(ResetPasswordSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ResetPasswordSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	// Gather any form/field errors to show as a prominent alert
	const formLevelErrors: string[] = Array.isArray((actionData as any)?.result?.formErrors)
		? (actionData as any).result.formErrors
		: []
	const fieldPasswordErrors: string[] = (actionData as any)?.result?.fieldErrors?.password ?? []
	const fieldConfirmErrors: string[] = (actionData as any)?.result?.fieldErrors?.confirmPassword ?? []
	const allErrors = [...formLevelErrors, ...fieldPasswordErrors, ...fieldConfirmErrors]

	// Special-case: show a dedicated alert for password reuse ("last 5")
	const isReuseMessage = (s: string) => /last\s*5/i.test(s)
	const reuseErrorPresent =
		fieldPasswordErrors.some(isReuseMessage) || (fields.password.errors?.some?.(isReuseMessage) ?? false)
	const filteredAllErrors = allErrors.filter(e => !isReuseMessage(e))

	// Client-side checks to reflect requirement status as user types (UI only)
	const upperOk = /[A-Z]/.test(passwordInput)
	const lowerOk = /[a-z]/.test(passwordInput)
	const digitOk = /[0-9]/.test(passwordInput)
	const specialOk = /[!@#$%^&*()_+\-={}\[\]:;"'`~<>,.?/\\|]/.test(passwordInput)
	const lenOk = passwordInput.length >= 12 && passwordInput.length <= 24
	const trimOk = passwordInput.trim() === passwordInput
	const checklist = [
		{ label: PASSWORD_REQUIREMENTS[0], ok: lenOk },
		{ label: PASSWORD_REQUIREMENTS[1], ok: upperOk },
		{ label: PASSWORD_REQUIREMENTS[2], ok: lowerOk },
		{ label: PASSWORD_REQUIREMENTS[3], ok: digitOk },
		{ label: PASSWORD_REQUIREMENTS[4], ok: specialOk },
		{ label: PASSWORD_REQUIREMENTS[5], ok: trimOk },
	]

	return (
		<div className="container flex flex-col justify-center pt-20 pb-32">
			<div className="text-center">
				<h1 className="text-h1">Password Reset</h1>
				<p className="text-body-md text-muted-foreground mt-3">
					Hi, {loaderData.resetPasswordUsername}. No worries. It happens all the
					time.
				</p>
			</div>
			<div className="mx-auto mt-16 max-w-sm min-w-full sm:min-w-[368px]">
				<Form method="POST" {...getFormProps(form)}>
					{/* Prominent alert for any non-reuse errors */}
					{filteredAllErrors.length > 0 ? (
						<Alert className="mb-4" variant="error" heading="Please fix the following:" role="alert">
							<ul className="mt-2 list-disc pl-5">
								{filteredAllErrors.map((err, i) => (
									<li key={i}>{err}</li>
								))}
							</ul>
						</Alert>
					) : null}
					{/* New Password with show/hide and live checklist */}
					<div className="mb-4">
						<label className="block text-sm font-medium text-gray-700" htmlFor={fields.password.id}>
							New Password
						</label>
						<div className="relative mt-1">
							<input
								{...getInputProps(fields.password, {
									type: showPassword ? 'text' : 'password',
								})}
								onChange={e => setPasswordInput(e.currentTarget.value)}
								autoComplete="new-password"
								autoFocus
								className={
									'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-gray-900 shadow-sm ' +
									'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ' +
									'hover:border-gray-400 transition'
								}
							/>
							<button
								type="button"
								onClick={() => setShowPassword(v => !v)}
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
						{/* Dedicated alert for password reuse */}
						{reuseErrorPresent ? (
							<Alert className="mt-2" variant="error" heading="Password was recently used" role="alert" icon={<ExclamationTriangleIcon className="mt-0.5 h-5 w-5 text-red-600" aria-hidden="true" />}>
								New password cannot match any of the last 5. Please choose a new password you haven’t used recently.
							</Alert>
						) : null}
						{/* Inline error for other password issues */}
						{!reuseErrorPresent && fields.password.errors?.length ? (
							<p className="mt-1 text-sm text-red-600">{fields.password.errors[0]}</p>
						) : null}

						{/* Requirements checklist */}
						<ul className="mt-3 space-y-1 text-sm">
							{checklist.map(item => (
								<li key={item.label} className={item.ok ? 'text-green-700' : 'text-gray-600'}>
									{item.ok ? (
										<CheckCircleIcon className="mr-2 inline-block h-4 w-4 text-green-600 align-middle" aria-hidden="true" />
									) : (
										<span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-gray-300 align-middle" />
									)}
									{item.label}
								</li>
							))}
						</ul>
					</div>
					{/* Confirm Password with show/hide */}
					<div className="mb-4">
						<label className="block text-sm font-medium text-gray-700" htmlFor={fields.confirmPassword.id}>
							Confirm Password
						</label>
						<div className="relative mt-1">
							<input
								{...getInputProps(fields.confirmPassword, {
									type: showConfirm ? 'text' : 'password',
								})}
								onChange={e => setConfirmInput(e.currentTarget.value)}
								autoComplete="new-password"
								className={
									'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-gray-900 shadow-sm ' +
									'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ' +
									'hover:border-gray-400 transition'
								}
							/>
							<button
								type="button"
								onClick={() => setShowConfirm(v => !v)}
								className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700 focus:outline-none"
								tabIndex={-1}
								aria-label={showConfirm ? 'Hide password' : 'Show password'}
							>
								{showConfirm ? (
									<EyeIcon className="h-5 w-5 text-gray-500" />
								) : (
									<EyeSlashIcon className="h-5 w-5 text-gray-500" />
								)}
							</button>
						</div>
						{fields.confirmPassword.errors?.length ? (
							<p className="mt-1 text-sm text-red-600">{fields.confirmPassword.errors[0]}</p>
						) : null}
						{confirmInput.length > 0 ? (
							<p
								className={
									'mt-1 text-sm ' +
									(confirmInput === passwordInput ? 'text-green-700' : 'text-red-600')
								}
							>
								{confirmInput === passwordInput
									? 'Passwords match'
									: 'Passwords do not match'}
							</p>
						) : null}
					</div>

					<ErrorList errors={form.errors} id={form.errorId} />

					<StatusButton
						className="w-full"
						status={isPending ? 'pending' : (form.status ?? 'idle')}
						type="submit"
						disabled={isPending}
					>
						Reset password
					</StatusButton>
				</Form>
			</div>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

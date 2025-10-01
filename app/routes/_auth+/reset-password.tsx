// app/routes/_auth+/reset-password.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import React from 'react'
import { data, redirect, Form } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList } from '#app/components/forms.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import {
	checkIsCommonPassword,
	requireAnonymous,
	isPasswordReused,
	captureCurrentPasswordToHistory,
	getPasswordHash,
} from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'
import { PASSWORD_REQUIREMENTS } from '#app/utils/password-requirements.ts'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
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
	const ctx = await extractRequestContext(request, { requireUser: false })
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

	// Prevent reuse of current or last 5
	const user = await (prisma as any).user.findUnique({ where: { username: resetPasswordUsername }, select: { id: true, customerId: true, softLocked: true, failedLoginCount: true } })
	if (!user) throw redirect('/login')
	if (await isPasswordReused(user.id, password)) {
		await audit.auth({
			action: 'PASSWORD_RESET',
			status: 'FAILURE',
			actorType: 'USER',
			actorId: user.id,
			actorDisplay: ctx.actorDisplay ?? null,
			actorIp: ctx.ip ?? null,
			actorUserAgent: ctx.userAgent ?? null,
			customerId: user.customerId ?? null,
			chainKey: user.customerId || 'global',
			entityType: 'User',
			entityId: user.id,
			summary: 'Password reset rejected: password reuse detected',
			metadata: { reason: 'REUSE_BLOCK', lastN: 5, username: resetPasswordUsername },
		})
		return data(
			{ result: submission.reply({ formErrors: ['New password cannot match any of the last 5 passwords.'] }) },
			{ status: 400 },
		)
	}
	// Capture current into history and then set new password
	await captureCurrentPasswordToHistory(user.id)
	const hash = await getPasswordHash(password)
	await prisma.password.upsert({
		where: { userId: user.id },
		update: { hash },
		create: { userId: user.id, hash },
	})
	// Clear mustChangePassword flag & set passwordChangedAt
	// Cast for mustChangePassword until Prisma types updated
	await (prisma as any).user.update({
		where: { id: user.id },
		data: { mustChangePassword: false, passwordChangedAt: new Date(), softLocked: false, failedLoginCount: 0 },
		select: { id: true },
	})

	// If the account was soft-locked, record an unlock event
	if (user.softLocked) {
		await audit.security({
			action: 'ACCOUNT_UNLOCKED',
			actorType: 'USER',
			actorId: user.id,
			actorDisplay: ctx.actorDisplay ?? null,
			actorIp: ctx.ip ?? null,
			actorUserAgent: ctx.userAgent ?? null,
			customerId: user.customerId ?? null,
			entityType: 'USER',
			entityId: user.id,
			summary: 'Account unlocked via password reset',
			metadata: { username: resetPasswordUsername, reason: 'PASSWORD_RESET' },
		})
	}

	await audit.auth({
		action: 'PASSWORD_RESET',
		actorType: 'USER',
		actorId: user.id,
		actorDisplay: ctx.actorDisplay ?? null,
		actorIp: ctx.ip ?? null,
		actorUserAgent: ctx.userAgent ?? null,
		customerId: user.customerId ?? null,
		chainKey: user.customerId || 'global',
		entityType: 'User',
		entityId: user.id,
		summary: 'User reset password via reset flow',
		metadata: { username: resetPasswordUsername },
	})
	const verifySession = await verifySessionStorage.getSession()
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
	const [showPwd, setShowPwd] = React.useState(false)
	const [showConfirm, setShowConfirm] = React.useState(false)
	const [pwd, setPwd] = React.useState('')

	const [form, fields] = useForm({
		id: 'reset-password',
		constraint: getZodConstraint(ResetPasswordSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ResetPasswordSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	// Live checks mirror server complexity rules
	const checks = [
		{ label: PASSWORD_REQUIREMENTS[0], ok: pwd.length >= 12 && pwd.length <= 24 },
		{ label: PASSWORD_REQUIREMENTS[1], ok: /[A-Z]/.test(pwd) },
		{ label: PASSWORD_REQUIREMENTS[2], ok: /[a-z]/.test(pwd) },
		{ label: PASSWORD_REQUIREMENTS[3], ok: /\d/.test(pwd) },
		{ label: PASSWORD_REQUIREMENTS[4], ok: /[^A-Za-z0-9]/.test(pwd) },
		{ label: PASSWORD_REQUIREMENTS[5], ok: !(pwd.startsWith(' ') || pwd.endsWith(' ')) },
	]
	const allOk = checks.every(c => c.ok)

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
					<div className="space-y-2">
						<label className="text-sm font-medium text-gray-700" htmlFor={fields.password.id}>New Password</label>
						<div className="relative">
							<input
								{...getInputProps(fields.password, { type: showPwd ? 'text' : 'password' })}
								id={fields.password.id}
								autoComplete="new-password"
								autoFocus
								onChange={e => setPwd(e.currentTarget.value)}
								className="w-full rounded-md border border-gray-300 pr-10 py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
							/>
							<button
								type="button"
								onClick={() => setShowPwd(s => !s)}
								className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700"
								aria-label={showPwd ? 'Hide password' : 'Show password'}
							>
								<Icon name={showPwd ? 'hero:eye' : 'hero:eye-slash'} className="h-5 w-5" />
							</button>
						</div>
						{fields.password.errors?.length ? (
							<ul className="text-xs text-red-600 space-y-0.5">
								{fields.password.errors.map(e => <li key={e}>{e}</li>)}
							</ul>
						) : null}
						<ul className="text-[11px] leading-4 space-y-0.5 mt-1">
							{checks.map(c => (
								<li key={c.label} className={c.ok ? 'text-green-600 flex items-center gap-1' : 'text-gray-500 flex items-center gap-1'}>
									{c.ok ? <Icon name="check" className="h-3 w-3" /> : <span className="text-xs">•</span>}
									<span>{c.label}</span>
								</li>
							))}
							{pwd && (
								<li className={allOk ? 'text-green-600 flex items-center gap-1' : 'text-gray-400 flex items-center gap-1'}>
									{allOk ? <Icon name="check" className="h-3 w-3" /> : <span className="text-xs">•</span>}
									<span>{allOk ? 'Looks good' : 'Keep typing to satisfy all requirements'}</span>
								</li>
							)}
						</ul>
					</div>

					<div className="space-y-2 mt-4">
						<label className="text-sm font-medium text-gray-700" htmlFor={fields.confirmPassword.id}>Confirm Password</label>
						<div className="relative">
							<input
								{...getInputProps(fields.confirmPassword, { type: showConfirm ? 'text' : 'password' })}
								id={fields.confirmPassword.id}
								autoComplete="new-password"
								className="w-full rounded-md border border-gray-300 pr-10 py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
							/>
							<button
								type="button"
								onClick={() => setShowConfirm(s => !s)}
								className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700"
								aria-label={showConfirm ? 'Hide password' : 'Show password'}
							>
								<Icon name={showConfirm ? 'hero:eye' : 'hero:eye-slash'} className="h-5 w-5" />
							</button>
						</div>
						{fields.confirmPassword.errors?.length ? (
							<ul className="text-xs text-red-600 space-y-0.5">
								{fields.confirmPassword.errors.map(e => <li key={e}>{e}</li>)}
							</ul>
						) : null}
						{pwd ? (
						  <div className={
							(fields.confirmPassword.value && fields.confirmPassword.value === pwd)
							  ? 'text-[11px] text-green-600 mt-1 flex items-center gap-1'
							  : 'text-[11px] text-gray-500 mt-1 flex items-center gap-1'
						  }>
							{(fields.confirmPassword.value && fields.confirmPassword.value === pwd)
							  ? <Icon name="check" className="h-3 w-3" />
							  : <span className="text-xs">•</span>}
							<span>{(fields.confirmPassword.value && fields.confirmPassword.value === pwd) ? 'Passwords match' : 'Passwords must match'}</span>
						  </div>
						) : null}
					</div>

					<ErrorList errors={form.errors} id={form.errorId} />

					<StatusButton
						className="w-full mt-2"
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

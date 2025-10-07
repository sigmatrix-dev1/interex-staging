// app/routes/_auth+/reset-password.tsx

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { data, redirect, Form } from 'react-router'
import { CsrfInput } from '#app/components/csrf-input.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList, Field } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import {
	checkIsCommonPassword,
	requireAnonymous,
	isPasswordReused,
	captureCurrentPasswordToHistory,
	getPasswordHash,
} from '#app/utils/auth.server.ts'
import { assertCsrf } from '#app/utils/csrf.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'
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
	await assertCsrf(request, formData)
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
	const user = await prisma.user.findUnique({ where: { username: resetPasswordUsername }, select: { id: true, customerId: true } })
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
		data: { mustChangePassword: false, passwordChangedAt: new Date() },
		select: { id: true },
	})

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

	const [form, fields] = useForm({
		id: 'reset-password',
		constraint: getZodConstraint(ResetPasswordSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ResetPasswordSchema })
		},
		shouldRevalidate: 'onBlur',
	})

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
					<CsrfInput />
					<Field
						labelProps={{
							htmlFor: fields.password.id,
							children: 'New Password',
						}}
						inputProps={{
							...getInputProps(fields.password, { type: 'password' }),
							autoComplete: 'new-password',
							autoFocus: true,
						}}
						errors={fields.password.errors}
					/>
					<Field
						labelProps={{
							htmlFor: fields.confirmPassword.id,
							children: 'Confirm Password',
						}}
						inputProps={{
							...getInputProps(fields.confirmPassword, { type: 'password' }),
							autoComplete: 'new-password',
						}}
						errors={fields.confirmPassword.errors}
					/>

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

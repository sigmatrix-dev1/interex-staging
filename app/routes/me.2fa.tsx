import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { useState } from 'react'
import { data, Form, redirect } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { 
	generateTwoFactorSecret, 
	verifyTwoFactorToken, 
	enableTwoFactorForUser,
	disableTwoFactorForUser,
	getUserTwoFactorStatus 
} from '#app/utils/twofa.server.ts'

const TwoFAVerifySchema = z.object({
	code: z.string().min(6, 'Verification code must be 6 digits').max(6),
	secret: z.string(),
})

const TwoFADisableSchema = z.object({
	action: z.literal('disable'),
})

export async function loader({ request }: { request: Request }) {
	const userId = await requireUserId(request)
	const twoFAStatus = await getUserTwoFactorStatus(userId)
	
	if (!twoFAStatus) {
		throw new Response('User not found', { status: 404 })
	}

	return { 
		twoFactorEnabled: twoFAStatus.twoFactorEnabled,
		userId 
	}
}

export async function action({ request }: { request: Request }) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	
	const intent = formData.get('intent')
	
	// Handle disable 2FA
	if (intent === 'disable') {
		const submission = parseWithZod(formData, { schema: TwoFADisableSchema })
		if (submission.status === 'success') {
			await disableTwoFactorForUser(userId)
			return redirect('/me/2fa')
		}
		return data({ result: submission.reply() }, { status: 400 })
	}
	
	// Handle setup/verification
	if (intent === 'verify') {
		const submission = await parseWithZod(formData, {
			schema: TwoFAVerifySchema.transform(async (data, ctx) => {
				const isValid = await verifyTwoFactorToken(data.secret, data.code)
				if (!isValid) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'Invalid verification code',
						path: ['code'],
					})
					return z.NEVER
				}
				return data
			}),
			async: true,
		})

		if (submission.status !== 'success') {
			return data({ result: submission.reply() }, { status: 400 })
		}

		await enableTwoFactorForUser(userId, submission.value.secret)
		return redirect('/me/2fa')
	}
	
	// Default: generate new secret for setup
	const user = await getUserTwoFactorStatus(userId)
	if (!user) {
		throw new Response('User not found', { status: 404 })
	}
	
	// Get username for the QR code (you may need to adjust this query)
	const userInfo = await prisma.user.findUnique({
		where: { id: userId },
		select: { username: true }
	})
	
	if (!userInfo) {
		throw new Response('User not found', { status: 404 })
	}

	const { secret, qrCode } = await generateTwoFactorSecret(userInfo.username)
	
	return data({ setupData: { secret, qrCode } })
}

export default function TwoFAPage({ loaderData, actionData }: { loaderData: any; actionData: any }) {
	const { twoFactorEnabled } = loaderData
	const isPending = useIsPending()
	const [showSetup, setShowSetup] = useState(!!actionData?.setupData)

	const [form, fields] = useForm({
		id: '2fa-verify',
		constraint: getZodConstraint(TwoFAVerifySchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: TwoFAVerifySchema })
		},
	})

	if (twoFactorEnabled) {
		return (
			<div className="container mx-auto max-w-md py-8">
				<div className="rounded-lg bg-white p-6 shadow-md">
					<h1 className="text-2xl font-bold text-gray-900 mb-4">Two-Factor Authentication</h1>
					<div className="bg-green-50 border border-green-200 rounded-md p-4 mb-6">
						<div className="flex">
							<div className="flex-shrink-0">
								<svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
									<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
								</svg>
							</div>
							<div className="ml-3">
								<p className="text-sm text-green-800">
									Two-factor authentication is <strong>enabled</strong> on your account.
								</p>
							</div>
						</div>
					</div>
					
					<Form method="post">
						<input type="hidden" name="intent" value="disable" />
						<StatusButton
							type="submit"
							variant="destructive"
							status={isPending ? 'pending' : 'idle'}
							className="w-full"
						>
							Disable 2FA
						</StatusButton>
					</Form>
				</div>
			</div>
		)
	}

	return (
		<div className="container mx-auto max-w-md py-8">
			<div className="rounded-lg bg-white p-6 shadow-md">
				<h1 className="text-2xl font-bold text-gray-900 mb-4">Set up Two-Factor Authentication</h1>
				
				{!showSetup ? (
					<div>
						<p className="text-gray-600 mb-6">
							Add an extra layer of security to your account by enabling two-factor authentication.
						</p>
						<Form method="post">
							<StatusButton
								type="submit"
								status={isPending ? 'pending' : 'idle'}
								className="w-full"
								onClick={() => setShowSetup(true)}
							>
								Set up 2FA
							</StatusButton>
						</Form>
					</div>
				) : actionData?.setupData ? (
					<div>
						<div className="mb-6">
							<p className="text-sm text-gray-600 mb-4">
								Scan this QR code with your authenticator app (like Google Authenticator, Authy, or 1Password):
							</p>
							<div className="flex justify-center mb-4">
								<img 
									src={actionData.setupData.qrCode} 
									alt="2FA QR Code" 
									className="border rounded-lg"
								/>
							</div>
							<p className="text-xs text-gray-500 text-center mb-4">
								Secret: <code className="bg-gray-100 px-1 rounded text-xs">{actionData.setupData.secret}</code>
							</p>
						</div>

						<Form method="post" {...getFormProps(form)}>
							<input type="hidden" name="intent" value="verify" />
							<input type="hidden" name="secret" value={actionData.setupData.secret} />
							
							<Field
								labelProps={{ children: 'Verification Code' }}
								inputProps={{
									...getInputProps(fields.code, { type: 'text' }),
									placeholder: '000000',
									maxLength: 6,
									className: 'text-center text-2xl tracking-widest',
								}}
								errors={fields.code.errors}
							/>

							<ErrorList errors={form.errors} id={form.errorId} />

							<StatusButton
								type="submit"
								status={isPending ? 'pending' : 'idle'}
								className="w-full mt-4"
							>
								Verify & Enable 2FA
							</StatusButton>
						</Form>
					</div>
				) : null}
			</div>
		</div>
	)
}

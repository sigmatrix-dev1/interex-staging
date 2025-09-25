import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { data, Form, redirect, useSearchParams } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireAnonymous } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { generateTwoFactorSecret, verifyTwoFactorToken, enableTwoFactorForUser } from '#app/utils/twofa.server.ts'
import { handleNewSession } from './login.server.ts'

const TwoFASetupSchema = z.object({
  code: z.string().min(6, 'Verification code must be 6 digits').max(6),
  userId: z.string(),
  secret: z.string(),
  remember: z.boolean().optional(),
  redirectTo: z.string().optional(),
})

export async function loader({ request }: { request: Request }) {
  await requireAnonymous(request)
  const url = new URL(request.url)
  const userId = url.searchParams.get('userId')
  if (!userId) return redirect('/login')

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, twoFactorEnabled: true },
  })
  if (!user) return redirect('/login')
  if (user.twoFactorEnabled) {
    // If somehow enabled already, proceed to 2FA verify page
    const q = new URLSearchParams(url.search)
  return redirect(`/2fa?${q}`)
  }

  // Generate a temporary secret and QR for setup (not persisted until verified)
  const { secret, qrCode } = await generateTwoFactorSecret(user.username || 'user')
  return data({ userId, username: user.username, secret, qrCode })
}

export async function action({ request }: { request: Request }) {
  await requireAnonymous(request)
  const formData = await request.formData()
  const submission = await parseWithZod(formData, {
    schema: TwoFASetupSchema.transform(async (val, ctx) => {
      const user = await prisma.user.findUnique({
        where: { id: val.userId },
        select: { id: true, twoFactorEnabled: true },
      })
      if (!user) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid user' })
        return z.NEVER
      }
      // Verify TOTP code against provided secret
      const ok = await verifyTwoFactorToken(val.secret, val.code)
      if (!ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid verification code', path: ['code'] })
        return z.NEVER
      }
      return val
    }),
    async: true,
  })

  if (submission.status !== 'success') {
    return data({ result: submission.reply({ hideFields: ['code'] }) }, { status: 400 })
  }

  const { userId, secret, remember, redirectTo } = submission.value
  // Persist secret and enable 2FA
  await enableTwoFactorForUser(userId, secret)

  // Create a new session and sign in (similar to /auth/2fa flow)
  const session = { userId, id: crypto.randomUUID(), expirationDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) }
  return handleNewSession({ request, session, remember: remember ?? false, redirectTo })
}

export default function TwoFASetupPage({ loaderData, actionData }: { loaderData: any; actionData: any }) {
  const { userId, username, secret, qrCode } = loaderData
  const isPending = useIsPending()
  const [searchParams] = useSearchParams()
  const remember = searchParams.get('remember') === 'true'
  const redirectTo = searchParams.get('redirectTo') || undefined

  const [form, fields] = useForm({
    id: '2fa-setup',
    constraint: getZodConstraint(TwoFASetupSchema),
    defaultValue: { userId, secret, remember, redirectTo },
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: TwoFASetupSchema })
    },
  })

  return (
    <div className="flex min-h-full flex-col justify-center pt-20 pb-32 bg-gray-50">
      <div className="mx-auto w-full max-w-md px-4 sm:px-0">
        <div className="rounded-2xl border border-gray-200 bg-white/95 shadow-xl ring-1 ring-black/5 backdrop-blur-sm">
          <div className="px-6 py-6 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-3 text-center mb-4">
              <h1 className="text-h2">Set up Two-Factor Authentication</h1>
              <p className="text-sm text-gray-600">Account: <strong>{username}</strong></p>
            </div>

            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-3">
                Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code below.
              </p>
              <div className="flex justify-center mb-2">
                <img src={qrCode} alt="2FA QR Code" className="border rounded-lg" />
              </div>
              <p className="text-xs text-gray-500 text-center">Secret: <code className="bg-gray-100 px-1 rounded">{secret}</code></p>
            </div>

            <Form method="post" {...getFormProps(form)}>
              <input {...getInputProps(fields.userId, { type: 'hidden' })} />
              <input {...getInputProps(fields.secret, { type: 'hidden' })} />
              <input {...getInputProps(fields.remember, { type: 'hidden' })} />
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
                errors={fields.code?.errors}
              />

              <ErrorList errors={form.errors} id={form.errorId} />

              <div className="flex flex-col gap-4 pt-4">
                <StatusButton
                  className="w-full rounded-md bg-gray-900 text-white shadow-sm hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition"
                  status={isPending ? 'pending' : (form.status ?? 'idle')}
                  type="submit"
                  disabled={isPending}
                >
                  Verify & Continue
                </StatusButton>
                <a href="/auth/login" className="text-center text-sm text-gray-600 hover:text-gray-900">← Back to login</a>
              </div>
            </Form>
          </div>
        </div>
      </div>
    </div>
  )
}

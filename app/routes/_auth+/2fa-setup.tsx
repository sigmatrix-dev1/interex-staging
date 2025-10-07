import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { data, Form, redirect, useSearchParams } from 'react-router'
import { z } from 'zod'
import { CsrfInput } from '#app/components/csrf-input.tsx'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import { requireAnonymous } from '#app/utils/auth.server.ts'
import { getOrCreateCsrfToken, assertCsrf } from '#app/utils/csrf.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { issueRecoveryCodes } from '#app/utils/mfa.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { generateTwoFactorSecret, verifyTwoFactorToken, enableTwoFactorForUser } from '#app/utils/twofa.server.ts'
import { verifySessionStorage } from '#app/utils/verification.server.ts'
import { handleNewSession } from './login.server.ts'

const TwoFASetupSchema = z.object({
  code: z.string().min(6, 'Verification code must be 6 digits').max(6),
  userId: z.string(),
  secret: z.string(),
  redirectTo: z.string().optional(),
})

export async function loader({ request }: { request: Request }) {
  await requireAnonymous(request)
  const ctx = await extractRequestContext(request, { requireUser: false })
  // Use the verify session stashed by handleNewSession to identify the user
  const verifySession = await verifySessionStorage.getSession(request.headers.get('cookie'))
  const unverifiedId = verifySession.get('unverified-session-id') as string | undefined
  if (!unverifiedId) return redirect('/login')

  const sess = await prisma.session.findUnique({ where: { id: unverifiedId }, select: { userId: true } })
  if (!sess?.userId) return redirect('/login')

  const user = await prisma.user.findUnique({
    where: { id: sess.userId },
    select: { id: true, username: true, twoFactorEnabled: true },
  })
  if (!user) return redirect('/login')
  if (user.twoFactorEnabled) {
    // If already enabled, go to the verification page instead of setup
    const q = new URLSearchParams(new URL(request.url).search)
    return redirect(`/2fa?${q.toString()}`)
  }

  // Generate a temporary secret and QR for setup (not persisted until verified)
  const { secret, qrCode } = await generateTwoFactorSecret(user.username || 'user')
  await audit.security({
    action: 'MFA_SETUP_START',
    status: 'INFO',
    actorType: 'USER',
    actorId: user.id,
    actorDisplay: user.username || null,
    actorIp: ctx.ip ?? null,
    actorUserAgent: ctx.userAgent ?? null,
    chainKey: 'global',
    entityType: 'User',
    entityId: user.id,
    summary: 'User initiated 2FA setup during login',
    metadata: { method: 'TOTP' },
  })
  const { token, setCookie } = await getOrCreateCsrfToken(request)
  return data({ userId: user.id, username: user.username, secret, qrCode, csrf: token }, setCookie ? { headers: { 'set-cookie': setCookie } } : undefined)
}

export async function action({ request }: { request: Request }) {
  await requireAnonymous(request)
  const ctx = await extractRequestContext(request, { requireUser: false })
  const formData = await request.formData()
  await assertCsrf(request, formData)
  // Recovery codes acknowledgment branch
  if (formData.get('intent') === 'ack-recovery') {
    const sessionId = String(formData.get('sessionId') || '')
    const remember = formData.get('remember') ? true : false
    const redirectTo = String(formData.get('redirectTo') || '') || undefined
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true, userId: true, expirationDate: true } })
    if (!session) return data({ result: { formErrors: ['Session expired. Please log in again.'] } }, { status: 400 })
    return handleNewSession({ request, session, remember, redirectTo, twoFAVerified: true })
  }
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

  const { userId, secret, redirectTo } = submission.value
  // Persist secret and enable 2FA
  await enableTwoFactorForUser(userId, secret)
  // Conditionally issue recovery codes ONLY for privileged roles; capture for one-time display
  let issuedCodes: string[] | null = null
  try {
    const roles = await prisma.role.findMany({
      where: { users: { some: { id: userId } } },
      select: { name: true },
    })
    const allowed = roles.some(r => r.name === 'system-admin' || r.name === 'customer-admin')
    if (allowed) {
      const codes = await issueRecoveryCodes(userId, { actorType: 'USER', actorId: userId, actorIp: ctx.ip ?? null, actorUserAgent: ctx.userAgent ?? null, chainKey: 'global', summary: 'Initial recovery codes issued at MFA enable' })
      issuedCodes = codes && codes.length ? codes : null
    }
  } catch (e) {
    console.warn('Failed to issue recovery codes', e)
  }
  await audit.security({
    action: 'MFA_ENABLE',
    actorType: 'USER',
    actorId: userId,
    actorIp: ctx.ip ?? null,
    actorUserAgent: ctx.userAgent ?? null,
    chainKey: 'global',
    entityType: 'User',
    entityId: userId,
    summary: '2FA enabled during login setup flow',
    metadata: { method: 'TOTP' },
  })

  // Resume pending login session from verify session
  const verifySession = await verifySessionStorage.getSession(request.headers.get('cookie'))
  const unverifiedId = verifySession.get('unverified-session-id') as string | undefined
  if (!unverifiedId) {
    return data({ result: { formErrors: ['Session expired. Please log in again.'] } }, { status: 400 })
  }
  const session = await prisma.session.findUnique({ where: { id: unverifiedId }, select: { id: true, userId: true, expirationDate: true } })
  if (!session) {
    return data({ result: { formErrors: ['Session expired. Please log in again.'] } }, { status: 400 })
  }
  // Read remember flag from verify session to respect the original login choice
  const remember = !!verifySession.get('remember')
  // If recovery codes were issued, show them once before redirecting into full session.
  if (issuedCodes && issuedCodes.length) {
    return data({ recoveryCodes: issuedCodes, next: { sessionId: session.id, remember, redirectTo } })
  }
  return handleNewSession({ request, session, remember, redirectTo, twoFAVerified: true })
}

export default function TwoFASetupPage({ loaderData, actionData }: { loaderData: any; actionData: any }) {
  const { userId, username, secret, qrCode } = loaderData
  const recoveryCodes: string[] | undefined = actionData?.recoveryCodes
  const pendingNext = actionData?.next
  const isPending = useIsPending()
  const [searchParams] = useSearchParams()
  const redirectTo = searchParams.get('redirectTo') || undefined

  const [form, fields] = useForm({
    id: '2fa-setup',
    constraint: getZodConstraint(TwoFASetupSchema),
  defaultValue: { userId, secret, redirectTo },
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: TwoFASetupSchema })
    },
  })

  if (recoveryCodes && recoveryCodes.length) {
    return (
      <div className="flex min-h-full flex-col justify-center pt-20 pb-32 bg-gray-50">
        <div className="mx-auto w-full max-w-md px-4 sm:px-0">
          <div className="rounded-2xl border border-green-200 bg-white shadow-xl ring-1 ring-black/5">
            <div className="px-6 py-6 sm:px-8 sm:py-8 space-y-4">
              <h1 className="text-h3 text-center">Recovery Codes</h1>
              <p className="text-sm text-gray-600">Store these one-time recovery codes in a secure password manager. Each can be used once if you lose access to your authenticator app.</p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm bg-gray-50 p-3 rounded">
                {recoveryCodes.map(c => <li key={c} className="px-2 py-1 bg-white rounded border border-gray-200 text-center">{c}</li>)}
              </ul>
              <Form method="post" className="pt-2">
                <CsrfInput />
                <input type="hidden" name="intent" value="ack-recovery" />
                <input type="hidden" name="sessionId" value={pendingNext.sessionId} />
                <input type="hidden" name="remember" value={pendingNext.remember ? '1' : ''} />
                <input type="hidden" name="redirectTo" value={pendingNext.redirectTo || ''} />
                <StatusButton type="submit" status={isPending ? 'pending' : 'idle'} className="w-full bg-indigo-600 text-white rounded-md py-2">Continue</StatusButton>
              </Form>
            </div>
          </div>
        </div>
      </div>
    )
  }
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
              <CsrfInput />
              <input {...getInputProps(fields.userId, { type: 'hidden' })} />
              <input {...getInputProps(fields.secret, { type: 'hidden' })} />
              {/* remember is sourced from verify session cookie; no hidden field needed */}
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
                <a href="/login" className="text-center text-sm text-gray-600 hover:text-gray-900">← Back to login</a>
              </div>
            </Form>
          </div>
        </div>
      </div>
    </div>
  )
}

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { data, Form, redirect } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { verifyTwoFactorToken, disableTwoFactorForUser, enableTwoFactorForUser, generateTwoFactorSecret } from '#app/utils/twofa.server.ts'
import { type BreadcrumbHandle } from './profile.tsx'

export const handle: BreadcrumbHandle & SEOHandle = {
  breadcrumb: <Icon name="refresh-cw">Reset</Icon>,
  getSitemapEntries: () => null,
}

/* -------------------------------------------------------------------------- */
/*                               SECURITY MODEL                               */
/*  - Only system-admin can access.                                           */
/*  - They may reset ONLY their own MFA (no target user id param)             */
/*  - Flow: show confirmation + require current valid TOTP code to authorize  */
/*    reset (prevents stolen unlocked session from silently nuking MFA).      */
/*  - On success: disable current 2FA, immediately issue new secret + QR and  */
/*    prompt to verify new code (single page multi-step).                     */
/* -------------------------------------------------------------------------- */

const ConfirmSchema = z.object({
  intent: z.literal('reset'),
  phase: z.literal('confirm'),
  code: z.string().min(6).max(6),
})
const VerifyNewSchema = z.object({
  intent: z.literal('finalize'),
  phase: z.literal('verify-new'),
  code: z.string().min(6).max(6),
  secret: z.string(),
})

type LoaderData = {
  username: string
  has2FA: boolean
  step: 'confirm' | 'verify-new'
  qrCode?: string
  secret?: string
}

export async function loader({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, twoFactorEnabled: true, roles: { select: { name: true } } } })
  if (!user) throw redirect('/login')
  const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
  if (!isSystemAdmin) throw new Response('Forbidden', { status: 403 })
  return data<LoaderData>({ username: user.username || '', has2FA: !!user.twoFactorEnabled, step: 'confirm' })
}

export async function action({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, twoFactorEnabled: true, twoFactorSecret: true, roles: { select: { name: true } } } })
  if (!user) throw redirect('/login')
  const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
  if (!isSystemAdmin) throw new Response('Forbidden', { status: 403 })
  const ctx = await extractRequestContext(request, { requireUser: true })
  const formData = await request.formData()
  const phase = formData.get('phase') as string | null

  if (phase === 'confirm') {
    const submission = await parseWithZod(formData, { schema: ConfirmSchema, async: true, })
    if (submission.status !== 'success') {
      return data({ result: submission.reply({ hideFields: ['code'] }) }, { status: 400 })
    }
    // Require current valid TOTP code
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return data({ result: submission.reply({ formErrors: ['2FA not currently enabled.'] }) }, { status: 400 })
    }
    const ok = await verifyTwoFactorToken(user.twoFactorSecret, submission.value.code)
    if (!ok) {
      return data({ result: submission.reply({ fieldErrors: { code: ['Invalid code'] } }) }, { status: 400 })
    }
    // Disable old secret
    await disableTwoFactorForUser(userId)
    await audit.security({
      action: 'MFA_RESET',
      status: 'SUCCESS',
      actorType: 'USER',
      actorId: userId,
      actorIp: ctx.ip ?? null,
      actorUserAgent: ctx.userAgent ?? null,
      summary: 'Admin self-reset of MFA (old secret invalidated)',
      metadata: { selfService: true },
      chainKey: 'global',
      entityType: 'User',
      entityId: userId,
    })
    // Issue new secret
    const { secret, qrCode } = await generateTwoFactorSecret(user.username || 'user')
    return data<LoaderData & { secret: string; qrCode: string }>({ username: user.username || '', has2FA: false, step: 'verify-new', secret, qrCode })
  }

  if (phase === 'verify-new') {
    const submission = await parseWithZod(formData, { schema: VerifyNewSchema, async: true })
    if (submission.status !== 'success') {
      return data({ result: submission.reply({ hideFields: ['code'] }) }, { status: 400 })
    }
    const { code, secret } = submission.value
    const ok = await verifyTwoFactorToken(secret, code)
    if (!ok) {
      return data({ result: submission.reply({ fieldErrors: { code: ['Invalid verification code'] } }) }, { status: 400 })
    }
    await enableTwoFactorForUser(userId, secret)
    await audit.security({
      action: 'MFA_ENABLE',
      status: 'SUCCESS',
      actorType: 'USER',
      actorId: userId,
      actorIp: ctx.ip ?? null,
      actorUserAgent: ctx.userAgent ?? null,
      summary: 'Admin completed MFA self-reset (new secret active)',
      metadata: { selfService: true },
      chainKey: 'global',
      entityType: 'User',
      entityId: userId,
    })
    return redirect('/settings/profile/two-factor')
  }

  return new Response('Bad Request', { status: 400 })
}

export default function TwoFactorResetRoute({ loaderData, actionData }: { loaderData: LoaderData; actionData?: any }) {
  const active = (actionData?.qrCode ? actionData : loaderData) as LoaderData & { secret?: string; qrCode?: string }
  const step = active.step

  const ConfirmFormSchema = ConfirmSchema
  const VerifyFormSchema = VerifyNewSchema
  const schema = step === 'confirm' ? ConfirmFormSchema : VerifyFormSchema

  const [form, fields] = useForm({
    id: 'mfa-reset',
    constraint: getZodConstraint(schema),
    lastResult: actionData?.result,
    defaultValue: step === 'verify-new' ? { intent: 'finalize', phase: 'verify-new', secret: active.secret } : { intent: 'reset', phase: 'confirm' },
    onValidate({ formData }) { return parseWithZod(formData, { schema }) },
  })

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div>
        <h1 className="text-h3">Reset Two-Factor Authentication</h1>
        {step === 'confirm' ? (
          <p className="text-sm text-gray-600 mt-2">Enter your current 2FA code to invalidate your existing secret and start a new setup.</p>
        ) : (
          <p className="text-sm text-gray-600 mt-2">Scan the new QR code and enter the first 6‑digit code to finalize the reset.</p>
        )}
      </div>

      {step === 'verify-new' && active.qrCode && (
        <div className="space-y-2">
          <img src={active.qrCode} alt="New MFA QR" className="h-44 w-44 border rounded" />
          <p className="text-xs text-gray-500 break-all">Secret: <code>{active.secret}</code></p>
        </div>
      )}

      <Form method="post" {...getFormProps(form)} className="space-y-4">
        <input {...getInputProps(fields.phase, { type: 'hidden' })} />
        <input {...getInputProps(fields.intent, { type: 'hidden' })} />
        {step === 'verify-new' && <input {...getInputProps(fields.secret, { type: 'hidden' })} />}
        <Field
          labelProps={{ children: 'Authentication Code' }}
          inputProps={{ ...getInputProps(fields.code, { type: 'text' }), placeholder: '000000', maxLength: 6, className: 'text-center text-xl tracking-widest font-mono', autoFocus: true }}
          errors={fields.code?.errors}
        />
        <ErrorList errors={form.errors} id={form.errorId} />
        <StatusButton type="submit" status={form.status ?? 'idle'} className="w-full">
          {step === 'confirm' ? 'Invalidate & Generate New' : 'Verify New Setup'}
        </StatusButton>
      </Form>
      <div className="text-xs text-gray-500">
        This action cannot recover the previous secret. Make sure you complete the new verification before logging out.
      </div>
    </div>
  )
}

export function ErrorBoundary() {
  return <div className="text-sm text-red-600">An unexpected error occurred. Try again.</div>
}

// app/routes/change-password.tsx
// Forced password change page when user mustChangePassword === true

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import React from 'react'
import { data, Form, redirect } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList, Field } from '#app/components/forms.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { audit } from '#app/services/audit.server.ts'
import { getUserId, checkIsCommonPassword, getPasswordHash, isPasswordReused, captureCurrentPasswordToHistory } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'
import { PASSWORD_REQUIREMENTS } from '#app/utils/password-requirements.ts'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { PasswordAndConfirmPasswordSchema } from '#app/utils/user-validation.ts'

export const handle: SEOHandle = { getSitemapEntries: () => null }

const ForcedChangeSchema = PasswordAndConfirmPasswordSchema

export async function loader({ request }: { request: Request }) {
  const userId = await getUserId(request)
  if (!userId) throw redirect('/login')
  const user = await (prisma as any).user.findUnique({ where: { id: userId }, select: { mustChangePassword: true, username: true } })
  if (!user) throw redirect('/login')
  if (!user.mustChangePassword) return redirect('/')
  return { username: user.username }
}

export async function action({ request }: { request: Request }) {
  const userId = await getUserId(request)
  if (!userId) throw redirect('/login')
  const user = await (prisma as any).user.findUnique({ where: { id: userId }, select: { mustChangePassword: true, username: true } })
  if (!user) throw redirect('/login')
  const ctx = await extractRequestContext(request, { requireUser: true })
  const formData = await request.formData()
  const submission = await parseWithZod(formData, {
    schema: ForcedChangeSchema.superRefine(async ({ password }, ctx) => {
      const { ok, errors } = validatePasswordComplexity(password)
      if (!ok) errors.forEach(msg => ctx.addIssue({ path: ['password'], code: 'custom', message: msg }))
      if (ok) {
        const isCommon = await checkIsCommonPassword(password)
        if (isCommon) ctx.addIssue({ path: ['password'], code: 'custom', message: 'Password appears in breach data; choose another.' })
      }
    }),
    async: true,
  })
  if (submission.status !== 'success') {
    return data({ result: submission.reply() }, { status: submission.status === 'error' ? 400 : 200 })
  }
  const { password } = submission.value
  // Update password
  const hash = await getPasswordHash(password)
  // Reuse check against current + last 5
  if (await isPasswordReused(userId, password)) {
    // Audit: rejected due to reuse
    await audit.auth({
      action: 'PASSWORD_CHANGE',
      status: 'FAILURE',
      actorType: 'USER',
      actorId: userId,
      actorDisplay: ctx.actorDisplay ?? null,
      actorIp: ctx.ip ?? null,
      actorUserAgent: ctx.userAgent ?? null,
      customerId: ctx.customerId ?? null,
      chainKey: ctx.customerId || 'global',
      entityType: 'User',
      entityId: userId,
      summary: 'Password change rejected: password reuse detected',
      metadata: { reason: 'REUSE_BLOCK', lastN: 5 },
    })
    return data({ result: submission.reply({ formErrors: ['New password cannot match any of the last 5 passwords.'] }) }, { status: 400 })
  }
  // Move current into history before updating
  await captureCurrentPasswordToHistory(userId)
  await prisma.password.upsert({
    where: { userId },
    update: { hash },
    create: { userId, hash },
  })
  await (prisma as any).user.update({ where: { id: userId }, data: { mustChangePassword: false, passwordChangedAt: new Date() } })
  // Audit: successful password change
  await audit.auth({
    action: 'PASSWORD_CHANGE',
    actorType: 'USER',
    actorId: userId,
    actorDisplay: ctx.actorDisplay ?? null,
    actorIp: ctx.ip ?? null,
    actorUserAgent: ctx.userAgent ?? null,
    customerId: ctx.customerId ?? null,
    chainKey: ctx.customerId || 'global',
    entityType: 'User',
    entityId: userId,
    summary: 'User changed password (forced due to policy)',
    metadata: { reason: 'FORCED_CHANGE' },
  })
  return redirect('/')
}

export default function ForcedChangePasswordPage({ actionData }: any) {
  const isPending = useIsPending()
  const [show, setShow] = React.useState(false)
  const [pwd, setPwd] = React.useState('')
  // live checks mirror server complexity
  const checks = [
    { label: PASSWORD_REQUIREMENTS[0], ok: pwd.length >= 12 && pwd.length <= 24 },
    { label: PASSWORD_REQUIREMENTS[1], ok: /[A-Z]/.test(pwd) },
    { label: PASSWORD_REQUIREMENTS[2], ok: /[a-z]/.test(pwd) },
    { label: PASSWORD_REQUIREMENTS[3], ok: /\d/.test(pwd) },
    { label: PASSWORD_REQUIREMENTS[4], ok: /[^A-Za-z0-9]/.test(pwd) },
    { label: PASSWORD_REQUIREMENTS[5], ok: !(pwd.startsWith(' ') || pwd.endsWith(' ')) },
  ]
  const allOk = checks.every(c => c.ok)
  const [form, fields] = useForm({
    id: 'change-password',
    constraint: getZodConstraint(ForcedChangeSchema),
    lastResult: actionData?.result,
    onValidate({ formData }) { return parseWithZod(formData, { schema: ForcedChangeSchema }) },
    shouldRevalidate: 'onBlur',
  })

  return (
    <div className="container flex flex-col justify-center pt-20 pb-32">
      <div className="text-center max-w-xl mx-auto">
        <h1 className="text-h1">Update Your Password</h1>
        <p className="text-body-md text-muted-foreground mt-3">For security, you must set a new password before continuing.</p>
      </div>
      <div className="mx-auto mt-12 max-w-sm min-w-full sm:min-w-[368px]">
        <Form method="POST" {...getFormProps(form)}>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700" htmlFor={fields.password.id}>New Password</label>
            <div className="relative">
              <input
                {...getInputProps(fields.password, { type: show ? 'text' : 'password' })}
                id={fields.password.id}
                autoComplete="new-password"
                autoFocus
                onChange={e => setPwd(e.currentTarget.value)}
                className="w-full rounded-md border border-gray-300 pr-10 py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={() => setShow(s => !s)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700"
                aria-label={show ? 'Hide password' : 'Show password'}
              >
                <Icon name={show ? 'eye-closed' : 'eye'} className="h-5 w-5" />
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
          <Field
            labelProps={{ htmlFor: fields.confirmPassword.id, children: 'Confirm Password' }}
            inputProps={{ ...getInputProps(fields.confirmPassword, { type: 'password' }), autoComplete: 'new-password' }}
            errors={fields.confirmPassword.errors}
          />
          <ErrorList errors={form.errors} id={form.errorId} />
          <StatusButton className="w-full mt-4" status={isPending ? 'pending' : (form.status ?? 'idle')} type="submit" disabled={isPending}>Update Password</StatusButton>
        </Form>
      </div>
    </div>
  )
}

export function ErrorBoundary() { return <GeneralErrorBoundary /> }

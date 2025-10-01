// app/routes/change-password.tsx
// Forced password change page when user mustChangePassword === true

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { EyeIcon, EyeSlashIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import React from 'react'
import { data, Form, redirect } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList } from '#app/components/forms.tsx'
import { Alert } from '#app/components/ui/alert.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { getUserId, checkIsCommonPassword, getPasswordHash, isPasswordReused, captureCurrentPasswordToHistory, clearSoftLockAndCounter } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'
import { PASSWORD_REQUIREMENTS } from '#app/utils/password-requirements.ts'
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
  // Block reuse of last 5 (including current)
  if (await isPasswordReused(userId, password)) {
    return data({ result: submission.reply({ fieldErrors: { password: ['New password cannot match any of the last 5.'] } }) }, { status: 400 })
  }
  // Capture current to history, then update password
  await captureCurrentPasswordToHistory(userId)
  // Update password
  const hash = await getPasswordHash(password)
  await prisma.password.upsert({
    where: { userId },
    update: { hash },
    create: { userId, hash },
  })
  await (prisma as any).user.update({ where: { id: userId }, data: { mustChangePassword: false, passwordChangedAt: new Date() } })
  // Clear any soft-lock and counters once user successfully changes password
  await clearSoftLockAndCounter(userId)
  return redirect('/')
}

export default function ForcedChangePasswordPage({ actionData }: any) {
  const isPending = useIsPending()
  const [show, setShow] = React.useState(false)
  const [showConfirm, setShowConfirm] = React.useState(false)
  const [pwd, setPwd] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  // Live checks mirror server complexity (aligned with reset-password UI)
  const upperOk = /[A-Z]/.test(pwd)
  const lowerOk = /[a-z]/.test(pwd)
  const digitOk = /[0-9]/.test(pwd)
  const specialOk = /[!@#$%^&*()_+\-={}\[\]:;"'`~<>,.?/\\|]/.test(pwd)
  const lenOk = pwd.length >= 12 && pwd.length <= 24
  const trimOk = pwd.trim() === pwd
  const checks = [
    { label: PASSWORD_REQUIREMENTS[0], ok: lenOk },
    { label: PASSWORD_REQUIREMENTS[1], ok: upperOk },
    { label: PASSWORD_REQUIREMENTS[2], ok: lowerOk },
    { label: PASSWORD_REQUIREMENTS[3], ok: digitOk },
    { label: PASSWORD_REQUIREMENTS[4], ok: specialOk },
    { label: PASSWORD_REQUIREMENTS[5], ok: trimOk },
  ]
  const [form, fields] = useForm({
    id: 'change-password',
    constraint: getZodConstraint(ForcedChangeSchema),
    lastResult: actionData?.result,
    onValidate({ formData }) { return parseWithZod(formData, { schema: ForcedChangeSchema }) },
    shouldRevalidate: 'onBlur',
  })

  // Aggregate server errors for a prominent alert
  const formErrors: string[] = Array.isArray(actionData?.result?.formErrors) ? actionData.result.formErrors : []
  const fieldPwdErrors: string[] = actionData?.result?.fieldErrors?.password ?? []
  const fieldConfirmErrors: string[] = actionData?.result?.fieldErrors?.confirmPassword ?? []
  const allErrors = [...formErrors, ...fieldPwdErrors, ...fieldConfirmErrors]
  // Special-case: detect password reuse ("last 5") to show a dedicated alert
  const isReuseMessage = (s: string) => /last\s*5/i.test(s)
  const reuseErrorPresent = fieldPwdErrors.some(isReuseMessage) || (fields.password.errors?.some?.(isReuseMessage) ?? false)
  const filteredAllErrors = allErrors.filter(e => !isReuseMessage(e))

  return (
    <div className="container flex flex-col justify-center pt-20 pb-32">
      <div className="text-center max-w-xl mx-auto">
        <h1 className="text-h1">Update Your Password</h1>
        <p className="text-body-md text-muted-foreground mt-3">For security, you must set a new password before continuing.</p>
      </div>
      <div className="mx-auto mt-16 max-w-sm min-w-full sm:min-w-[368px]">
        <Form method="POST" {...getFormProps(form)}>
          {filteredAllErrors.length > 0 ? (
            <Alert className="mb-4" variant="error" heading="Please fix the following:" role="alert">
              <ul className="mt-2 list-disc pl-5">
                {filteredAllErrors.map((e: string, i: number) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700" htmlFor={fields.password.id}>New Password</label>
            <div className="relative mt-1">
              <input
                {...getInputProps(fields.password, { type: show ? 'text' : 'password' })}
                autoComplete="new-password"
                autoFocus
                onChange={e => setPwd(e.currentTarget.value)}
                className={
                  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-gray-900 shadow-sm ' +
                  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ' +
                  'hover:border-gray-400 transition'
                }
              />
              <button
                type="button"
                onClick={() => setShow(s => !s)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700 focus:outline-none"
                aria-label={show ? 'Hide password' : 'Show password'}
              >
                {show ? (
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
              {checks.map(item => (
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
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700" htmlFor={fields.confirmPassword.id}>Confirm Password</label>
            <div className="relative mt-1">
              <input
                {...getInputProps(fields.confirmPassword, { type: showConfirm ? 'text' : 'password' })}
                autoComplete="new-password"
                onChange={e => setConfirm(e.currentTarget.value)}
                className={
                  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-gray-900 shadow-sm ' +
                  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ' +
                  'hover:border-gray-400 transition'
                }
              />
              <button
                type="button"
                onClick={() => setShowConfirm(s => !s)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700 focus:outline-none"
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
            {confirm.length > 0 ? (
              <p
                className={
                  'mt-1 text-sm ' +
                  (confirm === pwd ? 'text-green-700' : 'text-red-600')
                }
              >
                {confirm === pwd ? 'Passwords match' : 'Passwords do not match'}
              </p>
            ) : null}
          </div>
          <ErrorList errors={form.errors} id={form.errorId} />
          <StatusButton className="w-full" status={isPending ? 'pending' : (form.status ?? 'idle')} type="submit" disabled={isPending}>Update Password</StatusButton>
        </Form>
      </div>
    </div>
  )
}

export function ErrorBoundary() { return <GeneralErrorBoundary /> }

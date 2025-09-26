import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { data, Form, redirect, useSearchParams } from 'react-router'
import { z } from 'zod'
import { ErrorList, Field } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { authSessionStorage } from '#app/utils/session.server.ts'
import { verifyTwoFactorToken } from '#app/utils/twofa.server.ts'

export const handle: SEOHandle = { getSitemapEntries: () => null }

const verifiedTimeKey = 'verified-time'

const ReverifySchema = z.object({
  code: z.string().min(6).max(6),
  redirectTo: z.string().optional(),
})

export async function loader({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true, twoFactorSecret: true },
  })
  if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
    // User has no TOTP set; send them to self-service setup
    return redirect('/me/2fa')
  }
  return { ok: true }
}

export async function action({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const formData = await request.formData()

  const submission = await parseWithZod(formData, {
    schema: ReverifySchema.transform(async (val, ctx) => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { twoFactorSecret: true, twoFactorEnabled: true },
      })
      if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '2FA not configured' })
        return z.NEVER
      }
      const ok = await verifyTwoFactorToken(user.twoFactorSecret, val.code)
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

  // Mark session as recently verified
  const authSession = await authSessionStorage.getSession(request.headers.get('cookie'))
  authSession.set(verifiedTimeKey, Date.now())
  const headers = new Headers({
    'set-cookie': await authSessionStorage.commitSession(authSession),
  })

  const redirectTo = submission.value.redirectTo
  return redirect(redirectTo || '/', { headers })
}

export default function TwoFAReverifyPage({ actionData }: { actionData: any }) {
  const isPending = useIsPending()
  const [searchParams] = useSearchParams()
  const redirectTo = searchParams.get('redirectTo') || undefined

  const [form, fields] = useForm({
    id: '2fa-reverify',
    constraint: getZodConstraint(ReverifySchema),
    lastResult: actionData?.result,
    defaultValue: { redirectTo },
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: ReverifySchema })
    },
  })

  return (
    <div className="flex min-h-full flex-col justify-center pt-20 pb-32 bg-gray-50">
      <div className="mx-auto w-full max-w-md px-4 sm:px-0">
        <div className="rounded-2xl border border-gray-200 bg-white/95 shadow-xl ring-1 ring-black/5 backdrop-blur-sm">
          <div className="px-6 py-6 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-3 text-center mb-6">
              <h1 className="text-h2">Reverify with 2FA</h1>
              <p className="text-sm text-gray-600">Enter the 6-digit code from your authenticator app.</p>
            </div>
            <Form method="post" {...getFormProps(form)}>
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
                <StatusButton className="w-full" status={isPending ? 'pending' : (form.status ?? 'idle')} type="submit" disabled={isPending}>
                  Verify
                </StatusButton>
              </div>
            </Form>
          </div>
        </div>
      </div>
    </div>
  )
}

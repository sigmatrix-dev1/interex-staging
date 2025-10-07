import { data, redirect, Form } from 'react-router'
import { audit } from '#app/services/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { getOrCreateCsrfToken, assertCsrf } from '#app/utils/csrf.server.ts'
import { CsrfInput } from '#app/components/csrf-input.tsx'
import { prisma } from '#app/utils/db.server.ts'
import { issueRecoveryCodes, remainingRecoveryCodes } from '#app/utils/mfa.server.ts'

export async function loader({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { roles: { select: { name: true } } } })
  if (!user) throw redirect('/login')
  const allowed = user.roles.some(r => r.name === 'system-admin' || r.name === 'customer-admin')
  if (!allowed) throw new Response('Forbidden', { status: 403 })
  const remaining = await remainingRecoveryCodes(userId)
  const { token, setCookie } = await getOrCreateCsrfToken(request)
  return data({ remaining, csrf: token }, setCookie ? { headers: { 'set-cookie': setCookie } } : undefined)
}

export async function action({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const formData = await request.formData()
  await assertCsrf(request, formData)
  const intent = formData.get('intent')
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { roles: { select: { name: true } } } })
  if (!user) throw redirect('/login')
  const allowed = user.roles.some(r => r.name === 'system-admin' || r.name === 'customer-admin')
  if (!allowed) throw new Response('Forbidden', { status: 403 })

  if (intent === 'generate') {
    // Generate new set (invalidate old automatically in issueRecoveryCodes)
    const codes = await issueRecoveryCodes(userId, { actorType: 'USER', actorId: userId, chainKey: 'global' }, { auditAction: 'MFA_RECOVERY_REGENERATE' })
    await audit.security({
      action: 'MFA_RECOVERY_REGENERATE',
      status: 'SUCCESS',
      actorType: 'USER',
      actorId: userId,
      chainKey: 'global',
      entityType: 'User',
      entityId: userId,
      summary: 'User regenerated recovery codes',
      metadata: { count: codes.length },
    })
    // One-time display in flash-like response (not persisted). Avoid re-render with codes in URL.
    return data({ codes, remaining: codes.length })
  }
  return data({ ok: true })
}

export default function RecoveryCodesPage({ loaderData, actionData }: { loaderData: any; actionData?: any }) {
  const current = actionData?.codes ? actionData : loaderData
  const codes = actionData?.codes as string[] | undefined
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-h3">MFA Recovery Codes</h1>
      <p className="text-sm text-gray-600">Use a recovery code if you lose access to your authenticator. Each code can be used once.</p>
      {codes ? (
        <div className="space-y-3">
          <div className="rounded-md border bg-white p-4">
            <p className="text-xs font-medium mb-2">Copy & securely store these codes now. They will not be shown again.</p>
            <div className="grid grid-cols-2 gap-2 font-mono text-sm">
              {codes.map(c => <div key={c} className="px-2 py-1 bg-gray-100 rounded border text-center tracking-wide">{c}</div>)}
            </div>
          </div>
          <Form method="post">
            <CsrfInput />
            <input type="hidden" name="intent" value="generate" />
            <button className="text-xs text-blue-700 hover:underline" type="submit">Regenerate Codes</button>
          </Form>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">Remaining unused codes: <strong>{current.remaining}</strong></p>
          <Form method="post">
            <CsrfInput />
            <input type="hidden" name="intent" value="generate" />
            <button className="inline-flex items-center rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white shadow hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500">Generate / View Codes</button>
          </Form>
        </div>
      )}
      <div className="text-[11px] text-gray-500 border-t pt-4">
        Regenerating invalidates all previously unused codes. Loss of all codes and authenticator access will require manual administrator intervention.
      </div>
    </div>
  )
}

export function ErrorBoundary() {
  return <div className="text-sm text-red-600">Failed to load recovery codes page.</div>
}

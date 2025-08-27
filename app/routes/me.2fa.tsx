
import { json, redirect } from '@remix-run/node'
import { requireUserId } from '#app/utils/auth.server.ts'
import { generate2FASecret, verify2FACode, enable2FA, disable2FA } from '#app/utils/twofa.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { Form, useActionData, useLoaderData } from '@remix-run/react'
import { useState } from 'react'


export async function loader({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw redirect('/login')
  return json({
    twoFactorEnabled: user.twoFactorEnabled,
    hasSecret: !!user.twoFactorSecret,
  })
}


type ActionData =
  | { step: 'verify'; qrCodeDataURL: string }
  | { step: 'done'; success: true }
  | { step: 'verify'; error: string }
  | { step: 'disabled'; disabled: true }
  | undefined

export async function action({ request }: { request: Request }) {
  const userId = await requireUserId(request)
  const formData = await request.formData()
  const intent = formData.get('intent')
  if (intent === 'generate') {
    const { qrCodeDataURL } = await generate2FASecret(userId)
    return json({ qrCodeDataURL, step: 'verify' } satisfies ActionData)
  }
  if (intent === 'verify') {
    const code = formData.get('code') as string
    const valid = await verify2FACode(userId, code)
    if (valid) {
      await enable2FA(userId)
      return json({ success: true, step: 'done' } satisfies ActionData)
    }
    return json({ error: 'Invalid code', step: 'verify' } satisfies ActionData)
  }
  if (intent === 'disable') {
    await disable2FA(userId)
    return json({ disabled: true, step: 'disabled' } satisfies ActionData)
  }
  return json(undefined)
}


export default function TwoFactorPage() {
  const loaderData = useLoaderData<typeof loader>()
  const actionData = useActionData<ActionData>()
  const step = actionData?.step || (loaderData?.twoFactorEnabled ? 'done' : 'setup')

  if (step === 'done') {
    return <div>
      <h2>2FA Enabled</h2>
      <Form method="post">
        <button type="submit" name="intent" value="disable">Disable 2FA</button>
      </Form>
    </div>
  }
  if (step === 'disabled') {
    return <div>
      <h2>2FA Disabled</h2>
      <Form method="post">
        <button type="submit" name="intent" value="generate">Enable 2FA</button>
      </Form>
    </div>
  }
  if (step === 'verify' && actionData && 'qrCodeDataURL' in actionData) {
    return <div>
      <h2>Scan QR Code</h2>
      <img src={actionData.qrCodeDataURL} alt="2FA QR Code" />
      <Form method="post">
        <input name="code" placeholder="Enter code from app" required />
        <button type="submit" name="intent" value="verify">Verify</button>
      </Form>
      {(() => {
        if ('error' in actionData && actionData.error) {
          return <div style={{color:'red'}}>{String(actionData.error)}</div>
        }
        return null
      })()}
    </div>
  }
  return <div>
    <h2>Enable 2FA</h2>
    <Form method="post">
      <button type="submit" name="intent" value="generate">Start 2FA Setup</button>
    </Form>
  </div>
}

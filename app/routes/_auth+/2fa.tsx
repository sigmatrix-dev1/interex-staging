import { json, redirect } from '@remix-run/node'
import { Form, useActionData, useLoaderData } from '@remix-run/react'
import { useState } from 'react'
import { verify2FACode } from '#app/utils/twofa.server.ts'
import { prisma } from '#app/utils/db.server.ts'

export async function loader({ request }: { request: Request }) {
  // You may want to check for a temp session or context here
  return json({})
}

export async function action({ request }: { request: Request }) {
  const formData = await request.formData()
  const userId = formData.get('userId') as string
  const code = formData.get('code') as string
  const valid = await verify2FACode(userId, code)
  if (valid) {
    // Set a session/cookie to mark 2FA as complete, then redirect
    return redirect('/')
  }
  return json({ error: 'Invalid code' })
}

export default function TwoFAPrompt() {
  const actionData = useActionData() as { error?: string }
  const [code, setCode] = useState('')
  return (
    <div>
      <h2>Two-Factor Authentication Required</h2>
      <Form method="post">
        <input
          name="code"
          value={code}
          onChange={e => setCode(e.target.value)}
          placeholder="Enter 2FA code"
          required
        />
        <button type="submit">Verify</button>
      </Form>
      {actionData?.error && <div style={{color:'red'}}>{actionData.error}</div>}
    </div>
  )
}

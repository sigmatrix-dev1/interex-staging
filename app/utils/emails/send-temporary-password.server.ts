import { sendEmail } from '../email.server.ts'
import { TemporaryPasswordEmail } from './temporary-password-email.tsx'

export async function sendTemporaryPasswordEmail({
  to,
  adminName,
  customerName,
  tempPassword,
  loginUrl,
}: {
  to: string
  adminName: string
  customerName: string
  tempPassword: string
  loginUrl: string
}) {
  try {
    const result = await sendEmail({
      to,
      subject: `Welcome to Interex - Your Customer Admin Access for ${customerName}`,
      react: TemporaryPasswordEmail({
        adminName,
        customerName,
        tempPassword,
        loginUrl,
      }),
    })

    if (result.status === 'success') {
      console.log(`✅ Temporary password email sent to ${to} for ${customerName}`)
      const messageId = 'data' in result.data ? result.data.data.id : result.data.id
      return { success: true, messageId }
    } else {
      console.error(`❌ Failed to send temporary password email to ${to}:`, result.error)
      return { success: false, error: result.error }
    }
  } catch (error) {
    console.error(`❌ Error sending temporary password email to ${to}:`, error)
    return { success: false, error }
  }
}

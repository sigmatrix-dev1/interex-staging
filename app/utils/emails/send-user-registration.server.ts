import { sendEmail } from '../email.server.ts'
import { UserRegistrationEmail } from './user-registration-email.tsx'

export async function sendUserRegistrationEmail({
  to,
  userName,
  userRole,
  customerName,
  tempPassword,
  loginUrl,
  username,
  providerGroupName,
}: {
  to: string
  userName: string
  userRole: string
  customerName: string
  tempPassword: string
  loginUrl: string
  username: string
  providerGroupName?: string
}) {
  try {
    const roleDisplayName = userRole.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())
    
    const result = await sendEmail({
      to,
      subject: `Welcome to Interex - Your ${roleDisplayName} Account for ${customerName}`,
      react: UserRegistrationEmail({
        userName,
        userRole,
        customerName,
        tempPassword,
        loginUrl,
        username,
        providerGroupName,
      }),
    })

    if (result.status === 'success') {
      console.log(`✅ User registration email sent to ${to} for ${customerName}`)
      const messageId = 'data' in result.data ? result.data.data.id : result.data.id
      return { success: true, messageId }
    } else {
      console.error(`❌ Failed to send user registration email to ${to}:`, result.error)
      return { success: false, error: result.error }
    }
  } catch (error) {
    console.error(`❌ Error sending user registration email to ${to}:`, error)
    return { success: false, error }
  }
}

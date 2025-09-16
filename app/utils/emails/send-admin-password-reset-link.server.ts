// app/utils/emails/send-admin-password-reset-link.server.ts

import { sendEmail } from '../email.server.ts'
import {
    AdminPasswordResetLinkEmail,
    type AdminPasswordResetLinkEmailProps,
} from './admin-password-reset-link-email.tsx'

export async function sendAdminPasswordResetLinkEmail({
                                                          to,
                                                          recipientName,
                                                          requestedByName,
                                                          customerName,
                                                          resetUrl,
                                                          otp,
                                                          expiresInMinutes,
                                                      }: {
    to: string
} & Pick<
    AdminPasswordResetLinkEmailProps,
    'recipientName' | 'requestedByName' | 'customerName' | 'resetUrl' | 'otp' | 'expiresInMinutes'
>) {
    try {
        const subjectParts = ['Interex Password Reset']
        if (customerName) subjectParts.push(`– ${customerName}`)
        const subject = subjectParts.join(' ')

        const result = await sendEmail({
            to,
            subject,
            react: AdminPasswordResetLinkEmail({
                recipientName,
                requestedByName,
                customerName,
                resetUrl,
                otp,
                expiresInMinutes,
            }),
        })

        if (result.status === 'success') {
            const messageId =
                'data' in result.data ? (result.data as any).data.id : (result.data as any).id
            return { success: true, messageId }
        } else {
            return { success: false, error: result.error }
        }
    } catch (error) {
        return { success: false, error }
    }
}

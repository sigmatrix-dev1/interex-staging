// app/utils/emails/send-admin-password-manual-reset.server.ts

import { sendEmail } from '../email.server.ts'
import {
    AdminPasswordManualResetEmail,
    type AdminPasswordManualResetEmailProps,
} from './admin-password-manual-reset-email.tsx'

export async function sendAdminPasswordManualResetEmail({
                                                            to,
                                                            recipientName,
                                                            requestedByName,
                                                            customerName,
                                                            username,
                                                            tempPassword,
                                                            loginUrl,
                                                        }: {
    to: string
} & Pick<
    AdminPasswordManualResetEmailProps,
    'recipientName' | 'requestedByName' | 'customerName' | 'username' | 'tempPassword' | 'loginUrl'
>) {
    try {
        const subjectParts = ['Your Interex Password Was Reset']
        if (customerName) subjectParts.push(`– ${customerName}`)
        const subject = subjectParts.join(' ')

        const result = await sendEmail({
            to,
            subject,
            react: AdminPasswordManualResetEmail({
                recipientName,
                requestedByName,
                customerName,
                username,
                tempPassword,
                loginUrl,
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

// app/utils/emails/admin-password-reset-link-email.tsx

import {
    Html,
    Head,
    Body,
    Container,
    Section,
    Text,
    Link,
    Hr,
} from '@react-email/components'

export interface AdminPasswordResetLinkEmailProps {
    /** Recipient display name (optional) */
    recipientName?: string
    /** Name of the admin who initiated the reset (optional) */
    requestedByName?: string
    /** Customer/tenant display name (optional) */
    customerName?: string
    /** Absolute URL to the reset/verify page (includes code param) */
    resetUrl: string
    /** One-time code (optional, shown if provided) */
    otp?: string
    /** Minutes until the link/code expires */
    expiresInMinutes: number
}

export function AdminPasswordResetLinkEmail({
                                                recipientName,
                                                requestedByName,
                                                customerName,
                                                resetUrl,
                                                otp,
                                                expiresInMinutes,
                                            }: AdminPasswordResetLinkEmailProps) {
    return (
        <Html>
            <Head />
            <Body style={main}>
                <Container style={container}>
                    <Section style={logoContainer}>
                        <Text style={heading}>Interex Customer Portal</Text>
                    </Section>

                    <Section style={body}>
                        <Text style={paragraph}>
                            Hello{recipientName ? ` ${recipientName}` : ''},
                        </Text>

                        {customerName ? (
                            <Text style={paragraph}>
                                A password reset was initiated for your <strong>{customerName}</strong> Interex account
                                {requestedByName ? (
                                    <>
                                        {' '}by <strong>{requestedByName}</strong>.
                                    </>
                                ) : (
                                    '.'
                                )}
                            </Text>
                        ) : (
                            <Text style={paragraph}>
                                A password reset was initiated for your Interex account
                                {requestedByName ? (
                                    <>
                                        {' '}by <strong>{requestedByName}</strong>.
                                    </>
                                ) : (
                                    '.'
                                )}
                            </Text>
                        )}

                        <Text style={paragraph}>
                            Click the button below to set a new password. This link will expire in{' '}
                            <strong>{expiresInMinutes} minutes</strong>.
                        </Text>

                        <Section style={buttonContainer}>
                            <Link style={button} href={resetUrl}>
                                Reset your password
                            </Link>
                        </Section>

                        {otp ? (
                            <>
                                <Text style={paragraph}>
                                    Or use this verification code (valid for <strong>{expiresInMinutes} minutes</strong>):
                                </Text>
                                <Section style={codeBox}>
                                    <Text style={codeValue}>{otp}</Text>
                                </Section>
                            </>
                        ) : null}

                        <Text style={smallText}>
                            If you did not request this change, you can ignore this message. Your password will remain unchanged unless you complete the reset.
                        </Text>

                        <Hr style={hr} />

                        <Text style={footer}>
                            This is an automated message. Please do not reply.<br />
                            Need help? Contact your system administrator.
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    )
}

// Styles (re-using the visual language of other Interex emails)
const main = {
    backgroundColor: '#f6f9fc',
    fontFamily:
        '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
}

const container = {
    backgroundColor: '#ffffff',
    margin: '0 auto',
    padding: '20px 0 48px',
    marginBottom: '64px',
}

const logoContainer = {
    padding: '32px 48px',
    textAlign: 'center' as const,
    borderBottom: '1px solid #e6ebf1',
}

const heading = {
    fontSize: '24px',
    letterSpacing: '-0.5px',
    lineHeight: '1.3',
    fontWeight: 400,
    color: '#484848',
    padding: '17px 0 0',
    margin: 0,
}

const body = {
    padding: '24px 48px',
}

const paragraph = {
    fontSize: '16px',
    lineHeight: '1.4',
    color: '#3c4149',
    margin: '16px 0',
}

const smallText = {
    fontSize: '14px',
    lineHeight: '1.4',
    color: '#6c757d',
    margin: '8px 0',
}

const buttonContainer = {
    textAlign: 'center' as const,
    margin: '28px 0',
}

const button = {
    backgroundColor: '#3b82f6',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '16px',
    fontWeight: 600,
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '12px 24px',
}

const codeBox = {
    backgroundColor: '#f8f9fa',
    borderRadius: '6px',
    padding: '16px',
    margin: '16px 0 8px',
    border: '1px solid #e9ecef',
    textAlign: 'center' as const,
}

const codeValue = {
    fontSize: '20px',
    fontWeight: 700,
    color: '#495057',
    fontFamily:
        'Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    margin: 0,
}

const hr = {
    borderColor: '#e6ebf1',
    margin: '32px 0',
}

const footer = {
    color: '#8898aa',
    fontSize: '12px',
    lineHeight: '1.4',
    textAlign: 'center' as const,
}

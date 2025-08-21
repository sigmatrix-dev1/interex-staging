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

interface UserRegistrationEmailProps {
  userName: string
  userRole: string
  customerName: string
  tempPassword: string
  loginUrl: string
  username: string
  providerGroupName?: string
}

export function UserRegistrationEmail({
  userName,
  userRole,
  customerName,
  tempPassword,
  loginUrl,
  username,
  providerGroupName,
}: UserRegistrationEmailProps) {
  const roleDisplayName = userRole.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())
  
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
              Hello {userName},
            </Text>
            
            <Text style={paragraph}>
              Welcome to Interex! You have been registered as a <strong>{roleDisplayName}</strong> for <strong>{customerName}</strong>.
            </Text>

            {providerGroupName && (
              <Text style={paragraph}>
                You have been assigned to the <strong>{providerGroupName}</strong> provider group.
              </Text>
            )}
            
            <Text style={paragraph}>
              Your login credentials are:
            </Text>
            
            <Section style={credentialsBox}>
              <div style={credentialRow}>
                <Text style={credentialsLabel}>Username:</Text>
                <Text style={credentialsValue}>{username}</Text>
              </div>
              <div style={credentialRow}>
                <Text style={credentialsLabel}>Temporary Password:</Text>
                <Text style={credentialsValue}>{tempPassword}</Text>
              </div>
            </Section>
            
            <Text style={paragraph}>
              <strong>Important:</strong> Please change your password immediately after your first login for security purposes.
            </Text>
            
            <Section style={buttonContainer}>
              <Link style={button} href={loginUrl}>
                Login to Interex Portal
              </Link>
            </Section>

            <Text style={paragraph}>
              <strong>Getting Started:</strong>
            </Text>
            
            <Text style={smallText}>
              {userRole === 'basic-user' && '• You can view and manage your assigned NPIs'}
              {userRole === 'provider-group-admin' && '• You can manage users and NPIs within your provider group'}
              {userRole === 'customer-admin' && '• You have full administrative access to manage users, provider groups, and NPIs for your organization'}
            </Text>
            
            <Hr style={hr} />
            
            <Text style={footer}>
              This is an automated message. Please do not reply to this email.
              <br />
              If you have any questions or need assistance, please contact your system administrator.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

// Styles
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
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
  fontWeight: '400',
  color: '#484848',
  padding: '17px 0 0',
  margin: '0',
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

const credentialsBox = {
  backgroundColor: '#f8f9fa',
  borderRadius: '4px',
  padding: '16px',
  margin: '24px 0',
  border: '1px solid #e9ecef',
}

const credentialRow = {
  marginBottom: '12px',
}

const credentialsLabel = {
  fontSize: '14px',
  fontWeight: '600',
  color: '#6c757d',
  margin: '0 0 4px 0',
}

const credentialsValue = {
  fontSize: '16px',
  fontWeight: '700',
  color: '#495057',
  fontFamily: 'Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  margin: '0',
  padding: '8px 12px',
  backgroundColor: '#ffffff',
  border: '1px solid #dee2e6',
  borderRadius: '4px',
}

const buttonContainer = {
  textAlign: 'center' as const,
  margin: '32px 0',
}

const button = {
  backgroundColor: '#3b82f6',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '12px 24px',
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

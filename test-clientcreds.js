// Test OAuth 2.0 authentication with CMS HIH Gateway using clientCreds scope
import { createCmsHihSubmission, createCmsHihSubmissionPayload } from './app/utils/cms-hih-gateway.server.ts'

async function testClientCredsScope() {
  console.log('🧪 Testing CMS HIH Gateway OAuth with clientCreds scope...')
  
  const testSubmissionData = {
    title: 'Test ADR Submission',
    purposeOfSubmission: 'ADR',
    recipient: 'Test Recipient',
    claimId: 'TEST123',
    caseId: 'CASE456',
    comments: 'Test submission for clientCreds scope testing',
    category: 'DEFAULT',
    autoSplit: false,
    sendInX12: false,
    threshold: 100,
    providerNpi: '1234567890'
  }
  
  console.log('📋 Creating CMS HIH payload...')
  const payload = createCmsHihSubmissionPayload(testSubmissionData)
  console.log('Payload:', JSON.stringify(payload, null, 2))
  
  console.log('🔐 Testing OAuth flow with clientCreds scope...')
  const response = await createCmsHihSubmission(payload)
  console.log('Response:', JSON.stringify(response, null, 2))
  
  if (response.submissionId) {
    console.log('✅ OAuth integration test successful! Submission ID:', response.submissionId)
  } else {
    console.log('❌ OAuth integration test failed:', response.message)
  }
}

testClientCredsScope().catch(console.error)

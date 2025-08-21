// Test creating a real submission in CMS HIH Gateway
import { createCmsHihSubmission, createCmsHihSubmissionPayload } from './app/utils/cms-hih-gateway.server.ts'

async function testHIHSubmissionCreation() {
  console.log('🧪 Testing REAL CMS HIH Gateway submission creation...')
  console.log('⚠️  This will attempt to create an actual submission in CMS HIH Gateway')
  
  const testSubmissionData = {
    title: 'Test ADR Submission - Integration Test',
    purposeOfSubmission: 'ADR',
    recipient: 'CMS Review Contractor',
    claimId: 'TEST-CLAIM-123456',
    caseId: 'CASE-789',
    comments: 'This is a test submission created via API integration testing',
    category: 'DEFAULT',
    autoSplit: false,
    sendInX12: false,
    threshold: 100,
    providerNpi: '1234567890'
  }
  
  console.log('📋 Creating CMS HIH submission payload...')
  const payload = createCmsHihSubmissionPayload(testSubmissionData)
  console.log('📤 Payload to be sent:', JSON.stringify(payload, null, 2))
  
  console.log('\n🔐 Starting OAuth authentication with clientCreds scope...')
  console.log('🌐 Calling CMS HIH Gateway API...')
  
  try {
    const response = await createCmsHihSubmission(payload)
    
    console.log('\n📥 CMS HIH Gateway Response:')
    console.log(JSON.stringify(response, null, 2))
    
    if (response.status === 'success' && response.submissionId) {
      console.log('\n✅ SUCCESS! CMS HIH Gateway submission created successfully!')
      console.log('🆔 Submission ID:', response.submissionId)
      console.log('📝 Message:', response.message)
      
      // In a real app, this submission ID would be stored in the database
      console.log('\n💾 This submission ID would now be stored as fhirSubmissionId in the database')
      
    } else if (response.status === 'error') {
      console.log('\n❌ FAILED! CMS HIH Gateway returned an error:')
      console.log('📝 Message:', response.message)
      if (response.errors) {
        console.log('🔍 Errors:')
        response.errors.forEach((error, index) => {
          console.log(`   ${index + 1}. ${error.code}: ${error.description}`)
        })
      }
    } else {
      console.log('\n⚠️  Unexpected response format:', response)
    }
    
  } catch (error) {
    console.log('\n💥 EXCEPTION occurred during submission creation:')
    console.error(error)
  }
  
  console.log('\n🏁 Test completed.')
}

testHIHSubmissionCreation().catch(error => {
  console.error('💥 Unhandled error in test:', error)
  process.exit(1)
})

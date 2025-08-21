import { data, useLoaderData, Link } from 'react-router'
import { type LoaderFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { Icon } from '#app/components/ui/icon.tsx'

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const { submissionId } = params

  if (!submissionId) {
    throw new Response('Submission ID is required', { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { 
      roles: true,
      customer: true,
      providerGroup: true,
      userNpis: {
        include: {
          provider: true
        }
      }
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Check permissions
  const hasRequiredRole = user.roles.some(role => 
    ['customer-admin', 'provider-group-admin', 'basic-user'].includes(role.name)
  )
  
  if (!hasRequiredRole) {
    throw new Response('Insufficient permissions', { status: 403 })
  }

  if (!user.customerId) {
    throw new Response('User must be associated with a customer', { status: 400 })
  }

  // Get the submission with all related data
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      creator: {
        select: {
          id: true,
          username: true,
          name: true
        }
      },
      provider: {
        select: {
          id: true,
          npi: true,
          name: true,
          providerGroup: {
            select: {
              id: true,
              name: true
            }
          }
        }
      },
      documents: {
        include: {
          uploader: {
            select: {
              id: true,
              username: true,
              name: true
            }
          }
        }
      },
      customer: {
        select: {
          id: true,
          name: true
        }
      }
    }
  })

  if (!submission) {
    throw new Response('Submission not found', { status: 404 })
  }

  // Check if user has access to this submission
  if (submission.customerId !== user.customerId) {
    throw new Response('Access denied', { status: 403 })
  }

  // Additional role-based access checks
  const isCustomerAdmin = user.roles.some(role => role.name === 'customer-admin')
  const isProviderGroupAdmin = user.roles.some(role => role.name === 'provider-group-admin')
  
  if (isProviderGroupAdmin && user.providerGroupId) {
    if (submission.provider.providerGroup?.id !== user.providerGroupId) {
      throw new Response('Access denied', { status: 403 })
    }
  } else if (!isCustomerAdmin) {
    // Basic users can only see submissions for their assigned NPIs
    const hasAccess = user.userNpis.some(un => un.providerId === submission.providerId)
    if (!hasAccess) {
      throw new Response('Access denied', { status: 403 })
    }
  }

  return data({
    user,
    submission,
    isCustomerAdmin,
    isProviderGroupAdmin
  })
}

export default function SubmissionDetail() {
  const { user, submission, isCustomerAdmin, isProviderGroupAdmin } = useLoaderData<typeof loader>()

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'DRAFT': return 'bg-gray-100 text-gray-800'
      case 'SUBMITTED': return 'bg-blue-100 text-blue-800'
      case 'PROCESSING': return 'bg-yellow-100 text-yellow-800'
      case 'COMPLETED': return 'bg-green-100 text-green-800'
      case 'REJECTED': return 'bg-red-100 text-red-800'
      case 'ERROR': return 'bg-red-100 text-red-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const formatSubmissionPurpose = (purpose: string) => {
    return purpose.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  const formatStatus = (status: string) => {
    return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  const formatFileSize = (bytes: number) => {
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    if (bytes === 0) return '0 Bytes'
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i]
  }

  const canEdit = submission.status === 'DRAFT'

  return (
    <InterexLayout user={user}>
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
                <Link to="/customer/submissions" className="hover:text-gray-700">
                  Submissions
                </Link>
                <Icon name="arrow-right" className="h-4 w-4" />
                <span>{submission.title}</span>
              </div>
              <h1 className="text-2xl font-bold leading-7 text-gray-900 sm:truncate sm:text-3xl sm:tracking-tight">
                {submission.title}
              </h1>
              <div className="mt-2 flex items-center gap-4">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(submission.status)}`}>
                  {formatStatus(submission.status)}
                </span>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {formatSubmissionPurpose(submission.purposeOfSubmission)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canEdit && (
                <Link
                  to={`/customer/submissions/${submission.id}/edit`}
                  className="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                >
                  <Icon name="pencil-1" className="mr-1.5 h-4 w-4" />
                  Edit
                </Link>
              )}
              {canEdit && (
                <Link
                  to={`/customer/submissions/${submission.id}/documents/new`}
                  className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                >
                  <Icon name="plus" className="mr-1.5 h-4 w-4" />
                  Add Document
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Submission Details */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Main Details */}
          <div className="lg:col-span-2">
            <div className="bg-white shadow rounded-lg">
              <div className="px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">Submission Details</h3>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Purpose</dt>
                    <dd className="mt-1 text-sm text-gray-900">{formatSubmissionPurpose(submission.purposeOfSubmission)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Recipient</dt>
                    <dd className="mt-1 text-sm text-gray-900">{submission.recipient}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">NPI</dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {submission.provider.npi}
                      {submission.provider.name && (
                        <span className="text-gray-500 ml-2">- {submission.provider.name}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Author Type</dt>
                    <dd className="mt-1 text-sm text-gray-900">{submission.authorType}</dd>
                  </div>
                  {submission.claimId && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Claim ID</dt>
                      <dd className="mt-1 text-sm text-gray-900">{submission.claimId}</dd>
                    </div>
                  )}
                  {submission.caseId && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Case ID</dt>
                      <dd className="mt-1 text-sm text-gray-900">{submission.caseId}</dd>
                    </div>
                  )}
                </div>
                {submission.comments && (
                  <div>
                    <dt className="text-gray-900 font-medium text-gray-500">Comments</dt>
                    <dd className="mt-1 text-sm text-gray-900">{submission.comments}</dd>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Status & Metadata */}
          <div>
            <div className="bg-white shadow rounded-lg">
              <div className="px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">Status & Timeline</h3>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div>
                  <dt className="text-sm font-medium text-gray-500">Current Status</dt>
                  <dd className="mt-1">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(submission.status)}`}>
                      {formatStatus(submission.status)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500">Created</dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {new Date(submission.createdAt).toLocaleDateString()} at {new Date(submission.createdAt).toLocaleTimeString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500">Last Updated</dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {new Date(submission.updatedAt).toLocaleDateString()} at {new Date(submission.updatedAt).toLocaleTimeString()}
                  </dd>
                </div>
                {submission.submittedAt && (
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Submitted</dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {new Date(submission.submittedAt).toLocaleDateString()} at {new Date(submission.submittedAt).toLocaleTimeString()}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-sm font-medium text-gray-500">Created By</dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {submission.creator.name || submission.creator.username}
                  </dd>
                </div>
                {submission.transactionId && (
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Transaction ID</dt>
                    <dd className="mt-1 text-sm text-gray-900 font-mono">{submission.transactionId}</dd>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Documents */}
        <div className="mt-8">
          <div className="bg-white shadow rounded-lg">
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900">Documents ({submission.documents.length})</h3>
                {canEdit && (
                  <Link
                    to={`/customer/submissions/${submission.id}/documents/new`}
                    className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                  >
                    <Icon name="plus" className="mr-1.5 h-4 w-4" />
                    Add Document
                  </Link>
                )}
              </div>
            </div>
            <div className="px-6 py-4">
              {submission.documents.length === 0 ? (
                <div className="text-center py-6">
                  <Icon name="file-text" className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-semibold text-gray-900">No documents</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Add documents to this submission to get started.
                  </p>
                  {canEdit && (
                    <div className="mt-6">
                      <Link
                        to={`/customer/submissions/${submission.id}/documents/new`}
                        className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                      >
                        <Icon name="plus" className="mr-1.5 h-4 w-4" />
                        Add Document
                      </Link>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {submission.documents.map((document: any) => (
                    <div key={document.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-md">
                      <div className="flex items-center">
                        <Icon name="file-text" className="h-5 w-5 text-gray-400 mr-3" />
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {document.title || document.fileName}
                          </div>
                          <div className="text-sm text-gray-500">
                            {formatFileSize(document.fileSize)} • Uploaded {new Date(document.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          {document.documentType}
                        </span>
                        {canEdit && (
                          <button className="text-indigo-600 hover:text-indigo-900 text-sm">
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

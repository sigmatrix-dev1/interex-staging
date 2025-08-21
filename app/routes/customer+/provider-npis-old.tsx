import { data, useLoaderData } from 'react-router'
import { type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { Button } from '#app/components/ui/button.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { Link } from 'react-router'
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { useIsPending } from '#app/utils/misc.tsx'

const CreateProviderSchema = z.object({
  npi: z.string().regex(/^\d{10}$/, 'NPI must be exactly 10 digits'),
  name: z.string().min(1, 'Provider name is required'),
  providerGroupId: z.string().optional(),
})

const DeleteProviderSchema = z.object({
  intent: z.literal('delete'),
  providerId: z.string().min(1, 'Provider ID is required'),
})

const SearchSchema = z.object({
  search: z.string().optional(),
  providerGroupId: z.string().optional(),
})

const ActionSchema = z.discriminatedUnion('intent', [
  CreateProviderSchema.extend({ intent: z.literal('create') }),
  DeleteProviderSchema,
])

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  // Require customer admin role
  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  // Parse search parameters
  const url = new URL(request.url)
  const searchParams = {
    search: url.searchParams.get('search') || '',
    providerGroupId: url.searchParams.get('providerGroupId') || '',
  }

  // Build search conditions
  const whereConditions: any = {
    customerId: user.customerId,
  }

  if (searchParams.search) {
    whereConditions.OR = [
      { npi: { contains: searchParams.search } },
      { name: { contains: searchParams.search, mode: 'insensitive' } },
    ]
  }

  if (searchParams.providerGroupId) {
    whereConditions.providerGroupId = searchParams.providerGroupId
  }

  // Get customer data with provider groups and providers
  const customer = await prisma.customer.findUnique({
    where: { id: user.customerId },
    include: {
      providerGroups: {
        include: {
          _count: {
            select: { users: true, providers: true }
          }
        }
      },
      providers: {
        where: whereConditions,
        include: {
          providerGroup: { select: { id: true, name: true } },
          userNpis: {
            include: {
              user: { select: { id: true, name: true, email: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  })

  if (!customer) {
    throw new Response('Customer not found', { status: 404 })
  }

  return data({ user, customer, searchParams })
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      customerId: true,
      roles: { select: { name: true } },
    },
  })

  if (!user) {
    throw new Response('Unauthorized', { status: 401 })
  }

  requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])

  if (!user.customerId) {
    throw new Response('Customer admin must be associated with a customer', { status: 400 })
  }

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: ActionSchema })

  if (submission.status !== 'success') {
    return data(
      { result: submission.reply() },
      { status: submission.status === 'error' ? 400 : 200 }
    )
  }

  const { intent } = submission.value

  if (intent === 'create') {
    const { npi, name, providerGroupId } = submission.value

    // Check if NPI already exists
    const existingProvider = await prisma.provider.findUnique({
      where: { npi }
    })

    if (existingProvider) {
      return data(
        { 
          result: submission.reply({
            fieldErrors: {
              npi: ['NPI already exists in the system']
            }
          })
        },
        { status: 400 }
      )
    }

    // Validate provider group belongs to customer (if provided)
    if (providerGroupId) {
      const providerGroup = await prisma.providerGroup.findFirst({
        where: {
          id: providerGroupId,
          customerId: user.customerId
        }
      })

      if (!providerGroup) {
        return data(
          { 
            result: submission.reply({
              fieldErrors: {
                providerGroupId: ['Invalid provider group']
              }
            })
          },
          { status: 400 }
        )
      }
    }

    // Create the provider
    await prisma.provider.create({
      data: {
        npi,
        name,
        customerId: user.customerId,
        providerGroupId: providerGroupId || null,
      }
    })

    return data({ result: submission.reply({ resetForm: true }) })
  }

  if (intent === 'delete') {
    const { providerId } = submission.value

    // Verify the provider belongs to the customer
    const provider = await prisma.provider.findFirst({
      where: {
        id: providerId,
        customerId: user.customerId
      }
    })

    if (!provider) {
      return data(
        { result: submission.reply({ formErrors: ['Provider not found or not authorized to delete'] }) },
        { status: 404 }
      )
    }

    // Delete the provider (this will cascade delete UserNpi relationships)
    await prisma.provider.delete({
      where: { id: providerId }
    })

    return data({ result: submission.reply() })
  }

  return data({ result: submission.reply() })
}

export default function ProviderNpisPage() {
  const { user, customer, searchParams } = useLoaderData<typeof loader>()
  const isPending = useIsPending()

  const [form, fields] = useForm({
    id: 'create-provider-form',
    constraint: getZodConstraint(CreateProviderSchema),
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateProviderSchema })
    },
  })

  const [searchForm, searchFields] = useForm({
    id: 'search-form',
    constraint: getZodConstraint(SearchSchema),
    defaultValue: searchParams,
  })

  return (
    <InterexLayout user={user}>
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <h1 className="text-2xl font-bold text-gray-900">Provider NPIs</h1>
            <div className="flex space-x-3">
              <Link 
                to="/customer"
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* Search and Filter */}
        <div className="bg-white shadow rounded-lg p-6 mb-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Search NPIs</h2>
          <form method="get" {...getFormProps(searchForm)}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field
                labelProps={{ children: 'Search by NPI or Name' }}
                inputProps={{
                  ...getInputProps(searchFields.search, { type: 'text' }),
                  placeholder: 'Enter NPI or provider name',
                }}
                errors={searchFields.search.errors}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Provider Group
                </label>
                <select
                  {...getInputProps(searchFields.providerGroupId, { type: 'text' })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="">All Provider Groups</option>
                  {customer.providerGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <ErrorList errors={searchFields.providerGroupId.errors} />
              </div>

              <div className="flex items-end">
                <Button type="submit" className="w-full">
                  <Icon name="magnifying-glass" className="h-4 w-4 mr-2" />
                  Search
                </Button>
              </div>
            </div>
          </form>
        </div>

        {/* Create New Provider */}
        <div className="bg-white shadow rounded-lg p-6 mb-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Add New Provider NPI</h2>
          <form method="post" {...getFormProps(form)}>
            <input type="hidden" name="intent" value="create" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Field
                labelProps={{ children: 'NPI Number' }}
                inputProps={{
                  ...getInputProps(fields.npi, { type: 'text' }),
                  placeholder: 'Enter 10-digit NPI',
                  maxLength: 10,
                }}
                errors={fields.npi.errors}
              />

              <Field
                labelProps={{ children: 'Provider Name' }}
                inputProps={{
                  ...getInputProps(fields.name, { type: 'text' }),
                  placeholder: 'Enter provider name',
                }}
                errors={fields.name.errors}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Provider Group (Optional)
                </label>
                <select
                  {...getInputProps(fields.providerGroupId, { type: 'text' })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="">Select provider group</option>
                  {customer.providerGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <ErrorList errors={fields.providerGroupId.errors} />
              </div>
            </div>

            <ErrorList errors={form.errors} />

            <div className="mt-6">
              <StatusButton
                type="submit"
                status={isPending ? 'pending' : 'idle'}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                Add Provider NPI
              </StatusButton>
            </div>
          </form>
        </div>

        {/* Provider NPIs List */}
        <div className="bg-white shadow rounded-lg p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-medium text-gray-900">Provider NPIs ({customer.providers.length})</h2>
          </div>

          {customer.providers.length === 0 ? (
            <div className="text-center py-12">
              <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No provider NPIs found</h3>
              <p className="text-gray-500 mb-4">Get started by adding your first provider NPI.</p>
            </div>
          ) : (
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      NPI / Provider
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Provider Group
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Assigned Users
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {customer.providers.map((provider) => (
                    <tr key={provider.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {provider.npi}
                          </div>
                          <div className="text-sm text-gray-500">
                            {provider.name}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {provider.providerGroup ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            {provider.providerGroup.name}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-400">Not assigned</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {provider.userNpis.length} user{provider.userNpis.length !== 1 ? 's' : ''}
                        </div>
                        {provider.userNpis.length > 0 && (
                          <div className="text-xs text-gray-500">
                            {provider.userNpis.slice(0, 2).map(un => un.user.name).join(', ')}
                            {provider.userNpis.length > 2 && ` +${provider.userNpis.length - 2} more`}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center space-x-2">
                          <Link
                            to={`/customer/provider-npis/${provider.id}/edit`}
                            className="text-blue-600 hover:text-blue-800 p-1"
                            title="Edit provider"
                          >
                            <Icon name="pencil-1" className="h-4 w-4" />
                          </Link>
                          <form method="post" className="inline">
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="providerId" value={provider.id} />
                            <button
                              type="submit"
                              className="text-red-600 hover:text-red-800 p-1"
                              title="Delete provider"
                              onClick={(e) => {
                                if (!confirm(`Are you sure you want to delete NPI ${provider.npi}? This action cannot be undone and will remove all user assignments.`)) {
                                  e.preventDefault()
                                }
                              }}
                            >
                              <Icon name="trash" className="h-4 w-4" />
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </InterexLayout>
  )
}

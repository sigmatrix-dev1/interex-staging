// app/routes/admin+/system-admin.new.tsx
// External libs first
import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type LoaderFunctionArgs, type ActionFunctionArgs, data, Form, useActionData, useLoaderData, Link } from 'react-router'
import { z } from 'zod'
// UI components
import { Field, ErrorList } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
// Domain & utils (audit before others per lint preference)
import { audit } from '#app/services/audit.server.ts'
// then auth, roles, db, password, email, toast
import { requireUserId, checkIsCommonPassword } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { sendAdminPasswordManualResetEmail } from '#app/utils/emails/send-admin-password-manual-reset.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { generateTemporaryPassword, hashPassword } from '#app/utils/password.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'

const CreateSystemAdminSchema = z.object({
  intent: z.literal('create'),
  email: z.string().email('Invalid email'),
  username: z.string().min(3, 'Min 3 chars'),
  name: z.string().min(1, 'Required').optional(),
  active: z.boolean().default(true),
})

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, roles: { select: { name: true } } },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])
  return data({ user })
}

export async function action({ request }: ActionFunctionArgs) {
  const actorId = await requireUserId(request)
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, roles: { select: { name: true } }, name: true, email: true } })
  if (!actor) throw new Response('Unauthorized', { status: 401 })
  requireRoles(actor, [INTEREX_ROLES.SYSTEM_ADMIN])

  const formData = await request.formData()
  const submission = parseWithZod(formData, { schema: CreateSystemAdminSchema })
  if (submission.status !== 'success') {
    return data({ result: submission.reply() }, { status: 400 })
  }
  const { email, username, name, active } = submission.value

  const actorHighestRole = actor.roles.map(r => r.name).includes(INTEREX_ROLES.SYSTEM_ADMIN)
    ? INTEREX_ROLES.SYSTEM_ADMIN
    : actor.roles[0]?.name || 'unknown'

  await audit.admin({
    actorType: 'USER',
    actorId: actorId,
    action: 'USER_CREATE_ATTEMPT',
    status: 'SUCCESS',
    message: 'Attempt create system admin',
    metadata: JSON.stringify({ email, username, actorHighestRole }),
  }).catch(() => {})

  const exists = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] }, select: { id: true, email: true, username: true } })
  if (exists) {
    await audit.admin({
      actorType: 'USER',
      actorId: actorId,
      action: 'USER_CREATE_ATTEMPT',
      status: 'FAILURE',
      message: 'Conflict email/username',
      metadata: JSON.stringify({ email, username, actorHighestRole }),
    }).catch(() => {})
    return data({ result: submission.reply({ fieldErrors: { ...(exists.email === email ? { email: ['Email already exists'] } : {}), ...(exists.username === username ? { username: ['Username already exists'] } : {}) } }) }, { status: 400 })
  }

  let role = await prisma.role.findUnique({ where: { name: INTEREX_ROLES.SYSTEM_ADMIN } })
  if (!role) {
    role = await prisma.role.create({ data: { name: INTEREX_ROLES.SYSTEM_ADMIN, description: 'System Administrator' } })
  }

  let tempPassword = generateTemporaryPassword()
  for (let i = 0; i < 3; i++) {
    if (!(await checkIsCommonPassword(tempPassword))) break
    tempPassword = generateTemporaryPassword()
  }
  const passwordHash = hashPassword(tempPassword)

  const created = await (prisma as any).user.create({
    data: {
      email,
      username,
      name: name || null,
      active,
      mustChangePassword: true,
      roles: { connect: { id: role.id } },
      password: { create: { hash: passwordHash } },
    },
    select: { id: true, email: true, username: true, name: true },
  })

  await audit.admin({
    actorType: 'USER',
    actorId: actorId,
    action: 'USER_CREATE',
    status: 'SUCCESS',
    entityType: 'USER',
    entityId: created.id,
    message: 'System admin created',
    metadata: JSON.stringify({ email, username, actorHighestRole }),
  }).catch(() => {})

  const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
  void sendAdminPasswordManualResetEmail({
    to: created.email,
    recipientName: created.name || created.username,
    requestedByName: actor.name ?? undefined,
    customerName: undefined,
    username: created.username,
    tempPassword,
    loginUrl,
  })

  return redirectWithToast('/admin/users', {
    type: 'success',
    title: 'System Admin Created',
    description: `${created.username} created with temporary password (emailed).`,
  })
}

export default function CreateSystemAdminPage() {
  const { user } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [form, fields] = useForm({
    id: 'create-system-admin',
    constraint: getZodConstraint(CreateSystemAdminSchema),
    lastResult: actionData?.result,
    onValidate({ formData }) { return parseWithZod(formData, { schema: CreateSystemAdminSchema }) },
    defaultValue: { email: '', username: '', name: '', active: true },
  })
  // Extract checkbox props once so we can reference the generated id in the label htmlFor
  const activeInputProps = getInputProps(fields.active, { type: 'checkbox' })
  return (
    <InterexLayout user={user} title="Create System Admin" subtitle="Add a new global administrator" currentPath="/admin/system-admin/new" actions={<Link to="/admin/users" className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"><Icon name="arrow-left" className="-ml-1 mr-2 h-4 w-4" />Back</Link>}>
      <div className="max-w-xl mx-auto py-8">
        <div className="bg-white shadow rounded-lg p-6">
          <Form method="post" {...getFormProps(form)} className="space-y-6">
            <input type="hidden" name="intent" value="create" />
            <Field labelProps={{ children: 'Email *' }} inputProps={{ ...getInputProps(fields.email, { type: 'email' }), placeholder: 'admin@example.com' }} errors={fields.email.errors} />
            <Field labelProps={{ children: 'Username *' }} inputProps={{ ...getInputProps(fields.username, { type: 'text' }), placeholder: 'sysadmin' }} errors={fields.username.errors} />
            <Field labelProps={{ children: 'Name (Optional)' }} inputProps={{ ...getInputProps(fields.name, { type: 'text' }), placeholder: 'Jane Smith' }} errors={fields.name.errors} />
            <div className="flex items-center gap-2">
              <input {...activeInputProps} defaultChecked className="h-4 w-4 text-blue-600 border-gray-300 rounded" />
              <label htmlFor={activeInputProps.id} className="text-sm text-gray-700">Active</label>
            </div>
            <ErrorList errors={form.errors} id={form.errorId} />
            <div className="flex justify-end gap-3 pt-2 border-t">
              <Link to="/admin/users" className="px-4 py-2 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Cancel</Link>
              <StatusButton
                status={form.status ?? 'idle'}
                type="submit"
                className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700"
                onClick={(e) => {
                  if (!confirm('Create this System Admin? They will receive a temporary password and have full platform access.')) {
                    e.preventDefault()
                  }
                }}
              >
                Create System Admin
              </StatusButton>
            </div>
          </Form>
          <div className="mt-6 text-xs text-gray-500 space-y-1">
            <p>A strong temporary password will be generated and emailed. The user must change it upon first login.</p>
            <p>This account is not associated with any customer and has full system scope.</p>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

// Note: Uses audit.admin wrapper (no direct writeAudit import/export needed)

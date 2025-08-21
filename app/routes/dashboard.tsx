import { type LoaderFunctionArgs } from 'react-router'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { redirectToDashboard } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      roles: { select: { name: true } }
    }
  })

  if (!user) {
    throw new Response('User not found', { status: 404 })
  }

  // Redirect to appropriate dashboard based on role
  return redirectToDashboard(user)
}

// This component should never render because the loader always redirects
export default function Dashboard() {
  return null
}

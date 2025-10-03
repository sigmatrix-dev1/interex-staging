// Central helpers for querying only "active" users (not soft-deleted, active flag true)
// Phase 0 addition: consolidate logic to reduce risk of including soft-deleted users.

import { prisma } from '#app/utils/db.server.ts'

export function activeUserWhere(extra: Record<string, any> = {}) {
  return {
    deletedAt: null,
    active: true,
    ...extra,
  }
}

export async function getActiveUserById(id: string, select?: any) {
  return prisma.user.findFirst({
    where: activeUserWhere({ id }),
    select: select ?? { id: true },
  })
}

export async function ensureActiveUser(id: string, select?: any) {
  const user = await getActiveUserById(id, select)
  if (!user) throw new Error('User not found or inactive')
  return user
}

export async function listActiveUsers(args: { skip?: number; take?: number; select?: any } = {}) {
  const { skip, take, select } = args
  return prisma.user.findMany({
    where: activeUserWhere(),
    skip,
    take,
    select: select ?? { id: true, email: true, username: true },
    orderBy: { createdAt: 'desc' },
  })
}

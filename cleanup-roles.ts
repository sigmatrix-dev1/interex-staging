#!/usr/bin/env tsx

/**
 * Cleanup script to ensure only the 4 required Interex roles exist in the database
 * and remove any references to old 'user' or 'admin' roles
 */

import { prisma } from '#app/utils/db.server.ts'

const REQUIRED_ROLES = [
  { name: 'system-admin', description: 'System Administrator with capability to add new customers', active: true },
  { name: 'customer-admin', description: 'Customer Administrator with full access to customer organization', active: true },
  { name: 'provider-group-admin', description: 'Provider Group Administrator with access to their provider group', active: true },
  { name: 'basic-user', description: 'Basic user with access to assigned NPIs only', active: true },
]

const ROLES_TO_REMOVE = ['user', 'admin', 'super-admin', 'x']

async function cleanupRoles() {
  console.log('🧹 Starting role cleanup...')

  // First, update any users with old roles to use 'basic-user'
  console.log('📝 Updating users with old roles...')
  
  for (const oldRoleName of ROLES_TO_REMOVE) {
    const usersWithOldRole = await prisma.user.findMany({
      where: {
        roles: {
          some: {
            name: oldRoleName
          }
        }
      },
      include: {
        roles: true
      }
    })

    console.log(`Found ${usersWithOldRole.length} users with role '${oldRoleName}'`)

    for (const user of usersWithOldRole) {
      // Disconnect old role and connect basic-user role
      await prisma.user.update({
        where: { id: user.id },
        data: {
          roles: {
            disconnect: { name: oldRoleName },
            connect: { name: 'basic-user' }
          }
        }
      })
      console.log(`Updated user ${user.email} from '${oldRoleName}' to 'basic-user'`)
    }
  }

  // Ensure all required roles exist
  console.log('✅ Ensuring required roles exist...')
  for (const role of REQUIRED_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        description: role.description,
        active: role.active
      },
      create: role
    })
    console.log(`✓ Role '${role.name}' is ready`)
  }

  // Remove old roles (but only if no users are still connected to them)
  console.log('🗑️ Removing old roles...')
  for (const oldRoleName of ROLES_TO_REMOVE) {
    // Check if any users still have this role
    const usersCount = await prisma.user.count({
      where: {
        roles: {
          some: {
            name: oldRoleName
          }
        }
      }
    })

    if (usersCount === 0) {
      try {
        await prisma.role.delete({
          where: { name: oldRoleName }
        })
        console.log(`✓ Removed old role '${oldRoleName}'`)
      } catch (error) {
        console.log(`ℹ️ Role '${oldRoleName}' doesn't exist or couldn't be removed:`, (error as Error).message)
      }
    } else {
      console.log(`⚠️ Cannot remove role '${oldRoleName}' - ${usersCount} users still have this role`)
    }
  }

  // Verify final state
  console.log('🔍 Verifying final role state...')
  const allRoles = await prisma.role.findMany({
    orderBy: { name: 'asc' }
  })

  console.log('Current roles in database:')
  allRoles.forEach(role => {
    console.log(`  - ${role.name}: ${role.description}`)
  })

  const unexpectedRoles = allRoles.filter(role => 
    !REQUIRED_ROLES.some(req => req.name === role.name)
  )

  if (unexpectedRoles.length > 0) {
    console.log('⚠️ WARNING: Found unexpected roles:')
    unexpectedRoles.forEach(role => {
      console.log(`  - ${role.name}`)
    })
  } else {
    console.log('✅ All roles are as expected!')
  }

  console.log('🎉 Role cleanup completed!')
}

cleanupRoles()
  .catch((e) => {
    console.error('❌ Error during cleanup:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

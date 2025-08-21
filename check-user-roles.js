// Check user roles in database
import { PrismaClient } from '@prisma/client'

async function checkUserRoles() {
  const prisma = new PrismaClient()
  
  console.log('🔍 Checking user roles...')
  
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        roles: {
          select: {
            name: true,
          },
        },
      },
      take: 10, // Just first 10 users
    })
    
    console.log('Users and their roles:')
    users.forEach(user => {
      console.log(`- ${user.email} (${user.username}): [${user.roles.map(r => r.name).join(', ')}]`)
    })
    
    // Check if we have any system admins
    const systemAdmins = users.filter(u => u.roles.some(r => r.name === 'system-admin'))
    console.log(`\n📊 System admins found: ${systemAdmins.length}`)
    
    if (systemAdmins.length === 0) {
      console.log('❌ No system admins found! This might be the issue.')
    }
    
    // Check what roles exist
    const allRoles = await prisma.role.findMany({
      select: { name: true },
    })
    console.log('\n🏷️  All roles in database:')
    allRoles.forEach(role => {
      console.log(`- ${role.name}`)
    })
    
  } catch (error) {
    console.error('❌ Error checking user roles:', error)
  } finally {
    await prisma.$disconnect()
  }
}

checkUserRoles()

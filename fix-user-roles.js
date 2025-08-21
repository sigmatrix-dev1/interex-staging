// Fix user roles for the transition
import { PrismaClient } from '@prisma/client'

async function fixUserRoles() {
  const prisma = new PrismaClient()
  
  console.log('🔧 Fixing user roles...')
  
  try {
    // Find the kody user who has admin role
    const kodyUser = await prisma.user.findUnique({
      where: { email: 'kody@kcd.dev' },
      include: { roles: true },
    })
    
    if (!kodyUser) {
      console.log('❌ Kody user not found')
      return
    }
    
    console.log(`Found user: ${kodyUser.email}`)
    console.log(`Current roles: [${kodyUser.roles.map(r => r.name).join(', ')}]`)
    
    // Check if they already have system-admin role
    const hasSystemAdmin = kodyUser.roles.some(r => r.name === 'system-admin')
    
    if (!hasSystemAdmin) {
      // Add system-admin role
      const systemAdminRole = await prisma.role.findUnique({
        where: { name: 'system-admin' },
      })
      
      if (systemAdminRole) {
        await prisma.user.update({
          where: { id: kodyUser.id },
          data: {
            roles: {
              connect: { id: systemAdminRole.id },
            },
          },
        })
        console.log('✅ Added system-admin role to kody user')
      } else {
        console.log('❌ system-admin role not found')
      }
    } else {
      console.log('✅ User already has system-admin role')
    }
    
    // Verify the update
    const updatedUser = await prisma.user.findUnique({
      where: { email: 'kody@kcd.dev' },
      include: { roles: true },
    })
    
    console.log(`Updated roles: [${updatedUser?.roles.map(r => r.name).join(', ')}]`)
    
  } catch (error) {
    console.error('❌ Error fixing user roles:', error)
  } finally {
    await prisma.$disconnect()
  }
}

fixUserRoles()

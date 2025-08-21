#!/usr/bin/env node
/**
 * System Admin User Management Script
 * 
 * This script helps you:
 * 1. Find existing system-admin users
 * 2. Create a new system-admin user with basic credentials
 * 3. Reset password for existing system-admin users
 */

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function findSystemAdmins() {
  console.log('🔍 Searching for existing system-admin users...\n')
  
  const systemAdmins = await prisma.user.findMany({
    where: {
      roles: {
        some: {
          name: 'system-admin'
        }
      }
    },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      active: true,
      createdAt: true,
      roles: {
        select: {
          name: true
        }
      }
    }
  })

  if (systemAdmins.length === 0) {
    console.log('❌ No system-admin users found!\n')
    return []
  }

  console.log(`✅ Found ${systemAdmins.length} system-admin user(s):\n`)
  systemAdmins.forEach((user, index) => {
    console.log(`${index + 1}. Email: ${user.email}`)
    console.log(`   Username: ${user.username}`)
    console.log(`   Name: ${user.name || 'N/A'}`)
    console.log(`   Status: ${user.active ? '✅ Active' : '❌ Inactive'}`)
    console.log(`   Created: ${user.createdAt.toISOString()}`)
    console.log(`   Roles: [${user.roles.map(r => r.name).join(', ')}]`)
    console.log('')
  })

  return systemAdmins
}

async function createSystemAdminUser(username = 'admin', email = 'admin@example.com', password = 'admin', name = 'System Administrator') {
  console.log(`🔧 Creating new system-admin user...`)
  console.log(`   Username: ${username}`)
  console.log(`   Email: ${email}`)
  console.log(`   Password: ${password}`)
  console.log(`   Name: ${name}\n`)

  try {
    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email },
          { username: username }
        ]
      }
    })

    if (existingUser) {
      console.log(`❌ User with email "${email}" or username "${username}" already exists!`)
      console.log(`   Existing user: ${existingUser.email} (${existingUser.username})`)
      return null
    }

    // Ensure system-admin role exists
    const systemAdminRole = await prisma.role.upsert({
      where: { name: 'system-admin' },
      update: {},
      create: {
        name: 'system-admin',
        description: 'System Administrator with capability to add new customers',
        active: true
      }
    })

    // Create the user
    const hashedPassword = bcrypt.hashSync(password, 10)
    
    const newUser = await prisma.user.create({
      data: {
        username: username,
        email: email,
        name: name,
        active: true,
        password: {
          create: {
            hash: hashedPassword
          }
        },
        roles: {
          connect: {
            id: systemAdminRole.id
          }
        }
      },
      include: {
        roles: {
          select: {
            name: true
          }
        }
      }
    })

    console.log('✅ System admin user created successfully!')
    console.log(`   ID: ${newUser.id}`)
    console.log(`   Username: ${newUser.username}`)
    console.log(`   Email: ${newUser.email}`)
    console.log(`   Roles: [${newUser.roles.map(r => r.name).join(', ')}]`)
    console.log('')
    
    return newUser

  } catch (error) {
    console.error('❌ Error creating system admin user:', error)
    return null
  }
}

async function resetUserPassword(userIdentifier, newPassword = 'admin123') {
  console.log(`🔑 Resetting password for user: ${userIdentifier}`)
  
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: userIdentifier },
          { username: userIdentifier },
          { id: userIdentifier }
        ]
      },
      include: {
        roles: true
      }
    })

    if (!user) {
      console.log(`❌ User not found: ${userIdentifier}`)
      return false
    }

    // Hash the new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10)

    // Update the password
    await prisma.password.upsert({
      where: { userId: user.id },
      update: {
        hash: hashedPassword
      },
      create: {
        userId: user.id,
        hash: hashedPassword
      }
    })

    console.log(`✅ Password reset successfully for ${user.email} (${user.username})`)
    console.log(`   New password: ${newPassword}`)
    return true

  } catch (error) {
    console.error('❌ Error resetting password:', error)
    return false
  }
}

async function main() {
  console.log('🚀 System Admin User Management\n')
  console.log('=' .repeat(50) + '\n')

  try {
    // First, find existing system admins
    const existingAdmins = await findSystemAdmins()

    if (existingAdmins.length === 0) {
      console.log('Creating a default system admin user since none exist...\n')
      await createSystemAdminUser('admin', 'admin@example.com', 'admin123', 'Default System Administrator')
    } else {
      console.log('System admin users already exist. You can use one of the above accounts.')
      console.log('If you forgot the password, you can reset it by running:')
      console.log('node manage-admin-user.js reset <username-or-email> [new-password]')
    }

    console.log('\n' + '=' .repeat(50))
    console.log('✅ Management complete!')
    
    if (existingAdmins.length === 0) {
      console.log('\n🎉 You can now login with:')
      console.log('   Username: admin')
      console.log('   Email: admin@example.com') 
      console.log('   Password: admin123')
    }

  } catch (error) {
    console.error('❌ Error in main process:', error)
  } finally {
    await prisma.$disconnect()
  }
}

// Handle command line arguments
const args = process.argv.slice(2)
const command = args[0]

if (command === 'reset') {
  const userIdentifier = args[1]
  const newPassword = args[2] || 'admin123'
  
  if (!userIdentifier) {
    console.log('❌ Usage: node manage-admin-user.js reset <username-or-email> [new-password]')
    process.exit(1)
  }

  resetUserPassword(userIdentifier, newPassword)
    .then(() => prisma.$disconnect())
    .catch(error => {
      console.error('Error:', error)
      prisma.$disconnect()
    })
} else if (command === 'create') {
  const username = args[1] || 'admin'
  const email = args[2] || 'admin@example.com'
  const password = args[3] || 'admin123'
  const name = args[4] || 'System Administrator'

  createSystemAdminUser(username, email, password, name)
    .then(() => prisma.$disconnect())
    .catch(error => {
      console.error('Error:', error)
      prisma.$disconnect()
    })
} else if (command === 'find') {
  findSystemAdmins()
    .then(() => prisma.$disconnect())
    .catch(error => {
      console.error('Error:', error)
      prisma.$disconnect()
    })
} else {
  // Default: run the main management process
  main()
}

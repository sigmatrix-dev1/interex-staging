#!/usr/bin/env node
/**
 * Flexible User Management Script
 *
 * Usage:
 *   node manage-user.js create <role> <username> <email> <password> <name>
 *   node manage-user.js reset <username-or-email> [new-password]
 *   node manage-user.js find <role>
 *
 * Roles: system-admin, customer-admin, provider-group-admin, basic-user
 */

const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function findUsersByRole(role) {
  console.log(`🔍 Searching for users with role: ${role}\n`)
  const users = await prisma.user.findMany({
    where: {
      roles: { some: { name: role } }
    },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      active: true,
      createdAt: true,
      roles: { select: { name: true } }
    }
  })
  if (users.length === 0) {
    console.log(`❌ No users found with role: ${role}\n`)
    return []
  }
  users.forEach((user, i) => {
    console.log(`${i + 1}. Email: ${user.email}`)
    console.log(`   Username: ${user.username}`)
    console.log(`   Name: ${user.name || 'N/A'}`)
    console.log(`   Status: ${user.active ? '✅ Active' : '❌ Inactive'}`)
    console.log(`   Created: ${user.createdAt.toISOString()}`)
    console.log(`   Roles: [${user.roles.map(r => r.name).join(', ')}]`)
    console.log('')
  })
  return users
}

async function createUser(role, username, email, password, name) {
  if (!role || !username || !email || !password || !name) {
    console.log('❌ Usage: node manage-user.js create <role> <username> <email> <password> <name>')
    process.exit(1)
  }
  console.log(`🔧 Creating new user...`)
  console.log(`   Role: ${role}`)
  console.log(`   Username: ${username}`)
  console.log(`   Email: ${email}`)
  console.log(`   Password: ${password}`)
  console.log(`   Name: ${name}\n`)
  try {
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] }
    })
    if (existingUser) {
      console.log(`❌ User with email "${email}" or username "${username}" already exists!`)
      return null
    }
    const userRole = await prisma.role.upsert({
      where: { name: role },
      update: {},
      create: { name: role, description: `${role} role`, active: true }
    })
    const hashedPassword = bcrypt.hashSync(password, 10)
    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        name,
        active: true,
        password: { create: { hash: hashedPassword } },
        roles: { connect: { id: userRole.id } }
      },
      include: { roles: { select: { name: true } } }
    })
    console.log('✅ User created successfully!')
    console.log(`   ID: ${newUser.id}`)
    console.log(`   Username: ${newUser.username}`)
    console.log(`   Email: ${newUser.email}`)
    console.log(`   Roles: [${newUser.roles.map(r => r.name).join(', ')}]`)
    return newUser
  } catch (error) {
    console.error('❌ Error creating user:', error)
    return null
  }
}

async function resetUserPassword(userIdentifier, newPassword = 'admin123') {
  if (!userIdentifier) {
    console.log('❌ Usage: node manage-user.js reset <username-or-email> [new-password]')
    process.exit(1)
  }
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
      include: { roles: true }
    })
    if (!user) {
      console.log(`❌ User not found: ${userIdentifier}`)
      return false
    }
    const hashedPassword = bcrypt.hashSync(newPassword, 10)
    await prisma.password.upsert({
      where: { userId: user.id },
      update: { hash: hashedPassword },
      create: { userId: user.id, hash: hashedPassword }
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
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === 'create') {
    await createUser(args[1], args[2], args[3], args[4], args[5])
  } else if (command === 'reset') {
    await resetUserPassword(args[1], args[2])
  } else if (command === 'find') {
    await findUsersByRole(args[1])
  } else {
    console.log('Usage:')
    console.log('  node manage-user.js create <role> <username> <email> <password> <name>')
    console.log('  node manage-user.js reset <username-or-email> [new-password]')
    console.log('  node manage-user.js find <role>')
    console.log('\nRoles: system-admin, customer-admin, provider-group-admin, basic-user')
  }
  await prisma.$disconnect()
}

main()

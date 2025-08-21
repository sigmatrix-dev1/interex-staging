import { prisma } from '../../app/utils/db.server'
import { createPassword } from '../../tests/db-utils'

async function main() {
  const email = 'kody@kcd.dev' // admin email from seed
  const username = 'kody' // admin username from seed
  const newPassword = 'sysadmin'

  // Update by email or username
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email },
        { username },
      ],
    },
  })

  if (!user) {
    console.error('Admin user not found!')
    process.exit(1)
  }

  // Update password using the same hashing as seed
  await prisma.password.updateMany({
    where: { userId: user.id },
    data: createPassword(newPassword),
  })

  console.log('Admin password updated successfully!')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})

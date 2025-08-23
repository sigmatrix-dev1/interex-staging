// prisma/seed-sigmatrix.ts
import bcrypt from 'bcryptjs'
import { prisma } from '#app/utils/db.server.ts'

const ROLES = [
    'system-admin',
    'customer-admin',
    'provider-group-admin',
    'basic-user',
] as const

const SIGMATRIX = {
    customer: {
        name: 'Sigmatrix',
        description: 'Sigmatrix health org',
        baaNumber: 'SIGMATRIX-BAA-001',
    },
    providerGroup: {
        name: 'Sigmatrix Group A',
        description: 'Primary provider group for Sigmatrix',
    },
    providers: [
        { npi: '1992701343', name: 'Sigmatrix Clinic 1' },
        { npi: '1234567890', name: 'Sigmatrix Clinic 2' },
    ],
} as const

const RECIPIENT = {
    displayName: 'Medicare Review Contractor',
    oid: '2.16.840.1.113883.13.34.110.1.110.5',
    active: true,
} as const

const USERS = [
    { role: 'system-admin',          username: 'sysadmin',  email: 'sysadmin@sigmatrix.com',  name: 'Sigmatrix System Admin' },
    { role: 'customer-admin',        username: 'custadmin', email: 'custadmin@sigmatrix.com', name: 'Sigmatrix Customer Admin' },
    { role: 'provider-group-admin',  username: 'pgadmin',   email: 'pgadmin@sigmatrix.com',   name: 'Sigmatrix Provider Group Admin' },
    { role: 'basic-user',            username: 'basicuser', email: 'basicuser@sigmatrix.com', name: 'Sigmatrix Basic User' },
] as const

async function hashPassword(plain: string) {
    const salt = await bcrypt.genSalt(10)
    return bcrypt.hash(plain, salt)
}

async function main() {
    console.log('🌱 Seeding Sigmatrix data only...')

    // 1) Ensure roles exist
    for (const name of ROLES) {
        await prisma.role.upsert({
            where: { name },
            update: {},
            create: { name, description: `${name} role`, active: true },
        })
    }

    // 2) Customer
    const customer = await prisma.customer.upsert({
        where: { baaNumber: SIGMATRIX.customer.baaNumber },
        update: SIGMATRIX.customer,
        create: { ...SIGMATRIX.customer, baaDate: new Date() },
    })

    // 3) Provider group
    const providerGroup = await prisma.providerGroup.upsert({
        where: { customerId_name: { customerId: customer.id, name: SIGMATRIX.providerGroup.name } },
        update: SIGMATRIX.providerGroup,
        create: { ...SIGMATRIX.providerGroup, customerId: customer.id },
    })

    // 4) Providers (NPIs)
    const providers = []
    for (const p of SIGMATRIX.providers) {
        const provider = await prisma.provider.upsert({
            where: { npi: p.npi },
            update: { name: p.name, customerId: customer.id, providerGroupId: providerGroup.id },
            create: { ...p, customerId: customer.id, providerGroupId: providerGroup.id },
        })
        providers.push(provider)
    }

   // 5) Users (password = username)
    for (const u of USERS) {
        const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } })
        const passwordHash = await hashPassword(u.username)

        // If user exists, keep/replace role assignment
        const user = await prisma.user.upsert({
            where: { username: u.username },
            update: {
                email: u.email,
                name: u.name,
                roles: { set: [{ id: role.id }] },
                customerId: u.role === 'system-admin' ? null : customer.id,
                providerGroupId: ['provider-group-admin', 'basic-user'].includes(u.role) ? providerGroup.id : null,
            },
            create: {
                email: u.email,
                username: u.username,
                name: u.name,
                roles: { connect: { id: role.id } },
                customerId: u.role === 'system-admin' ? null : customer.id,
                providerGroupId: ['provider-group-admin', 'basic-user'].includes(u.role) ? providerGroup.id : null,
                password: { create: { hash: passwordHash } },
            },
        })

        // Assign both NPIs to the basic user
        if (u.role === 'basic-user') {
            for (const p of providers) {
                await prisma.userNpi.upsert({
                    where: { userId_providerId: { userId: user.id, providerId: p.id } },
                    update: {},
                    create: { userId: user.id, providerId: p.id },
                })
            }
        }
    }

    console.log('✅ Sigmatrix seed done.')
}

main()
    .catch(e => {
        console.error(e)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())

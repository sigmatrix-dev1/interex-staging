import { faker } from '@faker-js/faker'
import { prisma } from '#app/utils/db.server.ts'
import {
	createPassword,
	createUser,
	getNoteImages,
	getUserImages,
} from '#tests/db-utils.ts'

// Interex-specific seed data for User Management
const INTEREX_ROLES = [
	{ name: 'system-admin', description: 'System Administrator with capability to add new customers', active: true },
	{ name: 'customer-admin', description: 'Customer Administrator with full access to customer organization', active: true },
	{ name: 'provider-group-admin', description: 'Provider Group Administrator with access to their provider group', active: true },
	{ name: 'basic-user', description: 'Basic user with access to assigned NPIs only', active: true },
]

async function seed() {
	console.log('🌱 Seeding...')
	console.time(`🌱 Database has been seeded`)

	// Seed Interex roles
	console.time('👥 Created Interex roles...')
	for (const role of INTEREX_ROLES) {
		await prisma.role.upsert({
			where: { name: role.name },
			update: role,
			create: role,
		})
	}
	console.timeEnd('👥 Created Interex roles...')

	// Create sample Interex customers and provider groups
	console.time('🏢 Created sample customers and provider groups...')
	
	const sampleCustomers = [
		{ name: 'HealthTech Solutions', description: 'Large healthcare technology company', baaNumber: 'BAA-2024-001' },
		{ name: 'MedConnect Systems', description: 'Healthcare information exchange', baaNumber: 'BAA-2024-002' },
		{ name: 'Regional Health Network', description: 'Multi-state healthcare network', baaNumber: 'BAA-2024-003' },
	]

	const customers = []
	for (const customerData of sampleCustomers) {
		const customer = await prisma.customer.upsert({
			where: { baaNumber: customerData.baaNumber },
			update: customerData,
			create: {
				...customerData,
				baaDate: faker.date.past({ years: 1 }),
			},
		})
		customers.push(customer)

		// Create provider groups for each customer
		const groupCount = faker.number.int({ min: 2, max: 4 })
		for (let i = 0; i < groupCount; i++) {
			const groupName = `${customer.name} - Group ${i + 1}`
			await prisma.providerGroup.upsert({
				where: {
					customerId_name: {
						customerId: customer.id,
						name: groupName,
					},
				},
				update: {
					description: `Provider group ${i + 1} for ${customer.name}`,
				},
				create: {
					name: groupName,
					description: `Provider group ${i + 1} for ${customer.name}`,
					customerId: customer.id,
				},
			})
		}
	}
	console.timeEnd('🏢 Created sample customers and provider groups...')

	// Create sample providers (NPIs)
	console.time('👨‍⚕️ Created sample providers...')
	const allProviderGroups = await prisma.providerGroup.findMany()
	
	for (const providerGroup of allProviderGroups) {
		const providerCount = faker.number.int({ min: 3, max: 8 })
		for (let i = 0; i < providerCount; i++) {
			// Generate realistic NPI (10-digit number starting with 1 or 2)
			const npi = faker.number.int({ min: 1000000000, max: 2999999999 }).toString()
			
			await prisma.provider.upsert({
				where: { npi },
				update: {
					name: faker.person.fullName(),
				},
				create: {
					npi,
					name: faker.person.fullName(),
					customerId: providerGroup.customerId,
					providerGroupId: providerGroup.id,
				},
			})
		}
	}
	console.timeEnd('👨‍⚕️ Created sample providers...')

	// Create Interex users with role assignments
	const totalUsers = 15
	console.time(`👤 Created ${totalUsers} users...`)
	const userImages = await getUserImages()

	// Get all customers and provider groups for user assignment
	const allCustomers = await prisma.customer.findMany({ include: { providerGroups: true } })
	const allProviders = await prisma.provider.findMany()

	const createdUsers = []
	for (let index = 0; index < totalUsers; index++) {
		const userData = createUser()
		
		// Determine user type and assignment
		let roleData: { roleName: string; customerId?: string; providerGroupId?: string } = { roleName: 'basic-user' }
		
		if (index < 2) {
			// System admins
			roleData = { roleName: 'system-admin' }
		} else if (index < 5) {
			// Customer admins
			const customer = allCustomers[(index - 2) % allCustomers.length]
			if (!customer) throw new Error('Customer not found for customer admin')
			roleData = { roleName: 'customer-admin', customerId: customer.id }
		} else if (index < 10) {
			// Provider group admins
			const customer = allCustomers[Math.floor((index - 5) / 3) % allCustomers.length]
			if (!customer) throw new Error('Customer not found for provider group admin')
			const providerGroup = customer.providerGroups[(index - 5) % customer.providerGroups.length]
			if (!providerGroup) throw new Error('Provider group not found for provider group admin')
			roleData = { roleName: 'provider-group-admin', customerId: customer.id, providerGroupId: providerGroup.id }
		} else {
			// Basic users
			const customer = allCustomers[(index - 10) % allCustomers.length]
			if (!customer) throw new Error('Customer not found for basic user')
			const providerGroup = customer.providerGroups[(index - 10) % customer.providerGroups.length]
			if (!providerGroup) throw new Error('Provider group not found for basic user')
			roleData = { roleName: 'basic-user', customerId: customer.id, providerGroupId: providerGroup.id }
		}

		const user = await prisma.user.create({
			data: {
				...userData,
				password: { create: createPassword(userData.username) },
				roles: { connect: { name: roleData.roleName } },
				customerId: roleData.customerId,
				providerGroupId: roleData.providerGroupId,
			},
		})
		createdUsers.push({ ...user, roleData })

		// Assign NPIs to basic users
		if (roleData.roleName === 'basic-user' && roleData.providerGroupId) {
			const groupProviders = allProviders.filter((p: any) => p.providerGroupId === roleData.providerGroupId)
			const assignedProviders = faker.helpers.arrayElements(groupProviders, { min: 1, max: 3 })
			
			for (const provider of assignedProviders) {
				await prisma.userNpi.create({
					data: {
						userId: user.id,
						providerId: provider.id,
					},
				})
			}
		}

		// Upload user profile image
		const userImage = userImages[index % userImages.length]
		if (userImage) {
			await prisma.userImage.create({
				data: {
					userId: user.id,
					objectKey: userImage.objectKey,
				},
			})
		}
	}
	console.timeEnd(`👤 Created ${totalUsers} users...`)

	// Create sample submissions
	console.time('📋 Created sample submissions...')
	const submissionPurposes = ['ADR', 'PA_ABT', 'PA_DMEPOS', 'HH_PRE_CLAIM', 'HOPD', 'PWK_CLAIM_DOCUMENTATION', 'FIRST_APPEAL', 'SECOND_APPEAL']
	const submissionStatuses = ['DRAFT', 'SUBMITTED', 'PROCESSING', 'COMPLETED']
	const recipients = ['Medicare Review Contractor A', 'Medicare Review Contractor B', 'PERM Review Contractor', 'DME MAC']

	for (let i = 0; i < 20; i++) {
		// Find a user with provider access
		const userWithProvider = createdUsers.find(u => u.roleData.customerId)
		if (!userWithProvider) continue

		// Get a provider for this user's customer
		const customerProviders = allProviders.filter(p => p.customerId === userWithProvider.roleData.customerId)
		if (customerProviders.length === 0) continue

		const selectedProvider = faker.helpers.arrayElement(customerProviders)
		const purpose = faker.helpers.arrayElement(submissionPurposes)
		const status = faker.helpers.arrayElement(submissionStatuses)

		await prisma.submission.create({
			data: {
				title: `${purpose} Submission #${i + 1} - ${faker.company.name()}`,
				purposeOfSubmission: purpose as any,
				recipient: faker.helpers.arrayElement(recipients),
				claimId: ['ADR', 'PWK_CLAIM_DOCUMENTATION', 'FIRST_APPEAL', 'SECOND_APPEAL'].includes(purpose)
					? faker.number.int({ min: 10000000, max: 99999999 }).toString()
					: null,
				caseId: faker.helpers.maybe(() => faker.string.alphanumeric(10).toUpperCase(), { probability: 0.3 }),
				comments: faker.helpers.maybe(() => faker.lorem.sentences(2), { probability: 0.5 }),
				status: status as any,
				creatorId: userWithProvider.id,
				providerId: selectedProvider.id,
				customerId: userWithProvider.roleData.customerId!,
				submittedAt: status !== 'DRAFT' ? faker.date.past({ years: 0.1 }) : null,
				transactionId: status !== 'DRAFT' ? faker.string.alphanumeric(16).toUpperCase() : null,
			},
		})
	}
	console.timeEnd('📋 Created sample submissions...')

	console.timeEnd(`🌱 Database has been seeded`)
}

seed()
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
	.finally(async () => {
		await prisma.$disconnect()
	})

// we're ok to import from the test directory in this file
/*
eslint
	no-restricted-imports: "off",
*/

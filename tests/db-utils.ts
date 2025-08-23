import { faker } from '@faker-js/faker'
import bcrypt from 'bcryptjs'
import { UniqueEnforcer } from 'enforce-unique'
import { UsernameSchema, EmailSchema } from '../app/utils/user-validation'

const uniqueUsernameEnforcer = new UniqueEnforcer()

export function createUser() {
	const firstName = faker.person.firstName()
	const lastName = faker.person.lastName()

	let username = uniqueUsernameEnforcer
		.enforce(() => {
			return (
				faker.string.alphanumeric({ length: 2 }) +
				'_' +
				faker.internet.username({
					firstName: firstName.toLowerCase(),
					lastName: lastName.toLowerCase(),
				})
			)
		})
		.slice(0, 20)
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_')
	// Validate username
	try {
		username = UsernameSchema.parse(username)
	} catch (e) {
		let msg = 'Unknown error';
		if (e && typeof e === 'object') {
			if ('errors' in e && Array.isArray((e).errors) && ((e).errors[0] && typeof (e).errors[0] === 'object' && 'message' in (e).errors[0]))) {
				msg = ((e).errors[0]).message;
			} else if ('message' in e && typeof (e).message === 'string') {
				msg = (e).message;
			}
		}
		throw new Error(`Generated invalid username: ${msg}`)
	}
	let email = `${username}@example.com`
	// Validate email
	try {
		email = EmailSchema.parse(email)
	} catch (e) {
		let msg = 'Unknown error';
		if (e && typeof e === 'object') {
			if ('errors' in e && Array.isArray(e.errors) && e.errors[0]?.message) {
				msg = e.errors[0].message;
			} else if ('message' in e && typeof e.message === 'string') {
				msg = e.message;
			}
		}
		throw new Error(`Generated invalid email: ${msg}`)
	}
	return {
		username,
		name: `${firstName} ${lastName}`,
		email,
	}
}

export function createPassword(password: string = faker.internet.password()) {
	return {
		hash: bcrypt.hashSync(password, 10),
	}
}

let noteImages: Array<{ altText: string; objectKey: string }> | undefined
export async function getNoteImages() {
	if (noteImages) return noteImages

	noteImages = await Promise.all([
		{
			altText: 'a nice country house',
			objectKey: 'notes/0.png',
		},
		{
			altText: 'a city scape',
			objectKey: 'notes/1.png',
		},
		{
			altText: 'a sunrise',
			objectKey: 'notes/2.png',
		},
		{
			altText: 'a group of friends',
			objectKey: 'notes/3.png',
		},
		{
			altText: 'friends being inclusive of someone who looks lonely',
			objectKey: 'notes/4.png',
		},
		{
			altText: 'an illustration of a hot air balloon',
			objectKey: 'notes/5.png',
		},
		{
			altText:
				'an office full of laptops and other office equipment that look like it was abandoned in a rush out of the building in an emergency years ago.',
			objectKey: 'notes/6.png',
		},
		{
			altText: 'a rusty lock',
			objectKey: 'notes/7.png',
		},
		{
			altText: 'something very happy in nature',
			objectKey: 'notes/8.png',
		},
		{
			altText: `someone at the end of a cry session who's starting to feel a little better.`,
			objectKey: 'notes/9.png',
		},
	])

	return noteImages
}

let userImages: Array<{ objectKey: string }> | undefined
export async function getUserImages() {
	if (userImages) return userImages

	userImages = await Promise.all(
		Array.from({ length: 10 }, (_, index) => ({
			objectKey: `user/${index}.jpg`,
		})),
	)

	return userImages
}

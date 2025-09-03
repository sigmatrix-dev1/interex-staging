import { generateTOTP, getTOTPAuthUri, verifyTOTP } from '@epic-web/totp'
import QRCode from 'qrcode'
import { prisma } from './db.server.ts'

export async function generateTwoFactorSecret(
	username: string,
): Promise<{ secret: string; qrCode: string; backupCodes?: string[] }> {
	const issuer = 'InterEx'
	const { secret } = await generateTOTP()
	
	// Create the TOTP URI for QR code
	const uri = getTOTPAuthUri({
		secret,
		accountName: username,
		issuer,
		period: 30,
		digits: 6,
		algorithm: 'SHA1',
	})
	
	// Generate QR code as data URL
	const qrCode = await QRCode.toDataURL(uri)
	
	return {
		secret,
		qrCode,
	}
}

export async function verifyTwoFactorToken(secret: string, token: string): Promise<boolean> {
	try {
		const result = await verifyTOTP({ otp: token, secret, window: 1 })
		return result !== null
	} catch {
		return false
	}
}

export async function enableTwoFactorForUser(
	userId: string,
	secret: string,
): Promise<void> {
	await prisma.user.update({
		where: { id: userId },
		data: {
			twoFactorSecret: secret,
			twoFactorEnabled: true,
		},
	})
}

export async function disableTwoFactorForUser(userId: string): Promise<void> {
	await prisma.user.update({
		where: { id: userId },
		data: {
			twoFactorSecret: null,
			twoFactorEnabled: false,
		},
	})
}

export async function getUserTwoFactorStatus(userId: string) {
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			twoFactorEnabled: true,
			twoFactorSecret: true,
		},
	})
	
	return user
}


import { prisma } from './db.server.ts'
// @ts-expect-error: no types available for @epic-web/totp
import * as totp from '@epic-web/totp'
// @ts-expect-error: no types available for qrcode
import qrcode from 'qrcode'

// Generate a TOTP secret, store it, and return QR code data
export async function generate2FASecret(userId: string) {
  const { secret, period, digits, algorithm, charSet } = await totp.generateTOTP()
  const user = await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: secret },
    select: { email: true, username: true }
  })
  const otpauth = totp.getTOTPAuthUri({
    secret,
    period,
    digits,
    algorithm,
    accountName: user.email || user.username,
    issuer: 'InterEx',
  })
  const qrCodeDataURL = await qrcode.toDataURL(otpauth)
  return { secret, otpauth, qrCodeDataURL }
}

// Verify a TOTP code for a user
export async function verify2FACode(userId: string, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecret: true } })
  if (!user?.twoFactorSecret) return false
  const result = await totp.verifyTOTP({ otp: code, secret: user.twoFactorSecret })
  return !!result
}

// Enable 2FA for a user
export async function enable2FA(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: true },
  })
}

// Disable 2FA for a user
export async function disable2FA(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  })
}

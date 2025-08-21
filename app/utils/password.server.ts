import bcrypt from 'bcryptjs'
import { customAlphabet } from 'nanoid'

const generatePassword = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 12)

/**
 * Generate a temporary password for new users
 */
export function generateTemporaryPassword(): string {
  return generatePassword()
}

/**
 * Hash a password using bcrypt
 */
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10)
}

/**
 * Compare a plain password with a hashed password
 */
export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash)
}

// app/utils/password-policy.server.ts
// Central password complexity validator (applies only on password create/reset/change events)
// Policy: 12-24 chars, at least 1 upper, 1 lower, 1 digit, 1 special, no leading/trailing whitespace.
// Export a helper returning structured errors for UI display.

import { PASSWORD_REQUIREMENTS } from './password-requirements.ts'
// Reference requirements in a harmless way to avoid unused import removal
void PASSWORD_REQUIREMENTS

export interface PasswordPolicyResult {
  ok: boolean
  errors: string[]
}

// Precompile regexes for performance.
const UPPER_RE = /[A-Z]/
const LOWER_RE = /[a-z]/
const DIGIT_RE = /[0-9]/
// Define special as any non-alphanumeric ASCII punctuation (common set). Adjust if needed.
const SPECIAL_RE = /[!@#$%^&*()_+\-={}\[\]:;"'`~<>,.?/\\|]/

export function validatePasswordComplexity(password: string): PasswordPolicyResult {
  const errors: string[] = []
  if (password.length < 12 || password.length > 24) {
    errors.push('Password must be between 12 and 24 characters long')
  }
  if (password.trim() !== password) {
    errors.push('Password cannot start or end with whitespace')
  }
  if (!UPPER_RE.test(password)) errors.push('Password must include at least one uppercase letter')
  if (!LOWER_RE.test(password)) errors.push('Password must include at least one lowercase letter')
  if (!DIGIT_RE.test(password)) errors.push('Password must include at least one digit')
  if (!SPECIAL_RE.test(password)) errors.push('Password must include at least one special character')

  return { ok: errors.length === 0, errors }
}

// Optional: async Pwned Password check wrapper (soft-fail); integrate later if desired.
export async function softCheckPwned(password: string): Promise<{ pwned: boolean; message?: string }> {
  try {
    // Placeholder for integration with existing checkIsCommonPassword if imported dynamically to avoid circular deps.
    const mod = await import('./auth.server.ts')
    if (typeof mod.checkIsCommonPassword === 'function') {
      const compromised = await mod.checkIsCommonPassword(password)
      return compromised ? { pwned: true, message: 'Password appears in breach data (choose another).' } : { pwned: false }
    }
  } catch {
    // ignore network or dynamic import failure
  }
  return { pwned: false }
}

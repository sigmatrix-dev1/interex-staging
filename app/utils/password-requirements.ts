// app/utils/password-requirements.ts
// Client-safe shared password requirements text (no server-only code here).
// Imported by UI components and server validators for consistency.

export const PASSWORD_REQUIREMENTS: string[] = [
  '12-24 characters long',
  'At least one uppercase letter (A-Z)',
  'At least one lowercase letter (a-z)',
  'At least one digit (0-9)',
  'At least one special character (!@#$%^&* etc.)',
  'No leading or trailing spaces',
]

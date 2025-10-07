#!/usr/bin/env ts-node
/**
 * One-time backfill script to encrypt any legacy plaintext TOTP secrets.
 * Safe to re-run (idempotent): skips rows already starting with 'v1.'.
 * Requires MFA_ENCRYPTION_KEY or TOTP_ENC_KEY to be set.
 */
import { prisma } from '#app/utils/db.server.ts'
import { encryptTotpSecret, isMfaEncryptionEnabled } from '#app/utils/mfa.server.ts'

async function main() {
  if (!isMfaEncryptionEnabled()) {
    console.error('Encryption key not configured (MFA_ENCRYPTION_KEY or TOTP_ENC_KEY). Aborting.')
    process.exit(1)
  }
  const users = await prisma.user.findMany({
    where: { twoFactorSecret: { not: null } },
    select: { id: true, twoFactorSecret: true },
  })
  let updated = 0
  for (const u of users) {
    const secret = u.twoFactorSecret!
    if (secret.startsWith('v1.')) continue // already encrypted
    const enc = encryptTotpSecret(secret)
    if (enc === secret) continue
    await prisma.user.update({ where: { id: u.id }, data: { twoFactorSecret: enc } })
    updated++
  }
  console.log(`Processed ${users.length} users; encrypted ${updated} legacy secrets.`)
}

main().catch(err => { console.error(err); process.exit(1) })

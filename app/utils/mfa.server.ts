import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { audit } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

// --------- TOTP Secret Encryption Helpers ---------
// We encrypt the TOTP secret at rest using AES-256-GCM.
// Key is provided via env MFA_ENCRYPTION_KEY (base64 or hex, 32 bytes).
// Rotation strategy: support optional secondary key via MFA_ENCRYPTION_KEY_PREV for seamless re-decrypt + re-encrypt.

function getKey(keyEnv?: string | null): Buffer | null {
  if (!keyEnv) return null
  let buf: Buffer
  try {
    if (/^[0-9a-fA-F]{64}$/.test(keyEnv)) {
      buf = Buffer.from(keyEnv, 'hex')
    } else {
      buf = Buffer.from(keyEnv, 'base64')
    }
  } catch {
    return null
  }
  return buf.length === 32 ? buf : null
}

// Allow either MFA_ENCRYPTION_KEY (new) or TOTP_ENC_KEY (doc referenced) for flexibility.
const primaryKey = getKey(process.env.MFA_ENCRYPTION_KEY || process.env.TOTP_ENC_KEY)
const previousKey = getKey(process.env.MFA_ENCRYPTION_KEY_PREV || process.env.TOTP_ENC_KEY_PREV) // optional for rotation

export function isMfaEncryptionEnabled() {
  return !!primaryKey
}

export function encryptTotpSecret(secret: string): string {
  if (!primaryKey) return secret // passthrough if not configured
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', primaryKey, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'v1.' + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptTotpSecret(stored: string): string {
  if (!primaryKey) return stored
  if (!stored.startsWith('v1.')) return stored // legacy plaintext
  const raw = Buffer.from(stored.slice(3), 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const tryKeys: Buffer[] = primaryKey && previousKey && previousKey.compare(primaryKey) !== 0 ? [primaryKey, previousKey] : [primaryKey]
  for (const key of tryKeys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (key !== primaryKey) {
        // re-encrypt with primary for silent rotation
        return decryptReencrypt(stored, plain.toString('utf8'))
      }
      return plain.toString('utf8')
    } catch {
      continue
    }
  }
  throw new Error('Failed to decrypt TOTP secret with available keys')
}

function decryptReencrypt(original: string, plaintext: string): string {
  // Caller wants plaintext; but we also want to persist re-encrypted form.
  // Implementation hook left to higher layer if needed.
  return plaintext
}

// --------- Recovery Code Generation & Consumption ---------
// Policy: generate 10 codes, 10 chars each (base32 alphabet w/o visually ambiguous chars), single-use.
// Codes are hashed with bcrypt immediately; plaintext provided once.

const RECOVERY_CODE_COUNT = Number(process.env.RECOVERY_CODES_COUNT || 10)
const RECOVERY_CODE_LENGTH = 10
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // exclude I,O,0,1

export function generateRecoveryCodes(): string[] {
  const codes: string[] = []
  while (codes.length < RECOVERY_CODE_COUNT) {
    let c = ''
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
      const idx = crypto.randomInt(0, RECOVERY_ALPHABET.length)
      c += RECOVERY_ALPHABET[idx]
    }
    codes.push(c)
  }
  return codes
}

export async function issueRecoveryCodes(
  userId: string,
  actor: { actorType: 'USER' | 'SYSTEM'; actorId?: string | null; actorIp?: string | null; actorUserAgent?: string | null; chainKey?: string; summary?: string },
  opts: { auditAction?: 'MFA_RECOVERY_ISSUE' | 'MFA_RECOVERY_REGENERATE' } = {},
) {
  // Enforce hard-coded role gating: only system-admin or customer-admin users may receive recovery codes.
  try {
    const roles: Array<{ name: string }> = await (prisma as any).role.findMany({
      where: { users: { some: { id: userId } } },
      select: { name: true },
    })
    const allowed = roles.some(r => r.name === 'system-admin' || r.name === 'customer-admin')
    if (!allowed) {
      // Silently skip issuance for non-privileged accounts.
      return []
    }
  } catch {}
  const codes = generateRecoveryCodes()
  const hashes = await Promise.all(codes.map(code => bcrypt.hash(code, 10)))
  // Invalidate any existing (unused) codes by deleting them (simpler than soft invalidation)
  const p: any = prisma as any
  await p.recoveryCode.deleteMany({ where: { userId } })
  await prisma.$transaction(hashes.map(h => p.recoveryCode.create({ data: { userId, codeHash: h } })))
  await audit.security({
    action: opts.auditAction || 'MFA_RECOVERY_ISSUE',
    actorType: actor.actorType,
    actorId: actor.actorId ?? userId,
    actorIp: actor.actorIp ?? null,
    actorUserAgent: actor.actorUserAgent ?? null,
    chainKey: actor.chainKey || 'global',
    entityType: 'User',
    entityId: userId,
    summary: actor.summary || 'Recovery codes issued',
    metadata: { count: codes.length },
    status: 'SUCCESS',
  })
  return codes
}

export async function remainingRecoveryCodes(userId: string) {
  const p: any = prisma as any
  const rows: Array<{ usedAt: Date | null }> = await p.recoveryCode.findMany({ where: { userId } })
  return rows.filter(r => !r.usedAt).length
}

export async function consumeRecoveryCode(userId: string, code: string, ctx: { actorIp?: string | null; actorUserAgent?: string | null }) {
  const p: any = prisma as any
  const existing: Array<{ id: string; codeHash: string; usedAt: Date | null }> = await p.recoveryCode.findMany({ where: { userId } })
  for (const row of existing) {
    if (await bcrypt.compare(code, row.codeHash)) {
      if (row.usedAt) {
        await audit.security({
          action: 'MFA_RECOVERY_USE_FAILED',
            status: 'FAILURE',
            actorType: 'USER',
            actorId: userId,
            actorIp: ctx.actorIp ?? null,
            actorUserAgent: ctx.actorUserAgent ?? null,
            chainKey: 'global',
            entityType: 'User',
            entityId: userId,
            summary: 'Attempt to reuse an already used recovery code',
        })
        return { ok: false, reason: 'USED' as const }
      }
  await p.recoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } })
      await audit.security({
        action: 'MFA_RECOVERY_USE',
        status: 'SUCCESS',
        actorType: 'USER',
        actorId: userId,
        actorIp: ctx.actorIp ?? null,
        actorUserAgent: ctx.actorUserAgent ?? null,
        chainKey: 'global',
        entityType: 'User',
        entityId: userId,
        summary: 'Recovery code used to satisfy MFA',
  metadata: { remaining: existing.filter((r) => !r.usedAt && r.id !== row.id).length },
      })
      return { ok: true as const }
    }
  }
  await audit.security({
    action: 'MFA_RECOVERY_USE_FAILED',
    status: 'FAILURE',
    actorType: 'USER',
    actorId: userId,
    actorIp: ctx.actorIp ?? null,
    actorUserAgent: ctx.actorUserAgent ?? null,
    chainKey: 'global',
    entityType: 'User',
    entityId: userId,
    summary: 'Invalid recovery code attempt',
  })
  return { ok: false as const, reason: 'INVALID' as const }
}

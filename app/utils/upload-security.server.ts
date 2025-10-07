// Server-side upload security helpers: MIME validation, size caps, and block logging.
import { createHash } from 'node:crypto'
import { prisma } from '#app/utils/db.server.ts'

export interface ValidatedUpload {
  ok: true
  mime: string
  reason?: undefined
}

export interface BlockedUpload {
  ok: false
  reason: string
  mime?: string
}

export type UploadValidationResult = ValidatedUpload | BlockedUpload

// Allow-list of MIME types we accept (PDF only for now). Extend as needed.
const ALLOWED_MIME = new Set(['application/pdf'])

// Simple magic number detection for PDFs (first 4 bytes: %PDF)
function sniffPdf(bytes: Uint8Array) {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}

export interface UploadSecurityOptions {
  // Hard-coded externally; no env override (explicit requirement)
  maxPerFileMB: number
  userId?: string
  customerId?: string | null
  requestId?: string
  ip?: string
  userAgent?: string
}

export async function validateAndLogUpload(
  file: File,
  opts: UploadSecurityOptions,
): Promise<UploadValidationResult> {
  const perFileLimit = opts.maxPerFileMB // no env-driven override
  if (file.size > perFileLimit * 1024 * 1024) {
    await logSecurityEvent('UPLOAD_BLOCKED_SIZE', {
      fileName: file.name,
      size: file.size,
      limitMB: perFileLimit,
    }, opts, false, 'File exceeds size limit')
    return { ok: false, reason: `File exceeds size limit (${perFileLimit} MB)` }
  }

  // Read first 8 bytes for magic sniff
  const buf = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const mime = file.type || 'application/octet-stream'
  const isPdf = sniffPdf(buf)
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  const extIsPdf = ext === 'pdf'
  const declaredIsPdf = mime === 'application/pdf'

  // Mismatch conditions:
  // 1. Declared PDF but magic not PDF
  // 2. Magic PDF but extension not pdf
  // 3. Extension pdf but declared not PDF
  // (All result in a mismatch event; we block for defense-in-depth.)
  const mismatch = (
    (declaredIsPdf && !isPdf) ||
    (isPdf && !extIsPdf) ||
    (extIsPdf && !declaredIsPdf)
  )
  if (mismatch) {
    await logSecurityEvent('UPLOAD_MIME_MISMATCH', {
      fileName: file.name,
      declaredType: mime,
      extension: ext,
      magicPdf: isPdf,
    }, opts, false, 'MIME_MISMATCH')
    return { ok: false, reason: 'MIME/extension mismatch', mime }
  }

  const allowed = isPdf && declaredIsPdf && extIsPdf && ALLOWED_MIME.has('application/pdf')
  if (!allowed) {
    await logSecurityEvent('UPLOAD_BLOCKED_TYPE', {
      fileName: file.name,
      declaredType: mime,
      extension: ext,
      magicPdf: isPdf,
    }, opts, false, 'Disallowed file type')
    return { ok: false, reason: 'Disallowed file type', mime }
  }

  // Basic integrity fingerprint (non-cryptographic assurance) – optional future use
  const hash = createHash('sha256')
  hash.update(buf)
  const headHash = hash.digest('hex')
  await logSecurityEvent('UPLOAD_VALIDATED', {
    fileName: file.name,
    size: file.size,
    mime: 'application/pdf',
    headHash,
  }, opts, true)
  return { ok: true, mime: 'application/pdf' }
}

async function logSecurityEvent(kind: string, data: any, opts: UploadSecurityOptions, success: boolean, reason?: string) {
  try {
    await prisma.securityEvent.create({
      data: {
        kind,
        success,
        reason,
        userId: opts.userId,
        customerId: opts.customerId ?? undefined,
        userAgent: opts.userAgent,
        ip: opts.ip,
        requestId: opts.requestId,
        data,
      },
    })
  } catch {}
}

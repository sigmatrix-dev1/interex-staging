import { describe, it, expect } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'
import { validateAndLogUpload } from '#app/utils/upload-security.server.ts'

function makeFile(name: string, type: string, bytes: Uint8Array) {
  // Ensure we pass a BlobPart the environment accepts
  const arrBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = new Blob([arrBuf as BlobPart])
  return new File([blob], name, { type })
}

const PDF_MAGIC = new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x33]) // %PDF-1.3
const FAKE_MAGIC = new Uint8Array([0x89,0x50,0x4e,0x47,0,0,0,0]) // looks like PNG start

async function recentEvents(kind: string) {
  return prisma.securityEvent.findMany({ where: { kind }, orderBy: { createdAt: 'desc' }, take: 5 })
}

describe('upload MIME/extension mismatch', () => {
  it('blocks declared pdf where magic not pdf', async () => {
    const file = makeFile('doc.pdf', 'application/pdf', FAKE_MAGIC)
    const res = await validateAndLogUpload(file, { maxPerFileMB: 5 })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/mismatch|Disallowed/i)
    const ev = await recentEvents('UPLOAD_MIME_MISMATCH')
    expect(ev.length).toBeGreaterThan(0)
  })
  it('blocks magic pdf but wrong extension', async () => {
    const file = makeFile('doc.bin', 'application/pdf', PDF_MAGIC)
    const res = await validateAndLogUpload(file, { maxPerFileMB: 5 })
    expect(res.ok).toBe(false)
    const ev = await recentEvents('UPLOAD_MIME_MISMATCH')
    expect(ev.length).toBeGreaterThan(0)
  })
  it('allows proper pdf triple match', async () => {
    const file = makeFile('good.pdf', 'application/pdf', PDF_MAGIC)
    const res = await validateAndLogUpload(file, { maxPerFileMB: 5 })
    expect(res.ok).toBe(true)
  })
})

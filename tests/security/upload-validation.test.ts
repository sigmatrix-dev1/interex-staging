import { describe, it, expect } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'
import { validateAndLogUpload } from '#app/utils/upload-security.server.ts'

function makeFile(name: string, content: Uint8Array, type?: string): File {
  // Copy into a fresh Uint8Array backed by a normal ArrayBuffer
  const copy = new Uint8Array(content.length)
  copy.set(content)
  return new File([copy], name, { type: type || 'application/pdf' })
}

describe('upload security validation', () => {
  it('accepts a valid small PDF file', async () => {
    const pdfMagic = new Uint8Array([0x25,0x50,0x44,0x46,0x2D,0x31,0x2E,0x37]) // %PDF-1.7
    const file = makeFile('doc1.pdf', pdfMagic, 'application/pdf')
    const before = await prisma.securityEvent.count({ where: { kind: 'UPLOAD_VALIDATED' } })
    const res = await validateAndLogUpload(file, { maxPerFileMB: 1 })
    expect(res.ok).toBe(true)
    const after = await prisma.securityEvent.count({ where: { kind: 'UPLOAD_VALIDATED' } })
    expect(after).toBe(before + 1)
  })

  it('blocks oversize file', async () => {
    const big = new Uint8Array(2 * 1024 * 1024) // 2MB
    const file = makeFile('big.pdf', big, 'application/pdf')
    const res = await validateAndLogUpload(file, { maxPerFileMB: 1 })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/exceeds size/i)
  })

  it('blocks non-pdf magic despite misleading name', async () => {
    const notPdf = new Uint8Array([0x00,0x11,0x22,0x33,0x44])
    const file = makeFile('fake.pdf', notPdf, 'application/pdf')
    const res = await validateAndLogUpload(file, { maxPerFileMB: 1 })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/disallowed|mismatch/i)
  })
})

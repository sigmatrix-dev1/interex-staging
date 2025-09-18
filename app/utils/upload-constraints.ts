// Centralized upload constraints and helpers
export const BYTES_PER_MB = 1024 * 1024
export const MAX_FILE_MB = 75
export const MAX_TOTAL_MB = 600

export function formatMB(n: number) {
  return `${n.toFixed(1)} MB`
}

export function isPdfName(name: string) {
  return /\.pdf$/i.test(name)
}

export function isPdfFile(file: File) {
  return file.type === 'application/pdf' || isPdfName(file.name)
}

export function fileTooBigMB(file: File, limitMb = MAX_FILE_MB) {
  return file.size > limitMb * BYTES_PER_MB
}

export function totalTooBigMB(files: Array<File | null | undefined>, limitMb = MAX_TOTAL_MB) {
  const total = files.reduce((acc, f) => acc + (f?.size ?? 0), 0) / BYTES_PER_MB
  return { tooBig: total > limitMb, totalMb: total }
}

export const perFileNote = `PDF only · Max ${MAX_FILE_MB} MB per file`
export const totalsNote = `Only PDF. Each ≤ ${MAX_FILE_MB} MB. Total ≤ ${MAX_TOTAL_MB} MB.`

// Split-kind aware helpers
export type SplitKind = 'manual' | 'auto'

export function perFileLimitFor(kind: SplitKind) {
  return kind === 'auto' ? MAX_TOTAL_MB : MAX_FILE_MB
}

export function totalsNoteFor(kind: SplitKind) {
  const per = perFileLimitFor(kind)
  return `Only PDF. Each ≤ ${per} MB. Total ≤ ${MAX_TOTAL_MB} MB.`
}

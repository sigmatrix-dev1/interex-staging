// app/utils/phi-constants.ts
// Central definition of PHI / sensitive indicators used for:
//  * Write-time heuristic scanning (regex patterns)
//  * Read-time redaction of known field names / diff paths
//  * Future analytics (e.g., counts of blocked PHI attempts)

export interface PhiPattern { name: string; regex: RegExp }

// Core regexes (extend cautiously; prefer low false-positive rate)
export const PHI_PATTERNS: PhiPattern[] = [
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'mrn', regex: /\bMRN[:#]?\s*\d{5,}\b/i },
  { name: 'dob', regex: /\b(19|20)\d{2}[-\/.](0?[1-9]|1[0-2])[-\/.](0?[1-9]|[12]\d|3[01])\b/ },
]

// Known sensitive metadata keys (case-insensitive match performed at callsite)
export const PHI_SENSITIVE_KEYS = [
  'patientName','patientFirstName','patientLastName','dob','ssn','mrn','npi','address','phone','email','rawDocument','payload','documentText','fileName','fileSize'
] as const

// Diff path substrings (lowercased) considered sensitive
export const PHI_DIFF_PATH_SUBSTRINGS = [
  'patient','dob','ssn','mrn','npi','address','phone','email','raw','document','file'
] as const

export const PHI_REDACTED_TOKEN = '[REDACTED]'
export const PHI_REDACTED_OBJECT_TOKEN = '[REDACTED_OBJECT]'

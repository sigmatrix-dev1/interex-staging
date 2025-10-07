import { useMatches } from 'react-router'

/**
 * Returns the CSRF token exposed by the root loader (if present).
 * Falls back to undefined so callers can optionally skip rendering.
 */
export function useCsrfToken(): string | undefined {
  const matches = useMatches()
  for (const m of matches) {
    const data: any = m.data
    if (data && typeof data === 'object' && typeof data.csrf === 'string') {
      return data.csrf as string
    }
  }
  return undefined
}

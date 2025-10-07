import * as React from 'react'
import { useCsrfToken } from '#app/hooks/use-csrf.ts'

/**
 * Renders a hidden CSRF input. If token unavailable (should be rare), renders nothing.
 */
export function CsrfInput(props: { name?: string }) {
  const token = useCsrfToken()
  if (!token) return null
  return <input type="hidden" name={props.name || 'csrf'} value={token} />
}

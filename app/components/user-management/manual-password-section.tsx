import React, { useState, useMemo } from 'react'
import { Icon } from '#app/components/ui/icon.tsx'
import { PASSWORD_REQUIREMENTS } from '#app/utils/password-requirements.ts'

export interface ManualPasswordSectionProps {
  name?: string
  autoFocus?: boolean
  showOverallLine?: boolean
  onChangeValue?: (value: string, allOk: boolean) => void
  className?: string
}

/**
 * Shared manual password input with show/hide toggle and live requirement checklist.
 * Pure client-safe logic (no server-only imports) so it can be used in any route.
 */
export function ManualPasswordSection({
  name = 'manualPassword',
  autoFocus,
  showOverallLine = true,
  onChangeValue,
  className = '',
}: ManualPasswordSectionProps) {
  const [show, setShow] = useState(false)
  const [value, setValue] = useState('')

  const checks = useMemo(() => ([
    { label: PASSWORD_REQUIREMENTS[0], ok: value.length >= 12 && value.length <= 24 },
    { label: PASSWORD_REQUIREMENTS[1], ok: /[A-Z]/.test(value) },
    { label: PASSWORD_REQUIREMENTS[2], ok: /[a-z]/.test(value) },
    { label: PASSWORD_REQUIREMENTS[3], ok: /\d/.test(value) },
    { label: PASSWORD_REQUIREMENTS[4], ok: /[^A-Za-z0-9]/.test(value) },
    { label: PASSWORD_REQUIREMENTS[5], ok: !(value.startsWith(' ') || value.endsWith(' ')) },
  ]), [value])
  const allOk = checks.every(c => c.ok)

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.currentTarget.value
    setValue(v)
    onChangeValue?.(v, checks.every(c => c.ok))
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <label className="text-sm font-medium text-gray-700" htmlFor={name}>New Password</label>
      <div className="relative">
        <input
          id={name}
          name={name}
          type={show ? 'text' : 'password'}
          placeholder="12-24 chars, upper/lower/digit/special"
          minLength={12}
          maxLength={24}
          required
          autoComplete="new-password"
          autoFocus={autoFocus}
          onChange={handleChange}
          className="w-full rounded-md border border-gray-300 pr-10 py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700"
          aria-label={show ? 'Hide password' : 'Show password'}
        >
          <Icon name={show ? 'eye-closed' : 'eye'} className="h-5 w-5" />
        </button>
      </div>
      <ul className="text-[11px] leading-4 space-y-0.5">
        {checks.map(c => (
          <li key={c.label} className={c.ok ? 'text-green-600 flex items-center gap-1' : 'text-gray-500 flex items-center gap-1'}>
            {c.ok ? <Icon name="check" className="h-3 w-3" /> : <span className="text-xs">•</span>}
            <span>{c.label}</span>
          </li>
        ))}
        {showOverallLine && value && (
          <li className={allOk ? 'text-green-600 flex items-center gap-1' : 'text-gray-400 flex items-center gap-1'}>
            {allOk ? <Icon name="check" className="h-3 w-3" /> : <span className="text-xs">•</span>}
            <span>{allOk ? 'Looks good' : 'Keep typing to satisfy all requirements'}</span>
          </li>
        )}
      </ul>
    </div>
  )
}

import { InformationCircleIcon, ExclamationTriangleIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import * as React from 'react'

export type AlertVariant = 'info' | 'warning' | 'error' | 'success'
export type AlertSize = 'sm' | 'md'

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: AlertVariant
  heading?: React.ReactNode
  children?: React.ReactNode
  size?: AlertSize
  role?: 'alert' | 'status'
  icon?: React.ReactNode
}

const variantStyles: Record<AlertVariant, { container: string; icon: string; text: string; border: string; }>= {
  info:    { container: 'bg-blue-50',    icon: 'text-blue-600',    text: 'text-blue-900',    border: 'border-blue-200' },
  warning: { container: 'bg-amber-50',   icon: 'text-amber-600',   text: 'text-amber-900',   border: 'border-amber-300' },
  error:   { container: 'bg-red-50',     icon: 'text-red-600',     text: 'text-red-900',     border: 'border-red-300' },
  success: { container: 'bg-green-50',   icon: 'text-green-600',   text: 'text-green-900',   border: 'border-green-300' },
}

const defaultIcons: Record<AlertVariant, React.ReactNode> = {
  info: <InformationCircleIcon className="mt-0.5 h-5 w-5" aria-hidden="true" />,
  warning: <ExclamationTriangleIcon className="mt-0.5 h-5 w-5" aria-hidden="true" />,
  error: <XCircleIcon className="mt-0.5 h-5 w-5" aria-hidden="true" />,
  success: <CheckCircleIcon className="mt-0.5 h-5 w-5" aria-hidden="true" />,
}

export function Alert({
  variant = 'info',
  heading,
  children,
  size = 'md',
  role = 'status',
  icon,
  className,
  ...rest
}: AlertProps) {
  const v = variantStyles[variant]
  const padding = size === 'sm' ? 'p-2.5 text-xs' : 'p-3 text-sm'

  return (
    <div
      className={[
        'flex items-start gap-3 rounded-md border shadow-sm',
        v.container,
        v.text,
        v.border,
        padding,
        className,
      ].filter(Boolean).join(' ')}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      {...rest}
    >
      <div className={v.icon}>
        {icon ?? defaultIcons[variant]}
      </div>
      <div>
        {heading ? <div className="font-semibold">{heading}</div> : null}
        {children ? <div className={heading ? 'mt-0.5' : undefined}>{children}</div> : null}
      </div>
    </div>
  )
}

export default Alert

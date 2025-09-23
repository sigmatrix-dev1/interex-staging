import { formatDistanceToNow } from 'date-fns'
import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '#app/components/ui/icon.tsx'
import { useNotifications } from './notifications.tsx'

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, dismiss, markRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!panelRef.current) return
      if (panelRef.current.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  useEffect(() => {
    if (open) {
      markAllRead()
    }
  }, [open, markAllRead])

  return (
    <div className="relative">      
      <button
        ref={btnRef}
        type="button"
        aria-label={unreadCount ? `${unreadCount} unread notifications` : 'Notifications'}
        onClick={() => setOpen(o => !o)}
        className="relative inline-flex items-center justify-center rounded-full p-2 text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <Icon name="hero:bell" className="h-6 w-6" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1rem] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-4 text-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-96 max-h-[26rem] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl z-50 flex flex-col origin-top-right animate-in fade-in slide-in-from-top-2 duration-150"
        >
          <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
            <h3 className="text-sm font-semibold text-gray-800">Notifications</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => dismissAllButKeepMostRecent(notifications, dismiss)}
                className="text-[11px] text-gray-500 hover:text-gray-700"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {notifications.length === 0 && (
              <div className="p-4 text-xs text-gray-500">No notifications</div>
            )}
            {notifications.map(n => (
              <div key={n.id} className="group flex gap-3 p-3 hover:bg-gray-50 text-sm animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="mt-1">
                  <StatusIcon kind={n.kind} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-medium text-gray-800 truncate" title={n.title}>{n.title}</p>
                    <button
                      onClick={() => dismiss(n.id)}
                      className="text-gray-300 hover:text-gray-500"
                      aria-label="Dismiss notification"
                    >
                      <Icon name="cross-1" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {n.description && (
                    <p className="mt-0.5 text-[12px] leading-snug text-gray-600 whitespace-pre-wrap break-words">
                      {n.description}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">
                      {formatDistanceToNow(n.createdAt, { addSuffix: true })}
                    </span>
                    {!n.read && (
                      <button
                        onClick={() => markRead(n.id)}
                        className="text-[10px] text-blue-500 hover:underline"
                      >Mark read</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatusIcon({ kind }: { kind: string }) {
  if (kind === 'success') return <Icon name="check" className="h-4 w-4 text-green-600" />
  if (kind === 'error') return <Icon name="warning" className="h-4 w-4 text-red-600" />
  if (kind === 'warning') return <Icon name="warning" className="h-4 w-4 text-amber-500" />
  return <Icon name="info" className="h-4 w-4 text-blue-600" />
}

function dismissAllButKeepMostRecent(list: ReturnType<typeof useNotifications>['notifications'], dismiss: (id: string)=>void) {
  list.slice(1).forEach(n => dismiss(n.id))
}

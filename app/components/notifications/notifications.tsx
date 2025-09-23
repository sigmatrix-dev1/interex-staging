import { nanoid } from 'nanoid'
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'

export type NotificationKind = 'success' | 'error' | 'info' | 'warning'

export interface Notification {
  id: string
  kind: NotificationKind
  title: string
  description?: string
  createdAt: number
  read: boolean
  expiresAt?: number
}

export const NOTIFICATION_AUTO_DISMISS_MS = 5 * 60 * 1000 // 5 minutes (easy to change)
const MAX_NOTIFICATIONS = 50

interface NotificationsContextShape {
  notifications: Notification[]
  unreadCount: number
  add: (n: { kind: NotificationKind; title: string; description?: string; autoDismiss?: boolean; persist?: boolean }) => string
  markRead: (id: string, opts?: { persist?: boolean }) => void
  dismiss: (id: string, opts?: { persist?: boolean }) => void
  markAllRead: (opts?: { persist?: boolean }) => void
  clearExpired: () => void
}

const NotificationsContext = createContext<NotificationsContextShape | undefined>(undefined)

export function NotificationProvider({ children, initialNotifications = [] }: { children: React.ReactNode, initialNotifications?: Notification[] }) {
  const [notifications, setNotifications] = useState<Notification[]>(() => initialNotifications)
  const intervalRef = useRef<number | null>(null)

  const clearExpired = useCallback(() => {
    setNotifications(list => list.filter(n => !n.expiresAt || n.expiresAt > Date.now()))
  }, [])

  // Background cleaner
  useEffect(() => {
    if (intervalRef.current) return
    intervalRef.current = window.setInterval(clearExpired, 30 * 1000)
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current)
    }
  }, [clearExpired])

  const add: NotificationsContextShape['add'] = useCallback(({ kind, title, description, autoDismiss = true, persist = true }) => {
    const id = nanoid()
    setNotifications(list => {
      const next: Notification = {
        id,
        kind,
        title,
        description,
        createdAt: Date.now(),
        read: false,
        expiresAt: autoDismiss ? Date.now() + NOTIFICATION_AUTO_DISMISS_MS : undefined,
      }
      const merged = [next, ...list].slice(0, MAX_NOTIFICATIONS)
      return merged
    })
    if (persist) {
      // fire-and-forget; no await to keep UX snappy
      fetch('/resources/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', kind, title, description, expiresAt: autoDismiss ? Date.now() + NOTIFICATION_AUTO_DISMISS_MS : undefined }),
      }).catch(()=>{})
    }
    return id
  }, [])

  const markRead = useCallback((id: string, opts?: { persist?: boolean }) => {
    setNotifications(list => list.map(n => (n.id === id ? { ...n, read: true } : n)))
    if (opts?.persist !== false) {
      fetch('/resources/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'markRead', id }) }).catch(()=>{})
    }
  }, [])

  const dismiss = useCallback((id: string, opts?: { persist?: boolean }) => {
    setNotifications(list => list.filter(n => n.id !== id))
    if (opts?.persist !== false) {
      fetch('/resources/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss', id }) }).catch(()=>{})
    }
  }, [])

  const markAllRead = useCallback((opts?: { persist?: boolean }) => {
    setNotifications(list => list.map(n => (n.read ? n : { ...n, read: true })))
    if (opts?.persist !== false) {
      fetch('/resources/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'markAllRead' }) }).catch(()=>{})
    }
  }, [])

  const unreadCount = useMemo(() => notifications.filter(n => !n.read).length, [notifications])

  const value: NotificationsContextShape = useMemo(() => ({
    notifications,
    unreadCount,
    add,
    markRead,
    dismiss,
    markAllRead,
    clearExpired,
  }), [notifications, unreadCount, add, markRead, dismiss, markAllRead, clearExpired])

  return (
    <NotificationsContext.Provider value={value}>
      {/* Screen-reader live region */}
      <div aria-live="polite" className="sr-only" id="notification-live-region">
        {notifications.slice(0,1).map(n => `${n.title} ${n.description ?? ''}`)}
      </div>
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider')
  return ctx
}

import { useEffect } from 'react'
import { useNotifications } from '#app/components/notifications/notifications.tsx'
import { type Toast } from '#app/utils/toast.server.ts'

export function useToast(toast?: Toast | null) {
	const { add } = useNotifications()
	useEffect(() => {
		if (toast) {
			const safeTitle = toast.title ?? (toast.description.slice(0, 40) + (toast.description.length > 40 ? '…' : ''))
			add({ kind: toast.type as any, title: safeTitle, description: toast.description })
		}
	}, [toast, add])
}

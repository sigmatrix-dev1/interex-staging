import * as React from 'react'

type LoadingOverlayProps = {
    show: boolean
    title?: string
    message?: string
}

export function LoadingOverlay({ show, title = 'Processing…', message = "Please don't refresh or close this tab." }: LoadingOverlayProps) {
    if (!show) return null
    return (
        <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-white/80 backdrop-blur-sm"
            role="alert"
            aria-live="assertive"
            aria-busy="true"
        >
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-gray-200 bg-white px-8 py-6 shadow-xl">
                {/* spinner */}
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-300 border-t-indigo-600" aria-hidden="true" />
                <div className="text-center">
                    <div className="text-base font-semibold text-gray-900">{title}</div>
                    <div className="mt-1 text-sm text-gray-600">{message}</div>
                    <div className="mt-3 text-xs text-gray-500">
                        This may take a moment depending on network conditions.
                    </div>
                </div>
            </div>
        </div>
    )
}

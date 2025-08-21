// app/components/submission-activity-log.tsx
import * as React from 'react'
import { Icon } from '#app/components/ui/icon.tsx'

type Event = {
    id: string
    kind: string
    message: string | null
    payload: unknown | null
    createdAt: string
}

export function SubmissionActivityLog({ events }: { events: Event[] }) {
    if (!events?.length) {
        return (
            <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Activity Log</h3>
                <div className="text-sm text-gray-500">No activity yet.</div>
            </div>
        )
    }

    return (
        <div className="border-t border-gray-200 pt-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Activity Log</h3>
            <ul className="divide-y divide-gray-200 rounded-md border">
                {events.map((e) => {
                    const isError =
                        e.kind === 'PCG_CREATE_ERROR' ||
                        e.kind === 'PCG_UPLOAD_ERROR' ||
                        e.kind === 'PCG_UPDATE_ERROR' ||
                        /ERROR/i.test(e.message || '')
                    return (
                        <li key={e.id} className="p-3 text-sm">
                            <div className="flex items-center justify-between">
                <span className={`font-medium ${isError ? 'text-red-700' : 'text-gray-900'}`}>
                  {e.kind.replace(/_/g, ' ')}
                </span>
                                <span className="text-xs text-gray-500">{new Date(e.createdAt).toLocaleString()}</span>
                            </div>

                            {e.message ? (
                                <div className={`mt-1 ${isError ? 'text-red-700' : 'text-gray-700'}`}>{e.message}</div>
                            ) : null}

                            {isError ? (
                                <div className="mt-1 inline-flex items-center rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                                    Error
                                </div>
                            ) : null}

                            {e.payload ? (
                                <details className="mt-2 group">
                                    <summary className="cursor-pointer select-none text-xs text-indigo-600 hover:text-indigo-800">
                                        View details
                                    </summary>
                                    <div className="mt-2 rounded bg-gray-50 p-2">
                                        <div className="mb-2 flex items-center justify-between">
                                            <span className="text-xs font-medium text-gray-600">Raw payload</span>
                                            <button
                                                type="button"
                                                className="text-xs text-indigo-600 hover:text-indigo-800"
                                                onClick={() => navigator.clipboard.writeText(JSON.stringify(e.payload, null, 2))}
                                            >
                                                Copy JSON
                                            </button>
                                        </div>
                                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-800">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                                    </div>
                                </details>
                            ) : null}
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

import * as React from 'react'

export function JsonViewer({ data }: { data: unknown }) {
    const [open, setOpen] = React.useState(false)
    if (data == null) return null
    return (
        <div className="mt-2">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="text-xs text-indigo-600 hover:text-indigo-800"
            >
                {open ? 'Hide details' : 'View details'}
            </button>
            {open ? (
                <pre className="mt-2 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800">
{JSON.stringify(data, null, 2)}
        </pre>
            ) : null}
        </div>
    )
}

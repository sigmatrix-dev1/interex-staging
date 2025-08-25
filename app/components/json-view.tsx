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
                <pre
                    className="
            mt-2 rounded bg-gray-50 p-3 text-xs text-gray-800
            whitespace-pre-wrap break-words
            max-h-96 overflow-auto
            w-full min-w-[40rem] max-w-[80vw]
          "
                >
          {JSON.stringify(data, null, 2)}
        </pre>
            ) : null}
        </div>
    )
}

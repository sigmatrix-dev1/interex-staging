import * as React from 'react'

type Props = {
    label?: string
    name?: string
    accept?: string
    note?: React.ReactNode
    required?: boolean
    disabled?: boolean
    onPick?: (file: File) => void
    /** Optional initial file (previews & syncs hidden input). */
    initialFile?: File | null
}

export function FileDropzone({
                                 label,
                                 name,
                                 accept = 'application/pdf',
                                 note,
                                 required,
                                 disabled,
                                 onPick,
                                 initialFile = null,
                             }: Props) {
    const inputRef = React.useRef<HTMLInputElement | null>(null)
    const [file, setFile] = React.useState<File | null>(initialFile)
    const [dragOver, setDragOver] = React.useState(false)

    // Keep hidden input in sync when parent provides an initial file.
    React.useEffect(() => {
        if (!initialFile) return
        setFile(initialFile)
        if (inputRef.current) {
            const dt = new DataTransfer()
            dt.items.add(initialFile)
            inputRef.current.files = dt.files
        }
    }, [initialFile])

    function setHiddenInput(f: File) {
        if (!inputRef.current) return
        const dt = new DataTransfer()
        dt.items.add(f)
        inputRef.current.files = dt.files
    }

    function chooseFile(f: File | null) {
        if (!f) return
        setFile(f)
        setHiddenInput(f)
        onPick?.(f)
    }

    function extractFileFromDrop(e: React.DragEvent<HTMLDivElement>): File | null {
        // Prefer DataTransferItemList to avoid getting non-file entries.
        const items = e.dataTransfer?.items
        if (items && items.length) {
            for (let i = 0; i < items.length; i++) {
                const it = items[i]
                if (it.kind === 'file') {
                    const f = it.getAsFile()
                    if (f) return f
                }
            }
        }
        // Fallback to files list.
        const f = e.dataTransfer?.files?.[0]
        return f ?? null
    }

    return (
        <div className="space-y-2">
            {label ? <label className="block text-sm font-medium text-gray-700">{label}</label> : null}

            {/* Hidden native input (wired when we pick via click) */}
            <input
                ref={inputRef}
                type="file"
                name={name}
                accept={accept}
                required={required}
                disabled={disabled}
                className="hidden"
                onChange={e => chooseFile(e.currentTarget.files?.[0] ?? null)}
            />

            <div
                onDragOver={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setDragOver(true)
                }}
                onDragLeave={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setDragOver(false)
                }}
                onDrop={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setDragOver(false)
                    const dropped = extractFileFromDrop(e)
                    chooseFile(dropped)
                }}
                onClick={() => inputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        inputRef.current?.click()
                    }
                }}
                className={`flex items-center justify-between gap-4 rounded-md border-2 border-dashed px-4 py-6 cursor-pointer ${
                    dragOver ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:bg-gray-50'
                }`}
            >
                <div className="flex-1 text-sm">
                    <div className="font-medium text-gray-900">
                        {file ? file.name : 'Drop a PDF here or click Browse'}
                    </div>
                    <div className="text-xs text-gray-500">
                        {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'PDF only · Max 150 MB per file'}
                    </div>
                </div>

                <button
                    type="button"
                    onClick={e => {
                        e.stopPropagation()
                        inputRef.current?.click()
                    }}
                    className="shrink-0 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                    disabled={disabled}
                >
                    Browse
                </button>
            </div>

            {note ? <div className="text-xs text-gray-500">{note}</div> : null}
        </div>
    )
}

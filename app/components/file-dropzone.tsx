// app/components/file-dropzone.tsx
import * as React from 'react'

type Props = {
    /** Heading shown above the zone */
    label?: string
    /** Name for <input type="file"> so the file posts with the form (Step 3). Omit in Steps 1 & 2. */
    name?: string
    accept?: string
    note?: React.ReactNode
    required?: boolean
    disabled?: boolean
    /** Called when a file is picked (Steps 1 & 2 use this to fill metadata / cache the file). */
    onPick?: (file: File) => void
    /** Inject an initial file (e.g., from cache) so the zone shows it and syncs the hidden input. */
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

    React.useEffect(() => {
        if (!initialFile) return
        setFile(initialFile)
        if (name && inputRef.current && initialFile) {
            const dt = new DataTransfer()
            dt.items.add(initialFile)
            inputRef.current.files = dt.files
        }
    }, [initialFile, name])

    function chooseFile(f: File | null) {
        if (!f) return
        setFile(f)
        onPick?.(f)
        if (name && inputRef.current) {
            const dt = new DataTransfer()
            dt.items.add(f)
            inputRef.current.files = dt.files
        }
    }

    function onChange(e: React.ChangeEvent<HTMLInputElement>) {
        chooseFile(e.target.files?.[0] ?? null)
    }

    function onDrop(e: React.DragEvent) {
        e.preventDefault()
        setDragOver(false)
        chooseFile(e.dataTransfer.files?.[0] ?? null)
    }

    return (
        <div className="space-y-2">
            {label ? <label className="block text-sm font-medium text-gray-700">{label}</label> : null}

            {/* Hidden native input (wired when "name" is provided) */}
            <input
                ref={inputRef}
                type="file"
                name={name}
                accept={accept}
                required={required}
                disabled={disabled}
                className="hidden"
                onChange={onChange}
            />

            <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`flex items-center justify-between gap-4 rounded-md border-2 border-dashed px-4 py-6 ${
                    dragOver ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:bg-gray-50'
                }`}
            >
                <div className="flex-1 text-sm">
                    <div className="font-medium text-gray-900">
                        {file ? file.name : 'Drop a PDF here or click here'}
                    </div>
                    <div className="text-xs text-gray-500">
                        {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'PDF only · Max 300 MB'}
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
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

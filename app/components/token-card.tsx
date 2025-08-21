// app/components/token-card.tsx
import * as React from 'react'
import { Form, useNavigation } from 'react-router'
import { Button } from '#app/components/ui/button.tsx'

type Props = {
    /** ISO string from the loader */
    expiresAtIso: string | null
    /** seconds remaining from the loader (server-calculated) */
    secondsRemaining: number
    /** TEMP ONLY: access token to display/copy while testing */
    tokenValue?: string
    /** Optional title override */
    title?: string
}

export function TokenCard({
                              expiresAtIso,
                              secondsRemaining,
                              tokenValue,
                              title = 'PCG Access Token (temporary)',
                          }: Props) {
    const [showToken, setShowToken] = React.useState(false)
    const nav = useNavigation()
    const generating = nav.formData?.get('intent') === 'refresh-token'

    // live countdown (updates every 30s)
    const [left, setLeft] = React.useState(secondsRemaining)
    React.useEffect(() => {
        setLeft(secondsRemaining) // reset when loader changes
        if (!expiresAtIso) return
        const id = setInterval(() => {
            const now = Date.now()
            const ms = new Date(expiresAtIso).getTime() - now
            setLeft(Math.max(0, Math.floor(ms / 1000)))
        }, 30000)
        return () => clearInterval(id)
    }, [expiresAtIso, secondsRemaining])

    const humanLeft =
        left > 0
            ? `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m`
            : 'expired'

    const expiresLocal = expiresAtIso ? new Date(expiresAtIso).toLocaleString() : '—'
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

    return (
        <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-700 font-bold">{title}</div>

            <div className="rounded-md border p-3 space-y-3">
                {/* Expiry row */}
                <div className="text-sm font-medium text-gray-700 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="block text-sm font-medium text-gray-700">Expires</span>
                    </div>
                    <div className="flex items-center gap-3">
            <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                    left > 0 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}
                aria-live="polite"
            >
              {left > 0 ? `in ${humanLeft}` : 'expired'}
            </span>
                        <span className="text-gray-700 text-sm" aria-live="polite">
              {expiresLocal}
            </span>
                    </div>
                </div>

                <div className="text-[12px] text-gray-700 -mt-2">Timezone: {tz}</div>

                {/* Token (TEMP) */}
                <div>
                    <div className="font-bold text-s text-gray-500 mb-1">Access Token</div>
                    <div className="flex gap-2">
                        <input
                            readOnly
                            // SECURITY: keep the real token out of the DOM until user clicks "Show"
                            value={showToken ? tokenValue ?? '' : ''}
                            placeholder="••••••••••••••••"
                            autoComplete="off"
                            className="text-gray-700 flex-1 rounded border px-2 py-1 font-mono text-xs"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-gray-700"
                            onClick={() => setShowToken((s) => !s)}
                        >
                            {showToken ? 'Hide' : 'Show'}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-gray-700"
                            onClick={() => tokenValue && navigator.clipboard.writeText(tokenValue)}
                        >
                            Copy
                        </Button>
                    </div>
                </div>

                {/* Generate token */}
                <Form method="post" className="pt-1">
                    <Button
                        name="intent"
                        value="refresh-token"
                        variant="outline"
                        size="sm"
                        className="text-gray-700"
                        disabled={!!generating}
                    >
                        {generating ? 'Generating…' : 'Generate token'}
                    </Button>
                </Form>

                <p className="font-bold text-[15px] text-amber-600">
                    Temporary display for testing. This will be removed later.
                </p>
            </div>
        </div>
    )
}

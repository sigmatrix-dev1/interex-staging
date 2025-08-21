import * as React from 'react'
import { useFetcher } from 'react-router'

type Options = {
    secondsRemaining: number
    thresholdSeconds?: number // default 600 (10m)
}

export function useEnsureFreshToken({ secondsRemaining, thresholdSeconds = 600 }: Options) {
    const fetcher = useFetcher()
    const refreshing = fetcher.state !== 'idle'

    const ensureFreshToken = React.useCallback(async () => {
        if (secondsRemaining > thresholdSeconds) return
        // refresh if under threshold
        const fd = new FormData()
        fd.set('intent', 'refresh-token')
        const p = fetcher.submit(fd, { method: 'post' })
        // react-router returns void; wait until idle:
        await new Promise<void>((resolve) => {
            const iv = setInterval(() => {
                if (fetcher.state === 'idle') {
                    clearInterval(iv)
                    resolve()
                }
            }, 30)
        })
    }, [fetcher, secondsRemaining, thresholdSeconds])

    return { ensureFreshToken, refreshing }
}

// app/services/pcg-token.server.ts
import { prisma } from '#app/utils/db.server.ts'
import { PCG_ENV } from '#app/utils/env.server.ts'

type TokenResp = {
    token_type: 'Bearer'
    expires_in: number
    access_token: string
    scope?: string
}

function getRequiredPcgEnv(): {
    BASE_URL?: string
    TOKEN_URL: string
    CLIENT_ID: string
    CLIENT_SECRET: string
    SCOPE: string
} {
    const BASE_URL = PCG_ENV.BASE_URL
    const TOKEN_URL = PCG_ENV.TOKEN_URL
    const CLIENT_ID = PCG_ENV.CLIENT_ID
    const CLIENT_SECRET = PCG_ENV.CLIENT_SECRET
    const SCOPE = PCG_ENV.SCOPE ?? 'UserGroup'

    const missing: string[] = []
    if (!TOKEN_URL) missing.push('PCGF_TOKEN_URL')
    if (!CLIENT_ID) missing.push('PCGF_CLIENT_ID')
    if (!CLIENT_SECRET) missing.push('PCGF_CLIENT_SECRET')
    // BASE_URL is used by callers; TOKEN_URL is required here for token fetch.
    if (missing.length > 0) {
        throw new Error(
            `Missing PCG env vars: ${missing.join(', ')}. Please set these in your environment (.env) to enable PCG token fetch.`,
        )
    }
    // Narrow types for required values so downstream calls are strongly typed as string
    return {
        BASE_URL,
        TOKEN_URL: TOKEN_URL as string,
        CLIENT_ID: CLIENT_ID as string,
        CLIENT_SECRET: CLIENT_SECRET as string,
        SCOPE,
    }
}

/** Try to discover our current egress IPs for logging */
async function getCurrentEgressIps(): Promise<{ v4?: string; v6?: string }> {
    // Best-effort; tolerate failures (no throw).
    try {
        const fetchIp = async (url: string): Promise<string> => {
            try {
                const r = await fetch(url, { method: 'GET' })
                if (!r.ok) return ''
                const t = await r.text()
                return t
            } catch {
                return ''
            }
        }

        const [v4, v6] = await Promise.allSettled([
            fetchIp('https://api.ipify.org?format=text'),
            fetchIp('https://api64.ipify.org?format=text'),
        ])
        return {
            v4: v4.status === 'fulfilled' && v4.value ? v4.value.trim() : undefined,
            v6: v6.status === 'fulfilled' && v6.value ? v6.value.trim() : undefined,
        }
    } catch {
        return {}
    }
}

/** Request a new OAuth token from PCG (client_credentials). */
async function requestNewToken() {
    const cfg = getRequiredPcgEnv()
    const body = new URLSearchParams()
    body.set('grant_type', 'client_credentials')
    body.set('scope', cfg.SCOPE)               // typically "UserGroup"
    body.set('client_id', cfg.CLIENT_ID)
    body.set('client_secret', cfg.CLIENT_SECRET)

    const res = await fetch(cfg.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    })

    if (!res.ok) {
        const txt = await res.text().catch(() => '')
        // Extra diagnostics for 4xx (likely WAF/allow-list)
        if (res.status >= 400 && res.status < 500) {
            const egress = await getCurrentEgressIps()
            const tokenUrlHost = (() => {
                try { return new URL(cfg.TOKEN_URL).host } catch { return cfg.TOKEN_URL }
            })()
            console.error('PCG token fetch failed', {
                status: res.status,
                statusText: res.statusText,
                snippet: txt.slice(0, 500),
                tokenUrlHost,
                scope: cfg.SCOPE,
                outboundIpv4: egress.v4,
                outboundIpv6: egress.v6,
                hint: 'If CMS/PCG allow-lists IPs, ensure both listed addresses are whitelisted.',
            })
        }

        throw new Error(`PCG token fetch failed (${res.status}): ${txt.slice(0, 300)}`)
    }

    const data = (await res.json()) as TokenResp
    // Refresh slightly early to avoid clock drift.
    const expiresAt = new Date(Date.now() + (data.expires_in - 120) * 1000)
    return { token: data.access_token, expiresAt }
}

/** Get the cached token or refresh if expired (or force). */
export async function getAccessToken(opts?: { forceRefresh?: boolean }) {
    const force = opts?.forceRefresh === true
    const existing = await prisma.apiToken.findFirst({ where: { provider: 'pcg-fhir' } })
    const valid = existing && existing.expiresAt.getTime() > Date.now()

    if (valid && !force) return { token: existing.accessToken, expiresAt: existing.expiresAt }

    const { token, expiresAt } = await requestNewToken()
    let saved
    if (existing) {
        saved = await prisma.apiToken.update({
            where: { id: existing.id },
            data: { accessToken: token, expiresAt },
        })
    } else {
        saved = await prisma.apiToken.create({
            data: { provider: 'pcg-fhir', accessToken: token, expiresAt },
        })
    }
    return { token: saved.accessToken, expiresAt: saved.expiresAt }
}

/** Helper for calling PCG endpoints with auto-refresh on 401 once. */
export async function callPcg(endpoint: string, init: RequestInit = {}) {
    // Transient errors we should retry briefly
    const transientStatuses = new Set([429, 502, 503, 504])
    const maxAttempts = 3

    let { token } = await getAccessToken()
    let refreshedOnce = false

    const doFetch = async (authToken: string) => {
        // Normalize headers from init into a Headers instance
        const headers = new Headers(init.headers as HeadersInit | undefined)
        // Ensure we always send an Accept; some gateways behave better with it
        if (!headers.has('Accept')) headers.set('Accept', 'application/json')
        // Set a simple UA: some upstream gateways behave oddly without it
        headers.set('User-Agent', 'interex/1.0 (+pcg-hih)')
        headers.set('Authorization', `Bearer ${authToken}`)
        return fetch(endpoint, { ...init, headers })
    }

    let attempt = 0
    while (attempt < maxAttempts) {
        let res = await doFetch(token)

        // Handle expired/invalid token once
        if (res.status === 401 && !refreshedOnce) {
            refreshedOnce = true
            const refreshed = await getAccessToken({ forceRefresh: true })
            token = refreshed.token
            attempt++
            continue
        }

        // Simple backoff on transient upstream errors
        if (transientStatuses.has(res.status) && attempt < maxAttempts - 1) {
            const delayMs = 400 * Math.pow(2, attempt)
            await new Promise(r => setTimeout(r, delayMs))
            attempt++
            continue
        }

        return res
    }

    // Last try without special handling
    return doFetch(token)
}

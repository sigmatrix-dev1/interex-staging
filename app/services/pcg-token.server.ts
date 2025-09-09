// app/services/pcg-token.server.ts
import { prisma } from '#app/utils/db.server.ts'
import { PCG_ENV } from '#app/utils/env.server.ts'

type TokenResp = {
    token_type: 'Bearer'
    expires_in: number // e.g. 14400 (4h)
    access_token: string
    scope?: string
}

/**
 * Tiny helper to learn the egress IP of the running machine so you can
 * whitelist it with PCG if they are enforcing allow-lists.
 * Never blocks longer than ~1.5s.
 */
async function getOutboundIpHint(): Promise<string | null> {
    try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 1500)
        const res = await fetch('https://ifconfig.me/ip', { signal: ctl.signal })
        clearTimeout(t)
        if (!res.ok) return null
        const txt = await res.text()
        return (txt || '').trim() || null
    } catch {
        return null
    }
}

/** Request a new OAuth token from PCG (client_credentials). */
async function requestNewToken() {
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: PCG_ENV.SCOPE, // typically "UserGroup"
        client_id: PCG_ENV.CLIENT_ID,
        client_secret: PCG_ENV.CLIENT_SECRET,
    })

    const res = await fetch(PCG_ENV.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    })

    if (!res.ok) {
        const txt = await res.text().catch(() => '')
        // Enrich error with outbound IP + target host to quickly resolve allow-list issues.
        const ip = await getOutboundIpHint()
        let host = 'unknown'
        try {
            host = new URL(PCG_ENV.TOKEN_URL).host
        } catch {
            /* ignore */
        }
        console.error('PCG token fetch failed', {
            status: res.status,
            statusText: res.statusText,
            snippet: (txt || '').slice(0, 200),
            tokenUrlHost: host,
            outboundIp: ip ?? 'unknown',
            scope: PCG_ENV.SCOPE,
        })
        throw new Error(`PCG token fetch failed (${res.status}): ${(txt || '').slice(0, 300)}`)
    }

    const data = (await res.json()) as TokenResp
    // Refresh slightly earlier to avoid clock drift.
    const expiresAt = new Date(Date.now() + (data.expires_in - 120) * 1000)
    return { token: data.access_token, expiresAt }
}

/** Get the cached token or refresh if expired (or force). */
export async function getAccessToken(opts?: { forceRefresh?: boolean }) {
    const force = opts?.forceRefresh === true
    const existing = await prisma.apiToken.findUnique({ where: { provider: 'pcg-fhir' } })
    const valid = existing && existing.expiresAt.getTime() > Date.now()

    if (valid && !force) {
        return { token: existing!.accessToken, expiresAt: existing!.expiresAt }
    }

    const { token, expiresAt } = await requestNewToken()
    const saved = await prisma.apiToken.upsert({
        where: { provider: 'pcg-fhir' },
        create: { provider: 'pcg-fhir', accessToken: token, expiresAt },
        update: { accessToken: token, expiresAt },
    })
    return { token: saved.accessToken, expiresAt: saved.expiresAt }
}

/**
 * Helper for calling PCG endpoints with auto-refresh on 401 exactly once.
 * Adds lightweight diagnostics to help trace production issues.
 */
export async function callPcg(endpoint: string, init: RequestInit = {}) {
    let { token } = await getAccessToken()
    let res = await fetch(endpoint, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    })

    if (res.status === 401) {
        // Try a forced refresh once
        const refreshed = await getAccessToken({ forceRefresh: true })
        token = refreshed.token
        res = await fetch(endpoint, {
            ...init,
            headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
        })
    }

    // Helpful trace on 403 to surface likely allow-list or scope issues.
    if (res.status === 403) {
        let host = 'unknown'
        try {
            host = new URL(endpoint).host
        } catch {
            /* ignore */
        }
        const ip = await getOutboundIpHint()
        const snippet = await res
            .clone()
            .text()
            .then((t) => t.slice(0, 200))
            .catch(() => '')
        console.error('PCG API 403', {
            endpointHost: host,
            statusText: res.statusText,
            outboundIp: ip ?? 'unknown',
            snippet,
        })
    }

    return res
}

// app/services/pcg-token.server.ts
import { prisma } from '#app/utils/db.server.ts'
import { PCG_ENV } from '#app/utils/env.server.ts'

type TokenResp = {
    token_type: 'Bearer'
    expires_in: number
    access_token: string
    scope?: string
}

/** Try to discover our current egress IPs for logging */
async function getCurrentEgressIps(): Promise<{ v4?: string; v6?: string }> {
    // Best-effort; tolerate failures (no throw).
    try {
        const [v4, v6] = await Promise.allSettled([
            fetch('https://api.ipify.org?format=text', { method: 'GET' }).then(r => r.ok ? r.text() : ''),
            fetch('https://api64.ipify.org?format=text', { method: 'GET' }).then(r => r.ok ? r.text() : ''),
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
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: PCG_ENV.SCOPE,              // typically "UserGroup"
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
        // Extra diagnostics for 4xx (likely WAF/allow-list)
        if (res.status >= 400 && res.status < 500) {
            const egress = await getCurrentEgressIps()
            const tokenUrlHost = (() => {
                try { return new URL(PCG_ENV.TOKEN_URL).host } catch { return PCG_ENV.TOKEN_URL }
            })()
            console.error('PCG token fetch failed', {
                status: res.status,
                statusText: res.statusText,
                snippet: txt.slice(0, 500),
                tokenUrlHost,
                scope: PCG_ENV.SCOPE,
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
    const existing = await prisma.apiToken.findUnique({ where: { provider: 'pcg-fhir' } })
    const valid = existing && existing.expiresAt.getTime() > Date.now()

    if (valid && !force) return { token: existing.accessToken, expiresAt: existing.expiresAt }

    const { token, expiresAt } = await requestNewToken()
    const saved = await prisma.apiToken.upsert({
        where: { provider: 'pcg-fhir' },
        create: { provider: 'pcg-fhir', accessToken: token, expiresAt },
        update: { accessToken: token, expiresAt },
    })
    return { token: saved.accessToken, expiresAt: saved.expiresAt }
}

/** Helper for calling PCG endpoints with auto-refresh on 401 once. */
export async function callPcg(endpoint: string, init: RequestInit = {}) {
    let { token } = await getAccessToken()
    let res = await fetch(endpoint, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
        const refreshed = await getAccessToken({ forceRefresh: true })
        token = refreshed.token
        res = await fetch(endpoint, {
            ...init,
            headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
        })
    }
    return res
}

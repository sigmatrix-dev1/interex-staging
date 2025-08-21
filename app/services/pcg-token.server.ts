// app/services/pcg-token.server.ts
import { prisma } from '#app/utils/db.server.ts'
import { PCG_ENV } from '#app/utils/env.server.ts'

type TokenResp = {
    token_type: 'Bearer'
    expires_in: number      // e.g. 14400 (4h)
    access_token: string
    scope?: string
}

/** Request a new OAuth token from PCG (client_credentials). */
async function requestNewToken() {
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: PCG_ENV.SCOPE,              // should be "UserGroup"
        client_id: PCG_ENV.CLIENT_ID,
        client_secret: PCG_ENV.CLIENT_SECRET,
    })

    const res = await fetch(PCG_ENV.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    })
    if (!res.ok) {
        const txt = await res.text()
        throw new Error(`PCG token fetch failed (${res.status}): ${txt.slice(0, 300)}`)
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

// app/utils/env.server.ts
import { z } from 'zod'

const schema = z.object({
    NODE_ENV: z.enum(['production', 'development', 'test'] as const),
    DATABASE_PATH: z.string(),
    DATABASE_URL: z.string(),
    SESSION_SECRET: z.string(),
    INTERNAL_COMMAND_TOKEN: z.string(),
    HONEYPOT_SECRET: z.string(),
    CACHE_DATABASE_PATH: z.string(),
    // If you plan on using Sentry, remove the .optional()
    SENTRY_DSN: z.string().optional(),
    // If you plan to use Resend, remove the .optional()
    RESEND_API_KEY: z.string().optional(),
    // GitHub OAuth removed – variables deprecated (retain optional parsing for backward deploy safety)
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GITHUB_REDIRECT_URI: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),

    ALLOW_INDEXING: z.enum(['true', 'false']).optional(),

    // Tigris Object Storage Configuration (optional for deployment)
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_ENDPOINT_URL_S3: z.string().url().optional(),
    BUCKET_NAME: z.string().optional(),

    // PCG config (required in all environments)
    PCGF_BASE_URL: z.string().url(),
    PCGF_TOKEN_URL: z.string().url(),
    PCGF_CLIENT_ID: z.string(),
    PCGF_CLIENT_SECRET: z.string(),
    PCGF_SCOPE: z.string(),

    // Security policy flags
    REQUIRE_2FA_ON_LOGIN: z.enum(['true', 'false']).optional(),
    AUTH_RATE_LIMIT_ENABLED: z.enum(['true','false']).optional(),
    AUTH_RATE_LIMIT_WINDOW_SEC: z.string().optional(),
    AUTH_RATE_LIMIT_MAX: z.string().optional(),
    // Account lockout flags (Phase 1)
    LOCKOUT_ENABLED: z.enum(['true','false']).optional(),
    LOCKOUT_THRESHOLD: z.string().optional(),
    LOCKOUT_WINDOW_SEC: z.string().optional(),
    LOCKOUT_BASE_COOLDOWN_SEC: z.string().optional(),
    // Removed privileged MFA flags – MFA now mandatory for all users.

    // Privacy: how to record client IPs in audit logs: 'raw' | 'masked' | 'hash'
    LOG_IP_MODE: z.enum(['raw', 'masked', 'hash']).optional(),
    IP_HASH_SALT: z.string().optional(),
})

declare global {
    namespace NodeJS {
        interface ProcessEnv extends z.infer<typeof schema> {}
    }
}

export function init() {
    const parsed = schema.safeParse(process.env)
    if (parsed.success === false) {
        console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors)
        throw new Error('Invalid environment variables')
    }
}

/**
 * Public (safe) env for the client bundle. Keep secrets out of here.
 */
export function getEnv() {
    return {
        MODE: process.env.NODE_ENV,
        SENTRY_DSN: process.env.SENTRY_DSN,
        ALLOW_INDEXING: process.env.ALLOW_INDEXING,
        LOG_IP_MODE: process.env.LOG_IP_MODE,
        AUTH_RATE_LIMIT_ENABLED: process.env.AUTH_RATE_LIMIT_ENABLED,
        LOCKOUT_ENABLED: process.env.LOCKOUT_ENABLED,
    // No privileged MFA flags exported
    }
}

type ENV = ReturnType<typeof getEnv>

declare global {
     
    var ENV: ENV
    interface Window {
        ENV: ENV
    }
}

/* -------------------------------------------------------------------------- */
/*                         PCG CONFIG FROM ENV VARIABLES                      */
/* -------------------------------------------------------------------------- */

export const PCG_ENV = (() => {
    // Read from environment variables exclusively and enforce presence in all envs
    const env = {
        PCGF_BASE_URL: process.env.PCGF_BASE_URL,
        PCGF_TOKEN_URL: process.env.PCGF_TOKEN_URL,
        PCGF_CLIENT_ID: process.env.PCGF_CLIENT_ID,
        PCGF_CLIENT_SECRET: process.env.PCGF_CLIENT_SECRET,
        PCGF_SCOPE: process.env.PCGF_SCOPE,
    }

    const missing = Object.entries(env)
        .filter(([, v]) => !v)
        .map(([k]) => k)

    if (missing.length) {
        console.error('Missing required PCG env vars:', missing.join(', '))
        throw new Error('PCG configuration is missing required environment variables')
    }

    return {
        BASE_URL: env.PCGF_BASE_URL!,
        TOKEN_URL: env.PCGF_TOKEN_URL!,
        CLIENT_ID: env.PCGF_CLIENT_ID!,
        CLIENT_SECRET: env.PCGF_CLIENT_SECRET!,
        SCOPE: env.PCGF_SCOPE!,
    } as const
})()

// (Optional) tiny boot log to confirm which host you're hitting
try {
    if (process.env.NODE_ENV !== 'production') {
        console.info(
            'PCG env configured',
            JSON.stringify({ tokenUrlHost: new URL(PCG_ENV.TOKEN_URL).host, scope: PCG_ENV.SCOPE }),
        )
    }
    // In production, emit a warning if BASE_URL seems incomplete (common cause of 404: "no Route matched")
    if (process.env.NODE_ENV === 'production') {
        try {
            const u = new URL(PCG_ENV.BASE_URL)
            const p = u.pathname.replace(/\/+$/, '')
            const hasHihApi = p.includes('/pcgfhir') && p.includes('/hih') && p.includes('/api')
            if (!hasHihApi) {
                console.warn(
                    'PCG BASE_URL may be misconfigured. Expected path to include /pcgfhir/hih/api. Current:',
                    PCG_ENV.BASE_URL,
                )
            }
        } catch {}
    }
} catch {}

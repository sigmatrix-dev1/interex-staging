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
    // If you plan to use GitHub auth, remove the .optional()
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

    // PCG config (optional in dev; required in production)
    PCGF_BASE_URL: z.string().url().optional(),
    PCGF_TOKEN_URL: z.string().url().optional(),
    PCGF_CLIENT_ID: z.string().optional(),
    PCGF_CLIENT_SECRET: z.string().optional(),
    PCGF_SCOPE: z.string().optional(),
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
/*                     HARD-CODED PCG CONFIG (for debugging)                  */
/* -------------------------------------------------------------------------- */

export const PCG_ENV = {
    BASE_URL:
        process.env.PCGF_BASE_URL || 'https://drfpimpl.cms.gov/pcgfhir/hih/api',
    TOKEN_URL: process.env.PCGF_TOKEN_URL || 'https://drfpimpl.cms.gov/token',
    // Fall back to existing hard-coded values if env vars are not provided
    CLIENT_ID: process.env.PCGF_CLIENT_ID || '0oayc2ysgssSksF81297',
    CLIENT_SECRET:
        process.env.PCGF_CLIENT_SECRET || 'fNrlPQqDmjwMCdyxW1OicnR_nuJ0TzUA9nyaHryJbJGdi1F_OcN3616p_NGva8HY',
    SCOPE: process.env.PCGF_SCOPE || 'UserGroup',
} as const

// (Optional) tiny boot log to confirm which host you're hitting
try {
    if (process.env.NODE_ENV !== 'production') {
        console.info(
            'PCG env configured',
            JSON.stringify({ tokenUrlHost: new URL(PCG_ENV.TOKEN_URL).host, scope: PCG_ENV.SCOPE }),
        )
    }
} catch {}

import { createCookieSessionStorage } from 'react-router'

function loadSessionSecrets(): string[] {
	const raw = process.env.SESSION_SECRET
	if (!raw) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('SESSION_SECRET is required in production')
		}
		// Dev fallback (single ephemeral secret). Not suitable for multi-process consistency.
		return ['dev-insecure-secret-'+Math.random().toString(36).slice(2)]
	}
	const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
	if (parts.length === 0) throw new Error('SESSION_SECRET provided but empty after parsing')
	const MIN = 32
	const weak: string[] = []
	for (const p of parts) {
		if (p.length < MIN) weak.push(p)
	}
	if (weak.length && process.env.NODE_ENV === 'production') {
		throw new Error(`SESSION_SECRET entries too short (<${MIN}). Offenders: ${weak.length}`)
	} else if (weak.length) {
		console.warn('[security] Weak SESSION_SECRET length detected (dev only).')
	}
	return parts
}

const sessionSecrets = loadSessionSecrets()

export const authSessionStorage = createCookieSessionStorage({
	cookie: {
		name: 'en_session',
		sameSite: 'lax', // Consider upgrading to 'strict' if business flows allow.
		path: '/',
		httpOnly: true,
		secrets: sessionSecrets, // First = active signer, rest = legacy verifiers (rotation support)
		secure: process.env.NODE_ENV === 'production',
	},
})

// we have to do this because every time you commit the session you overwrite it
// so we store the expiration time in the cookie and reset it every time we commit
const originalCommitSession = authSessionStorage.commitSession

Object.defineProperty(authSessionStorage, 'commitSession', {
	value: async function commitSession(
		...args: Parameters<typeof originalCommitSession>
	) {
		const [session, options] = args
		if (options?.expires) {
			session.set('expires', options.expires)
		}
		if (options?.maxAge) {
			session.set('expires', new Date(Date.now() + options.maxAge * 1000))
		}
		const expires = session.has('expires')
			? new Date(session.get('expires'))
			: undefined
		const setCookieHeader = await originalCommitSession(session, {
			...options,
			expires,
		})
		return setCookieHeader
	},
})

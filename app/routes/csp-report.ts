// Resource route for receiving CSP violation reports.
// We intentionally reuse the existing SecurityEvent table rather than introducing
// a new Prisma model to avoid migration churn. Each report is stored with kind
// 'CSP_VIOLATION', success=false, and the raw report JSON in `data`.
// No authentication: browsers send reports out-of-band; we rate-limit globally elsewhere.
// The payload shape (Level 3) typically arrives as {"csp-report": {...}} but modern
// browsers may also POST an array or a Report-To JSON envelope. We handle the common
// single-report case; additional shapes are safely ignored / normalized.

import { prisma } from '#app/utils/db.server.ts'

// ---- Basic in-memory throttling to prevent log storms on repeated CSP violations ----
// We aggregate by (ip || userAgent) + (effectiveDirective || violatedDirective) within a window.
// When the per-key count exceeds the limit, we emit a single CSP_VIOLATION_THROTTLED event and
// suppress further writes until the window resets.

let CSP_THROTTLE_LIMIT = Number(process.env.CSP_THROTTLE_LIMIT || 20)
let CSP_THROTTLE_WINDOW_MS = 60_000 // 1 minute

type ThrottleEntry = { start: number; count: number; throttled: boolean }
const throttleMap: Map<string, ThrottleEntry> = new Map()

// Test-only override helper (not documented publicly). Guard to NODE_ENV to avoid accidental prod usage.
export function _setCspThrottleForTests(limit: number, windowMs: number) {
	if (process.env.NODE_ENV === 'test') {
		CSP_THROTTLE_LIMIT = limit
		CSP_THROTTLE_WINDOW_MS = windowMs
		throttleMap.clear()
	}
}

export async function action({ request }: { request: Request }) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	let bodyText: string | null = null
	try {
		bodyText = await request.text()
	} catch {
		return new Response('Invalid Body', { status: 400 })
	}

	if (!bodyText) {
		return new Response(null, { status: 204 }) // nothing to do
	}

	let parsed: any
	try {
		parsed = JSON.parse(bodyText)
	} catch {
		// Some user agents may send non-JSON (should not per spec) – discard quietly
		return new Response(null, { status: 204 })
	}

	// Normalize report object
	const report = parsed?.['csp-report'] ?? parsed
	if (!report || typeof report !== 'object') {
		return new Response(null, { status: 204 })
	}

	const userAgent = request.headers.get('user-agent') || undefined
	const ip =
		request.headers.get('fly-client-ip') ||
		request.headers.get('x-forwarded-for') ||
		undefined

	// Extract commonly useful fields for quick filtering; retain full payload in data
	const violatedDirective: string | undefined = report['violated-directive']
	const effectiveDirective: string | undefined = report['effective-directive']
	const blockedUri: string | undefined = report['blocked-uri']
	const documentUri: string | undefined = report['document-uri']

	// Throttle logic
	try {
		const directiveKey = effectiveDirective || violatedDirective || 'unknown'
		const actorKey = ip || userAgent || 'unknown'
		const key = actorKey + '|' + directiveKey
		const now = Date.now()
		let entry = throttleMap.get(key)
		if (!entry || now - entry.start > CSP_THROTTLE_WINDOW_MS) {
			entry = { start: now, count: 0, throttled: false }
			throttleMap.set(key, entry)
		}
		entry.count += 1
		if (entry.count <= CSP_THROTTLE_LIMIT) {
			await prisma.securityEvent.create({
				data: {
					kind: 'CSP_VIOLATION',
					success: false,
					message: violatedDirective,
					reason: effectiveDirective,
					userAgent,
					ip,
					data: {
						blockedUri,
						documentUri,
						violatedDirective,
						effectiveDirective,
						report,
						throttle: { count: entry.count, limit: CSP_THROTTLE_LIMIT },
					},
				},
			})
		} else if (!entry.throttled) {
			entry.throttled = true
			await prisma.securityEvent.create({
				data: {
					kind: 'CSP_VIOLATION_THROTTLED',
					success: false,
					message: 'CSP violation throttled',
					reason: directiveKey,
					userAgent,
					ip,
					data: {
						violatedDirective,
						effectiveDirective,
						blockedUri,
						documentUri,
						firstWindowStart: entry.start,
						limit: CSP_THROTTLE_LIMIT,
						windowMs: CSP_THROTTLE_WINDOW_MS,
						observed: entry.count,
					},
				},
			})
		} // else: already throttled, suppress silently
	} catch {
		// swallow errors
	}

	return new Response(null, { status: 204 })
}

// GET not supported; optionally could expose aggregate metrics in future.
export async function loader() {
	return new Response('Not Found', { status: 404 })
}

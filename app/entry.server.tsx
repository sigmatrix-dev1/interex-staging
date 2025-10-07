import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { styleText } from 'node:util'
import { createReadableStreamFromReadable } from '@react-router/node'
import * as Sentry from '@sentry/react-router'
import { isbot } from 'isbot'
import { renderToPipeableStream } from 'react-dom/server'
import {
	ServerRouter,
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
	type HandleDocumentRequestFunction,
} from 'react-router'
import { getEnv, init } from './utils/env.server.ts'
import { getInstanceInfo } from './utils/litefs.server.ts'
import { NonceProvider } from './utils/nonce-provider.ts'
import { makeTimings } from './utils/timing.server.ts'

export const streamTimeout = 5000

init()
global.ENV = getEnv()

const MODE = process.env.NODE_ENV ?? 'development'

type DocRequestArgs = Parameters<HandleDocumentRequestFunction>

export default async function handleRequest(...args: DocRequestArgs) {
	const [request, responseStatusCode, responseHeaders, reactRouterContext] =
		args
	const { currentInstance, primaryInstance } = await getInstanceInfo()
	responseHeaders.set('fly-region', process.env.FLY_REGION ?? 'unknown')
	responseHeaders.set('fly-app', process.env.FLY_APP_NAME ?? 'unknown')
	responseHeaders.set('fly-primary-instance', primaryInstance)
	responseHeaders.set('fly-instance', currentInstance)

	if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
		responseHeaders.append('Document-Policy', 'js-profiling')
	}

	const callbackName = isbot(request.headers.get('user-agent'))
		? 'onAllReady'
		: 'onShellReady'

	const nonce = crypto.randomBytes(16).toString('hex')
	return new Promise(async (resolve, reject) => {
		let didError = false
		// NOTE: this timing will only include things that are rendered in the shell
		// and will not include suspended components and deferred loaders
		const timings = makeTimings('render', 'renderToPipeableStream')

		const { pipe, abort } = renderToPipeableStream(
			<NonceProvider value={nonce}>
				<ServerRouter
					nonce={nonce}
					context={reactRouterContext}
					url={request.url}
				/>
			</NonceProvider>,
			{
				[callbackName]: () => {
					const body = new PassThrough()
					responseHeaders.set('Content-Type', 'text/html')
					responseHeaders.append('Server-Timing', timings.toString())

					// Manual CSP assembly for fine-grained control. Using strict-dynamic + nonce eliminates need for hash whitelists.
					// Tailwind is linked as a static stylesheet so we can avoid unsafe-inline for styles.
					// If a future inline style is required, prefer a hashed style attribute or move styles to CSS.
					const cspDirectives: Record<string, string[]> = {
						"default-src": ["'self'"],
						"base-uri": ["'self'"],
						"frame-ancestors": ["'none'"],
						"form-action": ["'self'"],
						"object-src": ["'none'"],
						"connect-src": [
							"'self'",
							MODE === 'development' ? 'ws:' : undefined,
							process.env.SENTRY_DSN ? '*.sentry.io' : undefined,
						].filter(Boolean) as string[],
						"img-src": ["'self'", 'data:'],
						"font-src": ["'self'", 'data:'],
						"script-src": ["'strict-dynamic'", "'self'", `'nonce-${nonce}'`],
						"script-src-attr": [`'nonce-${nonce}'`],
						"style-src": ["'self'"],
						// Reporting directives (non-legacy + legacy fallback). Browsers ignore unknown directives.
						"report-to": ['csp'],
						"report-uri": ['/csp-report'],
					}
					const csp = Object.entries(cspDirectives)
						.map(([k, v]) => `${k} ${v.join(' ')}`)
						.join('; ')
					responseHeaders.set('Content-Security-Policy', csp)

					// Configure Report-To header for modern reporting API.
					try {
						const origin = new URL(request.url).origin
						const reportTo = {
							group: 'csp',
							max_age: 60 * 60 * 24 * 7, // 7 days
							endpoints: [{ url: `${origin}/csp-report` }],
						}
						responseHeaders.set('Report-To', JSON.stringify(reportTo))
					} catch {}

					resolve(
						new Response(createReadableStreamFromReadable(body), {
							headers: responseHeaders,
							status: didError ? 500 : responseStatusCode,
						}),
					)
					pipe(body)
				},
				onShellError: (err: unknown) => {
					reject(err)
				},
				onError: () => {
					didError = true
				},
				nonce,
			},
		)

		setTimeout(abort, streamTimeout + 5000)
	})
}

export async function handleDataRequest(response: Response) {
	const { currentInstance, primaryInstance } = await getInstanceInfo()
	response.headers.set('fly-region', process.env.FLY_REGION ?? 'unknown')
	response.headers.set('fly-app', process.env.FLY_APP_NAME ?? 'unknown')
	response.headers.set('fly-primary-instance', primaryInstance)
	response.headers.set('fly-instance', currentInstance)

	return response
}

export function handleError(
	error: unknown,
	{ request }: LoaderFunctionArgs | ActionFunctionArgs,
): void {
	// Skip capturing if the request is aborted as Remix docs suggest
	// Ref: https://remix.run/docs/en/main/file-conventions/entry.server#handleerror
	if (request.signal.aborted) {
		return
	}

	if (error instanceof Error) {
		console.error(styleText('red', String(error.stack)))
	} else {
		console.error(error)
	}

	Sentry.captureException(error)
}

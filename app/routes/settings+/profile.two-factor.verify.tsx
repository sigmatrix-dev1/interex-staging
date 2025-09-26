import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { redirect } from 'react-router'
import { type Route } from './+types/profile.two-factor.verify.ts'

// Legacy route shim: this path used to handle 2FA verification. It now redirects
// to the unified self-service page under /me/2fa. Keeping this file avoids
// breaking old bookmarks without carrying any legacy logic.
export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export async function loader({}: Route.LoaderArgs) {
	return redirect('/me/2fa')
}

export default function VerifyRedirect() {
	return null
}

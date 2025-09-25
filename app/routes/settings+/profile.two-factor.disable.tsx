import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { Icon } from '#app/components/ui/icon.tsx'
import { type Route } from './+types/profile.two-factor.disable.ts'
import { type BreadcrumbHandle } from './profile.tsx'

export const handle: BreadcrumbHandle & SEOHandle = {
	breadcrumb: <Icon name="lock-open-1">Disable</Icon>,
	getSitemapEntries: () => null,
}

export async function loader({}: Route.LoaderArgs) {
	// Self-disable of 2FA is no longer allowed. Only admins can reset 2FA.
	throw new Response('Not Found', { status: 404 })
}

export async function action({}: Route.ActionArgs) {
	// Block any attempts to POST here as well
	throw new Response('Not Found', { status: 404 })
}

export default function TwoFactorDisableRoute() {
	return null
}

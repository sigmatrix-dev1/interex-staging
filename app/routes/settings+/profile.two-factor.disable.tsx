import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { Icon } from '#app/components/ui/icon.tsx'
import { type Route } from './+types/profile.two-factor.disable.ts'
import { type BreadcrumbHandle } from './profile.tsx'

export const handle: BreadcrumbHandle & SEOHandle = {
	breadcrumb: <Icon name="lock-open-1">Disable</Icon>,
	getSitemapEntries: () => null,
}

export async function loader({}: Route.LoaderArgs) {
	throw new Response('Not Found', { status: 404 })
}

export async function action({}: Route.ActionArgs) {
	throw new Response('Not Found', { status: 404 })
}

export default function TwoFactorDisableRoute() {
	return null
}

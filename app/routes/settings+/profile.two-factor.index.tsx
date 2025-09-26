import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { type Route } from './+types/profile.two-factor.index.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } })
	return { is2FAEnabled: Boolean(user?.twoFactorEnabled) }
}

export default function TwoFactorRoute({ loaderData }: Route.ComponentProps) {

	return (
		<div className="flex flex-col gap-4">
			{loaderData.is2FAEnabled ? (
				<>
					<p className="text-lg">
						<Icon name="check">
							You have enabled two-factor authentication.
						</Icon>
					</p>
					<p className="text-xs text-gray-500">
						2FA cannot be disabled by users. Contact an administrator if you need to reset 2FA.
					</p>
				</>
			) : (
				<>
					<p>
						<Icon name="lock-open-1">
							You have not enabled two-factor authentication yet.
						</Icon>
					</p>
					<p className="text-sm">
						Two factor authentication adds an extra layer of security to your
						account. You will need to enter a code from an authenticator app
						like{' '}
						<a className="underline" href="https://1password.com/">
							1Password
						</a>{' '}
						to log in.
					</p>
					{/* Redirect to the unified 2FA setup page under /me/2fa */}
					<a href="/me/2fa" className="mx-auto">
						<StatusButton type="button" className="mx-auto" status="idle">
							Enable 2FA
						</StatusButton>
					</a>
				</>
			)}
		</div>
	)
}

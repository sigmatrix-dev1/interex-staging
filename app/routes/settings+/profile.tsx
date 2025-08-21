import { invariantResponse } from '@epic-web/invariant'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { Link, Outlet, useMatches } from 'react-router'
import { z } from 'zod'
import { Icon } from '#app/components/ui/icon.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { cn } from '#app/utils/misc.tsx'
import { useUser } from '#app/utils/user.ts'
import { type Route } from './+types/profile.ts'

export const BreadcrumbHandle = z.object({ breadcrumb: z.any() })
export type BreadcrumbHandle = z.infer<typeof BreadcrumbHandle>

export const handle: BreadcrumbHandle & SEOHandle = {
	breadcrumb: <Icon name="file-text">Edit Profile</Icon>,
	getSitemapEntries: () => null,
}

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { username: true },
	})
	invariantResponse(user, 'User not found', { status: 404 })
	return {}
}

const BreadcrumbHandleMatch = z.object({
	handle: BreadcrumbHandle,
})

export default function EditUserProfile() {
	const user = useUser()
	const matches = useMatches()
	const breadcrumbs = matches
		.map((m) => {
			const result = BreadcrumbHandleMatch.safeParse(m)
			if (!result.success || !result.data.handle.breadcrumb) return null
			return (
				<Link key={m.id} to={m.pathname} className="flex items-center">
					{result.data.handle.breadcrumb}
				</Link>
			)
		})
		.filter(Boolean)

	return (
		<InterexLayout 
			user={user}
			title="Profile Settings"
			subtitle={`User: ${user.username}`}
			showBackButton={true}
			backTo="/dashboard"
			currentPath="/settings/profile"
		>
			<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<div className="bg-white shadow rounded-lg">
					<div className="px-6 py-8">
						{breadcrumbs.length > 0 && (
							<nav className="mb-8">
								<ul className="flex space-x-6 border-b border-gray-200">
									{breadcrumbs.map((breadcrumb, i, arr) => (
										<li
											key={i}
											className={cn('flex items-center pb-4', {
												'text-blue-600 border-b-2 border-blue-600': i === arr.length - 1,
												'text-gray-500 hover:text-gray-700': i < arr.length - 1,
											})}
										>
											{breadcrumb}
										</li>
									))}
								</ul>
							</nav>
						)}
						<Outlet />
					</div>
				</div>
			</div>
		</InterexLayout>
	)
}

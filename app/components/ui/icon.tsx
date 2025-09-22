// Heroicons outline set imports (placed before react per lint rule)
import {
	ChartBarIcon as HeroChartBarIcon,
	HomeIcon as HeroHomeIcon,
	Cog6ToothIcon as HeroCogIcon,
	DocumentTextIcon as HeroDocumentTextIcon,
	InboxStackIcon as HeroInboxStackIcon,
	FolderOpenIcon as HeroFolderOpenIcon,
	UsersIcon as HeroUsersIcon,
	ShieldCheckIcon as HeroShieldCheckIcon,
	ArrowPathIcon as HeroArrowPathIcon,
	ChevronDownIcon as HeroChevronDownIcon,
	ChevronUpIcon as HeroChevronUpIcon,
	PlusIcon as HeroPlusIcon,
	UserPlusIcon as HeroUserPlusIcon,
	UserGroupIcon as HeroUserGroupIcon,
	DocumentPlusIcon as HeroDocumentPlusIcon,
} from '@heroicons/react/24/outline'
import { type SVGProps } from 'react'
import { cn } from '#app/utils/misc.tsx'
import href from './icons/sprite.svg'

// NOTE: build step should overwrite types/icon-name.d.ts with a union.
// Until then we maintain a runtime list + aliases for safety.
const RAW_ICON_NAMES = [
	'arrow-left',
	'arrow-right',
	'avatar',
	'camera',
	'clock',
	'cross-1',
	'download',
	'dots-horizontal',
	'envelope-closed',
	'exit',
	'file-text',
	'gear',
	'github-logo',
	'id-card',
	'laptop',
	'link-2',
	'lock-closed',
	'lock-open-1',
	'magnifying-glass',
	'moon',
	'pencil-1',
	'pencil-2',
	'question-mark-circled',
	'reset',
	'sun',
	'trash',
	'update',
	'plus',
	'users',
	'warning',
	'check',
] as const

// Common aliases so nav can use friendlier names.
const ALIASES: Record<string, (typeof RAW_ICON_NAMES)[number]> = {
  users: 'avatar',
  gauge: 'gear',
  settings: 'gear',
  inbox: 'envelope-closed',
  mail: 'envelope-closed',
  wrench: 'gear',
  'layer-group': 'gear',
  passkey: 'lock-closed',
}

// Heroicon names (prefix hero: to avoid collisions with sprite ids)
const HERO_ICON_COMPONENTS = {
	'hero:dashboard': HeroHomeIcon,
	'hero:chart': HeroChartBarIcon,
	'hero:logs': HeroDocumentTextIcon,
	'hero:settings': HeroCogIcon,
	'hero:submissions': HeroInboxStackIcon,
	'hero:letters': HeroFolderOpenIcon,
	'hero:users': HeroUsersIcon,
	'hero:security': HeroShieldCheckIcon,
	'hero:refresh': HeroArrowPathIcon,
	'hero:chevron-down': HeroChevronDownIcon,
	'hero:chevron-up': HeroChevronUpIcon,
	'hero:plus': HeroPlusIcon,
	'hero:user-plus': HeroUserPlusIcon,
	'hero:user-group': HeroUserGroupIcon,
	'hero:document-plus': HeroDocumentPlusIcon,
} as const

// Bridge: allow plain "plus" usage even though it's not in sprite; map to hero:plus.
// We do this by extending the union and resolving in runtime branch (hero components win first).
export type IconName = typeof RAW_ICON_NAMES[number] | keyof typeof ALIASES | keyof typeof HERO_ICON_COMPONENTS | 'plus'
export function listIconNames(): string[] {
	return Array.from(new Set([...RAW_ICON_NAMES, ...Object.keys(ALIASES)])).sort()
}

export { href }

const sizeClassName = {
	font: 'size-[1em]',
	xs: 'size-3',
	sm: 'size-4',
	md: 'size-5',
	lg: 'size-6',
	xl: 'size-7',
} as const

type Size = keyof typeof sizeClassName

const childrenSizeClassName = {
	font: 'gap-1.5',
	xs: 'gap-1.5',
	sm: 'gap-1.5',
	md: 'gap-2',
	lg: 'gap-2',
	xl: 'gap-3',
} satisfies Record<Size, string>

/**
 * Renders an SVG icon. The icon defaults to the size of the font. To make it
 * align vertically with neighboring text, you can pass the text as a child of
 * the icon and it will be automatically aligned.
 * Alternatively, if you're not ok with the icon being to the left of the text,
 * you need to wrap the icon and text in a common parent and set the parent to
 * display "flex" (or "inline-flex") with "items-center" and a reasonable gap.
 *
 * Pass `title` prop to the `Icon` component to get `<title>` element rendered
 * in the SVG container, providing this way for accessibility.
 */
export function Icon({
	name,
	size = 'font',
	className,
	title,
	children,
	...props
}: SVGProps<SVGSVGElement> & {
  name: IconName
  size?: Size
  title?: string
}) {
	// If heroicon
	if (name in HERO_ICON_COMPONENTS) {
		const HeroComp = HERO_ICON_COMPONENTS[name as keyof typeof HERO_ICON_COMPONENTS]
		return (
			<HeroComp
				{...props}
				className={cn(sizeClassName[size], 'inline self-center', className)}
				aria-hidden={title ? undefined : 'true'}
			/>
		)
	}
	const resolved: string = (name in ALIASES ? ALIASES[name] : name) as string
	const isKnown = RAW_ICON_NAMES.includes(resolved as any)

	if (children) {
		return (
			<span
				className={`inline-flex items-center ${childrenSizeClassName[size]}`}
			>
				<Icon
					name={resolved as IconName}
					size={size}
					className={className}
					title={title}
					{...props}
				/>
				{children}
			</span>
		)
	}
	if (!isKnown) {
		if (process.env.NODE_ENV !== 'production') {
			console.warn(`[Icon] Unknown icon "${name}" (resolved to "${resolved}"). Available: ${listIconNames().join(', ')}`)
		}
		// Avoid passing SVG-only props to span: pick only className & title
		return (
			<span
				className={cn(
					sizeClassName[size],
					'inline-flex items-center justify-center rounded bg-red-50 text-red-600 text-[10px] font-medium',
					className,
				)}
				title={title || `Unknown icon: ${name}`}
			>
				?
			</span>
		)
	}
	return (
		<svg
			{...props}
			className={cn(sizeClassName[size], 'inline self-center', className)}
		>
			{title ? <title>{title}</title> : null}
			<use href={`${href}#${resolved}`} />
		</svg>
	)
}

import * as React from 'react'
import { cn } from '#app/utils/misc.tsx'

const Select = ({
	className,
	children,
	...props
}: React.ComponentProps<'select'>) => {
	return (
		<div className="relative">
			<select
				className={cn(
					// Base styling
					'flex h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-900 shadow-sm transition-all duration-200',
					// Remove default appearance
					'appearance-none cursor-pointer',
					// Focus states
					'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none',
					// Hover states  
					'hover:border-gray-400 hover:shadow-md',
					// Disabled states
					'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50',
					// Error states
					'aria-[invalid]:border-red-500 aria-[invalid]:ring-red-500/20',
					// Right padding for arrow
					'pr-12',
					className,
				)}
				{...props}
			>
				{children}
			</select>
			{/* Custom dropdown arrow */}
			<div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
				<svg
					className="h-5 w-5 text-gray-500 transition-colors duration-200"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M8 9l4-4 4 4m0 6l-4 4-4-4"
					/>
				</svg>
			</div>
			{/* Visual indicator that it's a dropdown */}
			<div className="absolute top-0 right-0 h-full w-12 bg-gradient-to-l from-gray-50 to-transparent rounded-r-lg pointer-events-none opacity-60" />
		</div>
	)
}

export { Select }

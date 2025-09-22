import { Fragment } from 'react'
import { Icon } from '#app/components/ui/icon.tsx'

interface DrawerProps {
  isOpen: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'fullscreen'
}

export function Drawer({ isOpen, onClose, title, children, size = 'md' }: DrawerProps) {
  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg', 
    lg: 'max-w-2xl',
    fullscreen: 'max-w-none',
  }

  if (!isOpen) return null

  // Removed unused wrapperPad and panelDims (previous layout refactor left them unused)

  return (
    <Fragment>
      {/* Invisible backdrop - only for click-to-close functionality */}
      <div 
        className="fixed inset-0 bg-transparent z-40"
        onClick={onClose}
      />
      
      {/* Drawer positioned on the right side */}
      <div className="fixed inset-0 overflow-hidden z-50 pointer-events-none">
        <div className="absolute inset-0 overflow-hidden">
          <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
            <div className={`pointer-events-auto w-screen ${sizeClasses[size]}`}>
              <div className="flex h-full flex-col bg-white shadow-2xl border-l border-gray-200">
                {/* Header */}
                <div className="bg-white px-4 py-6 sm:px-6 border-b border-gray-200">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
                    <button
                      type="button"
                      className="rounded-md bg-white text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 p-2"
                      onClick={onClose}
                    >
                      <span className="sr-only">Close panel</span>
                      <Icon name="cross-1" className="h-5 w-5" />
                    </button>
                  </div>
                </div>
                
                {/* Content */}
                <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 bg-white">
                  {children}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Fragment>
  )
}

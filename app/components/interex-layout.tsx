import { Outlet } from 'react-router'
import { InterexHeader } from '#app/components/interex-header.tsx'
import { type User } from '#app/utils/role-redirect.server.ts'

interface InterexLayoutProps {
  user: User
  children?: React.ReactNode
  title?: string
  subtitle?: string
  showBackButton?: boolean
  backTo?: string
  actions?: React.ReactNode
  currentPath?: string
}

export function InterexLayout({ 
  user, 
  children, 
  title, 
  subtitle, 
  showBackButton, 
  backTo, 
  actions, 
  currentPath 
}: InterexLayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <InterexHeader 
        user={user} 
        currentPath={currentPath}
        title={title}
        subtitle={subtitle}
        showBackButton={showBackButton}
        backTo={backTo}
        actions={actions}
      />
      <main>
        {children ?? <Outlet />}
      </main>
    </div>
  )
}

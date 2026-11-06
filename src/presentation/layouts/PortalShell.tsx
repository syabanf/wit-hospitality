import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAccess } from '../hooks/useAccess'
import { useServices } from '../hooks/useServices'
import { BrandMark } from '../ui/BrandMark'
import { Button } from '../ui/Button'
import { ThemeToggle } from '../ui/ThemeToggle'
import { useToast } from '../ui/useToast'
import { AccessProvider } from './AccessProvider'

const PORTAL_NAV = [
  { to: '/portal', label: 'Overview' },
  { to: '/portal/calendar', label: 'Calendar' },
  { to: '/portal/statements', label: 'Statements' },
  { to: '/portal/payouts', label: 'Payouts' },
  { to: '/portal/stays', label: 'My stays' },
  { to: '/portal/documents', label: 'Documents' },
]

/** The villa owner's portal: a top bar with the owner's pages, no console sidebar. Fits a phone. */
export function PortalShell() {
  return (
    <AccessProvider>
      <Portal />
    </AccessProvider>
  )
}

function Portal() {
  const { can, user } = useAccess()
  const { access } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const { pathname } = useLocation()
  if (!can('portal', 'view')) return <Navigate to="/" replace />
  const page = [...PORTAL_NAV].reverse().find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`))

  async function signOut() {
    await access.logout()
    toast({ title: 'Signed out' })
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-dvh bg-canvas pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] print:bg-white">
      <header className="border-b border-line bg-card print:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 md:px-6">
          <BrandMark className="size-7 shrink-0 text-fg" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold tracking-tight">
              Owner portal<span className="text-accent">.</span>
            </p>
            <p className="truncate text-xs text-muted">{user.name}</p>
          </div>
          <ThemeToggle />
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut aria-hidden className="size-4" />
          </Button>
        </div>
        <nav aria-label="Owner portal" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-3 md:px-6">
          {PORTAL_NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/portal'} className={({ isActive }) => cn('shrink-0 rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap', isActive ? 'bg-invert text-on-invert' : 'text-muted hover:bg-control hover:text-fg')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-5 md:px-6 print:p-0">
        <h1 className="mb-4 text-xl font-bold tracking-tight sm:text-2xl print:hidden">
          {page?.label ?? 'Owner portal'}
          <span className="text-accent">.</span>
        </h1>
        <div key={pathname} className="animate-rise">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

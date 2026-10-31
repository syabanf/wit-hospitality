import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { cn } from '@/lib/cn'
import { MOBILE_SCREENS } from '../features/mobile/screens'
import { AccessProvider } from './AccessProvider'
import { ViewSwitch } from './ViewSwitch'

/** Screens reached from the menu; the tab bar keeps six icons so it fits a phone. */
const MENU_ONLY = new Set(['/m/housekeeping', '/m/work-orders', '/m/payments'])

function TabBar() {
  return (
    <nav
      aria-label="App"
      className="fixed bottom-[max(env(safe-area-inset-bottom),1.25rem)] left-1/2 z-30 flex h-16 w-[min(100%-2.5rem,26rem)] -translate-x-1/2 items-center justify-between rounded-[22px] bg-ink/95 px-3 text-on-ink shadow-float ring-1 ring-white/5 backdrop-blur-md"
    >
      {MOBILE_SCREENS.filter((s) => !MENU_ONLY.has(s.to)).map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/m'}
          className={({ isActive }) =>
            cn('grid size-11 place-items-center rounded-2xl transition-colors', isActive ? 'bg-accent-strong text-white shadow-glow' : 'text-on-ink-muted hover:text-white')
          }
        >
          <Icon aria-hidden className="size-5" />
          <span className="sr-only">{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

/** The front-desk app: full width on a phone; on a wider screen one centred phone-width column on a grey backdrop, with the view switch in the corner. */
export function MobileShell() {
  const { pathname } = useLocation()
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' })
  }, [pathname])

  return (
    <AccessProvider>
      <div className="min-h-dvh bg-canvas md:bg-control">
        <div ref={top} />
        <div className="fixed top-4 right-4 z-30 hidden rounded-full shadow-card md:block">
          <ViewSwitch />
        </div>
        <div className="mx-auto min-h-dvh w-full max-w-md bg-canvas md:border-x md:border-line md:shadow-card">
          <Outlet />
        </div>
        <TabBar />
      </div>
    </AccessProvider>
  )
}

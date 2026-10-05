import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { cn } from '@/lib/cn'
import { MOBILE_SCREENS } from '../features/mobile/screens'

function TabBar() {
  return (
    <nav
      aria-label="App"
      className="fixed bottom-[max(env(safe-area-inset-bottom),1.25rem)] left-1/2 z-30 flex h-16 w-[min(100%-2.5rem,26rem)] -translate-x-1/2 items-center justify-between rounded-[22px] bg-ink/95 px-3 text-on-ink shadow-float ring-1 ring-white/5 backdrop-blur-md"
    >
      {MOBILE_SCREENS.map(({ to, label, icon: Icon }) => (
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

/** The front-desk app: full width on a phone, one centred column on a wider screen, no device frame. */
export function MobileShell() {
  const { pathname } = useLocation()
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' })
  }, [pathname])

  return (
    <div className="min-h-dvh bg-canvas">
      <div ref={top} />
      <div className="mx-auto w-full max-w-md">
        <Outlet />
      </div>
      <TabBar />
    </div>
  )
}

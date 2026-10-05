import { useEffect, useRef, useState, type Ref } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Bell, Menu } from 'lucide-react'
import type { BookingView, ServiceRequestView, TransactionView } from '@/application/views'
import { SERVICE_KIND_LABEL } from '@/domain/roomService'
import { shortDay, shortWeekday } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../hooks/useResource'
import { useServices } from '../hooks/useServices'
import { Dot, type Tone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { menuItem, Popover } from '../ui/Popover'
import { locate } from './dashboard/nav'
import { Sidebar, SidebarContent } from './dashboard/Sidebar'

const COLLAPSE_KEY = 'wit-sidebar'

/** Stored choice first; without one the sidebar starts open from 1280 px and collapsed below. */
function initialCollapsed() {
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY)
    if (saved) return saved === 'collapsed'
  } catch {
    // Storage blocked: fall back to the width rule.
  }
  return window.innerWidth < 1280
}

interface Attention {
  arrivals: readonly BookingView[]
  late: readonly BookingView[]
  departures: readonly BookingView[]
  pending: readonly TransactionView[]
  requests: readonly ServiceRequestView[]
}

function Notifications({ attention }: { attention?: Attention }) {
  const items: Array<{ key: string; to: string; tone: Tone; text: string; value: string }> = attention
    ? [
        ...attention.late.map((b) => ({ key: b.id, to: `/bookings/${b.id}`, tone: 'accent' as Tone, text: `${b.guestName} has not arrived · ${b.unitCode}`, value: b.code })),
        ...attention.arrivals.map((b) => ({ key: b.id, to: `/bookings/${b.id}`, tone: 'info' as Tone, text: `${b.guestName} arrives · ${b.unitCode}`, value: b.code })),
        ...attention.departures.map((b) => ({ key: b.id, to: `/bookings/${b.id}`, tone: 'neutral' as Tone, text: `${b.guestName} leaves · ${b.unitCode}`, value: b.code })),
        ...attention.requests.filter((r) => r.priority === 'urgent').map((r) => ({ key: r.id, to: `/services/${r.id}`, tone: 'accent' as Tone, text: `${r.unitCode} · ${SERVICE_KIND_LABEL[r.kind]} · urgent`, value: r.number })),
        ...attention.pending.map((t) => ({ key: t.id, to: `/finance/transactions/${t.id}`, tone: 'warning' as Tone, text: `${t.description}`, value: money(t.amount) })),
      ]
    : []
  const urgent = (attention?.late.length ?? 0) + (attention?.pending.length ?? 0) + (attention?.requests.filter((r) => r.priority === 'urgent').length ?? 0)
  return (
    <Popover
      trigger={(props) => (
        <Button {...props} variant="card" size="icon-lg" aria-label={`Needs attention, ${items.length} items`} className="relative">
          <Bell aria-hidden className="size-5" />
          {urgent > 0 && <Dot tone="accent" className="absolute top-3 right-3.5 ring-2 ring-card" />}
        </Button>
      )}
      className="w-80"
    >
      {(close) => (
        <div>
          <p className="px-3 pt-1 pb-2 text-xs font-semibold tracking-wider text-muted uppercase">Needs attention</p>
          {items.length === 0 && <p className="px-3 pb-2 text-sm text-body">Nothing waits for you today.</p>}
          {items.slice(0, 6).map((item) => (
            <Link key={item.key} to={item.to} onClick={close} className={menuItem}>
              <Dot tone={item.tone} />
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <span className="shrink-0 text-xs font-medium text-fg tabular">{item.value}</span>
            </Link>
          ))}
          {items.length > 6 && (
            <Link to="/?view=operational" onClick={close} className={menuItem}>
              See all {items.length} on the operational dashboard
            </Link>
          )}
        </div>
      )}
    </Popover>
  )
}

/** Breadcrumb over the page title, the date, and the bell. Phones get the menu button. */
function Header({ attention, onMenu, menuRef }: { attention?: Attention; onMenu: () => void; menuRef: Ref<HTMLButtonElement> }) {
  const { pathname } = useLocation()
  const { clock } = useServices()
  const place = locate(pathname)
  const today = clock.today()

  return (
    <header className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-4 md:px-6 lg:px-8 lg:pt-6">
      <Button ref={menuRef} variant="card" size="icon-lg" className="md:hidden" aria-label="Open menu" onClick={onMenu}>
        <Menu aria-hidden className="size-5" />
      </Button>
      <div className="min-w-0 flex-1">
        {place && (
          <nav aria-label="Breadcrumb">
            <ol className="flex items-center gap-1.5 text-xs text-muted">
              <li>{place.section}</li>
              <li aria-hidden>/</li>
              <li>
                {place.detail ? (
                  <Link to={place.page.to} className="hover:text-fg hover:underline">
                    {place.page.label}
                  </Link>
                ) : (
                  <span aria-current="page">{place.page.label}</span>
                )}
              </li>
              {place.detail && (
                <>
                  <li aria-hidden>/</li>
                  <li aria-current="page">{place.detail}</li>
                </>
              )}
            </ol>
          </nav>
        )}
        <h1 className="truncate text-2xl font-bold tracking-tight md:text-[28px]">
          {place?.detail && place.detail !== 'Details' ? place.detail : (place?.page.label ?? 'Not found')}
          <span className="text-accent">.</span>
        </h1>
      </div>
      <span className="hidden h-10 items-center rounded-full border border-line bg-card px-4 text-xs font-medium text-muted shadow-card sm:inline-flex">
        {shortWeekday(today)}, {shortDay(today)}
      </span>
      <Notifications attention={attention} />
    </header>
  )
}

/**
 * Desktop console: an attached white sidebar (collapsible to icons), a breadcrumb header and a
 * scrolling `main`. Phones open the same sidebar as a drawer from the menu button.
 */
export function DashboardShell() {
  const { pathname } = useLocation()
  const { dashboard, account } = useServices()
  const attention = useResource(`dashboard.attention:${pathname}`, () => dashboard.attention())
  const profile = useResource('account.profile', () => account.profile())
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [drawer, setDrawer] = useState(false)
  const main = useRef<HTMLElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)

  // Block body on purpose: newer browsers return a Promise from scrollTo, and an effect may only return a cleanup.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 })
  }, [pathname])

  useEffect(() => {
    if (!drawer) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeDrawer()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])

  function closeDrawer() {
    setDrawer(false)
    menuButton.current?.focus()
  }

  function toggle() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? 'open' : 'collapsed')
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
      return !c
    })
  }

  const a = attention.data
  const shared = {
    counts: { arrivals: (a?.arrivals.length ?? 0) + (a?.late.length ?? 0), pending: a?.pending.length ?? 0, requests: a?.requests.length ?? 0 },
    profile: profile.data,
  }

  return (
    <div className="flex h-dvh bg-canvas">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-invert px-4 py-2 text-on-invert focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} {...shared} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header attention={a} onMenu={() => setDrawer(true)} menuRef={menuButton} />
        <main id="main" ref={main} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 outline-none md:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
      {drawer && (
        <div role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-50 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 animate-fade bg-ink/40" onClick={closeDrawer} />
          <div ref={panel} tabIndex={-1} className="absolute inset-y-0 left-0 w-[86%] max-w-xs animate-slide-in bg-card shadow-float outline-none">
            <SidebarContent collapsed={false} onNavigate={() => setDrawer(false)} onClose={closeDrawer} {...shared} />
          </div>
        </div>
      )}
    </div>
  )
}

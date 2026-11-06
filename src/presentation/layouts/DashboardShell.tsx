import { useEffect, useRef, useState, type Ref } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Bell, Menu, Smartphone, X } from 'lucide-react'
import type { BookingView, HousekeepingRow, ServiceOrderView, ServiceRequestView, TransactionView, WorkOrderView } from '@/application/views'
import type { LowStockRow } from '@/application/stock'
import type { CashAccount, TransactionStatus } from '@/domain/finance'
import { SERVICE_KIND_LABEL } from '@/domain/roomService'
import { shortDay, shortWeekday } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../hooks/useAccess'
import { useResource } from '../hooks/useResource'
import { useServices } from '../hooks/useServices'
import { AccessProvider } from './AccessProvider'
import { Dot, type Tone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { menuItem, Popover } from '../ui/Popover'
import { locate } from './dashboard/nav'
import { Sidebar, SidebarContent } from './dashboard/Sidebar'
import { ViewSwitch } from './ViewSwitch'
import { counterpart, savedView, saveView } from './viewMode'

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
  mine: readonly TransactionView[]
  journals: ReadonlyArray<{ id: string; memo: string; status: TransactionStatus; amount: number }>
  requests: readonly ServiceRequestView[]
  orders: readonly ServiceOrderView[]
  hrPending: number
  urgentJobs: readonly WorkOrderView[]
  notReady: readonly HousekeepingRow[]
  toAssign: readonly BookingView[]
  lowPetty: ReadonlyArray<{ account: CashAccount; balance: number }>
  lowStock: readonly LowStockRow[]
}

function Notifications({ attention }: { attention?: Attention }) {
  const items: Array<{ key: string; to: string; tone: Tone; text: string; value: string }> = attention
    ? [
        ...attention.late.map((b) => ({ key: b.id, to: `/bookings/${b.id}`, tone: 'accent' as Tone, text: `${b.guestName} has not arrived · ${b.unitCode}`, value: b.code })),
        ...attention.arrivals.map((b) => ({ key: b.id, to: `/bookings/${b.id}`, tone: 'info' as Tone, text: `${b.guestName} arrives · ${b.unitCode}`, value: b.code })),
        ...attention.departures.map((b) => ({ key: b.id, to: `/bookings/${b.id}`, tone: 'neutral' as Tone, text: `${b.guestName} leaves · ${b.unitCode}`, value: b.code })),
        ...attention.requests.filter((r) => r.priority === 'urgent').map((r) => ({ key: r.id, to: `/services/${r.id}`, tone: 'accent' as Tone, text: `${r.unitCode} · ${SERVICE_KIND_LABEL[r.kind]} · urgent`, value: r.number })),
        ...attention.orders.map((o) => ({ key: o.id, to: `/services/orders/${o.id}`, tone: (o.late ? 'accent' : 'info') as Tone, text: `${o.unitCode} · ${o.late ? 'room service running late' : 'new room service order'}`, value: o.number })),
        ...attention.toAssign.map((b) => ({ key: `as-${b.id}`, to: `/bookings/${b.id}`, tone: 'warning' as Tone, text: `Assign a room · ${b.roomType ?? 'room type'}, ${b.guestName} arrives ${shortDay(b.checkIn)}`, value: b.code })),
        ...attention.lowPetty.map((p) => ({ key: `pc-${p.account.id}`, to: `/finance/accounts/${p.account.id}`, tone: 'warning' as Tone, text: `${p.account.name} is low, top it up`, value: money(p.balance) })),
        ...attention.lowStock.map((l) => ({ key: `st-${l.villaId}-${l.item.id}`, to: `/stock?villa=${l.villaId}`, tone: 'warning' as Tone, text: `${l.item.name} low at ${l.villaName}, reorder`, value: `${l.onHand} left` })),
        ...attention.notReady.map((r) => ({ key: `hk-${r.place.unit.id}`, to: '/housekeeping?arrivals=1', tone: 'accent' as Tone, text: `${r.place.unit.code} not ready, ${r.arrival?.guestName ?? 'guest'} arrives`, value: r.state.replace('_', ' ') })),
        ...attention.urgentJobs.map((wo) => ({ key: wo.id, to: `/maintenance/work-orders/${wo.id}`, tone: 'accent' as Tone, text: `${wo.unitCode || wo.villaName} · ${wo.title}`, value: wo.number })),
        ...attention.mine.map((t) => ({ key: t.id, to: `/finance/transactions/${t.id}`, tone: 'warning' as Tone, text: `${t.status === 'approved' ? 'Post' : 'Sign'} ${t.description}`, value: money(t.amount) })),
        ...attention.journals.map((j) => ({ key: j.id, to: `/accounting/manual/${j.id}`, tone: 'warning' as Tone, text: `${j.status === 'approved' ? 'Post' : 'Sign'} journal: ${j.memo}`, value: money(j.amount) })),
        ...(attention.hrPending > 0 ? [{ key: 'hr', to: '/hr', tone: 'info' as Tone, text: `${attention.hrPending} HR requests wait for a decision`, value: String(attention.hrPending) }] : []),
      ]
    : []
  const urgent = (attention?.late.length ?? 0) + (attention?.notReady.length ?? 0) + (attention?.urgentJobs.length ?? 0) + (attention?.mine.length ?? 0) + (attention?.journals.length ?? 0) + (attention?.requests.filter((r) => r.priority === 'urgent').length ?? 0)
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
    <header className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-4 md:px-6 lg:px-8 lg:pt-6 print:hidden">
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
                  <Link to={place.page.to} className="hover:text-fg hover:underline pointer-coarse:-my-3 pointer-coarse:inline-block pointer-coarse:py-3">
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
        <h1 className="line-clamp-2 text-xl leading-tight font-bold tracking-tight break-words sm:text-2xl md:line-clamp-1 md:text-[28px]">
          {place?.detail && place.detail !== 'Details' ? place.detail : (place?.page.label ?? 'Not found')}
          <span className="text-accent">.</span>
        </h1>
      </div>
      <div className="hidden md:block">
        <ViewSwitch />
      </div>
      <span className="hidden h-10 items-center rounded-full border border-line bg-card px-4 text-xs font-medium text-muted shadow-card lg:inline-flex">
        {shortWeekday(today)}, {shortDay(today)}
      </span>
      <Notifications attention={attention} />
    </header>
  )
}

/** A phone opening the console without a saved choice is offered the phone app, never sent there. */
function PhoneOffer() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(() => savedView() === null && window.innerWidth < 768 && window.matchMedia('(pointer: coarse)').matches)
  if (!open) return null
  const stay = () => {
    saveView('desktop')
    setOpen(false)
  }
  return (
    <div role="region" aria-label="Phone app" className="mb-4 flex items-center gap-3 rounded-card bg-invert p-3 pl-4 text-on-invert shadow-card print:hidden">
      <Smartphone aria-hidden className="size-5 shrink-0" />
      <p className="min-w-0 flex-1 text-sm">On a phone? The front desk app fits this screen.</p>
      <Link to={counterpart(pathname, 'mobile')} onClick={() => saveView('mobile')} className="shrink-0 rounded-full bg-accent-strong px-3 py-2 text-sm font-medium text-white">
        Open
      </Link>
      <button type="button" aria-label="Stay on the desktop view" onClick={stay} className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-on-invert/70 hover:text-on-invert">
        <X aria-hidden className="size-4" />
      </button>
    </div>
  )
}

/**
 * Desktop console: an attached white sidebar (collapsible to icons), a breadcrumb header and a
 * scrolling `main`. Phones open the same sidebar as a drawer from the menu button.
 */
export function DashboardShell() {
  return (
    <AccessProvider>
      <Shell />
    </AccessProvider>
  )
}

function Shell() {
  const { pathname } = useLocation()
  const { dashboard, account } = useServices()
  const { user } = useAccess()
  const attention = useResource(`dashboard.attention:${pathname}:${user.id}`, () => dashboard.attention())
  const profile = useResource(`account.profile:${user.id}`, () => account.profile())
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
    counts: { arrivals: (a?.arrivals.length ?? 0) + (a?.late.length ?? 0), pending: (a?.mine.length ?? 0) + (a?.journals.length ?? 0), requests: a?.requests.length ?? 0, orders: a?.orders.length ?? 0, hr: a?.hrPending ?? 0, maintenance: a?.urgentJobs.length ?? 0 },
    profile: profile.data,
  }

  return (
    <div className="flex h-dvh bg-canvas pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] print:block print:h-auto print:bg-white">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-invert px-4 py-2 text-on-invert focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} {...shared} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header attention={a} onMenu={() => setDrawer(true)} menuRef={menuButton} />
        <main id="main" ref={main} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 outline-none md:px-6 lg:px-8 print:overflow-visible print:p-0">
          <PhoneOffer />
          <div key={pathname} className="animate-rise">
            <Outlet />
          </div>
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

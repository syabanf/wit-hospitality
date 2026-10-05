import { type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowRight, Check, ChevronsLeft, ChevronsRight, ChevronsUpDown, LogOut, Moon, Search, Smartphone, X } from 'lucide-react'
import { ROLE_LABEL, type Profile } from '@/domain/account'
import { cn } from '@/lib/cn'
import { useTheme } from '../../hooks/useTheme'
import { Avatar } from '../../ui/Avatar'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Input } from '../../ui/Field'
import { menuItem, Popover } from '../../ui/Popover'
import { POP } from '../../ui/pop'
import { Switch } from '../../ui/Switch'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/useToast'
import { isActivePath, NAV_SECTIONS, SETTINGS_ITEM, type NavCount, type NavItem } from './nav'

interface SidebarProps {
  /** Icon-only column. The drawer on phones is never collapsed. */
  collapsed: boolean
  counts: Record<NavCount, number>
  profile?: Profile
  /** Called after any navigation, so the phone drawer can close. */
  onNavigate?: () => void
  onClose?: () => void
}

function SideLink({ item, collapsed, count = 0, onNavigate }: { item: NavItem; collapsed: boolean; count?: number; onNavigate?: () => void }) {
  const Icon = item.icon
  const { pathname } = useLocation()
  const active = isActivePath(item, pathname)
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={cn(
        'relative flex h-10 items-center gap-3 rounded-xl text-sm font-medium transition-colors',
        collapsed ? 'justify-center' : 'px-3',
        active ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-raised hover:text-fg',
      )}
    >
      {active && <span aria-hidden className="absolute top-2 bottom-2 -left-3 w-1 rounded-r-full bg-accent" />}
      <Icon aria-hidden className="size-[18px] shrink-0" />
      {collapsed ? <span className="sr-only">{item.label}</span> : <span className="flex-1 truncate">{item.label}</span>}
      {count > 0 &&
        (collapsed ? (
          <span aria-hidden className="absolute top-2 right-2.5 size-2 rounded-full bg-accent ring-2 ring-card" />
        ) : (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent-strong px-1.5 text-[11px] font-semibold text-white tabular">{count}</span>
        ))}
      {count > 0 && <span className="sr-only">, {count} {item.countLabel}</span>}
    </Link>
  )
}

function WorkspaceSwitcher({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const tile = <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-sm font-bold', POP.red)}>B</span>
  return (
    <Popover
      align="left"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label="Switch workspace"
          className={cn(
            'flex w-full cursor-pointer items-center gap-3 rounded-2xl text-left transition-colors hover:bg-control',
            collapsed ? 'justify-center p-1.5' : 'border border-line bg-raised p-2',
          )}
        >
          {tile}
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-semibold">Bali Villas</span>
                <span className="block truncate text-xs text-muted">Operations console</span>
              </span>
              <ChevronsUpDown aria-hidden className="size-4 text-muted" />
            </>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <p className="px-3 pt-1 pb-2 text-[11px] font-semibold tracking-wider text-subtle uppercase">Workspaces</p>
          <Link to="/" onClick={() => { close(); onNavigate?.() }} className={menuItem}>
            <span className="flex-1">Operations console</span>
            <Check aria-hidden className="size-4 text-accent-text" />
          </Link>
          <Link to="/m" onClick={() => { close(); onNavigate?.() }} className={menuItem}>
            <span className="flex-1">Front desk phone app</span>
          </Link>
        </div>
      )}
    </Popover>
  )
}

function ThemeRow({ collapsed }: { collapsed: boolean }) {
  const [theme, setTheme] = useTheme()
  if (collapsed) {
    return (
      <div className="flex justify-center">
        <ThemeToggle variant="ghost" size="icon" />
      </div>
    )
  }
  return (
    <div className="flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted">
      <Moon aria-hidden className="size-[18px]" />
      <span className="flex-1">Dark theme</span>
      <Switch label="Dark theme" checked={theme === 'dark'} onChange={(on) => setTheme(on ? 'dark' : 'light')} />
    </div>
  )
}

/** v2 sidebar: a white panel attached to the left edge with labelled, grouped links. */
export function SidebarContent({ collapsed, counts, profile, onNavigate, onClose }: SidebarProps) {
  const navigate = useNavigate()
  const toast = useToast()

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim()
    navigate(q ? `/bookings?q=${encodeURIComponent(q)}` : '/bookings')
    onNavigate?.()
  }

  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex h-16 shrink-0 items-center gap-2.5', collapsed ? 'justify-center' : 'px-5')}>
        <Link to="/" onClick={onNavigate} aria-label="Villa Console, dashboard" className="flex items-center gap-2.5">
          <BrandMark className="size-7 text-fg" />
          {!collapsed && (
            <span className="text-base font-bold tracking-tight">
              Villa Console<span className="text-accent">.</span>
            </span>
          )}
        </Link>
        {onClose && (
          <Button variant="ghost" size="icon" aria-label="Close menu" className="ml-auto" onClick={onClose}>
            <X aria-hidden className="size-5" />
          </Button>
        )}
      </div>

      <div className="space-y-3 px-3">
        <WorkspaceSwitcher collapsed={collapsed} onNavigate={onNavigate} />
        {collapsed ? (
          <div className="flex justify-center">
            <Link to="/bookings" onClick={onNavigate} title="Search bookings" aria-label="Search bookings" className={buttonStyles({ variant: 'ghost', size: 'icon' })}>
              <Search aria-hidden className="size-[18px]" />
            </Link>
          </div>
        ) : (
          <form role="search" onSubmit={onSearch}>
            <Input name="q" className="h-10" icon={<Search className="size-4" />} placeholder="Guest, code or unit" aria-label="Search bookings" />
          </form>
        )}
      </div>

      <nav aria-label="Main" className="no-scrollbar mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {NAV_SECTIONS.map((section, i) => (
          <div key={section.label}>
            {collapsed ? (
              i > 0 && <hr className="mx-2 mb-4 border-line" />
            ) : (
              <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">{section.label}</p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <SideLink item={item} collapsed={collapsed} count={item.count ? counts[item.count] : 0} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!collapsed && (
          <div className={cn('rounded-2xl p-4', POP.blue)}>
            <Smartphone aria-hidden className="size-5" />
            <p className="mt-3 text-sm font-semibold">Front desk on the phone</p>
            <p className="mt-0.5 text-xs opacity-70">Arrivals, check-ins and the cashbox from the villa.</p>
            <Link to="/m" onClick={onNavigate} className={buttonStyles({ variant: 'ink', size: 'sm', className: 'mt-3' })}>
              Open the app <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </div>
        )}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-line px-3 pt-3 pb-4">
        <SideLink item={SETTINGS_ITEM} collapsed={collapsed} onNavigate={onNavigate} />
        <ThemeRow collapsed={collapsed} />
        <div className={cn('mt-2 flex items-center gap-3 pt-1', collapsed && 'justify-center')}>
          {profile ? (
            <Link to="/settings" onClick={onNavigate} title={collapsed ? profile.name : undefined} className="shrink-0 rounded-full">
              <Avatar name={profile.name} />
            </Link>
          ) : (
            <span className="size-10 shrink-0 animate-pulse rounded-full bg-raised" />
          )}
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-semibold">{profile?.name ?? ' '}</p>
                <p className="truncate text-xs text-muted">{profile ? ROLE_LABEL[profile.role] : ' '}</p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => toast({ title: 'Signed out', description: 'This demo has no session, so you stay on the page.' })}
              >
                <LogOut aria-hidden className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Desktop and tablet: the attached panel with its collapse handle on the right edge. */
export function Sidebar({ collapsed, onToggle, ...props }: Omit<SidebarProps, 'onClose' | 'onNavigate'> & { onToggle: () => void }) {
  return (
    <aside className={cn('relative hidden shrink-0 border-r border-line bg-card transition-[width] duration-200 md:block', collapsed ? 'w-[72px]' : 'w-64')}>
      <SidebarContent collapsed={collapsed} {...props} />
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        className="absolute top-[76px] -right-3.5 z-10 grid size-7 cursor-pointer place-items-center rounded-full border border-line bg-card text-muted shadow-card transition-colors hover:text-fg"
      >
        {collapsed ? <ChevronsRight aria-hidden className="size-4" /> : <ChevronsLeft aria-hidden className="size-4" />}
      </button>
    </aside>
  )
}

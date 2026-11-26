import { useResource } from '../../hooks/useResource'
import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowRight, BriefcaseBusiness, Check, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown, LogOut, Moon, Search, Smartphone, UserRound, X } from 'lucide-react'
import { ROLE_LABEL, type Profile } from '@/domain/account'
import { cn } from '@/lib/cn'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
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
import { ViewSwitch } from '../ViewSwitch'
import { areaOfPath, EMPLOYEE_SECTION, isActivePath, locate, NAV_AREA_LABEL, NAV_AREAS, NAV_SECTIONS, SETTINGS_ITEM, type NavArea, type NavCount, type NavItem, type NavSection } from './nav'

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
  const tile = <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-sm font-bold', POP.red)}>W</span>
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
                <span className="block truncate text-sm font-semibold">WIT Hospitality</span>
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

/**
 * The menu on show. It follows the page that is open; a tab the user picks holds until they open a
 * page in the other area.
 */
function useNavArea(pathname: string): [NavArea, (area: NavArea) => void] {
  const pathArea = areaOfPath(pathname)
  const [area, setArea] = useState(pathArea)
  const [seen, setSeen] = useState(pathArea)
  if (seen !== pathArea) {
    setSeen(pathArea)
    setArea(pathArea)
  }
  return [area, setArea]
}

/** The Back office / Employee switch above the menu. */
function AreaTabs({ area, onChange }: { area: NavArea; onChange: (area: NavArea) => void }) {
  return (
    <div role="tablist" aria-label="Menu area" className="flex rounded-full bg-raised p-1">
      {NAV_AREAS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={key === area}
          onClick={() => onChange(key)}
          className={cn(
            'h-8 min-w-0 flex-1 cursor-pointer truncate rounded-full px-2 text-[13px] font-semibold transition-colors',
            key === area ? 'bg-invert text-on-invert' : 'text-muted hover:text-fg',
          )}
        >
          {NAV_AREA_LABEL[key]}
        </button>
      ))}
    </div>
  )
}

/** One section of the menu: a header that folds its links, or the bare links when the section is flat. */
function NavGroup({ section, open, onToggle, counts, onNavigate }: { section: NavSection; open: boolean; onToggle: () => void; counts: Record<NavCount, number>; onNavigate?: () => void }) {
  const links = (
    <ul className="space-y-0.5">
      {section.items.map((item) => (
        <li key={item.to}>
          <SideLink item={item} collapsed={false} count={item.count ? counts[item.count] : 0} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  )
  if (section.flat) return links
  const Icon = section.icon
  const total = section.items.reduce((sum, item) => sum + (item.count ? counts[item.count] : 0), 0)
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn('flex h-10 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors hover:bg-raised', open ? 'text-fg' : 'text-muted hover:text-fg')}
      >
        <Icon aria-hidden className="size-[18px] shrink-0" />
        <span className="flex-1 truncate text-left">{section.label}</span>
        {!open && total > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent-strong px-1.5 text-[11px] font-semibold text-white tabular">{total}</span>}
        <ChevronRight aria-hidden className={cn('size-4 opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-0.5 mb-1 ml-[21px] border-l border-line pl-3">{links}</div>}
    </div>
  )
}

/** v2 sidebar: a white panel attached to the left edge with labelled, grouped links. */
export function SidebarContent({ collapsed, counts, profile, onNavigate, onClose }: SidebarProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const { access, desk } = useServices()
  const { can } = useAccess()
  const { pathname } = useLocation()
  const hasHotel = useResource('desk.hasHotel', () => desk.hasHotel()).data ?? false
  const visible = (sections: readonly NavSection[]) => sections.map((s) => ({ ...s, items: s.items.filter((item) => can(item.module, 'view') && (!item.hotelOnly || hasHotel)) })).filter((s) => s.items.length > 0)
  const areas: Record<NavArea, NavSection[]> = { backoffice: visible(NAV_SECTIONS), employee: visible([EMPLOYEE_SECTION]) }
  // The tabs show only when both areas hold a menu; without a back office the employee area stands alone.
  const bothAreas = areas.backoffice.length > 0 && areas.employee.length > 0
  const [picked, setArea] = useNavArea(pathname)
  const area: NavArea = bothAreas ? picked : areas.backoffice.length > 0 ? 'backoffice' : 'employee'
  const other: NavArea = area === 'backoffice' ? 'employee' : 'backoffice'
  const sections = areas[area]
  // The group of the open page unfolds by itself; a group the user folded stays folded until they open another page.
  const activeGroup = locate(pathname)?.section ?? ''
  const [openGroups, setOpenGroups] = useState<readonly string[]>([activeGroup])
  const [seenGroup, setSeenGroup] = useState(activeGroup)
  if (seenGroup !== activeGroup) {
    setSeenGroup(activeGroup)
    setOpenGroups((open) => (open.includes(activeGroup) ? open : [...open, activeGroup]))
  }
  const [searching, setSearching] = useState(false)
  const toggleGroup = (label: string) => setOpenGroups((open) => (open.includes(label) ? open.filter((l) => l !== label) : [...open, label]))

  async function signOut() {
    await access.logout()
    toast({ title: 'Signed out' })
    navigate('/login', { replace: true })
  }

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
          <>
            {bothAreas && (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <AreaTabs area={area} onChange={setArea} />
                </div>
                <Button variant="soft" size="icon" aria-label="Search bookings" aria-expanded={searching} title="Search bookings" onClick={() => setSearching((on) => !on)}>
                  <Search aria-hidden className="size-[18px]" />
                </Button>
              </div>
            )}
            {(searching || !bothAreas) && (
              <form role="search" onSubmit={onSearch}>
                <Input name="q" autoFocus={bothAreas} className="h-10" icon={<Search className="size-4" />} placeholder="Guest, code or unit" aria-label="Search bookings" />
              </form>
            )}
          </>
        )}
        {collapsed && bothAreas && (
          <div className="flex justify-center">
            <Button variant="ghost" size="icon" title={`Switch to ${NAV_AREA_LABEL[other]}`} aria-label={`Switch to ${NAV_AREA_LABEL[other]}`} onClick={() => setArea(other)}>
              {area === 'backoffice' ? <BriefcaseBusiness aria-hidden className="size-[18px]" /> : <UserRound aria-hidden className="size-[18px]" />}
            </Button>
          </div>
        )}
      </div>

      <nav aria-label="Main" className="no-scrollbar mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {sections.map((section, i) =>
          collapsed ? (
            <div key={section.label}>
              {i > 0 && <hr className="mx-2 my-3 border-line" />}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <SideLink item={item} collapsed count={item.count ? counts[item.count] : 0} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div key={section.label}>
              {section.heading && section.heading !== sections[i - 1]?.heading && <p className="px-3 pt-4 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">{section.heading}</p>}
              <NavGroup section={section} open={openGroups.includes(section.label)} onToggle={() => toggleGroup(section.label)} counts={counts} onNavigate={onNavigate} />
            </div>
          ),
        )}
        {!collapsed && area === 'backoffice' && (
          <div className={cn('mt-3 rounded-2xl p-4', POP.blue)}>
            <Smartphone aria-hidden className="size-5" />
            <p className="mt-3 text-sm font-semibold">Front desk on the phone</p>
            <p className="mt-0.5 text-xs opacity-70">Arrivals, check-ins and the cashbox from the villa.</p>
            <Link to="/m" onClick={onNavigate} className={buttonStyles({ variant: 'ink', size: 'sm', className: 'mt-3' })}>
              Open the app <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </div>
        )}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-line px-3 pt-3 pb-[max(env(safe-area-inset-bottom),1rem)]">
        {onClose && (
          <div className="mb-2">
            <ViewSwitch full onSwitch={onNavigate} />
          </div>
        )}
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
                onClick={() => void signOut()}
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
    <aside className={cn('relative hidden shrink-0 border-r border-line bg-card transition-[width] duration-200 md:block print:hidden', collapsed ? 'w-[72px]' : 'w-64')}>
      <SidebarContent collapsed={collapsed} {...props} />
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        className="absolute top-[76px] -right-3.5 z-10 grid size-7 pointer-coarse:top-[72px] pointer-coarse:-right-5 pointer-coarse:size-10 cursor-pointer place-items-center rounded-full border border-line bg-card text-muted shadow-card transition-colors hover:text-fg"
      >
        {collapsed ? <ChevronsRight aria-hidden className="size-4" /> : <ChevronsLeft aria-hidden className="size-4" />}
      </button>
    </aside>
  )
}

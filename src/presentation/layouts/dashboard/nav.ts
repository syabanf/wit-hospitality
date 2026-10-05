import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BedDouble, Building2, CalendarDays, ConciergeBell, Database, DoorOpen, Globe, House, LayoutList, MapPin, Settings, ShieldCheck, Smartphone, Tags, Users, Wallet, type LucideIcon } from 'lucide-react'

export type NavCount = 'arrivals' | 'pending' | 'requests'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Which live count to show beside the item. */
  count?: NavCount
  countLabel?: string
}

/** The sidebar, top to bottom. Section labels double as the first breadcrumb. */
export const NAV_SECTIONS: ReadonlyArray<{ label: string; items: readonly NavItem[] }> = [
  { label: 'Workspace', items: [{ to: '/', label: 'Dashboard', icon: House }] },
  {
    label: 'Operations',
    items: [
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/bookings', label: 'Bookings', icon: BedDouble, count: 'arrivals', countLabel: 'arriving today' },
      { to: '/guests', label: 'Guests', icon: Users },
      { to: '/services', label: 'Room services', icon: ConciergeBell, count: 'requests', countLabel: 'open requests' },
    ],
  },
  {
    label: 'Property',
    items: [
      { to: '/property', label: 'Property', icon: Building2 },
      { to: '/airbnb', label: 'Airbnb', icon: Globe },
    ],
  },
  {
    label: 'Master data',
    items: [
      { to: '/master', label: 'Overview', icon: Database },
      { to: '/master/locations', label: 'Locations', icon: MapPin },
      { to: '/master/villas', label: 'Villas', icon: Building2 },
      { to: '/master/room-types', label: 'Room types', icon: LayoutList },
      { to: '/master/units', label: 'Units', icon: DoorOpen },
      { to: '/master/airbnb-accounts', label: 'Airbnb accounts', icon: Globe },
      { to: '/master/listings', label: 'Listings', icon: Globe },
      { to: '/master/cash-accounts', label: 'Cash accounts', icon: Wallet },
      { to: '/master/categories', label: 'Categories', icon: Tags },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/finance', label: 'Cashbox', icon: Wallet },
      { to: '/finance/cash-in', label: 'Cash in', icon: ArrowDownLeft },
      { to: '/finance/cash-out', label: 'Cash out', icon: ArrowUpRight },
      { to: '/finance/approvals', label: 'Approvals', icon: ShieldCheck, count: 'pending', countLabel: 'awaiting approval' },
      { to: '/finance/transactions', label: 'All transactions', icon: ArrowLeftRight },
      { to: '/finance/categories', label: 'Categories', icon: Tags },
    ],
  },
  { label: 'Apps', items: [{ to: '/m', label: 'Front desk app', icon: Smartphone }] },
]

export const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: Settings }

const ALL = [...NAV_SECTIONS.flatMap((s) => s.items.map((item) => ({ section: s.label, item }))), { section: 'Account', item: SETTINGS_ITEM }]

const DETAIL_LABEL: Record<string, string> = {
  '/property/new': 'New property',
  '/bookings/new': 'New booking',
  '/finance/transactions/new': 'New entry',
}

/** Section, page and the detail label below it (a record, a form), for the header breadcrumb. */
export function locate(pathname: string) {
  const matches = ALL.filter(({ item }) => (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)))
  const match = matches.sort((a, b) => b.item.to.length - a.item.to.length)[0]
  if (!match) return null
  const detail = pathname === match.item.to ? null : (DETAIL_LABEL[pathname] ?? 'Details')
  return { section: match.section, page: match.item, detail }
}

/** Whether a nav item is the active one; longer paths win, so Cashbox is not lit on Transactions. */
export const isActivePath = (item: NavItem, pathname: string) => locate(pathname)?.page.to === item.to

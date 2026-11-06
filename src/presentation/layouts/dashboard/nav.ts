import { CalendarClock, ClipboardList, HardHat, Hourglass, Package, ReceiptText, SlidersHorizontal, Sparkles, Wrench } from 'lucide-react'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, BedDouble, Building2, CalendarCheck, CalendarDays, ClipboardCheck, Clock, ConciergeBell, Database, DoorOpen, FileBarChart, Globe, HandCoins, House, KeyRound, LayoutList, ListChecks, MapPin, Megaphone, ScrollText, Settings, ShieldCheck, Smartphone, Tags, Target, UserRound, Users, UsersRound, Wallet, type LucideIcon } from 'lucide-react'
import { Boxes, MoonStar } from 'lucide-react'
import { BookOpen, Coins, FileText as StatementIcon, TrendingUp, UtensilsCrossed } from 'lucide-react'
import { BookOpenCheck, CalendarX2, FilePen, Hash, ListTree, NotebookTabs, Percent, Scale, Sheet } from 'lucide-react'
import { Calculator, ChartColumnIncreasing } from 'lucide-react'
import { ClipboardCheck as CheckInIcon, MessagesSquare } from 'lucide-react'
import type { Module } from '@/domain/access'

export type NavCount = 'arrivals' | 'pending' | 'requests' | 'orders' | 'hr' | 'maintenance'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** The module the item belongs to; it hides when the role cannot view that module. */
  module: Module
  /** Which live count to show beside the item. */
  count?: NavCount
  countLabel?: string
}

/** The sidebar, top to bottom. Section labels double as the first breadcrumb. */
export const NAV_SECTIONS: ReadonlyArray<{ label: string; items: readonly NavItem[] }> = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Dashboard', icon: House, module: 'dashboard' },
      { to: '/me', label: 'My area', icon: UserRound, module: 'me' },
      { to: '/guide', label: 'Guide', icon: BookOpen, module: 'dashboard' },
    ],
  },
  {
    label: 'Owner',
    items: [
      { to: '/owner', label: 'Performance', icon: TrendingUp, module: 'reports' },
      { to: '/owner/statement', label: 'Owner statement', icon: StatementIcon, module: 'reports' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/calendar', label: 'Calendar', icon: CalendarDays, module: 'booking' },
      { to: '/bookings', label: 'Bookings', icon: BedDouble, module: 'booking', count: 'arrivals', countLabel: 'arriving today' },
      { to: '/night-audit', label: 'Night audit', icon: MoonStar, module: 'booking' },
      { to: '/guests', label: 'Guests', icon: Users, module: 'guest' },
      { to: '/checkins', label: 'Online check-in', icon: CheckInIcon, module: 'booking' },
      { to: '/messages', label: 'Guest messages', icon: MessagesSquare, module: 'booking' },
      { to: '/services/orders', label: 'Room service orders', icon: UtensilsCrossed, module: 'services', count: 'orders', countLabel: 'new or late orders' },
      { to: '/services', label: 'Requests', icon: ConciergeBell, module: 'services', count: 'requests', countLabel: 'open requests' },
      { to: '/services/catalog', label: 'Service menu', icon: BookOpen, module: 'services' },
    ],
  },
  {
    label: 'Maintenance',
    items: [
      { to: '/maintenance', label: 'Overview', icon: Wrench, module: 'maintenance', count: 'maintenance', countLabel: 'urgent jobs open' },
      { to: '/maintenance/work-orders', label: 'Work orders', icon: ClipboardList, module: 'maintenance' },
      { to: '/housekeeping', label: 'Housekeeping', icon: Sparkles, module: 'maintenance' },
      { to: '/stock', label: 'Stock', icon: Boxes, module: 'maintenance' },
      { to: '/maintenance/preventive', label: 'Preventive plans', icon: CalendarClock, module: 'maintenance' },
      { to: '/maintenance/assets', label: 'Assets', icon: Package, module: 'maintenance' },
      { to: '/maintenance/vendors', label: 'Vendors', icon: HardHat, module: 'maintenance' },
    ],
  },
  {
    label: 'Property',
    items: [
      { to: '/property', label: 'Property', icon: Building2, module: 'property' },
      { to: '/airbnb', label: 'Airbnb', icon: Globe, module: 'airbnb' },
    ],
  },
  {
    label: 'Payments',
    items: [
      { to: '/payments', label: 'Overview', icon: Banknote, module: 'payments' },
      { to: '/payments/list', label: 'All payments', icon: ReceiptText, module: 'payments' },
      { to: '/payments/receivables', label: 'Receivables', icon: Hourglass, module: 'payments' },
      { to: '/payments/payouts', label: 'Airbnb payouts', icon: Globe, module: 'payments' },
      { to: '/payments/settings', label: 'Payment policy', icon: SlidersHorizontal, module: 'payments' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/finance', label: 'Cashbox', icon: Wallet, module: 'finance' },
      { to: '/finance/cash-in', label: 'Cash in', icon: ArrowDownLeft, module: 'finance' },
      { to: '/finance/cash-out', label: 'Cash out', icon: ArrowUpRight, module: 'finance' },
      { to: '/finance/petty-cash', label: 'Petty cash', icon: Coins, module: 'finance' },
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck, module: 'approval', count: 'pending', countLabel: 'waiting for you' },
      { to: '/finance/transactions', label: 'All transactions', icon: ArrowLeftRight, module: 'finance' },
      { to: '/finance/categories', label: 'Categories', icon: Tags, module: 'finance' },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { to: '/accounting', label: 'Chart of accounts', icon: ListTree, module: 'finance' },
      { to: '/accounting/transaction-codes', label: 'Transaction codes', icon: Hash, module: 'finance' },
      { to: '/accounting/tax', label: 'Tax and service', icon: Percent, module: 'finance' },
      { to: '/accounting/journals', label: 'Journals', icon: NotebookTabs, module: 'finance' },
      { to: '/accounting/ledger', label: 'General ledger', icon: BookOpenCheck, module: 'finance' },
      { to: '/accounting/trial-balance', label: 'Trial balance', icon: Scale, module: 'finance' },
      { to: '/accounting/income-statement', label: 'Income statement', icon: TrendingUp, module: 'finance' },
      { to: '/accounting/balance-sheet', label: 'Balance sheet', icon: Sheet, module: 'finance' },
      { to: '/accounting/manual', label: 'Manual journals', icon: FilePen, module: 'finance' },
      { to: '/accounting/periods', label: 'Period close', icon: CalendarX2, module: 'finance' },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/hr', label: 'HR overview', icon: UsersRound, module: 'hr', count: 'hr', countLabel: 'requests pending' },
      { to: '/hr/employees', label: 'Employees', icon: Users, module: 'hr' },
      { to: '/hr/roster', label: 'Shift roster', icon: CalendarCheck, module: 'hr' },
      { to: '/hr/attendance', label: 'Attendance', icon: ClipboardCheck, module: 'hr' },
      { to: '/hr/leave', label: 'Leave', icon: ListChecks, module: 'hr' },
      { to: '/hr/overtime', label: 'Overtime', icon: Clock, module: 'hr' },
      { to: '/hr/loans', label: 'Loans', icon: HandCoins, module: 'hr' },
      { to: '/hr/kpi', label: 'KPI reviews', icon: Target, module: 'hr' },
      { to: '/hr/announcements', label: 'Announcements', icon: Megaphone, module: 'hr' },
      { to: '/payroll', label: 'Payroll', icon: Banknote, module: 'payroll' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { to: '/reports', label: 'Reports', icon: FileBarChart, module: 'reports' },
      { to: '/revenue', label: 'Revenue', icon: ChartColumnIncreasing, module: 'reports' },
      { to: '/revenue/budget', label: 'Budget', icon: Calculator, module: 'reports' },
    ],
  },
  {
    label: 'Master data',
    items: [
      { to: '/master', label: 'Overview', icon: Database, module: 'master' },
      { to: '/master/locations', label: 'Locations', icon: MapPin, module: 'master' },
      { to: '/master/villas', label: 'Villas', icon: Building2, module: 'master' },
      { to: '/master/room-types', label: 'Room types', icon: LayoutList, module: 'master' },
      { to: '/master/units', label: 'Units', icon: DoorOpen, module: 'master' },
      { to: '/master/airbnb-accounts', label: 'Airbnb accounts', icon: Globe, module: 'master' },
      { to: '/master/listings', label: 'Listings', icon: Globe, module: 'master' },
      { to: '/master/cash-accounts', label: 'Cash accounts', icon: Wallet, module: 'master' },
      { to: '/master/categories', label: 'Categories', icon: Tags, module: 'master' },
      { to: '/master/approval-rules', label: 'Approval rules', icon: ShieldCheck, module: 'approval' },
      { to: '/master/shifts', label: 'Shifts', icon: Clock, module: 'hr' },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/access/users', label: 'Users', icon: KeyRound, module: 'access' },
      { to: '/access/roles', label: 'Roles and permissions', icon: ShieldCheck, module: 'access' },
      { to: '/access/audit', label: 'Audit trail', icon: ScrollText, module: 'access' },
    ],
  },
  { label: 'Apps', items: [{ to: '/m', label: 'Front desk app', icon: Smartphone, module: 'dashboard' }] },
]

export const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: Settings, module: 'dashboard' }

const ALL = [...NAV_SECTIONS.flatMap((s) => s.items.map((item) => ({ section: s.label, item }))), { section: 'Account', item: SETTINGS_ITEM }]

const DETAIL_LABEL: Record<string, string> = {
  '/guide/system': 'System map',
  '/property/new': 'New property',
  '/bookings/new': 'New booking',
  '/bookings/groups': 'Group bookings',
  '/bookings/groups/new': 'New group',
  '/finance/transactions/new': 'New entry',
  '/finance/transfer': 'Cash transfer',
  '/hr/employees/new': 'New employee',
  '/maintenance/work-orders/new': 'New work order',
  '/services/orders/new': 'New order',
  '/services/qr': 'Room QR cards',
  '/payroll/settings': 'Payroll settings',
  '/messages/settings': 'Templates',
  '/accounting/manual/new': 'New manual journal',
  '/me/requests': 'New request',
  '/me/payslips': 'Payslips',
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

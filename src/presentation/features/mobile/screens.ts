import { ClipboardList, Banknote, Sparkles } from 'lucide-react'
import { CalendarDays, ConciergeBell, House, LayoutGrid, UserRound, Wallet, type LucideIcon } from 'lucide-react'

export interface MobileScreen {
  to: string
  label: string
  icon: LucideIcon
  blurb: string
}

/** Every phone screen, in the order the tab bar and the menu list them. */
export const MOBILE_SCREENS: readonly MobileScreen[] = [
  { to: '/m', label: 'Today', icon: House, blurb: 'Arrivals, departures, check-ins' },
  { to: '/m/availability', label: 'Free nights', icon: CalendarDays, blurb: 'Seven nights per unit' },
  { to: '/m/services', label: 'Room services', icon: ConciergeBell, blurb: 'Requests per unit' },
  { to: '/m/cash', label: 'Cashbox', icon: Wallet, blurb: 'Record cash in and out' },
  { to: '/m/housekeeping', label: 'Housekeeping', icon: Sparkles, blurb: 'Rooms from dirty to ready' },
  { to: '/m/work-orders', label: 'Work orders', icon: ClipboardList, blurb: 'My repair jobs' },
  { to: '/m/payments', label: 'Payments', icon: Banknote, blurb: 'Take a payment, see balances due' },
  { to: '/m/me', label: 'My area', icon: UserRound, blurb: 'Shifts, leave, payslip' },
  { to: '/m/menu', label: 'Menu', icon: LayoutGrid, blurb: 'Every screen' },
]

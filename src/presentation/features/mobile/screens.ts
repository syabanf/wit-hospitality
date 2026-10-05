import { CalendarDays, ConciergeBell, House, LayoutGrid, Wallet, type LucideIcon } from 'lucide-react'

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
  { to: '/m/menu', label: 'Menu', icon: LayoutGrid, blurb: 'Every screen' },
]

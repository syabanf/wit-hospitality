import { Link } from 'react-router'
import { ArrowUpRight, Monitor } from 'lucide-react'
import { cn } from '@/lib/cn'
import { POP, POP_ORDER, type Pop } from '../../ui/pop'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { MOBILE_SCREENS } from './screens'
import { Screen } from './Screen'

const CONSOLE_LINKS = [
  { to: '/bookings', label: 'Bookings', blurb: 'Every stay' },
  { to: '/calendar', label: 'Calendar', blurb: 'Two weeks per unit' },
  { to: '/guests', label: 'Guests', blurb: 'Profiles and history' },
  { to: '/finance', label: 'Finance', blurb: 'Balances and approvals' },
]

export function MenuScreen() {
  const screens = MOBILE_SCREENS.filter((s) => s.to !== '/m/menu')
  return (
    <Screen title="Menu" back={false} actions={<ThemeToggle />}>
      <ul className="grid grid-cols-2 gap-3">
        {screens.map((s, i) => (
          <li key={s.to}>
            <Link to={s.to} className={cn('flex h-full flex-col rounded-[22px] p-4 active:scale-[0.98]', POP[POP_ORDER[i % POP_ORDER.length] as Pop])}>
              <span className="flex justify-between">
                <s.icon aria-hidden className="size-5" />
                <ArrowUpRight aria-hidden className="size-4 opacity-60" />
              </span>
              <span className="mt-8 font-display text-xl leading-none font-bold uppercase">{s.label}</span>
              <span className="mt-1 text-xs opacity-70">{s.blurb}</span>
            </Link>
          </li>
        ))}
        {CONSOLE_LINKS.map((s, i) => (
          <li key={s.to}>
            <Link to={s.to} className={cn('flex h-full flex-col rounded-[22px] p-4 active:scale-[0.98]', POP[POP_ORDER[(i + screens.length) % POP_ORDER.length] as Pop])}>
              <span className="flex justify-between">
                <Monitor aria-hidden className="size-5" />
                <ArrowUpRight aria-hidden className="size-4 opacity-60" />
              </span>
              <span className="mt-8 font-display text-xl leading-none font-bold uppercase">{s.label}</span>
              <span className="mt-1 text-xs opacity-70">{s.blurb}</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/" className="flex items-center gap-3 rounded-[22px] bg-card p-4 text-sm shadow-card">
        <Monitor aria-hidden className="size-5 text-muted" />
        <span className="flex-1">Open the desktop console</span>
        <ArrowUpRight aria-hidden className="size-4 text-muted" />
      </Link>
    </Screen>
  )
}

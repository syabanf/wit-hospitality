import { NavLink } from 'react-router'
import { cn } from '@/lib/cn'

const TABS = [
  { to: '/villa-owners', label: 'Owners and contracts' },
  { to: '/villa-owners/statements', label: 'Statements and payouts' },
]

/** Switches between the two villa owner pages. */
export function OwnersTabs() {
  return (
    <nav aria-label="Villa owners" className="flex flex-wrap gap-1">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end className={({ isActive }) => cn('rounded-full px-4 py-2 text-sm font-medium', isActive ? 'bg-invert text-on-invert' : 'text-muted hover:bg-control hover:text-fg')}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}

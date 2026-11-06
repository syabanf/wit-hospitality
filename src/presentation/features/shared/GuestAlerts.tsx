import { AlertTriangle, Ban, Crown } from 'lucide-react'
import { guestAlerts, type Guest } from '@/domain/guest'
import { cn } from '@/lib/cn'

const LOOK = {
  danger: { box: 'bg-danger-soft text-danger', Icon: Ban },
  warning: { box: 'bg-warning-soft text-warning', Icon: AlertTriangle },
  info: { box: 'bg-info-soft text-body', Icon: Crown },
} as const

/** VIP level, allergies and blacklist, shown wherever the desk handles the guest's stay. */
export function GuestAlerts({ guest, className }: { guest: Pick<Guest, 'vipLevel' | 'vipReason' | 'preferences' | 'blacklist'>; className?: string }) {
  const alerts = guestAlerts(guest)
  if (!alerts.length) return null
  return (
    <ul className={cn('space-y-2', className)} aria-label="Guest alerts">
      {alerts.map((a) => {
        const { box, Icon } = LOOK[a.tone]
        return (
          <li key={a.text} className={cn('flex items-start gap-2 rounded-panel p-3 text-sm font-medium', box)}>
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {a.text}
          </li>
        )
      })}
    </ul>
  )
}

import { priceSourceLabel, type NightPrice } from '@/domain/pricing'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { Tag } from '../../ui/Badge'

interface Run {
  from: string
  nights: number
  rate: number
  label: string
  listing: boolean
}

/** Consecutive nights at the same price from the same source read as one line. */
function runs(nights: readonly NightPrice[]): Run[] {
  const out: Run[] = []
  for (const n of nights) {
    const label = priceSourceLabel(n.source)
    const last = out.at(-1)
    if (last && last.rate === n.rate && last.label === label) last.nights += 1
    else out.push({ from: n.date, nights: 1, rate: n.rate, label, listing: n.source.kind === 'listing' })
  }
  return out
}

/** The list price of each night and where it came from: the Airbnb listing, a rate plan or the channel. */
export function NightPrices({ nights, className }: { nights: readonly NightPrice[]; className?: string }) {
  return (
    <ul className={cn('divide-y divide-line text-sm', className)} aria-label="Price per night">
      {runs(nights).map((r) => (
        <li key={r.from} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
          <span className="min-w-0 flex-1">
            {shortDay(r.from)}
            {r.nights > 1 && <span className="text-muted">, {plural(r.nights, 'night')}</span>}
          </span>
          <Tag tone={r.listing ? 'info' : 'neutral'}>{r.label}</Tag>
          <span className="w-32 text-right font-medium tabular">
            {money(r.rate)}
            {r.nights > 1 && <span className="text-xs font-normal text-muted"> each</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

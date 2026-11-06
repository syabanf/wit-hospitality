import { markTags, type DayMarks as Marks } from '@/domain/restriction'
import { cn } from '@/lib/cn'
import { shortDay, weekdayDay } from '@/lib/dates'

interface DayMarksProps {
  marks: readonly Marks[]
  /** The picked stay, shaded from check-in to the night before check-out. */
  checkIn?: string
  checkOut?: string
  /** Makes each date a button, for picking the stay on the dates. */
  onPick?: (date: string) => void
  label: string
}

/** Dates with their stay restrictions: Closed, CTA, CTD, Min and Max nights. */
export function DayMarks({ marks, checkIn, checkOut, onPick, label }: DayMarksProps) {
  return (
    <ul className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" aria-label={label}>
      {marks.map((m) => {
        const tags = markTags(m)
        const inStay = Boolean(checkIn && checkOut && m.date >= checkIn && m.date < checkOut)
        const edge = m.date === checkIn || m.date === checkOut
        const cell = cn(
          'block h-full w-full rounded-xl p-2 text-left text-xs',
          m.stopSell ? 'bg-danger-soft text-danger' : m.cta || m.ctd ? 'bg-warning-soft text-warning' : tags.length ? 'bg-info-soft text-info-text' : 'bg-raised',
          inStay && 'ring-2 ring-accent',
          edge && 'font-semibold',
        )
        const body = (
          <>
            <span className="block font-medium">{weekdayDay(m.date)}</span>
            <span className="block truncate opacity-80">{tags.join(' · ') || 'Open'}</span>
          </>
        )
        return (
          <li key={m.date}>
            {onPick ? (
              <button type="button" className={cn(cell, 'transition-[filter] hover:brightness-95')} aria-label={`${shortDay(m.date)}: ${tags.join(', ') || 'open'}`} aria-pressed={inStay} onClick={() => onPick(m.date)}>
                {body}
              </button>
            ) : (
              <span className={cell}>{body}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

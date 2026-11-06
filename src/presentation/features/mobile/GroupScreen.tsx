import { Link, useParams } from 'react-router'
import { BOOKING_STATUS_LABEL } from '@/domain/booking'
import { GROUP_BILLING_LABEL, GROUP_STATUS_LABEL } from '@/domain/group'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Fallback } from '../../ui/Gate'
import { POP } from '../../ui/pop'
import { BOOKING_TONE, GROUP_TONE } from '../shared/tones'
import { Screen, ScreenSkeleton } from './Screen'

/** The group at a glance for the desk: who is in which unit, who has arrived, and what is still owed. */
export function GroupScreen() {
  const { id = '' } = useParams()
  const { groups } = useServices()
  const resource = useResource(`groups.detail:${id}`, () => groups.detail(id), { keepPrevious: false })
  const d = resource.data

  return (
    <Screen title={d ? d.row.group.code : 'Group'}>
      {!d ? (
        <Fallback error={resource.error} onRetry={resource.reload} what="group" back={{ to: '/m', label: 'Back to today' }} loading={<ScreenSkeleton />} />
      ) : (
        <>
          <section aria-label={d.row.group.name} className={cn('rounded-[28px] p-5 shadow-pop', POP.ink)}>
            <p className="truncate text-lg font-semibold">{d.row.group.name}</p>
            <p className="truncate text-xs opacity-80">
              Lead {d.row.leadName} · {GROUP_BILLING_LABEL[d.row.group.billing]}
            </p>
            <p className="mt-4 text-[34px] leading-none font-semibold tracking-tight tabular">{money(d.owed)}</p>
            <p className="mt-1 text-xs opacity-80">
              Still owed · {shortDay(d.row.checkIn)} to {shortDay(d.row.checkOut)} · {plural(d.row.stays.length, 'stay')}
            </p>
            <StatusPill tone={GROUP_TONE[d.row.status]} className="mt-4 bg-white/90">
              {GROUP_STATUS_LABEL[d.row.status]}
            </StatusPill>
          </section>

          <ul className="space-y-2" aria-label="Stays">
            {d.stays.map(({ booking: b, owed }) => (
              <li key={b.id}>
                <Link to={`/m/bookings/${b.id}`} className="flex items-center gap-3 rounded-[22px] bg-card p-3 shadow-card">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {b.unitCode} <span className="font-mono text-xs font-normal text-muted">{b.code}</span>
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {shortDay(b.checkIn)} to {shortDay(b.checkOut)}
                      {b.partySize ? ` · ${plural(b.partySize.adults + b.partySize.children, 'guest')}` : ''} · {money(owed)} {d.master ? 'extras' : 'owed'}
                    </span>
                  </span>
                  <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>
                </Link>
              </li>
            ))}
          </ul>

          {d.master && (
            <p className="rounded-[22px] bg-info-soft p-4 text-sm text-body">
              The master folio holds every room night: <span className="font-semibold tabular">{money(d.master.due)}</span> to pay before the last stay leaves.
            </p>
          )}

          <Link to={`/bookings/groups/${d.row.group.id}`} className="flex items-center justify-between rounded-[22px] bg-card p-4 text-sm shadow-card">
            Check in, take payment or change the group on the console
            <span aria-hidden>→</span>
          </Link>
        </>
      )}
    </Screen>
  )
}

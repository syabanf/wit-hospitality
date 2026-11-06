import { useState } from 'react'
import { Link } from 'react-router'
import { PRECHECKIN_STATUS_LABEL, type PreCheckInStatus } from '@/domain/precheckin'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { PRECHECKIN_TONE } from '../messages/tones'
import { PreCheckInDetails } from './PreCheckInCard'

type Chip = PreCheckInStatus | 'all'

/** The week's arrivals with their online check-in: the desk verifies submitted ones before the guest walks in. */
export default function ArrivalsCheckInPage() {
  const { precheckin } = useServices()
  const data = useResource('precheckin.arrivals', () => precheckin.arrivals())
  const [chip, setChip] = useState<Chip>('all')

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const { rows, today } = data.data
  const count = (s: PreCheckInStatus) => rows.filter((r) => r.status === s).length
  const shown = chip === 'all' ? rows : rows.filter((r) => r.status === chip)
  const toggle = (s: PreCheckInStatus) => setChip(chip === s ? 'all' : s)

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="To verify" value={count('submitted')} hint="Sent by the guest" active={chip === 'submitted'} onClick={() => toggle('submitted')} />
        <StatTile label="Verified" value={count('verified')} hint="Check-in form prefilled" active={chip === 'verified'} onClick={() => toggle('verified')} />
        <StatTile label="Not started" value={count('not_started')} hint="Pre-arrival goes out on its own" active={chip === 'not_started'} onClick={() => toggle('not_started')} />
      </div>
      {shown.length === 0 && <EmptyState title="No arrival matches">Pick another tile.</EmptyState>}
      {shown.map((r) => (
        <Card key={r.booking.id} aria-labelledby={`arr-${r.booking.id}`}>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <Link id={`arr-${r.booking.id}`} to={`/bookings/${r.booking.id}`} className="font-semibold hover:underline">
                {r.booking.guestName}
              </Link>
              <p className="text-xs text-muted">
                {r.booking.checkIn === today ? 'Today' : shortDay(r.booking.checkIn)} · {r.booking.unitCode} · {r.booking.place.villa.name} · {plural(r.booking.nights, 'night')} · <span className="font-mono">{r.booking.code}</span>
              </p>
            </div>
            <StatusPill tone={PRECHECKIN_TONE[r.status]}>{PRECHECKIN_STATUS_LABEL[r.status]}</StatusPill>
          </div>
          <PreCheckInDetails view={r} onVerified={data.reload} />
        </Card>
      ))}
    </div>
  )
}

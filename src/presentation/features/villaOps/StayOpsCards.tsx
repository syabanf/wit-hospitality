import { useState } from 'react'
import { Link } from 'react-router'
import { ClipboardCheck, Gauge } from 'lucide-react'
import { CHECK_KIND_LABEL, CHECK_KINDS, linesOff, type CheckKind, type InventoryCheck } from '@/domain/unitInventory'
import { METER_KIND_LABEL, type ReadingPurpose } from '@/domain/utilities'
import { shortDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { useToast } from '../../ui/useToast'
import { billedLine, checkHref } from './links'
import { ReadingForm } from './ReadingForm'

function CheckRow({ kind, check, start }: { kind: CheckKind; check: InventoryCheck | null; start: string | null }) {
  if (check) {
    const off = linesOff(check)
    return (
      <Link to={`/housekeeping/checks/${check.id}`} className="flex items-center gap-3 rounded-panel bg-raised px-4 py-3 transition-colors hover:bg-control">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{CHECK_KIND_LABEL[kind]}</p>
          <p className="truncate text-xs text-muted">
            {check.number} · {shortDay(check.on)} · {check.by}
          </p>
        </div>
        <Tag tone={off ? 'danger' : 'success'}>{off ? `${off} off` : 'In order'}</Tag>
      </Link>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-panel bg-raised px-4 py-3">
      <p className="min-w-0 flex-1 truncate text-sm text-muted">{CHECK_KIND_LABEL[kind]}: not counted</p>
      {start && (
        <Link to={start} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
          Count
        </Link>
      )}
    </div>
  )
}

/** The stay's inventory checks on the booking page. Hidden while the unit has no list. */
export function StayChecksCard({ bookingId }: { bookingId: string }) {
  const { villaOps } = useServices()
  const data = useResource(`villaOps.stayChecks:${bookingId}`, () => villaOps.stayChecks(bookingId), { keepPrevious: false })
  const d = data.data
  if (!d || (!d.hasList && !d.pre && !d.post)) return null
  const b = d.booking
  const canStart = (kind: CheckKind) => d.canRecord && d.hasList && (kind === 'pre_arrival' ? b.status === 'confirmed' || b.status === 'checked_in' : b.status === 'checked_in' || b.status === 'checked_out')
  return (
    <Card aria-labelledby="stay-checks-title">
      <CardHeader id="stay-checks-title" title="Inventory checks" icon={<ClipboardCheck aria-hidden className="size-5 text-muted" />} />
      <div className="space-y-2">
        {CHECK_KINDS.map((kind) => (
          <CheckRow key={kind} kind={kind} check={kind === 'pre_arrival' ? d.pre : d.post} start={canStart(kind) ? checkHref(b.unitId, b.id, kind) : null} />
        ))}
      </div>
      {b.status === 'checked_in' && !d.post && d.hasList && <p className="mt-3 text-xs text-muted">Count {d.unitCode} before checking out, so any damage reaches the bill before the deposit goes back.</p>}
    </Card>
  )
}

/** A long stay's meters with the check-in and check-out readings. Hidden on a short stay. */
export function StayMetersCard({ bookingId }: { bookingId: string }) {
  const { villaOps, clock } = useServices()
  const toast = useToast()
  const data = useResource(`villaOps.stayMeters:${bookingId}`, () => villaOps.stayMeters(bookingId), { keepPrevious: false })
  const [open, setOpen] = useState<{ meterId: string; purpose: ReadingPurpose } | null>(null)
  const d = data.data
  if (!d) return null
  return (
    <Card aria-labelledby="stay-meters-title">
      <CardHeader id="stay-meters-title" title="Meter readings" icon={<Gauge aria-hidden className="size-5 text-muted" />} />
      <p className="mb-3 text-xs text-muted">
        A {d.nights}-night stay: the property reads the meters at check-in and check-out on stays of {d.threshold} nights or more.
      </p>
      <ul className="space-y-2">
        {d.meters.map(({ meter, checkIn, checkOut }) => (
          <li key={meter.id} className="rounded-panel bg-raised px-4 py-3">
            <p className="text-sm font-medium">
              {METER_KIND_LABEL[meter.kind]} <span className="font-mono text-xs text-muted">{meter.number}</span>
            </p>
            <p className="text-xs text-muted">
              Check-in: {checkIn ? `${checkIn.value} ${meter.unit} on ${shortDay(checkIn.on)}` : 'not read'} · Check-out: {checkOut ? `${checkOut.value} ${meter.unit}, ${billedLine(checkOut)}` : 'not read'}
            </p>
            {d.canRecord && (!checkIn || !checkOut) && (
              <Button size="sm" variant="soft" className="mt-2" aria-pressed={open?.meterId === meter.id} onClick={() => setOpen(open?.meterId === meter.id ? null : { meterId: meter.id, purpose: checkIn ? 'check_out' : 'check_in' })}>
                Record the {checkIn ? 'check-out' : 'check-in'} reading
              </Button>
            )}
            {open?.meterId === meter.id && (
              <div className="mt-3">
                <ReadingForm
                  meters={[meter]}
                  today={clock.today()}
                  preset={{ meterId: meter.id, purpose: open.purpose, bookingId: d.booking.id }}
                  onDone={(r) => {
                    toast({ title: `Read ${meter.number}`, description: billedLine(r) })
                    setOpen(null)
                    data.reload()
                  }}
                  onCancel={() => setOpen(null)}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Today's villa arrivals and departures and their counts, on the housekeeping page. */
export function VillaChecksCard() {
  const { villaOps } = useServices()
  const data = useResource('villaOps.today', () => villaOps.villaChecksToday())
  const rows = data.data ?? []
  if (rows.length === 0) return null
  return (
    <Card aria-labelledby="villa-checks-title">
      <CardHeader id="villa-checks-title" title="Villa inventory checks today" icon={<ClipboardCheck aria-hidden className="size-5 text-muted" />} />
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={`${r.booking.id}-${r.kind}`} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {r.unitCode} · {CHECK_KIND_LABEL[r.kind]}
              </p>
              <p className="truncate text-xs text-muted">
                <Link to={`/bookings/${r.booking.id}`} className="hover:underline">
                  {r.booking.code}
                </Link>
                {r.guestName && ` · ${r.guestName}`} · {r.kind === 'pre_arrival' ? 'arrives today' : 'leaves today'}
              </p>
            </div>
            {r.done ? (
              <Link to={`/housekeeping/checks/${r.done.id}`} className="text-sm font-medium text-accent-text hover:underline">
                {r.done.number}, {linesOff(r.done) ? `${linesOff(r.done)} off` : 'in order'}
              </Link>
            ) : r.hasList ? (
              <Link to={checkHref(r.booking.unitId, r.booking.id, r.kind)} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                Count
              </Link>
            ) : (
              <Link to={`/property/units/${r.booking.unitId}`} className="text-xs text-muted hover:underline">
                No list yet
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

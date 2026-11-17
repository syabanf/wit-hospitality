import { useState } from 'react'
import { LogIn, LogOut, MapPin } from 'lucide-react'
import type { Attendance, Shift } from '@/domain/hr'
import type { Villa } from '@/domain/property'
import { CLOCK_ACTION_LABEL, placeLabel, type ClockAction, type GeoPoint } from '@/domain/selfService'
import { cn } from '@/lib/cn'
import { shortDay, type IsoDate } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { useToast } from '../../ui/useToast'

export interface ClockState {
  action: ClockAction
  row: Attendance | null
  shift: Shift | null
  villa: Villa | null
}

/** The browser's position when the person grants it within a few seconds; the clock goes ahead without one. */
function position(): Promise<GeoPoint | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null)
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(null), 5000)
    const done = (point: GeoPoint | null) => {
      clearTimeout(giveUp)
      resolve(point)
    }
    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => done(null),
      { timeout: 4000, maximumAge: 60_000 },
    )
  })
}

interface ClockCardProps {
  clock: ClockState
  today: IsoDate
  onDone: () => void
  /** The phone card: borderless on the canvas. */
  phone?: boolean
}

/** One action that follows the day: Clock in, then Clock out. A day off the roster asks why first. */
export function ClockCard({ clock, today, onDone, phone = false }: ClockCardProps) {
  const { selfService } = useServices()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { action, row, shift, villa } = clock
  const needsReason = action === 'in' && !shift

  async function press() {
    setBusy(true)
    setError('')
    try {
      const geo = await position()
      const saved = action === 'in' ? await selfService.clockIn({ reason, geo }) : await selfService.clockOut(geo)
      const stamp = action === 'in' ? saved.clockInGeo : saved.clockOutGeo
      toast({ title: action === 'in' ? `Clocked in at ${saved.clockIn}` : `Clocked out at ${saved.clockOut}`, description: saved.lateMinutes > 0 && action === 'in' ? `${saved.lateMinutes} min late · ${placeLabel(stamp)}` : placeLabel(stamp) })
      setReason('')
      onDone()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong.'
      setError(message)
      toast({ tone: 'danger', title: action === 'in' ? 'Could not clock in' : 'Could not clock out', description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="clock-title" className={cn(phone ? 'rounded-[22px] bg-card p-4 shadow-card' : 'rounded-card border border-line bg-card p-5 shadow-card')}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="clock-title" className={cn('font-semibold tracking-tight', phone ? 'text-base' : 'text-lg')}>
            {shift ? `${shift.name} shift, ${shift.start} to ${shift.end}` : 'Not on the roster today'}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {row?.clockIn ? `In ${row.clockIn}${row.clockOut ? `, out ${row.clockOut}` : ''}${row.date === today ? '' : `, since ${shortDay(row.date)}`}` : shift ? `At ${villa?.name ?? 'your villa'}. The server stamps the time when you press.` : 'Clock in with a reason when you cover a shift.'}
          </p>
          {row?.clockIn && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Tag tone={row.clockInGeo?.place === 'villa' ? 'success' : row.clockInGeo?.place === 'away' ? 'warning' : 'neutral'}>
                <MapPin aria-hidden className="size-3" /> {placeLabel(row.clockInGeo)}
              </Tag>
              {row.lateMinutes > 0 && <Tag tone="warning">{row.lateMinutes} min late</Tag>}
              {row.corrected && <Tag tone="info">Corrected by HR</Tag>}
            </div>
          )}
        </div>
        <Button variant={action === 'out' ? 'solid' : 'accent'} className={cn('h-14 px-7 text-base', phone && 'w-full')} loading={busy} disabled={action === 'done'} onClick={() => void press()}>
          {action === 'out' ? <LogOut aria-hidden className="size-5" /> : <LogIn aria-hidden className="size-5" />}
          {CLOCK_ACTION_LABEL[action]}
        </Button>
      </div>
      {needsReason && (
        <Field label="Reason" htmlFor="clock-reason" className="mt-4" hint="HR sees it beside the clock-in">
          <Input id="clock-reason" value={reason} placeholder="Covering for a coworker, called in for an arrival…" onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ConciergeBell, Phone } from 'lucide-react'
import { ACTION_LABEL, BOOKING_STATUS_LABEL, nextStep } from '@/domain/booking'
import { RequestRows } from '../shared/RequestRows'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Fallback } from '../../ui/Gate'
import { POP } from '../../ui/pop'
import { Steps } from '../../ui/Steps'
import { useToast } from '../../ui/useToast'
import { BOOKING_TONE } from '../shared/tones'
import { Screen, ScreenSkeleton } from './Screen'

export function BookingScreen() {
  const { id = '' } = useParams()
  const { booking } = useServices()
  const toast = useToast()
  const resource = useResource(`booking.detail:${id}`, () => booking.detail(id), { keepPrevious: false })
  const [busy, setBusy] = useState(false)
  const d = resource.data

  async function advance() {
    if (!d) return
    const step = nextStep(d.booking)
    if (!step) return
    setBusy(true)
    try {
      await booking.transition(d.booking.id, step)
      toast({ title: `${BOOKING_STATUS_LABEL[step]} ${d.booking.guestName}` })
      resource.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update the stay', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title={d ? d.booking.unitCode : 'Stay'}>
      {!d ? (
        <Fallback error={resource.error} onRetry={resource.reload} what="booking" back={{ to: '/m', label: 'Back to today' }} loading={<ScreenSkeleton />} />
      ) : (
        <>
          <section aria-label={d.booking.code} className={cn('rounded-[28px] p-5 shadow-pop', POP.red)}>
            <div className="flex items-center gap-3">
              <Avatar name={d.booking.guestName} size="lg" className="ring-2 ring-white/40" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-semibold">{d.booking.guestName}</p>
                <p className="truncate text-xs opacity-80">
                  {d.booking.code} · {d.booking.sourceLabel}
                </p>
              </div>
            </div>
            <p className="mt-4 text-[34px] leading-none font-semibold tracking-tight tabular">{money(d.booking.total)}</p>
            <p className="mt-1 text-xs opacity-80">
              {shortDay(d.booking.checkIn)} to {shortDay(d.booking.checkOut)} · {plural(d.booking.nights, 'night')} · {d.booking.place.villa.name}
            </p>
            <div className="mt-4 flex items-center gap-2">
              <StatusPill tone={BOOKING_TONE[d.booking.status]} className="bg-white/90">
                {BOOKING_STATUS_LABEL[d.booking.status]}
              </StatusPill>
              <a href={`tel:${d.booking.guest.phone.replace(/\s/g, '')}`} className={buttonStyles({ variant: 'onPop', size: 'sm', className: 'ml-auto' })}>
                <Phone aria-hidden className="size-3.5" /> Call
              </a>
            </div>
          </section>

          {d.booking.status === 'confirmed' ? (
            <Link to={`/m/bookings/${d.booking.id}/check-in`} className={buttonStyles({ variant: 'accent', className: 'w-full' })}>
              Check in with the arrival checklist
            </Link>
          ) : d.booking.status === 'checked_in' ? (
            <Link to={`/m/bookings/${d.booking.id}/check-out`} className={buttonStyles({ variant: 'accent', className: 'w-full' })}>
              Check out with the departure checklist
            </Link>
          ) : (
            nextStep(d.booking) && (
              <Button variant="accent" className="w-full" loading={busy} onClick={() => void advance()}>
                {ACTION_LABEL[nextStep(d.booking) ?? 'confirmed']}
              </Button>
            )
          )}

          <section className="rounded-[26px] bg-card p-4 shadow-card" aria-labelledby="m-rq">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="m-rq" className="text-base font-semibold">
                Room services
              </h2>
              {d.booking.status === 'checked_in' && (
                <Link to={`/m/services?new=1&booking=${d.booking.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                  <ConciergeBell aria-hidden className="size-3.5" /> New
                </Link>
              )}
            </div>
            <RequestRows requests={d.requests} today={d.today} empty="No requests for this stay." />
          </section>

          <section className="rounded-[26px] bg-card p-4 shadow-card" aria-label="Progress">
            <Steps label="Booking progress" steps={d.steps} />
          </section>

          {d.booking.notes && (
            <section className="rounded-[26px] bg-info-soft p-4 text-sm text-body" aria-label="Notes">
              {d.booking.notes}
            </section>
          )}

          <Link to={`/bookings/${d.booking.id}`} className="flex items-center justify-between rounded-[22px] bg-card p-4 text-sm shadow-card">
            Open the full record on the console
            <span aria-hidden>→</span>
          </Link>
        </>
      )}
    </Screen>
  )
}

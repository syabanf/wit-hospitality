import { useState } from 'react'
import { Link } from 'react-router'
import { Bell, ConciergeBell, LogIn, LogOut, Search } from 'lucide-react'
import { nextServiceStep, SERVICE_KIND_LABEL } from '@/domain/roomService'
import type { ServiceRequestView } from '@/application/views'
import type { BookingView } from '@/application/views'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Tag } from '../../ui/Badge'
import { Select } from '../../ui/Field'
import { POP } from '../../ui/pop'
import { Skeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'

function StayRow({ b, action, label, accent }: { b: BookingView; action: 'checked_in' | 'checked_out'; label: string; accent?: boolean }) {
  return (
    <li className="flex items-center gap-3 rounded-[22px] bg-card p-3 shadow-card">
      <Link to={`/m/bookings/${b.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={b.guestName} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{b.guestName}</span>
          <span className="block truncate text-xs text-muted">
            {b.unitCode} · {plural(b.nights, 'night')} · {action === 'checked_in' ? `until ${shortDay(b.checkOut)}` : `since ${shortDay(b.checkIn)}`}
          </span>
        </span>
      </Link>
      <Link to={`/m/bookings/${b.id}/${action === 'checked_in' ? 'check-in' : 'check-out'}`} className={buttonStyles({ variant: accent ? 'accent' : 'solid', size: 'sm' })}>
        {action === 'checked_in' ? <LogIn aria-hidden className="size-3.5" /> : <LogOut aria-hidden className="size-3.5" />}
        {label}
      </Link>
    </li>
  )
}

export function HomeScreen() {
  const { dashboard, service, account } = useServices()
  const toast = useToast()
  const profile = useResource('account.profile', () => account.profile())
  const options = useResource('dashboard.filterOptions', () => dashboard.filterOptions())
  const [locationId, setLocationId] = useState('')
  const ops = useResource(`dashboard.operational:m|${locationId}`, () => dashboard.operational({ period: '7d', locationId: locationId || undefined }))
  const [busy, setBusy] = useState<string | null>(null)
  const name = profile.data?.name

  async function advance(r: ServiceRequestView) {
    const step = nextServiceStep(r)
    if (!step) return
    setBusy(r.id)
    try {
      await service.transition(r.id, step)
      toast({ title: step === 'done' ? `Closed ${r.number}` : `Started ${r.number}`, description: `${r.unitCode} · ${SERVICE_KIND_LABEL[r.kind]}` })
      ops.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${r.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  const d = ops.data
  return (
    <div className="space-y-4 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-32">
      <header className="flex h-10 items-center gap-3">
        <Link to="/settings" aria-label="Profile" className="shrink-0 rounded-full transition-transform active:scale-95">
          {name ? <Avatar name={name} size="sm" /> : <Skeleton className="size-8 rounded-full" />}
        </Link>
        <h1 className="flex-1 truncate text-base font-semibold">{name ? `Hi, ${name.split(' ')[0]}!` : 'Hi!'}</h1>
        <Link to="/bookings" aria-label="Search bookings" className={buttonStyles({ variant: 'card', size: 'icon-sm' })}>
          <Search aria-hidden className="size-3.5" />
        </Link>
        <Link to="/?view=operational" aria-label="Needs attention" className={buttonStyles({ variant: 'card', size: 'icon-sm', className: 'relative' })}>
          <Bell aria-hidden className="size-3.5" />
          {d && d.lateArrivals.length > 0 && <span aria-hidden className="absolute top-2 right-2.5 size-2 rounded-full bg-accent ring-2 ring-card" />}
        </Link>
      </header>


      {options.data && (
        <Select
          aria-label="Location"
          tone="card"
          className="w-full"
          value={locationId}
          options={[{ value: '', label: 'All locations' }, ...options.data.catalog.locations.map((l) => ({ value: l.id, label: l.name }))]}
          onChange={(e) => setLocationId(e.target.value)}
        />
      )}

      {!d ? (
        <div className="space-y-4">
          <Skeleton className="h-28 rounded-[26px]" />
          <Skeleton className="h-40 rounded-[22px]" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className={cn('rounded-[22px] p-3', POP.red)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Arrive</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.arrivals.length + d.lateArrivals.length}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.blue)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Leave</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.departures.length + d.overstays.length}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.ink)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Free</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.available}</p>
            </div>
          </div>

          <section aria-labelledby="m-arrivals">
            <h2 id="m-arrivals" className="mb-2 text-base font-semibold">
              Arrivals
            </h2>
            {d.arrivals.length + d.lateArrivals.length === 0 ? (
              <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nobody arrives today.</p>
            ) : (
              <ul className="space-y-2">
                {[...d.lateArrivals, ...d.arrivals].map((b) => (
                  <StayRow key={b.id} b={b} action="checked_in" label="Check in" accent={b.checkIn < d.today} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="m-departures">
            <h2 id="m-departures" className="mb-2 text-base font-semibold">
              Departures
            </h2>
            {d.departures.length + d.overstays.length === 0 ? (
              <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nobody leaves today.</p>
            ) : (
              <ul className="space-y-2">
                {[...d.overstays, ...d.departures].map((b) => (
                  <StayRow key={b.id} b={b} action="checked_out" label="Check out" />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="m-services">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="m-services" className="text-base font-semibold">
                Room services
              </h2>
              <Link to="/m/services?new=1" className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                <ConciergeBell aria-hidden className="size-3.5" /> New
              </Link>
            </div>
            {d.requests.length === 0 ? (
              <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">No open requests.</p>
            ) : (
              <ul className="space-y-2">
                {d.requests.slice(0, 4).map((r) => {
                  const step = nextServiceStep(r)
                  return (
                    <li key={r.id} className="flex items-center gap-3 rounded-[22px] bg-card p-3 shadow-card">
                      <Link to={`/services/${r.id}`} className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <span className="font-mono">{r.unitCode}</span> {SERVICE_KIND_LABEL[r.kind]}
                          {r.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                        </span>
                        <span className="block truncate text-xs text-muted">{r.guestName ?? 'Housekeeping'}{r.note && ` · ${r.note}`}</span>
                      </Link>
                      {step && (
                        <Button size="sm" variant={step === 'done' ? 'solid' : 'soft'} loading={busy === r.id} onClick={() => void advance(r)}>
                          {step === 'done' ? 'Done' : 'Start'}
                        </Button>
                      )}
                    </li>
                  )
                })}
                {d.requests.length > 4 && (
                  <li>
                    <Link to="/m/services" className="block rounded-[22px] bg-card p-3 text-center text-sm text-accent-text shadow-card">
                      All {d.requests.length} open requests
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </section>

          <section aria-labelledby="m-inhouse">
            <h2 id="m-inhouse" className="mb-2 text-base font-semibold">
              In house
            </h2>
            <ul className="space-y-2">
              {d.inHouse
                .filter((b) => b.checkOut > d.today)
                .slice(0, 8)
                .map((b) => (
                  <li key={b.id}>
                    <Link to={`/m/bookings/${b.id}`} className="flex items-center gap-3 rounded-[22px] bg-card p-3 shadow-card active:scale-[0.99]">
                      <Avatar name={b.guestName} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{b.guestName}</span>
                        <span className="block truncate text-xs text-muted">
                          {b.unitCode} · leaves {shortDay(b.checkOut)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}

import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { CircleCheck, Save } from 'lucide-react'
import type { NewBooking } from '@/application/ports'
import { BLOCK_REASON_LABEL, type BookingSource } from '@/domain/booking'
import { ID_TYPE_LABEL, type IdType } from '@/domain/guest'
import type { Scope } from '@/domain/property'
import { addDays, daysBetween, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { ScopePicker } from '../shared/ScopePicker'

const SOURCE_TABS = [
  { value: 'direct', label: 'Direct' },
  { value: 'airbnb', label: 'Airbnb' },
] as const

const NEW_GUEST = '__new'
const round10k = (v: number) => Math.round(v / 10_000) * 10_000

/** One form for direct and manual Airbnb bookings, with a live availability check and alternatives. */
export default function NewBookingPage() {
  const { booking } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const options = useResource('booking.formOptions', () => booking.formOptions())

  const [source, setSource] = useState<BookingSource>(params.get('source') === 'airbnb' ? 'airbnb' : 'direct')
  const [accountId, setAccountId] = useState(params.get('account') ?? '')
  const [airbnbCode, setAirbnbCode] = useState('')
  const [guestId, setGuestId] = useState(params.get('guest') ?? '')
  const [guest, setGuest] = useState({ name: '', email: '', phone: '', nationality: '', idType: 'passport' as IdType, idNumber: '', notes: '' })
  const [scope, setScope] = useState<Scope>({ unitId: params.get('unit') ?? undefined })
  const [checkIn, setCheckIn] = useState(params.get('checkIn') ?? '')
  const [checkOut, setCheckOut] = useState(params.get('checkOut') ?? '')
  const [rate, setRate] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<'draft' | 'confirm' | null>(null)

  const catalog = options.data?.catalog
  const unit = scope.unitId && catalog ? catalog.unit(scope.unitId) : null
  const listing = unit ? options.data?.listings.find((l) => l.unitId === unit.id) : undefined
  const effectiveAccountId = accountId || listing?.accountId || ''
  const suggestedRate = unit ? (source === 'airbnb' ? unit.nightlyRate : round10k(unit.nightlyRate * 0.9)) : 0
  const nightlyRate = rate ?? suggestedRate
  const nights = checkIn && checkOut ? Math.max(0, daysBetween(checkIn, checkOut)) : 0
  const availabilityKey = unit && checkIn && checkOut ? `${unit.id}|${checkIn}|${checkOut}` : ''
  const availability = useResource(`booking.availability:${availabilityKey}`, () => (availabilityKey && unit ? booking.availability(unit.id, checkIn, checkOut) : Promise.resolve(null)))

  function pickScope(next: Scope) {
    setScope(next)
    setRate(null)
    if (next.unitId && source === 'airbnb') {
      const l = options.data?.listings.find((x) => x.unitId === next.unitId)
      if (l) setAccountId(l.accountId)
    }
  }

  async function submit(confirm: boolean) {
    if (!options.data) return
    const today = options.data.today
    const input: NewBooking = {
      guestId: guestId && guestId !== NEW_GUEST ? guestId : null,
      newGuest: guestId === NEW_GUEST ? guest : null,
      unitId: scope.unitId ?? '',
      source,
      airbnbAccountId: source === 'airbnb' ? effectiveAccountId || null : null,
      airbnbCode: source === 'airbnb' ? airbnbCode : null,
      checkIn: checkIn || today,
      checkOut: checkOut || addDays(today, 1),
      nightlyRate,
      notes,
      confirm,
    }
    setSaving(confirm ? 'confirm' : 'draft')
    setErrors({})
    try {
      const created = await booking.create(input)
      toast({ title: confirm ? `Confirmed ${created.code}` : `Saved ${created.code} as a draft`, description: `${created.guestName} · ${created.unitCode} · ${shortDay(created.checkIn)}` })
      navigate(`/bookings/${created.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the booking', description: Object.values(e)[0] })
    } finally {
      setSaving(null)
    }
  }

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data || !catalog) return <CardSkeleton lines={8} />
  const o = options.data
  const conflicts = availability.data?.conflicts ?? []
  const alternatives = availability.data?.alternatives ?? []
  const stayProblem = availability.data?.problem ?? null

  return (
    <>
      <PageBar fallback="/bookings" label="Bookings" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="src-title">
            <CardHeader id="src-title" title="Source" action={<Tabs label="Booking source" options={SOURCE_TABS} value={source} onChange={(v) => { setSource(v); setRate(null) }} />} />
            {source === 'airbnb' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Airbnb account" htmlFor="account" error={errors.airbnbAccountId} hint={listing ? `${unit?.code} is listed under ${o.accounts.find((a) => a.id === listing.accountId)?.name}` : undefined}>
                  <Select id="account" className="w-full" value={effectiveAccountId} options={[{ value: '', label: 'Pick the host account' }, ...o.accounts.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => setAccountId(e.target.value)} />
                </Field>
                <Field label="Confirmation code" htmlFor="code" error={errors.airbnbCode} hint="From the host inbox, for example HMK3T7Q2">
                  <Input id="code" value={airbnbCode} onChange={(e) => setAirbnbCode(e.target.value.toUpperCase())} className="font-mono" placeholder="HM……" />
                </Field>
              </div>
            ) : (
              <p className="text-sm text-muted">A direct booking takes the direct rate, 10% under the Airbnb price, and is paid to the cashbox or the bank.</p>
            )}
          </Card>

          <Card aria-labelledby="guest-title">
            <CardHeader id="guest-title" title="Guest" />
            <Field label="Guest" htmlFor="guest" error={errors.guestId}>
              <Select
                id="guest"
                className="w-full"
                value={guestId}
                options={[{ value: '', label: 'Pick a guest' }, { value: NEW_GUEST, label: '+ New guest' }, ...o.guests.map((g) => ({ value: g.id, label: `${g.name} · ${g.nationality}` }))]}
                onChange={(e) => setGuestId(e.target.value)}
              />
            </Field>
            {guestId === NEW_GUEST && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Full name" htmlFor="g-name" error={errors['guest.name']}>
                  <Input id="g-name" value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} />
                </Field>
                <Field label="Nationality" htmlFor="g-nat" error={errors['guest.nationality']}>
                  <Input id="g-nat" value={guest.nationality} onChange={(e) => setGuest({ ...guest, nationality: e.target.value })} />
                </Field>
                <Field label="Email" htmlFor="g-email" error={errors['guest.email']}>
                  <Input id="g-email" type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
                </Field>
                <Field label="Phone" htmlFor="g-phone" error={errors['guest.phone']}>
                  <Input id="g-phone" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} placeholder="+62 …" />
                </Field>
                <Field label="ID type" htmlFor="g-idtype">
                  <Select id="g-idtype" className="w-full" value={guest.idType} options={(['passport', 'ktp'] as IdType[]).map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} onChange={(e) => setGuest({ ...guest, idType: e.target.value as IdType })} />
                </Field>
                <Field label="ID number" htmlFor="g-idno">
                  <Input id="g-idno" value={guest.idNumber} onChange={(e) => setGuest({ ...guest, idNumber: e.target.value })} className="font-mono" />
                </Field>
              </div>
            )}
          </Card>

          <Card aria-labelledby="stay-title">
            <CardHeader id="stay-title" title="Stay" />
            <div className="space-y-4">
              <Field label="Unit" error={errors.unitId}>
                <ScopePicker catalog={catalog} value={scope} onChange={pickScope} className="grid grid-cols-1 gap-2 sm:grid-cols-3" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Check-in" htmlFor="in" error={errors.checkIn}>
                  <Input id="in" type="date" value={checkIn} min={o.today} onChange={(e) => setCheckIn(e.target.value)} />
                </Field>
                <Field label="Check-out" htmlFor="out" error={errors.checkOut ?? stayProblem ?? undefined}>
                  <Input id="out" type="date" value={checkOut} min={checkIn || o.today} onChange={(e) => setCheckOut(e.target.value)} />
                </Field>
                <Field label="Rate per night" htmlFor="rate" error={errors.nightlyRate} hint={unit && rate !== null && rate !== suggestedRate ? `List: ${money(suggestedRate)}` : undefined}>
                  <Input id="rate" type="number" inputMode="numeric" step={10_000} min={0} value={nightlyRate || ''} onChange={(e) => setRate(Number(e.target.value))} className="tabular" />
                </Field>
              </div>
              <Field label="Notes" htmlFor="notes">
                <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Arrival time, requests, who called" />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card aria-labelledby="avail-title">
            <CardHeader id="avail-title" title="Availability" />
            {!unit ? (
              <p className="text-sm text-muted">Pick a unit and the dates to check the nights.</p>
            ) : !checkIn || !checkOut ? (
              <p className="text-sm text-muted">{unit.code} picked. Add the dates.</p>
            ) : stayProblem ? (
              <p className="text-sm text-danger">{stayProblem}</p>
            ) : conflicts.length === 0 ? (
              <div className="rounded-panel bg-success-soft p-3.5 text-sm text-success">
                <CircleCheck aria-hidden className="mb-1 size-4" />
                {unit.code} is free for {plural(nights, 'night')}, {shortDay(checkIn)} to {shortDay(checkOut)}.
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="rounded-panel bg-danger-soft p-3.5 text-danger">
                  {unit.code} is held on these nights:
                  <ul className="mt-1 list-disc pl-4">
                    {conflicts.map((c) => (
                      <li key={c.id}>
                        {c.kind === 'block' ? BLOCK_REASON_LABEL[c.label as keyof typeof BLOCK_REASON_LABEL] ?? c.label : c.label}, {shortDay(c.from)} to {shortDay(c.to)}
                      </li>
                    ))}
                  </ul>
                </div>
                {alternatives.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs text-muted">Interchangeable units that are free:</p>
                    <div className="flex flex-wrap gap-2">
                      {alternatives.map((u) => (
                        <Button key={u.id} size="sm" variant="solid" className="font-mono" onClick={() => pickScope({ ...scope, unitId: u.id })}>
                          {u.code}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted">No interchangeable unit is free. Pick other dates or another villa.</p>
                )}
              </div>
            )}
          </Card>
          <Card aria-labelledby="sum-title">
            <CardHeader id="sum-title" title="Summary" />
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Nights</dt>
                <dd className="tabular">{nights}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Rate</dt>
                <dd className="tabular">{money(nightlyRate)}</dd>
              </div>
              <div className="flex justify-between border-t border-line-strong pt-2 font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{money(nights * nightlyRate)}</dd>
              </div>
            </dl>
            {errors.form && <p role="alert" className="mt-3 text-xs font-medium text-danger">{errors.form}</p>}
            <div className="mt-4 flex flex-col gap-2">
              <Button type="submit" variant="accent" loading={saving === 'confirm'} disabled={conflicts.length > 0}>
                {saving !== 'confirm' && <CircleCheck aria-hidden className="size-4" />} Confirm booking
              </Button>
              <Button variant="soft" loading={saving === 'draft'} onClick={() => void submit(false)}>
                {saving !== 'draft' && <Save aria-hidden className="size-4" />} Save as draft
              </Button>
            </div>
          </Card>
        </div>
      </form>
    </>
  )
}

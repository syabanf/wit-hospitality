import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { CircleCheck, Save, UsersRound } from 'lucide-react'
import type { NewBooking } from '@/application/ports'
import { BLOCK_REASON_LABEL, type BookingSource } from '@/domain/booking'
import { DEFAULT_PAYMENT_POLICY, depositAmount, DESK_METHODS, GATEWAY_METHODS, isGateway, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/domain/payment'
import { RuleError } from '@/domain/errors'
import { countryName, ID_TYPE_LABEL, ID_TYPES, type IdType } from '@/domain/guest'
import type { Scope } from '@/domain/property'
import { addDays, daysBetween, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { DayMarks } from '../shared/DayMarks'
import { NightPrices } from '../shared/NightPrices'
import { ScopePicker } from '../shared/ScopePicker'
import { GuestAlerts } from '../shared/GuestAlerts'
import { CountrySelect } from '../guests/DocumentFields'
import { PriceFields } from './PriceFields'
import { EMPTY_PRICE, toPriceChange, type PriceDraft } from './priceDraft'

const SOURCE_TABS = [
  { value: 'direct', label: 'Direct' },
  { value: 'airbnb', label: 'Airbnb' },
] as const

const NEW_GUEST = '__new'

/** One form for direct and manual Airbnb bookings, with a live availability check and alternatives. */
export default function NewBookingPage() {
  const { booking, payments, stayRules } = useServices()
  const policy = useResource('payments.policy', () => payments.policy())
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
  const [channelRate, setChannelRate] = useState<number | null>(null)
  const [price, setPrice] = useState<PriceDraft>(EMPTY_PRICE)
  const [bookBy, setBookBy] = useState<'type' | 'room'>('type')
  const [groupId, setGroupId] = useState('')
  const [notes, setNotes] = useState('')
  const [override, setOverride] = useState('')
  const [payMode, setPayMode] = useState<'none' | 'deposit' | 'full'>('deposit')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('qris')
  const [payAmount, setPayAmount] = useState<number | null>(null)
  const [payRef, setPayRef] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<'draft' | 'confirm' | null>(null)

  const catalog = options.data?.catalog
  // Villas whose identical rooms sell as a room type: the guest books the type and the operator assigns the room later.
  const roomTypes = catalog && scope.villaId ? catalog.groups.filter((g) => g.villaId === scope.villaId && g.operatorAssigns) : []
  const byType = roomTypes.length > 0 && bookBy === 'type'
  const group = byType ? (roomTypes.find((g) => g.id === groupId) ?? roomTypes[0] ?? null) : null
  const unit = !byType && scope.unitId && catalog ? catalog.unit(scope.unitId) : null
  const priceUnit = unit ?? (group && catalog ? (catalog.units.find((u) => u.groupId === group.id && u.status !== 'inactive') ?? null) : null)
  const listing = priceUnit ? options.data?.listings.find((l) => l.unitId === priceUnit.id) : undefined
  const effectiveAccountId = accountId || listing?.accountId || ''
  const nights = checkIn && checkOut ? Math.max(0, daysBetween(checkIn, checkOut)) : 0
  const channelPrice = channelRate ?? priceUnit?.nightlyRate ?? 0
  const priceChange = source === 'direct' ? toPriceChange(price) : null
  const quoteKey = priceUnit && checkIn && checkOut ? JSON.stringify([unit?.id ?? null, group?.id ?? null, checkIn, checkOut, source, channelPrice, priceChange]) : ''
  const quote = useResource(`booking.quote:${quoteKey}`, () => (quoteKey ? booking.quote({ unitId: unit?.id ?? null, groupId: group?.id ?? null, checkIn, checkOut, source, channelRate: source === 'direct' ? null : channelPrice, price: priceChange }) : Promise.resolve(null)))
  // A failed quote, NO_PRICE most often, shows its message in place of a total.
  const noPrice = quote.status === 'error' ? quote.error.message : null
  const planTo = quote.status === 'error' && quote.error instanceof RuleError && quote.error.code === 'NO_PRICE' && priceUnit?.groupId ? `/property/room-types/${priceUnit.groupId}` : null
  const stayTotal = noPrice ? 0 : (quote.data?.price.total ?? 0)
  const suggestedPay = payMode === 'full' ? stayTotal : depositAmount(stayTotal, policy.data ?? DEFAULT_PAYMENT_POLICY)
  const payNow = payAmount ?? suggestedPay
  const takesPayment = source === 'direct' && payMode !== 'none'
  const availabilityKey = unit && checkIn && checkOut ? `${unit.id}|${checkIn}|${checkOut}` : ''
  const availability = useResource(`booking.availability:${availabilityKey}`, () => (availabilityKey && unit ? booking.availability(unit.id, checkIn, checkOut) : Promise.resolve(null)))
  const typeKey = group && checkIn && checkOut ? `${group.id}|${checkIn}|${checkOut}` : ''
  const typeFree = useResource(`booking.roomType:${typeKey}`, () => (typeKey && group ? booking.roomTypeAvailability(group.id, checkIn, checkOut) : Promise.resolve(null)))
  const rulesKey = unit || group ? JSON.stringify([unit?.id ?? null, group?.id ?? null, checkIn, checkOut, source]) : ''
  const stayCheck = useResource(`stayRules.check:${rulesKey}`, () => (rulesKey ? stayRules.check({ unitId: unit?.id ?? null, groupId: group?.id ?? null, checkIn, checkOut, source }) : Promise.resolve(null)))
  const violations = stayCheck.data?.violations ?? []
  // A direct stay that breaks a rule saves only with a manager's reason; a channel stay comes in with a warning.
  const needsOverride = source === 'direct' && violations.length > 0
  const overrideReady = needsOverride && Boolean(stayCheck.data?.mayOverride) && overrideReason.trim().length >= 3

  /** A date before or on the arrival sets the arrival, with the minimum stay it asks; a later one sets the departure. */
  function pickDate(date: string) {
    if (!checkIn || date <= checkIn) {
      const mark = stayCheck.data?.marks.find((m) => m.date === date)
      setCheckIn(date)
      setCheckOut(addDays(date, mark?.minNights ?? 1))
    } else setCheckOut(date)
  }

  function pickScope(next: Scope) {
    setScope(next)
    setChannelRate(null)
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
      unitId: byType ? null : (scope.unitId ?? null),
      groupId: group?.id ?? null,
      source,
      airbnbAccountId: source === 'airbnb' ? effectiveAccountId || null : null,
      airbnbCode: source === 'airbnb' ? airbnbCode : null,
      checkIn: checkIn || today,
      checkOut: checkOut || addDays(today, 1),
      channelRate: source === 'direct' ? null : channelPrice,
      price: priceChange,
      notes,
      blacklistOverride: override || undefined,
      confirm,
      payment: takesPayment ? { kind: payMode === 'full' ? 'full' : 'deposit', method: payMethod, amount: payNow, reference: payRef } : null,
      override: overrideReady ? { reason: overrideReason } : null,
    }
    setSaving(confirm ? 'confirm' : 'draft')
    setErrors({})
    try {
      const created = await booking.create(input)
      toast({ title: confirm ? `Confirmed ${created.code}` : `Saved ${created.code} as a draft`, description: `${created.guestName} · ${created.roomType ? `${created.roomType}, room to assign` : created.unitCode} · ${shortDay(created.checkIn)}` })
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
  const picked = o.guests.find((g) => g.id === guestId) ?? null
  const conflicts = byType ? [] : (availability.data?.conflicts ?? [])
  const typeFull = (byType && typeFree.data !== null && typeFree.data !== undefined && typeFree.data.sellable < 1) || (!byType && Boolean(availability.data?.roomTypeFull))
  const overbooks = byType && !typeFull && typeFree.data?.free === 0
  const q = noPrice ? null : (quote.data ?? null)
  const fromPlan = q?.priceList === 'plan'
  const alternatives = availability.data?.alternatives ?? []
  const stayProblem = availability.data?.problem ?? null

  return (
    <>
      <PageBar
        fallback="/bookings"
        label="Bookings"
        actions={
          <Link to="/bookings/groups/new" className={buttonStyles({ variant: 'card' })}>
            <UsersRound aria-hidden className="size-4" /> Group booking
          </Link>
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="src-title">
            <CardHeader id="src-title" title="Source" action={<Tabs label="Booking source" options={SOURCE_TABS} value={source} onChange={(v) => { setSource(v); setChannelRate(null) }} />} />
            {source === 'airbnb' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Airbnb account" htmlFor="account" error={errors.airbnbAccountId} hint={listing ? `${unit?.code} is listed under ${o.accounts.find((a) => a.id === listing.accountId)?.name}` : undefined}>
                  <Select id="account" className="w-full" value={effectiveAccountId} options={[{ value: '', label: 'Pick the host account' }, ...o.accounts.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => setAccountId(e.target.value)} />
                </Field>
                <Field label="Confirmation code" htmlFor="code" error={errors.airbnbCode} hint="From the host inbox, for example HMK3T7Q2">
                  <Input id="code" value={airbnbCode} onChange={(e) => setAirbnbCode(e.target.value.toUpperCase())} className="font-mono" placeholder="HM……" />
                </Field>
                <Field label="Price per night Airbnb sold, Rp" htmlFor="channel-rate" error={errors.channelRate} hint="From the reservation; the booking keeps this price">
                  <Input id="channel-rate" type="number" inputMode="numeric" min={0} step={10_000} value={channelPrice || ''} onChange={(e) => setChannelRate(Number(e.target.value))} className="tabular" />
                </Field>
              </div>
            ) : (
              <p className="text-sm text-muted">A direct booking sells at the unit's Airbnb listing price, or at its room type's rate plan when the unit has no live listing. Give a staff rate or a discount below if the guest gets one; it is paid to the cashbox or the bank.</p>
            )}
          </Card>

          <Card aria-labelledby="guest-title">
            <CardHeader id="guest-title" title="Guest" />
            <Field label="Guest" htmlFor="guest" error={errors.guestId}>
              <Select
                id="guest"
                className="w-full"
                value={guestId}
                options={[{ value: '', label: 'Pick a guest' }, { value: NEW_GUEST, label: '+ New guest' }, ...o.guests.map((g) => ({ value: g.id, label: `${g.name} · ${countryName(g.nationality)}${g.blacklist ? ', blacklisted' : ''}` }))]}
                onChange={(e) => setGuestId(e.target.value)}
              />
            </Field>
            {picked && <GuestAlerts guest={picked} className="mt-4" />}
            {picked?.blacklist && (
              <Field label="Override reason" htmlFor="bl-override" error={errors.form} hint="Only a villa manager may book a blacklisted guest; the reason goes on the audit trail" className="mt-4">
                <Input id="bl-override" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Why the operator takes this guest again" />
              </Field>
            )}
            {guestId === NEW_GUEST && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Full name" htmlFor="g-name" error={errors['guest.name']}>
                  <Input id="g-name" value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} />
                </Field>
                <Field label="Nationality" htmlFor="g-nat" error={errors['guest.nationality']}>
                  <CountrySelect id="g-nat" value={guest.nationality} onChange={(nationality) => setGuest({ ...guest, nationality })} />
                </Field>
                <Field label="Email" htmlFor="g-email" error={errors['guest.email']}>
                  <Input id="g-email" type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
                </Field>
                <Field label="Phone" htmlFor="g-phone" error={errors['guest.phone']}>
                  <Input id="g-phone" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} placeholder="+62 …" />
                </Field>
                <Field label="ID type" htmlFor="g-idtype">
                  <Select id="g-idtype" className="w-full" value={guest.idType} options={ID_TYPES.map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} onChange={(e) => setGuest({ ...guest, idType: e.target.value as IdType })} />
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
              <Field label={byType ? 'Villa' : 'Unit'} error={errors.unitId}>
                <ScopePicker catalog={catalog} value={scope} onChange={pickScope} units={!byType} className={`grid grid-cols-1 gap-2 ${byType ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`} />
              </Field>
              {roomTypes.length > 0 && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
                  <Field label="Book by">
                    <Tabs label="Book by" options={[{ value: 'type', label: 'Room type' }, { value: 'room', label: 'Specific room' }]} value={bookBy} onChange={setBookBy} />
                  </Field>
                  {byType && (
                    <Field label="Room type" htmlFor="room-type" hint="The guest books the type; you assign the room before check-in">
                      <Select id="room-type" className="w-full" value={group?.id ?? ''} options={roomTypes.map((g) => ({ value: g.id, label: g.name }))} onChange={(e) => setGroupId(e.target.value)} />
                    </Field>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Check-in" htmlFor="in" error={errors.checkIn}>
                  <Input id="in" type="date" value={checkIn} min={o.today} onChange={(e) => setCheckIn(e.target.value)} />
                </Field>
                <Field label="Check-out" htmlFor="out" error={errors.checkOut ?? stayProblem ?? undefined}>
                  <Input id="out" type="date" value={checkOut} min={checkIn || o.today} onChange={(e) => setCheckOut(e.target.value)} />
                </Field>
              </div>
              <Field label="Notes" htmlFor="notes">
                <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Arrival time, requests, who called" />
              </Field>
            </div>
          </Card>

          {source === 'direct' && (
            <Card aria-labelledby="price-title">
              <CardHeader id="price-title" title="Price" action={q && <span className="text-xs text-muted">{fromPlan ? 'Price from the rate plan' : 'Price from the Airbnb listing'}</span>} />
              {noPrice && (
                <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-panel bg-danger-soft p-3 text-sm text-danger">
                  <p className="min-w-0 flex-1">{noPrice}</p>
                  {planTo && (
                    <Link to={planTo} className={buttonStyles({ variant: 'accent', size: 'sm' })}>
                      Set a rate plan
                    </Link>
                  )}
                </div>
              )}
              {q && (
                <div className="mb-4 space-y-3">
                  <p className="text-sm text-muted">
                    {plural(q.listRates.length, 'night')} at the {fromPlan ? 'rate plan, as the unit has no live Airbnb listing' : 'listing'}: <span className="font-medium text-fg tabular">{money(q.price.list)}</span>
                  </p>
                  <NightPrices nights={q.nights} />
                </div>
              )}
              <PriceFields idPrefix="new" value={price} onChange={setPrice} errors={errors} quote={q} />
            </Card>
          )}

          {source === 'direct' && (
            <Card aria-labelledby="paynow-title">
              <CardHeader
                id="paynow-title"
                title="Payment"
                action={<Tabs label="Payment now" options={[{ value: 'none', label: 'Later' }, { value: 'deposit', label: 'Deposit' }, { value: 'full', label: 'Full' }]} value={payMode} onChange={(v) => { setPayMode(v); setPayAmount(null) }} />}
              />
              {payMode === 'none' ? (
                <p className="text-sm text-muted">No money now. The booking shows the whole stay as outstanding and you can send a payment link later.</p>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Method" htmlFor="pay-method" hint={isGateway(payMethod) ? 'The guest gets a link to pay' : 'Recorded now as received'}>
                    <Select id="pay-method" className="w-full" value={payMethod} options={[...GATEWAY_METHODS, ...DESK_METHODS].map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)} />
                  </Field>
                  <Field label="Amount, Rp" htmlFor="pay-amount" error={errors['payment.amount']} hint={payMode === 'deposit' ? `${policy.data?.depositPct ?? 30}% of the stay` : 'The whole stay'}>
                    <Input id="pay-amount" type="number" inputMode="numeric" min={0} step={10_000} value={payNow || ''} onChange={(e) => setPayAmount(Number(e.target.value))} className="tabular" />
                  </Field>
                  {payMethod === 'bank_transfer' && (
                    <Field label="Bank reference" htmlFor="pay-ref" error={errors['payment.reference']}>
                      <Input id="pay-ref" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="TRF-…" />
                    </Field>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card aria-labelledby="avail-title">
            <CardHeader id="avail-title" title="Availability" />
            {byType ? (
              !group || !checkIn || !checkOut ? (
                <p className="text-sm text-muted">Pick the room type and the dates to check the nights.</p>
              ) : typeFree.data ? (
                <div className={`rounded-panel p-3.5 text-sm ${typeFull ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}>
                  <CircleCheck aria-hidden className="mb-1 size-4" />
                  {typeFull
                    ? `Every ${group.name} room is taken on at least one night, overbooking included.`
                    : overbooks
                      ? `Every ${group.name} room is taken on at least one night. The overbooking policy sells ${plural(typeFree.data.sellable, 'more stay')}; the night shows as overbooked until a room frees up or a guest is walked.`
                      : `${plural(typeFree.data.free, 'room')} of ${group.name} free on the tightest night, ${shortDay(checkIn)} to ${shortDay(checkOut)}. You assign the room later.`}
                </div>
              ) : (
                <p className="text-sm text-muted">Checking…</p>
              )
            ) : !unit ? (
              <p className="text-sm text-muted">Pick a unit and the dates to check the nights.</p>
            ) : !checkIn || !checkOut ? (
              <p className="text-sm text-muted">{unit.code} picked. Add the dates.</p>
            ) : stayProblem ? (
              <p className="text-sm text-danger">{stayProblem}</p>
            ) : typeFull ? (
              <p className="rounded-panel bg-danger-soft p-3.5 text-sm text-danger">{unit.code} is free, but stays waiting for a room fill every room of its type on at least one night.</p>
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
          {stayCheck.data && stayCheck.data.marks.length > 0 && (
            <Card aria-labelledby="rules-title">
              <CardHeader id="rules-title" title="Stay rules" />
              <DayMarks marks={stayCheck.data.marks} checkIn={checkIn} checkOut={checkOut} onPick={pickDate} label="Dates with their stay restrictions; pick the arrival, then the departure" />
              <p className="mt-2 text-xs text-muted">Tap the arrival, then the departure. CTA: no arrivals. CTD: no departures. Min: nights an arrival needs.</p>
              {violations.length > 0 && (
                <div role="alert" className={`mt-4 rounded-panel p-3.5 text-sm ${needsOverride ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning'}`}>
                  {needsOverride ? 'The stay breaks these rules:' : 'Airbnb sold this stay against these rules; it is kept with a warning:'}
                  <ul className="mt-1 list-disc pl-4">
                    {violations.map((v) => (
                      <li key={v.rule}>{v.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {needsOverride &&
                (stayCheck.data.mayOverride ? (
                  <Field label="Sell past the rules because" htmlFor="override" error={errors.override} hint="Kept on the booking and in the audit trail" className="mt-4">
                    <Input id="override" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Returning guest, owner's friend" />
                  </Field>
                ) : (
                  <p className="mt-3 text-xs text-muted">Change the dates, or ask a villa manager to sell past the rules.</p>
                ))}
            </Card>
          )}
          <Card aria-labelledby="sum-title">
            <CardHeader id="sum-title" title="Summary" />
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Nights</dt>
                <dd className="tabular">{nights}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">{source !== 'direct' ? 'Channel price' : fromPlan ? 'Rate plan price' : 'Listing price'}</dt>
                <dd className="tabular">{money(q?.price.list ?? 0)}</dd>
              </div>
              {q && q.price.subtotal !== q.price.list && (
                <div className="flex justify-between">
                  <dt className="text-muted">At the staff rate</dt>
                  <dd className="tabular">{money(q.price.subtotal)}</dd>
                </div>
              )}
              {q && q.price.discount > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted">Discount</dt>
                  <dd className="tabular">−{money(q.price.discount)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-line-strong pt-2 font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{money(stayTotal)}</dd>
              </div>
              {takesPayment && (
                <div className="flex justify-between text-accent-text">
                  <dt>{isGateway(payMethod) ? 'Link for' : 'Paid now'}</dt>
                  <dd className="tabular">{money(payNow)}</dd>
                </div>
              )}
            </dl>
            {errors.form && <p role="alert" className="mt-3 text-xs font-medium text-danger">{errors.form}</p>}
            <div className="mt-4 flex flex-col gap-2">
              <Button type="submit" variant="accent" loading={saving === 'confirm'} disabled={conflicts.length > 0 || typeFull || Boolean(noPrice) || Boolean(q?.beyondLimit && !q.mayApprove) || (needsOverride && !overrideReady)}>
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

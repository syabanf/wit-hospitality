import { useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowLeftRight, BedDouble, CalendarClock, CircleCheck, LogIn, LogOut, Pencil, Tag as TagIcon, UserX, XCircle } from 'lucide-react'
import type { BookingAction } from '@/application/ports'
import { ACTION_LABEL, BOOKING_STATUS_LABEL, canTransition, nextStep } from '@/domain/booking'
import { bookingFlow } from '@/domain/flow'
import { folioOwed } from '@/domain/folio'
import { beyondDiscountLimit, stayPrice } from '@/domain/pricing'
import { ID_TYPE_LABEL } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { Popover } from '../../ui/Popover'
import { Steps } from '../../ui/Steps'
import { useToast } from '../../ui/useToast'
import { BookingRows } from '../shared/BookingRows'
import { CheckInForm } from '../shared/CheckInForm'
import { CheckOutForm } from '../shared/CheckOutForm'
import { RequestRows } from '../shared/RequestRows'
import { TransactionRows } from '../shared/TransactionRows'
import { BookingPaymentCard } from '../payments/BookingPaymentCard'
import { StayServiceCard } from '../services/StayServiceCard'
import { FlowBar } from '../shared/FlowBar'
import { NightPrices } from '../shared/NightPrices'
import { buttonStyles } from '../../ui/buttonStyles'
import { ConciergeBell } from 'lucide-react'
import { BOOKING_TONE } from '../shared/tones'
import { FolioCard } from './FolioCard'
import { PriceFields } from './PriceFields'
import { priceDraftOf, toPriceChange, type PriceDraft } from './priceDraft'

const ICON = { confirmed: CircleCheck, checked_in: LogIn, checked_out: LogOut, cancelled: XCircle } as const

/** The record: next lifecycle step as the accent action, swap and stay adjustment beside it. */
export default function BookingPage() {
  const { id = '' } = useParams()
  const { booking } = useServices()
  const toast = useToast()
  const resource = useResource(`booking.detail:${id}`, () => booking.detail(id), { keepPrevious: false })
  const [busy, setBusy] = useState<'step' | 'cancel' | 'move' | 'adjust' | 'noshow' | 'notes' | 'price' | 'assign' | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  const [pricing, setPricing] = useState<PriceDraft | null>(null)
  const [editingNotes, setEditingNotes] = useState(false)
  const [params] = useSearchParams()
  const [desk, setDesk] = useState<'in' | 'out' | null>(params.get('desk') === 'in' ? 'in' : params.get('desk') === 'out' ? 'out' : null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: NonNullable<typeof busy>, label: string, action: () => Promise<unknown>, description?: string) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title: label, description })
      resource.reload()
      return true
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not ${label.toLowerCase()}`, description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="booking" back={{ to: '/bookings', label: 'Back to bookings' }}>
      {({ booking: b, steps, swapTargets, movements, others, today, requests, cashbox, transactions, invoice, folio, ending, assignable, nights: listNights, pricing: rules }) => {
        const step = nextStep(b)
        const live = b.status === 'draft' || b.status === 'confirmed' || b.status === 'checked_in'
        const needsRoom = !b.unitAssigned && step === 'checked_in'
        // The limit check runs here as the guest's price is typed, the same rule the API applies on save.
        const draftChange = pricing ? toPriceChange(pricing) : null
        const draftPrice = pricing ? stayPrice({ listRates: b.listRates, rateOverride: draftChange?.rateOverride ?? null, discount: draftChange?.discount ?? null }) : null
        const draftQuote = draftPrice ? { price: draftPrice, limitPct: rules.limitPct, beyondLimit: beyondDiscountLimit(draftPrice, rules.limitPct), mayApprove: rules.mayApprove } : null
        const StepIcon = step ? ICON[step] : null
        const transition = (to: BookingAction) =>
          run(to === 'cancelled' ? 'cancel' : 'step', `${BOOKING_STATUS_LABEL[to]} ${b.code}`, () => booking.transition(b.id, to), `${b.guestName} · ${b.unitCode}`)
        return (
          <>
            <PageBar
              fallback="/bookings"
              label="Bookings"
              actions={
                <>
                  {swapTargets.length > 0 && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <ArrowLeftRight aria-hidden className="size-4" /> Swap unit
                        </Button>
                      )}
                    >
                      {(close) => (
                        <form
                          onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault()
                            const f = new FormData(e.currentTarget)
                            const rate = String(f.get('rate') ?? '').trim()
                            const price = rate ? { rateOverride: Number(rate), discount: b.discount, reason: String(f.get('reason')) } : undefined
                            void run('move', `Moved ${b.code}`, () => booking.moveUnit(b.id, String(f.get('unit')), String(f.get('reason')), price), 'The movement is on the record').then((ok) => ok && close())
                          }}
                          className="space-y-3"
                        >
                          <p className="text-sm font-semibold">Move {b.guestName} to an interchangeable unit</p>
                          <Field label="Unit" htmlFor="swap-unit">
                            <Select id="swap-unit" name="unit" className="w-full" options={swapTargets.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))} />
                          </Field>
                          <Field label="Reason" htmlFor="swap-reason" error={errors.reason}>
                            <Input id="swap-reason" name="reason" placeholder="Why the guest moves" />
                          </Field>
                          {rules.channel ? (
                            <p className="text-xs text-muted">The stay keeps the price {b.sourceLabel} sold it for.</p>
                          ) : (
                            <Field label="Staff rate per night, Rp" htmlFor="swap-rate" error={errors.rateOverride} hint="Empty sells at the new unit's listing or rate plan; the balance follows">
                              <Input id="swap-rate" name="rate" type="number" inputMode="numeric" min={1} step={10000} defaultValue={b.rateOverride ?? ''} placeholder="List price" className="tabular" />
                            </Field>
                          )}
                          <Button type="submit" variant="solid" size="sm" loading={busy === 'move'}>
                            Move stay
                          </Button>
                        </form>
                      )}
                    </Popover>
                  )}
                  {live && !rules.channel && (
                    <Button variant="card" aria-pressed={pricing !== null} onClick={() => setPricing(pricing ? null : priceDraftOf(b))}>
                      <TagIcon aria-hidden className="size-4" /> Price
                    </Button>
                  )}
                  {live && (
                    <Button variant="card" aria-pressed={adjusting} onClick={() => setAdjusting((a) => !a)}>
                      <CalendarClock aria-hidden className="size-4" /> Adjust stay
                    </Button>
                  )}
                  {canTransition(b, 'cancelled') && (
                    <Popover
                      align="right"
                      className="w-72 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <XCircle aria-hidden className="size-4" /> Cancel
                        </Button>
                      )}
                    >
                      {(close) => (
                        <div className="space-y-3">
                          <p className="text-sm">Cancel {b.code}? The nights free up and the record stays for history.</p>
                          {(ending.cancelled.refund > 0 || ending.cancelled.retained > 0) && (
                            <p className="rounded-panel bg-raised p-2.5 text-xs">
                              {ending.cancelled.refund > 0 && <>Refunds {money(ending.cancelled.refund)} as a cash-out for approval. </>}
                              {ending.cancelled.retained > 0 && <>Keeps {money(ending.cancelled.retained)} as room revenue{b.source === 'direct' ? ', the deposit inside the policy window' : ''}.</>}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <Button size="sm" variant="accent" loading={busy === 'cancel'} onClick={() => void transition('cancelled').then((ok) => ok && close())}>
                              Cancel booking
                            </Button>
                            <Button size="sm" variant="soft" onClick={close}>
                              Keep it
                            </Button>
                          </div>
                        </div>
                      )}
                    </Popover>
                  )}
                  {canTransition(b, 'no_show') && b.checkIn <= today && (
                    <Popover
                      align="right"
                      className="w-72 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <UserX aria-hidden className="size-4" /> No-show
                        </Button>
                      )}
                    >
                      {(close) => (
                        <div className="space-y-3">
                          <p className="text-sm">Mark {b.code} as a no-show? The nights free up and open payment links close.</p>
                          {ending.no_show.retained > 0 && <p className="rounded-panel bg-raised p-2.5 text-xs">Keeps the {money(ending.no_show.retained)} paid as room revenue.</p>}
                          <div className="flex gap-2">
                            <Button size="sm" variant="accent" loading={busy === 'noshow'} onClick={() => void run('noshow', `No show ${b.code}`, () => booking.transition(b.id, 'no_show'), `${b.guestName} · ${b.unitCode}`).then((ok) => ok && close())}>
                              Mark no-show
                            </Button>
                            <Button size="sm" variant="soft" onClick={close}>
                              Keep it
                            </Button>
                          </div>
                        </div>
                      )}
                    </Popover>
                  )}
                  {step && StepIcon && (
                    <Button
                      variant="accent"
                      loading={busy === 'step'}
                      disabled={needsRoom}
                      title={needsRoom ? 'Assign a room first' : undefined}
                      aria-pressed={step === 'checked_in' ? desk === 'in' : step === 'checked_out' ? desk === 'out' : undefined}
                      onClick={() => (step === 'checked_in' ? setDesk(desk === 'in' ? null : 'in') : step === 'checked_out' ? setDesk(desk === 'out' ? null : 'out') : void transition(step))}
                    >
                      <StepIcon aria-hidden className="size-4" /> {ACTION_LABEL[step]}
                    </Button>
                  )}
                </>
              }
            />
            <FlowBar
              label={`Where ${b.code} stands`}
              steps={bookingFlow(b, { paid: invoice.paid, expected: invoice.expected, firstEntryId: invoice.payments.find((p) => p.transactionId)?.transactionId ?? null, allPosted: transactions.every((x) => x.status === 'posted' || x.status === 'reversed'), owed: folioOwed(folio) })}
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                {desk === 'in' && (
                  <Card as="div" aria-label="Check-in">
                    <p className="mb-4 text-lg font-semibold tracking-tight">Check-in</p>
                    <CheckInForm
                      booking={b}
                      cashbox={cashbox}
                      save={(details) => booking.checkIn(b.id, details)}
                      onDone={() => {
                        toast({ title: `Checked in ${b.guestName}`, description: `${b.unitCode} · ${b.code}` })
                        setDesk(null)
                        resource.reload()
                      }}
                      onCancel={() => setDesk(null)}
                    />
                  </Card>
                )}
                {desk === 'out' && (
                  <Card as="div" aria-label="Check-out">
                    <p className="mb-4 text-lg font-semibold tracking-tight">Check-out</p>
                    <CheckOutForm
                      booking={b}
                      onDone={(outcome) => {
                        if (outcome === 'out') {
                          toast({ title: `Checked out ${b.guestName}`, description: `${b.unitCode} · ${b.code}` })
                          setDesk(null)
                        }
                        resource.reload()
                      }}
                      onCancel={() => setDesk(null)}
                    />
                  </Card>
                )}
                {assignable.length > 0 || !b.unitAssigned ? (
                  <Card aria-labelledby="room-title" className={b.unitAssigned ? undefined : 'ring-2 ring-warning'}>
                    <CardHeader id="room-title" title={b.unitAssigned ? 'Room' : 'Assign a room'} />
                    <p className="mb-3 text-sm text-muted">
                      {b.unitAssigned
                        ? `${b.unitCode} is assigned. You can still change it before check-in.`
                        : `The guest booked a ${b.roomType ?? 'room'}. Pick the room before check-in; these are free for every night of the stay.`}
                    </p>
                    {assignable.length === 0 ? (
                      <p className="text-sm text-danger">No room of this type is free for the whole stay. Move another stay or change the dates.</p>
                    ) : (
                      <form
                        onSubmit={(e: FormEvent<HTMLFormElement>) => {
                          e.preventDefault()
                          const unitId = String(new FormData(e.currentTarget).get('unit') ?? '')
                          void run('assign', `Assigned a room to ${b.code}`, () => booking.assignUnit(b.id, unitId), `${b.guestName} · ${shortDay(b.checkIn)}`)
                        }}
                        className="flex flex-wrap items-end gap-2"
                      >
                        <Field label="Room" htmlFor="assign-unit" error={errors.unitId} className="min-w-48 flex-1">
                          <Select id="assign-unit" name="unit" className="w-full" options={assignable.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))} />
                        </Field>
                        <Button type="submit" variant={b.unitAssigned ? 'solid' : 'accent'} loading={busy === 'assign'}>
                          <BedDouble aria-hidden className="size-4" /> {b.unitAssigned ? 'Change room' : 'Assign room'}
                        </Button>
                      </form>
                    )}
                  </Card>
                ) : null}

                {pricing && (
                  <Card as="div" aria-label="Price of the stay">
                    <form
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        void run('price', `Repriced ${b.code}`, () => booking.setPrice(b.id, draftChange ?? { rateOverride: null, discount: null, reason: '' }), 'The deposit and the balance follow the new total').then((ok) => ok && setPricing(null))
                      }}
                      className="space-y-4"
                    >
                      <p className="text-lg font-semibold tracking-tight">Price of the stay</p>
                      <p className="text-sm text-muted">
                        {plural(b.nights, 'night')} at the list price: <span className="font-medium text-fg tabular">{money(b.price.list)}</span>. Clear both fields to go back to it.
                      </p>
                      <PriceFields idPrefix="bk" value={pricing} onChange={setPricing} errors={errors} quote={draftQuote} />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button type="submit" variant="accent" loading={busy === 'price'} disabled={Boolean(draftQuote?.beyondLimit && !draftQuote.mayApprove)}>
                          Save price {draftPrice && `· ${money(draftPrice.total)}`}
                        </Button>
                        <Button variant="soft" onClick={() => setPricing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </Card>
                )}

                <Card aria-label={`Booking ${b.code}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-xs text-muted">
                        {b.code}
                        {b.airbnbCode && ` · Airbnb ${b.airbnbCode}`}
                      </p>
                      <Headline className="mt-1">{b.guestName}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        {shortDay(b.checkIn)} to {shortDay(b.checkOut)} · {plural(b.nights, 'night')} · {b.sourceLabel}
                      </p>
                    </div>
                    <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>
                  </div>
                  <p className="mt-6 text-[44px] leading-none font-medium tracking-tight tabular">{money(b.total)}</p>
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Unit', b.unitAssigned ? <Link key="u" to={`/property/units/${b.unitId}`} className="hover:underline">{b.unitCode} · {b.place.unit.name}</Link> : `Unassigned · ${b.roomType ?? ''}`],
                      ['Villa', <Link key="v" to={`/property/villas/${b.place.villa.id}`} className="hover:underline">{b.place.villa.name}, {b.place.location.name}</Link>],
                      [rules.channel ? `Price ${b.sourceLabel} sold` : 'List price', money(b.price.list)],
                      ...(b.rateOverride !== null ? ([['Staff rate', `${money(b.rateOverride)} a night`]] as const) : []),
                      ...(b.discount ? ([['Discount', `−${money(b.price.discount)} · ${b.discount.reason}`]] as const) : []),
                      ['Average per night', money(b.rate)],
                      ['Booked on', shortDay(b.createdOn)],
                      ['Checked in', b.checkedInOn ? shortDay(b.checkedInOn) : 'Not yet'],
                      ['Checked out', b.checkedOutOn ? shortDay(b.checkedOutOn) : 'Not yet'],
                    ]}
                  />
                  <details className="mt-4 rounded-panel bg-raised px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium">Price per night and its source</summary>
                    <NightPrices nights={listNights} className="mt-3" />
                  </details>
                  {b.priceSetBy && (
                    <p className="mt-4 text-xs text-muted">
                      Priced by {b.priceSetBy.by} on {shortDay(b.priceSetBy.on)}
                      {b.priceSetBy.reason && `: ${b.priceSetBy.reason}`}
                      {b.priceSetBy.approvedBy && `. Past the ${rules.limitPct}% limit, allowed by ${b.priceSetBy.approvedBy}.`}
                    </p>
                  )}
                  {b.requestedUnitId !== b.unitId && b.unitAssigned && movements.length > 0 && (
                    <p className="mt-4 rounded-panel bg-info-soft p-3.5 text-sm text-body">
                      The guest asked for <span className="font-mono font-medium">{movements[0]?.from.code}</span>; the stay now sits in <span className="font-mono font-medium">{b.unitCode}</span>.
                    </p>
                  )}
                </Card>

                {adjusting && (
                  <Card as="div" aria-label="Adjust the stay">
                    <form
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const f = new FormData(e.currentTarget)
                        const channelRate = f.get('channelRate') ? Number(f.get('channelRate')) : undefined
                        void run('adjust', `Changed ${b.code}`, () => booking.adjustStay(b.id, String(f.get('in')), String(f.get('out')), channelRate), rules.channel ? 'New nights at the price the channel charged' : 'New nights at the list price').then((ok) => ok && setAdjusting(false))
                      }}
                      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
                    >
                      <Field label="Check-in" htmlFor="adj-in" error={errors.checkIn} hint={b.status === 'checked_in' ? 'Fixed once the guest is in' : undefined}>
                        <Input id="adj-in" name="in" type="date" defaultValue={b.checkIn} readOnly={b.status === 'checked_in'} />
                      </Field>
                      <Field label="Check-out" htmlFor="adj-out" error={errors.checkOut ?? errors.form}>
                        <Input id="adj-out" name="out" type="date" defaultValue={b.checkOut} min={today} />
                      </Field>
                      {rules.channel && (
                        <Field label={`Price per extra night ${b.sourceLabel} charged, Rp`} htmlFor="adj-rate" error={errors.channelRate ?? errors.form} hint="Only for nights the stay gains; nights already sold keep their price">
                          <Input id="adj-rate" name="channelRate" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={b.listRates.at(-1) ?? ''} className="tabular" />
                        </Field>
                      )}
                      <div className="flex gap-2 sm:col-span-2">
                        <Button type="submit" variant="accent" loading={busy === 'adjust'}>
                          Save dates
                        </Button>
                        <Button variant="soft" onClick={() => setAdjusting(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </Card>
                )}

                <Card aria-labelledby="moves-title">
                  <CardHeader id="moves-title" title="Unit movements" />
                  {movements.length === 0 ? (
                    <p className="text-sm text-muted">{b.unitAssigned ? `The stay has stayed in ${b.unitCode}.` : 'No room assigned yet.'}</p>
                  ) : (
                    <ol className="divide-y divide-line">
                      {movements.map((m, i) => (
                        <li key={i} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 text-sm">
                          <span className="font-mono font-medium">{m.from.code}</span>
                          <ArrowLeftRight aria-hidden className="size-4 text-muted" />
                          <span className="font-mono font-medium">{m.to.code}</span>
                          <span className="min-w-0 flex-1 truncate text-muted">{m.reason}</span>
                          <span className="text-xs text-muted">{m.by} · {shortDay(m.on)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>

                {(b.arrival || b.departure) && (
                  <Card aria-labelledby="desk-title">
                    <CardHeader id="desk-title" title="Front desk record" />
                    <FactGrid
                      className="grid-cols-2 sm:grid-cols-3"
                      facts={[
                        ...(b.arrival
                          ? ([
                              ['Arrived at', b.arrival.arrivalTime || 'Not noted'],
                              ['Party', `${plural(b.arrival.adults, 'adult')}${b.arrival.children ? `, ${plural(b.arrival.children, 'child').replace('childs', 'children')}` : ''}`],
                              ['Deposit held', money(b.arrival.deposit)],
                              ['ID checked', b.arrival.idVerified ? 'Yes' : 'No'],
                              ['Keys handed', b.arrival.keysHanded ? 'Yes' : 'No'],
                              ['House rules', b.arrival.rulesExplained ? 'Explained' : 'Skipped'],
                            ] as const)
                          : []),
                        ...(b.departure
                          ? ([
                              ['Deposit returned', money(b.departure.depositReturned)],
                              ['Departure charges', money(b.departure.extraCharges)],
                              ['Room inspected', b.departure.roomInspected ? 'Yes' : 'No'],
                            ] as const)
                          : []),
                      ]}
                    />
                    {(b.arrival?.notes || b.departure?.notes) && <p className="mt-4 text-sm text-body">{[b.arrival?.notes, b.departure?.notes].filter(Boolean).join(' · ')}</p>}
                  </Card>
                )}

                <StayServiceCard booking={b} today={today} onPaid={resource.reload} />

                <Card aria-labelledby="rq-title">
                  <CardHeader
                    id="rq-title"
                    title="Requests"
                    action={
                      b.status === 'checked_in' && (
                        <Link to={`/services?new=1&booking=${b.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                          <ConciergeBell aria-hidden className="size-3.5" /> New request
                        </Link>
                      )
                    }
                  />
                  <RequestRows requests={requests} today={today} empty="No requests for this stay." />
                </Card>

                <BookingPaymentCard invoice={invoice} onChanged={resource.reload} />

                <FolioCard booking={b} folio={folio} limitPct={rules.limitPct} mayApprove={rules.mayApprove} onChanged={resource.reload} />

                <Card aria-labelledby="money-title">
                  <CardHeader id="money-title" title="Money" />
                  <TransactionRows rows={transactions} empty="No cash entry links to this stay yet. Deposits and departure charges appear here." />
                </Card>

                <Card aria-labelledby="notes-title">
                  <CardHeader
                    id="notes-title"
                    title="Notes"
                    action={
                      <Button size="sm" variant="soft" aria-pressed={editingNotes} onClick={() => setEditingNotes((v) => !v)}>
                        <Pencil aria-hidden className="size-3.5" /> Edit
                      </Button>
                    }
                  />
                  {editingNotes ? (
                    <form
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        void run('notes', `Notes saved for ${b.code}`, () => booking.updateNotes(b.id, String(new FormData(e.currentTarget).get('notes') ?? ''))).then((ok) => ok && setEditingNotes(false))
                      }}
                      className="space-y-3"
                    >
                      <Textarea name="notes" defaultValue={b.notes} rows={3} aria-label="Booking notes" placeholder="Requests, preferences, who to call" />
                      <div className="flex gap-2">
                        <Button type="submit" variant="accent" loading={busy === 'notes'}>
                          Save notes
                        </Button>
                        <Button variant="soft" onClick={() => setEditingNotes(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <p className="text-sm text-body">{b.notes || <span className="text-muted">No notes on this stay.</span>}</p>
                  )}
                </Card>
              </div>

              <div className="space-y-4">
                <Card aria-labelledby="steps-title">
                  <CardHeader id="steps-title" title="Progress" />
                  <Steps label="Booking progress" steps={steps} />
                </Card>
                <Card aria-labelledby="guest-title">
                  <CardHeader id="guest-title" title="Guest" />
                  <div className="flex items-center gap-3">
                    <Avatar name={b.guestName} />
                    <div className="min-w-0">
                      <Link to={`/guests/${b.guestId}`} className="block truncate font-medium hover:underline">
                        {b.guestName}
                      </Link>
                      <p className="truncate text-xs text-muted">
                        {b.guest.nationality} · {ID_TYPE_LABEL[b.guest.idType]} {b.guest.idNumber}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1 text-sm">
                    <a href={`mailto:${b.guest.email}`} className="block truncate text-accent-text hover:underline">
                      {b.guest.email}
                    </a>
                    <a href={`tel:${b.guest.phone.replace(/\s/g, '')}`} className="block text-accent-text hover:underline">
                      {b.guest.phone}
                    </a>
                  </div>
                  {others.length > 0 && (
                    <div className="mt-4 border-t border-line pt-4">
                      <p className="mb-2 text-xs font-semibold tracking-wider text-subtle uppercase">Other stays</p>
                      <BookingRows bookings={others} empty="" />
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

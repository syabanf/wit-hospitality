import { useState } from 'react'
import { useNavigate } from 'react-router'
import { CircleCheck, Plus, Save, Trash2 } from 'lucide-react'
import type { NewBookingGroup } from '@/application/ports'
import { GROUP_BILLING_LABEL, GROUP_BILLINGS, GROUP_SOURCE_LABEL, GROUP_SOURCES, type GroupBilling, type GroupSource, type GroupStayInput } from '@/domain/group'
import { RuleError } from '@/domain/errors'
import { ID_TYPE_LABEL, type IdType } from '@/domain/guest'
import { DEFAULT_PAYMENT_POLICY, depositAmount, DESK_METHODS, GATEWAY_METHODS, isGateway, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/domain/payment'
import { addDays, daysBetween } from '@/lib/dates'
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

const NEW_GUEST = '__new'

/** A stay row as the form holds it: `pick` is `unit:<id>` or `type:<id>`, the rate is typed text. */
interface StayDraft {
  key: number
  pick: string
  checkIn: string
  checkOut: string
  adults: number
  children: number
  rate: string
}

const toStay = (d: StayDraft, rateReason: string): GroupStayInput => {
  const [kind, id = ''] = d.pick.split(':')
  const rate = Number(d.rate)
  return { unitId: kind === 'unit' ? id : null, roomTypeId: kind === 'type' ? id : null, checkIn: d.checkIn, checkOut: d.checkOut, adults: d.adults, children: d.children, price: rate > 0 ? { rateOverride: rate, discount: null, reason: rateReason } : null }
}

/** One form for a party in several units: shared dates, a row per unit or room type, one deposit, all or nothing. */
export default function NewGroupPage() {
  const { groups } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const data = useResource('groups.formOptions', () => groups.formOptions())
  const today = data.data?.options.today ?? ''

  const [name, setName] = useState('')
  const [guestId, setGuestId] = useState('')
  const [guest, setGuest] = useState({ name: '', email: '', phone: '', nationality: '', idType: 'passport' as IdType, idNumber: '', notes: '' })
  const [source, setSource] = useState<GroupSource>('direct')
  const [billing, setBilling] = useState<GroupBilling>('master')
  const [dates, setDates] = useState<{ checkIn: string; checkOut: string } | null>(null)
  const [drafts, setDrafts] = useState<StayDraft[]>([])
  const [discountPct, setDiscountPct] = useState('')
  const [discountReason, setDiscountReason] = useState('')
  const [note, setNote] = useState('')
  const [payMode, setPayMode] = useState<'none' | 'deposit'>('deposit')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('bank_transfer')
  const [payAmount, setPayAmount] = useState<number | null>(null)
  const [payRef, setPayRef] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<'draft' | 'confirm' | null>(null)
  /** Set once a stay restriction refused the group: a villa manager may then sell past it with a reason. */
  const [restricted, setRestricted] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')

  const shared = dates ?? { checkIn: today, checkOut: today ? addDays(today, 3) : '' }
  const rows = drafts.length ? drafts : [1, 2].map((key) => ({ key, pick: '', checkIn: shared.checkIn, checkOut: shared.checkOut, adults: 2, children: 0, rate: '' }))
  const discount = Number(discountPct) > 0 ? { pct: Number(discountPct), reason: discountReason } : null
  const rateReason = `Group rate${name.trim() ? `, ${name.trim()}` : ''}`
  const stays = rows.map((d) => toStay(d, rateReason))
  const picked = stays.every((st) => st.unitId || st.roomTypeId)
  const checkKey = picked ? JSON.stringify([stays, discount]) : ''
  const check = useResource(`groups.check:${checkKey}`, () => (checkKey ? groups.check(stays, discount) : Promise.resolve(null)))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { options, policy } = data.data
  const cat = options.catalog
  const picks = [
    ...cat.groups.filter((g) => g.operatorAssigns).map((g) => ({ value: `type:${g.id}`, label: `${g.name}, any room (${cat.villas.find((v) => v.id === g.villaId)?.name ?? ''})` })),
    ...cat.units.filter((u) => u.status === 'active').map((u) => ({ value: `unit:${u.id}`, label: `${u.code} · ${u.name}` })),
  ]
  const result = check.data ?? null
  const total = result?.total ?? 0
  const payNow = payAmount ?? depositAmount(total, policy ?? DEFAULT_PAYMENT_POLICY)
  const clashes = result?.clashes ?? []
  const blocked = clashes.length > 0 || Boolean(result?.quotes.some((q) => q.problem || (q.quote?.beyondLimit && !q.quote.mayApprove)))

  const edit = (key: number, patch: Partial<StayDraft>) => setDrafts(rows.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  /** New shared dates move every stay still on the old ones; a stay given its own dates keeps them. */
  function shareDates(next: { checkIn: string; checkOut: string }) {
    setDrafts(rows.map((d) => (d.checkIn === shared.checkIn && d.checkOut === shared.checkOut ? { ...d, ...next } : d)))
    setDates(next)
  }

  async function submit(confirm: boolean) {
    const input: NewBookingGroup = {
      name,
      guestId: guestId && guestId !== NEW_GUEST ? guestId : null,
      newGuest: guestId === NEW_GUEST ? guest : null,
      source,
      billing,
      stays,
      discount,
      note,
      confirm,
      deposit: payMode === 'deposit' ? { kind: 'deposit', method: payMethod, amount: payNow, reference: payRef, note: '' } : null,
      override: restricted && overrideReason.trim() ? { reason: overrideReason } : null,
    }
    setSaving(confirm ? 'confirm' : 'draft')
    setErrors({})
    try {
      const { group, link } = await groups.create(input)
      toast({ title: `${confirm ? 'Confirmed' : 'Saved'} ${group.code}`, description: link ? `${plural(stays.length, 'stay')}; the deposit link is on the group page` : `${group.name} · ${plural(stays.length, 'stay')}` })
      navigate(`/bookings/groups/${group.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      if (error instanceof RuleError && error.code === 'RESTRICTION_VIOLATED') setRestricted(true)
      toast({ tone: 'danger', title: 'Could not book the group', description: Object.values(e)[0] })
    } finally {
      setSaving(null)
    }
  }

  return (
    <>
      <PageBar fallback="/bookings/groups" label="Groups" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="group-title">
            <CardHeader id="group-title" title="Group" action={<Tabs label="Source" options={GROUP_SOURCES.map((s) => ({ value: s, label: GROUP_SOURCE_LABEL[s] }))} value={source} onChange={setSource} />} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="g-name" error={errors.name} hint="The couple, the family or the company">
                <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Menon wedding" />
              </Field>
              <Field label="Lead guest" htmlFor="g-lead" error={errors.guestId} hint="Every stay is booked in this name">
                <Select id="g-lead" className="w-full" value={guestId} options={[{ value: '', label: 'Pick the lead guest' }, { value: NEW_GUEST, label: '+ New guest' }, ...options.guests.map((g) => ({ value: g.id, label: `${g.name} · ${g.nationality}` }))]} onChange={(e) => setGuestId(e.target.value)} />
              </Field>
            </div>
            {guestId === NEW_GUEST && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {(['name', 'nationality', 'email', 'phone'] as const).map((k) => (
                  <Field key={k} label={k === 'name' ? 'Full name' : k.charAt(0).toUpperCase() + k.slice(1)} htmlFor={`ng-${k}`} error={errors[`guest.${k}`]}>
                    <Input id={`ng-${k}`} value={guest[k]} onChange={(e) => setGuest({ ...guest, [k]: e.target.value })} />
                  </Field>
                ))}
                <Field label="ID type" htmlFor="ng-idtype">
                  <Select id="ng-idtype" className="w-full" value={guest.idType} options={(['passport', 'ktp'] as IdType[]).map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} onChange={(e) => setGuest({ ...guest, idType: e.target.value as IdType })} />
                </Field>
                <Field label="ID number" htmlFor="ng-idno">
                  <Input id="ng-idno" value={guest.idNumber} onChange={(e) => setGuest({ ...guest, idNumber: e.target.value })} className="font-mono" />
                </Field>
              </div>
            )}
            <div className="mt-4">
              <Field label="Billing" hint={billing === 'master' ? 'The group pays every room night on one master folio; each stay pays its own extras' : 'Each stay pays its own folio'}>
                <Tabs label="Billing" options={GROUP_BILLINGS.map((b) => ({ value: b, label: GROUP_BILLING_LABEL[b] }))} value={billing} onChange={setBilling} />
              </Field>
            </div>
          </Card>

          <Card aria-labelledby="stays-title">
            <CardHeader id="stays-title" title="Stays" action={<span className="text-xs text-muted">{plural(rows.length, 'unit')}</span>} />
            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Check-in for everyone" htmlFor="g-in">
                <Input id="g-in" type="date" value={shared.checkIn} min={today} onChange={(e) => shareDates({ ...shared, checkIn: e.target.value })} />
              </Field>
              <Field label="Check-out for everyone" htmlFor="g-out" hint={shared.checkIn && shared.checkOut ? plural(Math.max(0, daysBetween(shared.checkIn, shared.checkOut)), 'night') : undefined}>
                <Input id="g-out" type="date" value={shared.checkOut} min={shared.checkIn || today} onChange={(e) => shareDates({ ...shared, checkOut: e.target.value })} />
              </Field>
            </div>
            {errors.stays && <p role="alert" className="mb-3 text-sm text-danger">{errors.stays}</p>}
            <ol className="space-y-3">
              {rows.map((d, i) => {
                const q = result?.quotes[i]
                const clash = clashes.find((c) => c.index === i)
                return (
                  <li key={d.key} className={`rounded-panel bg-raised p-3.5 ${clash ? 'ring-2 ring-danger' : ''}`}>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]">
                      <Field label={`Stay ${i + 1}`} htmlFor={`st-${d.key}`} error={errors[`stays.${i}.unitId`]} className="col-span-2 sm:col-span-1">
                        <Select id={`st-${d.key}`} className="w-full" value={d.pick} options={[{ value: '', label: 'Pick a unit or a room type' }, ...picks]} onChange={(e) => edit(d.key, { pick: e.target.value })} />
                      </Field>
                      <Field label="Check-in" htmlFor={`st-in-${d.key}`}>
                        <Input id={`st-in-${d.key}`} type="date" value={d.checkIn} min={today} onChange={(e) => edit(d.key, { checkIn: e.target.value })} />
                      </Field>
                      <Field label="Check-out" htmlFor={`st-out-${d.key}`} error={errors[`stays.${i}.checkOut`]}>
                        <Input id={`st-out-${d.key}`} type="date" value={d.checkOut} min={d.checkIn} onChange={(e) => edit(d.key, { checkOut: e.target.value })} />
                      </Field>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
                      <Field label="Adults" htmlFor={`st-a-${d.key}`} error={errors[`stays.${i}.adults`]}>
                        <Input id={`st-a-${d.key}`} type="number" min={1} value={d.adults} onChange={(e) => edit(d.key, { adults: Number(e.target.value) })} />
                      </Field>
                      <Field label="Children" htmlFor={`st-c-${d.key}`}>
                        <Input id={`st-c-${d.key}`} type="number" min={0} value={d.children} onChange={(e) => edit(d.key, { children: Number(e.target.value) })} />
                      </Field>
                      <Field label="Staff rate, Rp" htmlFor={`st-r-${d.key}`} hint="Empty sells at the list">
                        <Input id={`st-r-${d.key}`} type="number" inputMode="numeric" min={0} step={10_000} value={d.rate} onChange={(e) => edit(d.key, { rate: e.target.value })} className="tabular" />
                      </Field>
                      <Button variant="soft" size="sm" disabled={rows.length <= 2} aria-label={`Remove stay ${i + 1}`} onClick={() => setDrafts(rows.filter((x) => x.key !== d.key))}>
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                    <p className={`mt-2 text-xs ${clash || q?.problem ? 'text-danger' : 'text-muted'}`}>
                      {clash ? `${clash.label} ${clash.detail}` : q?.problem ? q.problem : q?.quote ? `${money(q.quote.price.total)}${q.quote.price.discount > 0 ? `, ${money(q.quote.price.discount)} off` : ''} at the ${q.quote.priceList === 'plan' ? 'rate plan' : 'Airbnb listing'}${q.quote.beyondLimit && !q.quote.mayApprove ? '; past the discount limit, ask a villa manager' : ''}` : 'Pick the unit to see the price.'}
                    </p>
                  </li>
                )
              })}
            </ol>
            <Button variant="soft" size="sm" className="mt-3" onClick={() => setDrafts([...rows, { key: Math.max(...rows.map((r) => r.key)) + 1, pick: '', checkIn: shared.checkIn, checkOut: shared.checkOut, adults: 2, children: 0, rate: '' }])}>
              <Plus aria-hidden className="size-4" /> Add a unit
            </Button>
          </Card>

          <Card aria-labelledby="discount-title">
            <CardHeader id="discount-title" title="Group discount" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              <Field label="Percent off" htmlFor="g-disc" error={errors['discount.pct']} hint={`Limit ${policy.discountLimitPct}%${data.data.mayApprove ? ', you may go past it' : ''}`}>
                <Input id="g-disc" type="number" min={0} max={100} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} className="tabular" />
              </Field>
              <Field label="Reason" htmlFor="g-disc-reason" error={errors['discount.reason']} hint="On every stay without a discount of its own">
                <Input id="g-disc-reason" value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} placeholder="Wedding party of three villas" />
              </Field>
            </div>
            <Field label="Note" htmlFor="g-note" className="mt-4">
              <Textarea id="g-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Event, arrival plan, who pays what" />
            </Field>
          </Card>

          <Card aria-labelledby="gdep-title">
            <CardHeader id="gdep-title" title="Deposit" action={<Tabs label="Deposit now" options={[{ value: 'none', label: 'Later' }, { value: 'deposit', label: 'Deposit' }]} value={payMode} onChange={(v) => { setPayMode(v); setPayAmount(null) }} />} />
            {payMode === 'none' ? (
              <p className="text-sm text-muted">No money now. Take the deposit from the group page later.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Method" htmlFor="gd-method" hint={isGateway(payMethod) ? 'The lead guest gets one link' : 'Recorded now as received'}>
                  <Select id="gd-method" className="w-full" value={payMethod} options={[...DESK_METHODS, ...GATEWAY_METHODS].map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)} />
                </Field>
                <Field label="Amount, Rp" htmlFor="gd-amount" error={errors['deposit.amount']} hint={`${policy.depositPct}% of the group`}>
                  <Input id="gd-amount" type="number" inputMode="numeric" min={0} step={10_000} value={payNow || ''} onChange={(e) => setPayAmount(Number(e.target.value))} className="tabular" />
                </Field>
                {payMethod === 'bank_transfer' && (
                  <Field label="Bank reference" htmlFor="gd-ref" error={errors['deposit.reference']}>
                    <Input id="gd-ref" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="TRF-…" />
                  </Field>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card aria-labelledby="gsum-title">
            <CardHeader id="gsum-title" title="Summary" />
            {clashes.length > 0 && (
              <div role="alert" className="mb-4 rounded-panel bg-danger-soft p-3.5 text-sm text-danger">
                The whole group is refused while a unit is taken:
                <ul className="mt-1 list-disc pl-4">
                  {clashes.map((c) => (
                    <li key={c.index}>
                      {c.label} {c.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Units</dt>
                <dd className="tabular">{rows.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Guests</dt>
                <dd className="tabular">{rows.reduce((s, d) => s + d.adults + d.children, 0)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Billing</dt>
                <dd>{GROUP_BILLING_LABEL[billing]}</dd>
              </div>
              <div className="flex justify-between border-t border-line-strong pt-2 font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{money(total)}</dd>
              </div>
              {payMode === 'deposit' && (
                <div className="flex justify-between text-accent-text">
                  <dt>{isGateway(payMethod) ? 'Link for' : 'Paid now'}</dt>
                  <dd className="tabular">{money(payNow)}</dd>
                </div>
              )}
            </dl>
            {errors.form && <p role="alert" className="mt-3 text-xs font-medium text-danger">{errors.form}</p>}
            {restricted && (
              <Field label="Sell past the stay rules because" htmlFor="group-override" hint="A villa manager only; kept on every stay" className="mt-3">
                <Input id="group-override" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Wedding party agreed with the owner" />
              </Field>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <Button type="submit" variant="accent" loading={saving === 'confirm'} disabled={blocked}>
                {saving !== 'confirm' && <CircleCheck aria-hidden className="size-4" />} Confirm group
              </Button>
              <Button variant="soft" loading={saving === 'draft'} disabled={blocked} onClick={() => void submit(false)}>
                {saving !== 'draft' && <Save aria-hidden className="size-4" />} Save as draft
              </Button>
            </div>
          </Card>
        </div>
      </form>
    </>
  )
}

import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { HandCoins, LogIn, Plus, XCircle } from 'lucide-react'
import type { GroupPaymentInput } from '@/application/ports'
import { BOOKING_STATUS_LABEL } from '@/domain/booking'
import { GROUP_BILLING_LABEL, GROUP_SOURCE_LABEL, GROUP_STATUS_LABEL, liveStay } from '@/domain/group'
import { DESK_METHODS, GATEWAY_METHODS, isGateway, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, type PaymentMethod } from '@/domain/payment'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
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
import { useToast } from '../../ui/useToast'
import { CheckRow } from '../shared/CheckRow'
import { FlowBar } from '../shared/FlowBar'
import { FolioLines } from '../shared/FolioLines'
import { BOOKING_TONE, GROUP_TONE } from '../shared/tones'
import { GroupStayForm } from './GroupStayForm'

/** The group record: its stays with their balances, the master folio, the group's payments and the desk actions. */
export default function GroupPage() {
  const { id = '' } = useParams()
  const { groups, booking } = useServices()
  const toast = useToast()
  const resource = useResource(`groups.detail:${id}`, () => groups.detail(id), { keepPrevious: false })
  const options = useResource('groups.formOptions', () => groups.formOptions())
  const [busy, setBusy] = useState<string | null>(null)
  const [desk, setDesk] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: string, label: string, action: () => Promise<unknown>, description?: string) {
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
      toast({ tone: 'danger', title: `Could not ${label.charAt(0).toLowerCase()}${label.slice(1)}`, description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="group" back={{ to: '/bookings/groups', label: 'Back to groups' }}>
      {({ row, stays, master, batches, deposit, owed, arriving, flow, may }) => {
        const g = row.group
        const open = row.stays.filter((b) => b.status === 'draft' || b.status === 'confirmed')
        const live = row.stays.some(liveStay)
        const units = options.data?.options.catalog.units.filter((u) => u.status === 'active' && g.villaIds.includes(u.villaId)) ?? []
        return (
          <>
            <PageBar
              fallback="/bookings/groups"
              label="Groups"
              actions={
                <>
                  {may.edit && live && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <Plus aria-hidden className="size-4" /> Add stay
                        </Button>
                      )}
                    >
                      {(close) => (
                        <GroupStayForm
                          name={g.name}
                          units={units}
                          checkIn={row.checkIn}
                          checkOut={row.checkOut}
                          leadBlacklisted={Boolean(options.data?.options.guests.find((x) => x.id === g.leadGuestId)?.blacklist)}
                          busy={busy === 'add'}
                          errors={errors}
                          onAdd={(stay, overrides) => void run('add', `Added a stay to ${g.code}`, () => groups.addStay(g.id, stay, overrides)).then((ok) => ok && close())}
                        />
                      )}
                    </Popover>
                  )}
                  {may.pay && row.outstanding > 0 && (
                    <Popover align="right" className="w-80 p-4" trigger={(props) => <Button {...props} variant="card"><HandCoins aria-hidden className="size-4" /> Take payment</Button>}>
                      {(close) => <GroupPaymentForm outstanding={master?.due ?? row.outstanding} hasDeposit={deposit > 0} errors={errors} busy={busy === 'pay'} onSubmit={(input) => void run('pay', isGateway(input.method) ? `Sent a link for ${g.code}` : `Took ${money(input.amount)} for ${g.code}`, () => groups.pay(g.id, input)).then((ok) => ok && close())} />}
                    </Popover>
                  )}
                  {may.edit && open.length > 0 && (
                    <Button variant="card" loading={busy === 'cancel'} onClick={() => window.confirm(`Cancel ${plural(open.length, 'stay')} of ${g.name}? Each stay's money follows the cancellation policy.`) && void run('cancel', `Cancelled ${g.code}`, () => groups.cancel(g.id))}>
                      <XCircle aria-hidden className="size-4" /> Cancel group
                    </Button>
                  )}
                  {may.edit && arriving.length > 0 && (
                    <Button variant="accent" aria-pressed={desk} onClick={() => setDesk(!desk)}>
                      <LogIn aria-hidden className="size-4" /> Check in {plural(arriving.length, 'stay')}
                    </Button>
                  )}
                </>
              }
            />
            <FlowBar label={`Where ${g.code} stands`} steps={flow} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                {desk && (
                  <Card as="div" aria-label="Group check-in">
                    <p className="mb-1 text-lg font-semibold tracking-tight">Check in the group</p>
                    <p className="mb-4 text-sm text-muted">
                      {arriving.map((b) => `${b.code} ${b.unitCode}`).join(', ')}. Each stay keeps the party it booked.
                    </p>
                    <form
                      className="space-y-3"
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const f = new FormData(e.currentTarget)
                        const details = { idVerified: f.get('idVerified') === 'on', deposit: Number(f.get('deposit')) || 0, keysHanded: f.get('keysHanded') === 'on', rulesExplained: f.get('rulesExplained') === 'on', arrivalTime: String(f.get('arrivalTime') ?? ''), adults: 2, children: 0, notes: String(f.get('notes') ?? '') }
                        void run('checkin', `Checked in ${g.code}`, () => groups.checkIn(g.id, details), plural(arriving.length, 'stay')).then((ok) => ok && setDesk(false))
                      }}
                    >
                      <CheckRow name="idVerified" label="IDs matched against the bookings" error={errors.idVerified} />
                      <CheckRow name="keysHanded" label="Keys or access codes handed over" error={errors.keysHanded} />
                      <CheckRow name="rulesExplained" label="House rules explained" />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Arrival time" htmlFor="gc-time">
                          <Input id="gc-time" name="arrivalTime" type="time" defaultValue="14:00" />
                        </Field>
                        <Field label="Security deposit per stay, Rp" htmlFor="gc-deposit" error={errors.deposit} hint="Zero when none">
                          <Input id="gc-deposit" name="deposit" type="number" min={0} step={50_000} defaultValue={0} className="tabular" />
                        </Field>
                      </div>
                      <Field label="Notes" htmlFor="gc-notes">
                        <Textarea id="gc-notes" name="notes" placeholder="Who arrived, luggage, transfers" />
                      </Field>
                      {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
                      <div className="flex gap-2">
                        <Button type="submit" variant="accent" loading={busy === 'checkin'}>
                          <LogIn aria-hidden className="size-4" /> Check in
                        </Button>
                        <Button variant="soft" onClick={() => setDesk(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </Card>
                )}

                <Card aria-label={`Group ${g.code}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-xs text-muted">
                        {g.code} · {GROUP_SOURCE_LABEL[g.source]} · {GROUP_BILLING_LABEL[g.billing]}
                      </p>
                      <Headline className="mt-1">{g.name}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        Lead guest {row.leadName} · {row.villaNames} · {shortDay(row.checkIn)} to {shortDay(row.checkOut)}
                      </p>
                    </div>
                    <StatusPill tone={GROUP_TONE[row.status]}>{GROUP_STATUS_LABEL[row.status]}</StatusPill>
                  </div>
                  <p className="mt-6 text-[44px] leading-none font-medium tracking-tight tabular">{money(row.total)}</p>
                  <FactGrid
                    className="mt-5 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Stays', row.stays.length],
                      ['Guests', row.guests],
                      ['Unit nights', row.nights],
                      ['Deposit', money(deposit)],
                      ['Paid', money(row.paid)],
                      ['Still owed', money(owed)],
                    ]}
                  />
                  {g.discount && <p className="mt-4 text-sm text-muted">Group discount: {g.discount.pct}% off every stay, {g.discount.reason}.</p>}
                  {g.note && <p className="mt-2 text-sm text-body">{g.note}</p>}
                </Card>

                <Card aria-labelledby="stays-title" className="p-0">
                  <CardHeader id="stays-title" title="Stays" className="px-5 pt-5" />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="border-y border-line text-left text-xs tracking-wide text-muted uppercase">
                          <th scope="col" className="py-2 pr-3 pl-5 font-medium">Stay</th>
                          <th scope="col" className="px-3 py-2 font-medium">Unit</th>
                          <th scope="col" className="px-3 py-2 font-medium">Dates</th>
                          <th scope="col" className="px-3 py-2 font-medium">Status</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">{g.billing === 'master' ? 'Extras due' : 'Balance'}</th>
                          <th scope="col" className="py-2 pr-5 pl-3 text-right font-medium">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {stays.map(({ booking: b, owed: due }) => (
                          <tr key={b.id}>
                            <td className="py-3 pr-3 pl-5">
                              <Link to={`/bookings/${b.id}`} className="font-mono font-medium hover:underline">
                                {b.code}
                              </Link>
                              {b.partySize && <p className="text-xs text-muted">{plural(b.partySize.adults, 'adult')}{b.partySize.children ? `, ${b.partySize.children} ${b.partySize.children === 1 ? 'child' : 'children'}` : ''}</p>}
                            </td>
                            <td className="px-3 py-3">
                              <span className="font-mono">{b.unitCode}</span>
                              {b.roomType && <p className="text-xs text-warning">{b.roomType}, room to assign</p>}
                            </td>
                            <td className="px-3 py-3 whitespace-nowrap">
                              {shortDay(b.checkIn)} to {shortDay(b.checkOut)} · {plural(b.nights, 'night')}
                            </td>
                            <td className="px-3 py-3">
                              <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>
                            </td>
                            <td className="px-3 py-3 text-right tabular">{money(b.total)}</td>
                            <td className="px-3 py-3 text-right font-medium tabular">{money(due)}</td>
                            <td className="py-3 pr-5 pl-3 text-right whitespace-nowrap">
                              {may.edit && (b.status === 'draft' || b.status === 'confirmed') && (
                                <Button size="sm" variant="soft" loading={busy === `cancel-${b.id}`} onClick={() => window.confirm(`Cancel ${b.code}? Its money follows the cancellation policy.`) && void run(`cancel-${b.id}`, `Cancelled ${b.code}`, () => booking.transition(b.id, 'cancelled'))}>
                                  Cancel
                                </Button>
                              )}
                              {may.edit && liveStay(b) && row.stays.length > 1 && (
                                <Button size="sm" variant="soft" className="ml-1" loading={busy === `remove-${b.id}`} onClick={() => void run(`remove-${b.id}`, `Took ${b.code} out of ${g.code}`, () => groups.removeStay(g.id, b.id), 'It carries on as a booking of its own')}>
                                  Remove
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {master && (
                  <Card aria-labelledby="master-title">
                    <CardHeader id="master-title" title="Master folio" action={<span className="text-sm font-semibold tabular">{money(master.due)} due</span>} />
                    <p className="mb-4 text-sm text-muted">Every room night of the group and the payments for them. Each stay pays its own room service and charges; the last stay leaves once this is paid.</p>
                    <FolioLines lines={master.lines} />
                  </Card>
                )}
              </div>

              <div className="space-y-4">
                <Card aria-labelledby="bill-title">
                  <CardHeader id="bill-title" title="Bill" />
                  <dl className="space-y-2 text-sm">
                    {master && (
                      <div className="flex justify-between">
                        <dt className="text-muted">Master folio, room nights</dt>
                        <dd className="tabular">{money(master.due)}</dd>
                      </div>
                    )}
                    {stays.map((x) => (
                      <div key={x.booking.id} className="flex justify-between">
                        <dt className="text-muted">
                          {x.booking.code} {master ? 'extras' : 'balance'}
                        </dt>
                        <dd className="tabular">{money(master ? x.extras : x.owed)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-line-strong pt-2 font-semibold">
                      <dt>Still owed</dt>
                      <dd className="tabular">{money(owed)}</dd>
                    </div>
                  </dl>
                </Card>
                <Card aria-labelledby="gpay-title">
                  <CardHeader id="gpay-title" title="Group payments" />
                  {batches.length === 0 ? (
                    <p className="text-sm text-muted">No payment taken for the group yet.</p>
                  ) : (
                    <ul className="divide-y divide-line text-sm">
                      {batches.map((p) => (
                        <li key={p.batch} className="py-2.5">
                          <div className="flex justify-between gap-3">
                            <span className="font-medium">
                              {PAYMENT_KIND_LABEL[p.kind]} <span className="font-mono text-xs text-muted">{p.batch}</span>
                            </span>
                            <span className="font-semibold tabular">{money(p.amount)}</span>
                          </div>
                          <p className="text-xs text-muted">
                            {PAYMENT_METHOD_LABEL[p.method]} · {PAYMENT_STATUS_LABEL[p.status]}
                            {p.paidOn ? ` ${shortDay(p.paidOn)}` : ''} · over {p.stays.join(', ')}
                          </p>
                        </li>
                      ))}
                    </ul>
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

/** One payment for the group: deposit or balance, by cash, transfer or a link. */
function GroupPaymentForm({ outstanding, hasDeposit, errors, busy, onSubmit }: { outstanding: number; hasDeposit: boolean; errors: Record<string, string>; busy: boolean; onSubmit: (input: GroupPaymentInput) => void }) {
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer')
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        onSubmit({ kind: f.get('kind') === 'deposit' ? 'deposit' : 'balance', method, amount: Number(f.get('amount')), reference: String(f.get('reference') ?? ''), note: '' })
      }}
    >
      <p className="text-sm font-semibold">Take money for the group</p>
      <p className="text-xs text-muted">It splits over the stays by arrival, each up to what it owes, and lands as one cash-in for approval.</p>
      <Field label="For" htmlFor="gp-kind">
        <Select id="gp-kind" name="kind" className="w-full" defaultValue={hasDeposit ? 'balance' : 'deposit'} options={[{ value: 'deposit', label: 'Deposit' }, { value: 'balance', label: 'Balance' }]} />
      </Field>
      <Field label="Method" htmlFor="gp-method" hint={isGateway(method) ? 'The lead guest gets one link' : 'Recorded now as received'}>
        <Select id="gp-method" className="w-full" value={method} options={[...DESK_METHODS, ...GATEWAY_METHODS].map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setMethod(e.target.value as PaymentMethod)} />
      </Field>
      <Field label="Amount, Rp" htmlFor="gp-amount" error={errors.amount} hint={`${money(outstanding)} still owed`}>
        <Input id="gp-amount" name="amount" type="number" min={1} step={10_000} defaultValue={outstanding} className="tabular" />
      </Field>
      {method === 'bank_transfer' && (
        <Field label="Bank reference" htmlFor="gp-ref" error={errors.reference}>
          <Input id="gp-ref" name="reference" placeholder="TRF-…" />
        </Field>
      )}
      <Button type="submit" variant="solid" size="sm" loading={busy}>
        {isGateway(method) ? 'Send link' : 'Record payment'}
      </Button>
    </form>
  )
}

import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Check, ChefHat, Truck, Undo2, UserRound, XCircle } from 'lucide-react'
import type { TransactionView } from '@/application/views'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { clockLabel } from '@/domain/roomService'
import { canTransitionOrder, isOpenOrder, MENU_CATEGORY_LABEL, nextOrderStep, ORDER_ACTION_LABEL, ORDER_SLA_MINUTES, ORDER_STATUS_LABEL, PARTNER_KIND_LABEL, type OrderAction } from '@/domain/serviceOrder'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'
import { FlowBar } from '../shared/FlowBar'
import { TRANSACTION_TONE } from '../shared/tones'
import { OrderLines, OrderPill, PayPill } from './orderParts'
import { PayOrders } from './PayOrders'

const STEP_ICON: Record<OrderAction, typeof Check> = { confirmed: Check, preparing: ChefHat, delivered: Truck, cancelled: XCircle, voided: Undo2 }

function Entries({ title, id, entries, empty }: { title: string; id: string; entries: readonly TransactionView[]; empty: string }) {
  return (
    <Card aria-labelledby={id}>
      <CardHeader id={id} title={title} />
      {entries.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {entries.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2.5">
              <Link to={`/finance/transactions/${t.id}`} className="min-w-0 flex-1 hover:underline">
                <span className="font-mono text-xs">{t.number}</span> <span className="text-muted">· {t.categoryName}</span>
                <span className="block truncate text-xs text-muted">{t.accountName}</span>
              </Link>
              <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>
              <span className="w-28 text-right tabular">{money(t.kind === 'cash_in' ? t.amount : -t.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function OrderPage() {
  const { id = '' } = useParams()
  const { orders } = useServices()
  const toast = useToast()
  const resource = useResource(`orders.detail:${id}`, () => orders.detail(id), { keepPrevious: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [ending, setEnding] = useState<'cancelled' | 'voided' | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: string, label: string, action: () => Promise<unknown>) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title: label })
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
    <Gate resource={resource} what="order" back={{ to: '/services/orders', label: 'Back to orders' }}>
      {({ order: o, booking, payment, link, revenue, costs, partners, steps, today, canEdit, canPay }) => {
        const step = nextOrderStep(o)
        const Icon = step ? STEP_ICON[step] : Check
        return (
          <>
            <PageBar
              fallback="/services/orders"
              label="Room service orders"
              actions={
                canEdit && (
                  <>
                    {canTransitionOrder(o, 'cancelled') && (
                      <Button variant="card" aria-pressed={ending === 'cancelled'} onClick={() => setEnding((v) => (v === 'cancelled' ? null : 'cancelled'))}>
                        <XCircle aria-hidden className="size-4" /> Cancel order
                      </Button>
                    )}
                    {canTransitionOrder(o, 'voided') && o.deliveredOn === today && o.payState !== 'paid' && (
                      <Button variant="card" aria-pressed={ending === 'voided'} onClick={() => setEnding((v) => (v === 'voided' ? null : 'voided'))}>
                        <Undo2 aria-hidden className="size-4" /> {ORDER_ACTION_LABEL.voided}
                      </Button>
                    )}
                    {step && (
                      <Button variant="accent" loading={busy === 'step'} onClick={() => void run('step', `${ORDER_STATUS_LABEL[step]} ${o.number}`, () => orders.transition(o.id, step))}>
                        <Icon aria-hidden className="size-4" /> {ORDER_ACTION_LABEL[step]}
                      </Button>
                    )}
                  </>
                )
              }
            />
            <FlowBar steps={steps} label="Where this order is" />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 space-y-4">
                {ending && (
                  <Card aria-label={ending === 'voided' ? 'Void the delivery' : 'Cancel the order'}>
                    <form
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const note = String(new FormData(e.currentTarget).get('note') ?? '')
                        void run(ending, `${ORDER_STATUS_LABEL[ending]} ${o.number}`, () => orders.transition(o.id, ending, note)).then((ok) => ok && setEnding(null))
                      }}
                    >
                      {ending === 'voided' && <p className="mb-3 text-sm text-muted">Voiding takes the delivery off the folio, reverses its revenue and partner bills, and puts minibar stock back. It works on the business day of the delivery; after that, post a rebate on the folio.</p>}
                      <Field label={ending === 'voided' ? 'Why is it voided' : 'Why is it cancelled'} htmlFor="so-end" error={errors.note}>
                        <Input id="so-end" name="note" placeholder={ending === 'voided' ? 'Marked delivered on the wrong room' : 'Guest changed plans, item not available'} />
                      </Field>
                      <Button type="submit" variant="solid" size="sm" className="mt-3" loading={busy === ending}>
                        {ORDER_ACTION_LABEL[ending]}
                      </Button>
                    </form>
                  </Card>
                )}
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">{o.number}</p>
                      <Headline className="mt-1">{`${o.unitCode} · ${o.guestName}`}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        {o.place.villa.name} · for {shortDay(o.requestedOn)} {clockLabel(o.requestedAt)} · {o.placedBy === 'guest' ? 'ordered by the guest' : 'ordered at the desk'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {o.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                      {o.late && <Tag tone="danger">Late</Tag>}
                      <OrderPill status={o.status} />
                      <PayPill state={o.payState} />
                    </div>
                  </div>
                  {o.note && <p className="mt-4 rounded-panel bg-raised p-3 text-sm">{o.note}</p>}
                  <div className="mt-4">
                    <OrderLines lines={o.lines} totals={o.totals} discountPct={o.discountPct} showCost />
                  </div>
                  <FactGrid
                    className="mt-5 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Stay', <Link key="b" to={`/bookings/${booking.id}`} className="hover:underline">{booking.code}</Link>],
                      ['Categories', [...new Set(o.lines.map((l) => MENU_CATEGORY_LABEL[l.category]))].join(', ')],
                      ['Delivered', o.deliveredOn ? `${shortDay(o.deliveredOn)} ${clockLabel(o.deliveredAt ?? 0)}` : 'Not yet'],
                      ['Waited', o.delay === null ? (o.late ? 'Running late' : 'On time so far') : o.delay <= ORDER_SLA_MINUTES ? `On time (${o.delay} min)` : `${o.delay} min after the time`],
                      ['Discount', o.discountPct ? `${o.discountPct}%, ${o.discountReason}` : 'None'],
                      ['On the house', o.compReason || 'Nothing'],
                    ]}
                  />
                </Card>
                <Entries title="Income in the books" id="so-income" entries={revenue} empty={o.status === 'delivered' ? 'Booked once the guest pays.' : 'Billed once the order is delivered.'} />
                <Entries title="Partner bills" id="so-costs" entries={costs} empty={partners.length ? 'Booked when the order is delivered.' : 'The villa’s own team delivers this order.'} />
              </div>
              <div className="space-y-4">
                <Card aria-labelledby="so-bill">
                  <CardHeader id="so-bill" title="Guest bill" />
                  {o.payState === 'unpaid' && canPay && <PayOrders bookingId={o.bookingId} orderIds={[o.id]} amount={o.totals.charge} onDone={resource.reload} id="so-pay" />}
                  {o.payState === 'unpaid' && !canPay && <p className="text-sm text-muted">On the guest’s bill; the desk takes the payment.</p>}
                  {o.payState === 'not_due' && <p className="text-sm text-muted">Charged to the stay once delivered: {money(o.totals.charge)}.</p>}
                  {o.payState === 'free' && <p className="text-sm text-muted">Nothing to pay.</p>}
                  {payment && (o.payState === 'paid' || o.payState === 'pending') && (
                    <dl className="space-y-1.5 text-sm">
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Payment</dt>
                        <dd className="font-mono">{payment.number}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Method</dt>
                        <dd>{PAYMENT_METHOD_LABEL[payment.method]}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Amount</dt>
                        <dd className="tabular">{money(payment.amount)}</dd>
                      </div>
                      {link?.status === 'pending' && (
                        <p className="pt-2">
                          <Link to={`/pay/${link.token}`} className="text-accent-text hover:underline">
                            Open the guest checkout
                          </Link>
                        </p>
                      )}
                    </dl>
                  )}
                </Card>
                {partners.length > 0 && (
                  <Card aria-labelledby="so-partners">
                    <CardHeader id="so-partners" title="Partners" />
                    <ul className="space-y-2 text-sm">
                      {partners.map((p) => (
                        <li key={p.id}>
                          <span className="font-medium">{p.name}</span>
                          <span className="block text-xs text-muted">
                            {PARTNER_KIND_LABEL[p.kind]} · {p.contact} {p.phone}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                <Card aria-labelledby="so-assign">
                  <CardHeader id="so-assign" title="Who takes it" />
                  <form
                    onSubmit={(e: FormEvent<HTMLFormElement>) => {
                      e.preventDefault()
                      const who = String(new FormData(e.currentTarget).get('assignee') ?? '')
                      void run('assign', `Assigned ${o.number} to ${who.trim()}`, () => orders.assign(o.id, who))
                    }}
                    className="space-y-3"
                  >
                    <Field label="Staff or partner" htmlFor="so-who" error={errors.assignee}>
                      <Input id="so-who" name="assignee" defaultValue={o.assignee} placeholder="Wayan, Komang, Taksu Mobile Spa" icon={<UserRound className="size-4" />} />
                    </Field>
                    <Button type="submit" variant="solid" size="sm" loading={busy === 'assign'} disabled={!canEdit || !isOpenOrder(o)}>
                      Save
                    </Button>
                  </form>
                </Card>
                <Card aria-labelledby="so-history">
                  <CardHeader id="so-history" title="History" />
                  <ol className="space-y-2 text-sm">
                    {[...o.history].reverse().map((h, i) => (
                      <li key={`${h.at}-${i}`} className="flex gap-3">
                        <span className="w-24 shrink-0 text-xs text-muted tabular">
                          {h.at.slice(0, 10) === today ? h.at.slice(11, 16) : shortDay(h.at.slice(0, 10))}
                        </span>
                        <span className="min-w-0">
                          <span className="font-medium">{h.kind === 'placed' ? 'Ordered' : h.kind === 'assigned' ? 'Assigned' : h.kind === 'paid' ? 'Paid' : ORDER_STATUS_LABEL[h.kind]}</span> by {h.by}
                          {h.note && <span className="block text-xs text-muted">{h.note}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                </Card>
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

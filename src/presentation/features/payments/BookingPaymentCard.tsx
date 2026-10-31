import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Copy, Link2, Printer, ReceiptText, Undo2, Wallet } from 'lucide-react'
import type { InvoiceView } from '@/application/views'
import type { Attachment } from '@/domain/attachment'
import { paymentFlow } from '@/domain/flow'
import { DESK_METHODS, GATEWAY_METHODS, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, type PaymentKind, type PaymentMethod } from '@/domain/payment'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { FactGrid } from '../../ui/Headline'
import { Popover } from '../../ui/Popover'
import { useToast } from '../../ui/useToast'
import { AttachmentList, AttachmentPicker } from '../shared/Attachments'
import { FlowBar } from '../shared/FlowBar'
import { QrCode } from './QrCode'
import { LINK_TONE, PAYMENT_TONE, payUrl } from './tones'

/** Invoice summary, payments and the actions that move money for one booking. */
export function BookingPaymentCard({ invoice, onChanged }: { invoice: InvoiceView; onChanged: () => void }) {
  const { payments } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  /** Proof for the form that is open: the transfer slip or the refund receipt. */
  const [proof, setProof] = useState<Attachment[]>([])
  const b = invoice.booking
  const latestPaid = invoice.payments.filter((p) => p.status === 'paid' && p.kind !== 'refund').at(-1)
  const airbnb = b.source === 'airbnb'
  const live = b.status !== 'draft' || !airbnb
  const pending = invoice.links.find((l) => l.status === 'pending')
  const defaultKind: PaymentKind = airbnb ? 'payout' : invoice.paid === 0 ? 'deposit' : 'balance'

  async function act(key: string, label: string, work: () => Promise<unknown>) {
    setBusy(key)
    setErrors({})
    try {
      await work()
      toast({ title: label })
      setProof([])
      onChanged()
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

  const form = (method: 'desk' | 'link', close: () => void) => (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        const input = { bookingId: b.id, kind: String(f.get('kind')) as PaymentKind, method: String(f.get('method')) as PaymentMethod, amount: Number(f.get('amount')) }
        const work = method === 'desk' ? () => payments.record({ ...input, reference: String(f.get('reference') ?? ''), payer: b.guestName, note: '', attachments: proof }) : () => payments.createLink({ ...input, payer: b.guestName })
        void act(method, method === 'desk' ? 'Payment recorded' : 'Payment link created', work).then((ok) => ok && close())
      }}
      className="space-y-3"
    >
      <p className="text-sm font-semibold">{method === 'desk' ? 'Record money received' : 'Send a payment link'}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind" htmlFor={`${method}-kind`}>
          <Select id={`${method}-kind`} name="kind" className="w-full" defaultValue={defaultKind} options={(airbnb ? (['payout'] as PaymentKind[]) : (['deposit', 'balance', 'full', 'extra'] as PaymentKind[])).map((k) => ({ value: k, label: PAYMENT_KIND_LABEL[k] }))} />
        </Field>
        <Field label="Method" htmlFor={`${method}-method`} error={errors.method}>
          <Select id={`${method}-method`} name="method" className="w-full" options={(method === 'link' ? GATEWAY_METHODS : airbnb ? (['airbnb_payout'] as PaymentMethod[]) : DESK_METHODS).map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} />
        </Field>
      </div>
      <Field label="Amount, Rp" htmlFor={`${method}-amount`} error={errors.amount} hint={`Outstanding ${money(invoice.outstanding)}`}>
        <Input id={`${method}-amount`} name="amount" type="number" inputMode="numeric" min={1000} max={invoice.outstanding} step={1000} defaultValue={invoice.outstanding} className="tabular" />
      </Field>
      {method === 'desk' && (
        <Field label="Reference" htmlFor="desk-ref" error={errors.reference} hint="Bank reference for a transfer; leave empty for cash">
          <Input id="desk-ref" name="reference" placeholder="TRF-…" />
        </Field>
      )}
      {method === 'desk' && (
        <Field label="Transfer slip or receipt" htmlFor="desk-proof">
          <AttachmentPicker id="desk-proof" value={proof} onChange={setProof} hint="Photo or PDF" />
        </Field>
      )}
      <Button type="submit" variant="accent" size="sm" loading={busy === method}>
        {method === 'desk' ? 'Record payment' : 'Create link'}
      </Button>
    </form>
  )

  return (
    <Card id="payments" aria-labelledby="pay-title">
      <CardHeader
        id="pay-title"
        title="Payment"
        action={
          <>
            <Link to={`/bookings/${b.id}/invoice`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
              <Printer aria-hidden className="size-3.5" /> Invoice
            </Link>
            {live && invoice.outstanding > 0 && can('payments', 'create') && (
              <>
                {!airbnb && (
                  <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                    <Button {...props} size="sm" variant="soft">
                      <Link2 aria-hidden className="size-3.5" /> Link
                    </Button>
                  )}>
                    {(close) => form('link', close)}
                  </Popover>
                )}
                <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="sm" variant="accent" onClick={() => {
                    setProof([])
                    props.onClick()
                  }}>
                    <Wallet aria-hidden className="size-3.5" /> Record
                  </Button>
                )}>
                  {(close) => form('desk', close)}
                </Popover>
              </>
            )}
          </>
        }
      />
      <FactGrid
        className="grid-cols-2 sm:grid-cols-4"
        facts={[
          [airbnb ? 'Payout expected' : 'Stay total', money(invoice.expected)],
          ['Paid', money(invoice.paid)],
          ['Outstanding', <span key="o" className={invoice.outstanding > 0 ? 'text-accent-text' : undefined}>{money(invoice.outstanding)}</span>],
          [airbnb ? 'Expected on' : 'Balance due', shortDay(invoice.dueOn)],
        ]}
      />
      {invoice.overpaid > 0 && latestPaid && can('payments', 'edit') && (
        <div role="status" className="mt-4 flex flex-wrap items-center gap-3 rounded-panel bg-warning-soft p-3.5 text-sm">
          <span className="min-w-0 flex-1">
            The guest paid {money(invoice.overpaid)} more than the stay now costs. Refund it from {latestPaid.number}; the refund goes out as a cash-out for approval.
          </span>
          <Button size="sm" variant="accent" loading={busy === 'overpaid'} onClick={() => void act('overpaid', `Refunded ${money(invoice.overpaid)}`, () => payments.refund(latestPaid.id, Math.min(invoice.overpaid, latestPaid.amount), `${b.code} changed; paid above the new total`))}>
            <Undo2 aria-hidden className="size-3.5" /> Refund {money(Math.min(invoice.overpaid, latestPaid.amount))}
          </Button>
        </div>
      )}
      {pending && (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-panel bg-raised p-3.5">
          {pending.method === 'qris' && <QrCode payload={pending.qrPayload} className="size-24 shrink-0" />}
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold">
              {PAYMENT_METHOD_LABEL[pending.method]} link waiting · {money(pending.amount)}
            </p>
            {pending.vaNumber && (
              <p className="text-muted">
                {pending.vaBank} virtual account <span className="font-mono text-fg">{pending.vaNumber}</span>
              </p>
            )}
            <p className="truncate font-mono text-xs text-muted">{payUrl(pending.token)}</p>
            <p className="text-xs text-muted">Expires {pending.expiresAt.replace('T', ' ').slice(0, 16)}</p>
            {pending.proofs.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-xs font-medium">The guest uploaded a transfer receipt</p>
                <AttachmentList files={pending.proofs} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="soft" onClick={() => void navigator.clipboard?.writeText(payUrl(pending.token)).then(() => toast({ title: 'Link copied' }))}>
              <Copy aria-hidden className="size-3.5" /> Copy
            </Button>
            <Link to={`/pay/${pending.token}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
              Open as guest
            </Link>
          </div>
        </div>
      )}
      {invoice.payments.length === 0 ? (
        <p className="mt-4 rounded-panel bg-raised px-4 py-5 text-center text-sm text-muted">No payment yet.</p>
      ) : (
        <ul className="stagger mt-4 divide-y divide-line">
          {invoice.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <ReceiptText aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]}
                </span>
                <span className="block truncate text-xs text-muted">
                  <span className="font-mono">{p.number}</span> · {shortDay(p.paidOn ?? p.createdOn)}
                  {p.reference && ` · ${p.reference}`}
                  {p.transactionNumber && (
                    <>
                      {' · '}
                      <Link to={`/finance/transactions/${p.transactionId}`} className="hover:underline">
                        {p.transactionNumber} {p.transactionStatus && TRANSACTION_STATUS_LABEL[p.transactionStatus].toLowerCase()}
                      </Link>
                    </>
                  )}
                  {!p.transactionId && p.status === 'paid' && ` · ${p.note}`}
                </span>
                <span className="mt-2 block">
                  <FlowBar compact label={`Where ${p.number} stands`} steps={paymentFlow(p, p.transactionStatus)} />
                </span>
                {p.proofs.length > 0 && (
                  <span className="mt-2 block">
                    <AttachmentList files={p.proofs} />
                  </span>
                )}
              </span>
              {p.link && p.status === 'pending' && <Tag tone={LINK_TONE[p.link.status]}>Link</Tag>}
              <StatusPill tone={PAYMENT_TONE[p.status]}>{PAYMENT_STATUS_LABEL[p.status]}</StatusPill>
              <span className="shrink-0 font-semibold tabular">
                {p.kind === 'refund' ? '-' : ''}
                {money(p.amount)}
              </span>
              {p.status === 'paid' && p.kind !== 'refund' && can('payments', 'edit') && (
                <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="icon-sm" variant="ghost" aria-label={`Refund ${p.number}`} onClick={() => {
                    setProof([])
                    props.onClick()
                  }}>
                    <Undo2 aria-hidden className="size-4" />
                  </Button>
                )}>
                  {(close) => (
                    <form
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const f = new FormData(e.currentTarget)
                        void act(`refund-${p.id}`, `Refunded ${p.number}`, () => payments.refund(p.id, Number(f.get('amount')), String(f.get('reason') ?? ''), proof)).then((ok) => ok && close())
                      }}
                      className="space-y-3"
                    >
                      <p className="text-sm">The refund leaves the same account the money came into, as a cash-out for approval.</p>
                      <Field label="Amount, Rp" htmlFor={`ref-amt-${p.id}`} error={errors.amount}>
                        <Input id={`ref-amt-${p.id}`} name="amount" type="number" inputMode="numeric" min={1} max={p.amount} defaultValue={p.amount} className="tabular" />
                      </Field>
                      <Field label="Reason" htmlFor={`ref-why-${p.id}`} error={errors.note}>
                        <Input id={`ref-why-${p.id}`} name="reason" placeholder="Guest cancelled in the free window" />
                      </Field>
                      <Field label="Refund proof" htmlFor={`ref-proof-${p.id}`}>
                        <AttachmentPicker id={`ref-proof-${p.id}`} value={proof} onChange={setProof} hint="Transfer slip or signed receipt" />
                      </Field>
                      <Button type="submit" variant="accent" size="sm" loading={busy === `refund-${p.id}`}>
                        Refund
                      </Button>
                    </form>
                  )}
                </Popover>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { HandCoins, Plus, Printer, Undo2 } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { FOLIO_KIND_LABEL, FOLIO_KINDS, filterFolio, type FolioKind, type GuestFolio, type RebateTarget } from '@/domain/folio'
import { PAYMENT_METHOD_LABEL, type Payment } from '@/domain/payment'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { FactGrid } from '../../ui/Headline'
import { Popover } from '../../ui/Popover'
import { useToast } from '../../ui/useToast'
import { FolioLines } from '../shared/FolioLines'

type Posting = 'charge' | 'rebate' | 'refund'

interface FolioCardProps {
  booking: BookingView
  folio: GuestFolio
  /** Posted lines a rebate can still correct. */
  rebates: readonly RebateTarget[]
  /** Paid money a refund can give back. */
  refunds: ReadonlyArray<{ payment: Payment; refundable: number }>
  /** The discount limit, and whether the signed-in person may approve past it. */
  limitPct: number
  mayApprove: boolean
  onChanged: () => void
}

/** The stay's folio: running balance, a filter by kind, and the desk's charges, rebates and refunds. */
export function FolioCard({ booking: b, folio: f, rebates, refunds, limitPct, mayApprove, onChanged }: FolioCardProps) {
  const { booking } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const [kind, setKind] = useState<FolioKind | ''>('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Posting | null>(null)
  const mayPost = b.status === 'checked_in' && can('booking', 'edit')
  const mayRefund = can('payments', 'edit') && refunds.length > 0
  const codes = useResource('booking.chargeCodes', () => booking.chargeCodes())
  const kinds = FOLIO_KINDS.filter((k) => f.lines.some((l) => l.kind === k))

  async function post(e: FormEvent<HTMLFormElement>, what: Posting, close: () => void) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const amount = Number(form.get('amount')) || 0
    const reason = String(form.get('reason') ?? '')
    setBusy(what)
    setErrors({})
    try {
      if (what === 'charge') await booking.postCharge(b.id, { code: String(form.get('code') ?? ''), description: String(form.get('description') ?? ''), amount })
      else if (what === 'rebate') await booking.postRebate(b.id, { lineId: String(form.get('lineId') ?? ''), amount, reason })
      else await booking.refund(b.id, { paymentId: String(form.get('paymentId') ?? ''), amount, reason })
      toast({ title: what === 'charge' ? `Charged ${money(amount)}` : what === 'rebate' ? `Rebate of ${money(amount)} posted` : `Refund of ${money(amount)} sent for approval`, description: what === 'refund' ? 'The cash-out waits in the approval inbox.' : undefined })
      close()
      onChanged()
    } catch (error) {
      const found = fieldErrors(error)
      setErrors(found)
      toast({ tone: 'danger', title: `Could not post the ${what}`, description: Object.values(found)[0] })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card id="folio" aria-labelledby="folio-title">
      <CardHeader
        id="folio-title"
        title="Folio"
        action={
          <>
            <Link to={`/bookings/${b.id}/folio`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
              <Printer aria-hidden className="size-3.5" /> Print
            </Link>
            {mayRefund && (
              <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                <Button {...props} size="sm" variant="soft">
                  <Undo2 aria-hidden className="size-3.5" /> Refund
                </Button>
              )}>
                {(close) => (
                  <form onSubmit={(e) => void post(e, 'refund', close)} className="space-y-3">
                    <p className="text-sm font-semibold">Give the credit back</p>
                    <Field label="Against" htmlFor="fr-payment" error={errors.paymentId} hint="The cash-out goes back the way the money came, through approval">
                      <Select id="fr-payment" name="paymentId" className="w-full" options={refunds.map((r) => ({ value: r.payment.id, label: `${r.payment.number} ${PAYMENT_METHOD_LABEL[r.payment.method]}, up to ${money(r.refundable)}` }))} />
                    </Field>
                    <Field label="Amount, Rp" htmlFor="fr-amount" error={errors.amount} hint={`Refund due ${money(f.refundDue)}`}>
                      <Input id="fr-amount" name="amount" type="number" inputMode="numeric" min={1000} step={1000} defaultValue={Math.min(f.refundDue, refunds[0]?.refundable ?? 0)} className="tabular" />
                    </Field>
                    <Field label="Reason" htmlFor="fr-reason" error={errors.note}>
                      <Input id="fr-reason" name="reason" placeholder="Rebate after payment" />
                    </Field>
                    <Button type="submit" variant="accent" size="sm" loading={busy === 'refund'}>
                      Refund
                    </Button>
                  </form>
                )}
              </Popover>
            )}
            {mayPost && (
              <>
                <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="sm" variant="soft" disabled={rebates.length === 0}>
                    <HandCoins aria-hidden className="size-3.5" /> Post rebate
                  </Button>
                )}>
                  {(close) => (
                    <form onSubmit={(e) => void post(e, 'rebate', close)} className="space-y-3">
                      <p className="text-sm font-semibold">Correct a posted line</p>
                      <Field label="Line" htmlFor="fa-line" error={errors.lineId} hint="The rebate posts on the same code, so the revenue reverses on its account">
                        <Select id="fa-line" name="lineId" className="w-full" options={rebates.map((t) => ({ value: t.line.id, label: `${t.line.code} · ${t.line.description}, ${money(t.open)} left` }))} />
                      </Field>
                      <Field label="Amount, Rp" htmlFor="fa-amount" error={errors.amount}>
                        <Input id="fa-amount" name="amount" type="number" inputMode="numeric" min={1000} step={1000} className="tabular" />
                      </Field>
                      <Field label="Reason" htmlFor="fa-reason" error={errors.reason}>
                        <Input id="fa-reason" name="reason" placeholder="Why the guest gets it" />
                      </Field>
                      {!mayApprove && <p className="text-xs text-muted">Past {limitPct}% of the line, a villa manager gives it.</p>}
                      <Button type="submit" variant="accent" size="sm" loading={busy === 'rebate'}>
                        Post rebate
                      </Button>
                    </form>
                  )}
                </Popover>
                <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="sm" variant="accent">
                    <Plus aria-hidden className="size-3.5" /> Post charge
                  </Button>
                )}>
                  {(close) => (
                    <form onSubmit={(e) => void post(e, 'charge', close)} className="space-y-3">
                      <p className="text-sm font-semibold">Charge the guest</p>
                      <Field label="Transaction code" htmlFor="fc-code" error={errors.code} hint="Its account takes the revenue">
                        <Select id="fc-code" name="code" className="w-full" options={(codes.data ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} />
                      </Field>
                      <Field label="What was charged" htmlFor="fc-description" error={errors.description}>
                        <Input id="fc-description" name="description" placeholder="2 × Bintang from the minibar" />
                      </Field>
                      <Field label="Amount, Rp" htmlFor="fc-amount" error={errors.amount} hint="Taken with the bill at check-out">
                        <Input id="fc-amount" name="amount" type="number" inputMode="numeric" min={1000} step={1000} className="tabular" />
                      </Field>
                      <Button type="submit" variant="accent" size="sm" loading={busy === 'charge'}>
                        Post charge
                      </Button>
                    </form>
                  )}
                </Popover>
              </>
            )}
          </>
        }
      />
      <FactGrid
        className="grid-cols-2 sm:grid-cols-4"
        facts={[
          ['Debits', money(f.debits)],
          ['Credits', money(f.credits)],
          ['Balance', <span key="b" className={f.balance > 0 ? 'text-accent-text' : undefined}>{money(f.balance)}</span>],
          f.refundDue > 0 ? ['Refund due', <span key="r" className="text-accent-text">{money(f.refundDue)}</span>] : f.forecast !== 0 ? ['Estimated at check-out', money(f.estimated)] : ['Deposit held', money(f.depositHeld)],
        ]}
      />
      <div className="mt-4 mb-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {f.refundDue > 0 ? `Refund due: ${money(f.refundDue)} goes back to the guest.` : f.forecast !== 0 ? `Nights the audit has not posted show as forecast, outside the balance; check-out settles them, ${money(f.estimated)} in all.` : f.balance > 0 ? 'Check-out takes this balance.' : f.balance < 0 ? 'The guest is in credit.' : 'Nothing owed.'}
        </p>
        <Select compact aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as FolioKind | '')} options={[{ value: '', label: 'Every kind' }, ...kinds.map((k) => ({ value: k, label: FOLIO_KIND_LABEL[k] }))]} />
      </div>
      <FolioLines lines={filterFolio(f.lines, kind)} />
    </Card>
  )
}

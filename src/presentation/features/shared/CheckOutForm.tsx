import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Copy, ExternalLink, LogOut, ReceiptText, Wallet } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { Attachment } from '@/domain/attachment'
import { isGateway, PAYMENT_METHOD_LABEL, settlementLines, type PaymentMethod } from '@/domain/payment'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { useToast } from '../../ui/useToast'
import { payUrl } from '../payments/tones'
import { AttachmentPicker } from './Attachments'
import { CheckRow } from './CheckRow'

const METHODS: readonly PaymentMethod[] = ['cash', 'bank_transfer', 'qris', 'virtual_account', 'card']

interface CheckOutFormProps {
  booking: BookingView
  /** `link` when the guest still has to pay the check-out link; the stay closes once they do. */
  onDone: (outcome: 'out' | 'link') => void
  onCancel?: () => void
}

/**
 * The departure checklist with the bill read from the folio: room balance, unpaid room service, folio charges
 * and departure charges are taken in one payment and the stay closes in the same step. A link instead closes
 * the stay when the guest pays it.
 */
export function CheckOutForm({ booking: b, onDone, onCancel }: CheckOutFormProps) {
  const { booking, payments } = useServices()
  const toast = useToast()
  const due = useResource(`booking.settlement:${b.id}`, () => booking.settlement(b.id))
  const [charges, setCharges] = useState(0)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [files, setFiles] = useState<readonly Attachment[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const held = b.arrival?.deposit ?? 0
  const lines = due.data ? settlementLines(due.data.roomDue, due.data.orders, charges, due.data.charges) : []
  const total = lines.reduce((sum, l) => sum + l.amount, 0)
  const owed = lines.some((l) => l.kind !== 'charges')
  const link = due.data?.link ?? null
  // The last stay of a master-billed group waits for the group to pay its rooms.
  const masterOpen = due.data?.master?.closes && due.data.master.due > 0 ? due.data.master : null

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const details = {
      depositReturned: Number(f.get('depositReturned')) || 0,
      extraCharges: charges,
      roomInspected: f.get('roomInspected') === 'on',
      keysReturned: f.get('keysReturned') === 'on',
      notes: String(f.get('notes') ?? ''),
    }
    setSaving(true)
    setErrors({})
    try {
      if (total === 0) {
        await booking.checkOut(b.id, details)
        onDone('out')
        return
      }
      const result = await booking.settleAndCheckOut(b.id, { details, method, reference, attachments: files })
      if (result.link) {
        toast({ title: `${PAYMENT_METHOD_LABEL[method]} link ready for ${money(result.link.amount)}`, description: 'Send it to the guest; the stay checks out when it is paid.' })
        due.reload()
        onDone('link')
      } else onDone('out')
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  async function cancelLink(token: string) {
    try {
      await payments.cancelLink(token)
      toast({ title: 'Link cancelled', description: 'Take the bill another way.' })
      due.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not cancel the link', description: fieldErrors(error).form })
    }
  }

  if (link)
    return (
      <div className="space-y-3" aria-label={`Check out ${b.guestName}`}>
        <div className="rounded-panel bg-warning-soft p-3.5 text-sm text-body" role="status">
          <p className="font-semibold">Waiting for {b.guestName} to pay {money(link.amount)}</p>
          <p className="mt-0.5">The {PAYMENT_METHOD_LABEL[link.method]} link covers the whole bill. The stay checks out as soon as it is paid.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="soft" onClick={() => void navigator.clipboard?.writeText(payUrl(link.token)).then(() => toast({ title: 'Link copied' }))}>
            <Copy aria-hidden className="size-4" /> Copy link
          </Button>
          <Link to={`/pay/${link.token}`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
            <ExternalLink aria-hidden className="size-4" /> Open as guest
          </Link>
          <Button size="sm" variant="soft" onClick={() => due.reload()}>
            Check again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void cancelLink(link.token)}>
            Cancel link
          </Button>
        </div>
      </div>
    )

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={`Check out ${b.guestName}`}>
      <div className="rounded-panel bg-info-soft p-3.5 text-sm text-body">
        <span className="font-semibold">{b.guestName}</span> · {b.unitCode} · {plural(b.nights, 'night')} · arrived {b.checkedInOn ? shortDay(b.checkedInOn) : shortDay(b.checkIn)} · deposit held {money(held)}
      </div>
      <CheckRow name="roomInspected" label="Room inspected" hint="Minibar, towels, remote controls, damage" error={errors.roomInspected} />
      <CheckRow name="keysReturned" label="Keys or access card returned" defaultChecked />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Deposit returned, Rp" htmlFor="co-deposit" error={errors.depositReturned} hint={held ? `${money(held)} held; the difference stays in the cashbox` : 'No deposit was held'}>
          <Input id="co-deposit" name="depositReturned" type="number" inputMode="numeric" min={0} max={held} step={50_000} defaultValue={held} className="tabular" />
        </Field>
        <Field label="Departure charges, Rp" htmlFor="co-charges" error={errors.extraCharges} hint="Minibar, damage, late check-out">
          <Input id="co-charges" type="number" inputMode="numeric" min={0} step={10_000} value={charges || ''} placeholder="0" onChange={(e) => setCharges(Math.max(0, Number(e.target.value) || 0))} className="tabular" />
        </Field>
      </div>
      <Field label="Notes" htmlFor="co-notes">
        <Textarea id="co-notes" name="notes" rows={2} placeholder="What was charged and why, feedback from the guest" />
      </Field>

      {masterOpen && b.group && (
        <p role="alert" className="rounded-panel bg-warning-soft p-3 text-sm text-body">
          This is the last stay of {masterOpen.code}. The master folio still has {money(masterOpen.due)} to pay;{' '}
          <Link to={`/bookings/groups/${b.group.id}`} className="font-medium underline">
            take it on the group page
          </Link>{' '}
          first.
        </p>
      )}
      {due.data && due.data.waiting.length > 0 && (
        <p role="alert" className="rounded-panel bg-warning-soft p-3 text-sm text-body">
          {due.data.waiting.join(', ')} already has a payment link open. Wait for the guest or cancel that link on the booking before checking out.
        </p>
      )}
      {lines.length > 0 && (
        <section aria-label="Bill to settle" className="space-y-3 rounded-panel border border-line p-3.5">
          <p className="text-sm font-semibold">Bill to settle</p>
          <ul className="divide-y divide-line text-sm">
            {lines.map((l) => (
              <li key={`${l.kind}-${l.label}`} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block font-medium">{l.label}</span>
                  <span className="block truncate text-xs text-muted">{l.detail}</span>
                </span>
                <span className="shrink-0 font-semibold whitespace-nowrap tabular">{money(l.amount)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 pt-2 font-semibold">
              <span>Total</span>
              <span className="tabular">{money(total)}</span>
            </li>
          </ul>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Paid by" htmlFor="co-method" error={errors.method}>
              <Select id="co-method" value={method} options={(owed ? METHODS : METHODS.filter((m) => !isGateway(m))).map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setMethod(e.target.value as PaymentMethod)} />
            </Field>
            {method === 'bank_transfer' && (
              <Field label="Bank reference" htmlFor="co-ref" error={errors.reference}>
                <Input id="co-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="From the transfer slip" />
              </Field>
            )}
          </div>
          {!isGateway(method) && (
            <Field label="Receipt" htmlFor="co-files" hint="Optional: the signed bill or the transfer slip">
              <AttachmentPicker id="co-files" value={files} onChange={setFiles} />
            </Field>
          )}
          <p className="text-xs text-muted">{isGateway(method) ? 'One link covers the whole bill; the stay checks out when the guest pays it.' : 'Each part lands in its own income category and waits for approval in Finance.'}</p>
        </section>
      )}
      {due.data && (
        <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>Folio balance {money(due.data.owed)}{charges > 0 && `, plus ${money(charges)} departure charges`}</span>
          <Link to={`/bookings/${b.id}/folio`} className="inline-flex items-center gap-1 text-accent-text hover:underline">
            <ReceiptText aria-hidden className="size-3.5" /> Open the folio
          </Link>
        </p>
      )}
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.form}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="accent" loading={saving} disabled={!due.data || due.data.waiting.length > 0 || Boolean(masterOpen)}>
          {!saving && (total > 0 ? <Wallet aria-hidden className="size-4" /> : <LogOut aria-hidden className="size-4" />)}
          {total === 0 ? 'Complete check-out' : isGateway(method) ? `Send a link for ${money(total)}` : `Take ${money(total)} and check out`}
        </Button>
        {onCancel && (
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

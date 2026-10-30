import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Banknote } from 'lucide-react'
import type { ReceivableRow } from '@/application/views'
import { AGING_LABEL } from '@/domain/payment'
import { addDays, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Skeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { AGING_TONE } from '../payments/tones'
import { Screen } from './Screen'

/** The desk takes a payment from a guest standing in front of it; balances due this week come first. */
export function PaymentsScreen() {
  const { payments } = useServices()
  const toast = useToast()
  const data = useResource('payments.receivables', () => payments.receivables())
  const [open, setOpen] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function take(e: FormEvent<HTMLFormElement>, r: ReceivableRow) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const p = await payments.record({ bookingId: r.booking.id, kind: r.paid === 0 ? 'deposit' : 'balance', method: String(f.get('method')) === 'bank_transfer' ? 'bank_transfer' : 'cash', amount: Number(f.get('amount')), reference: String(f.get('reference') ?? ''), payer: r.booking.guestName, note: 'Taken at the desk' })
      toast({ title: `${p.number} recorded`, description: `${money(p.amount)} waits for approval` })
      setOpen(null)
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  const d = data.data
  const soon = d ? d.rows.filter((r) => r.dueOn <= addDays(d.today, 7) || r.booking.status === 'checked_in') : []
  return (
    <Screen title="Payments" band="blue">
      {!d ? (
        <Skeleton className="h-40 rounded-[22px]" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[22px] bg-card p-3 shadow-card">
              <p className="text-[11px] font-medium text-muted uppercase">Due this week</p>
              <p className="mt-2 text-xl leading-none font-semibold break-words tabular">{money(soon.reduce((s, r) => s + r.outstanding, 0))}</p>
            </div>
            <div className="rounded-[22px] bg-card p-3 shadow-card">
              <p className="text-[11px] font-medium text-muted uppercase">Bookings</p>
              <p className="mt-2 text-xl leading-none font-semibold tabular">{soon.length}</p>
            </div>
          </div>
          <h2 className="text-base font-semibold">Collect now</h2>
          {soon.length === 0 && <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nothing is due this week.</p>}
          <ul className="stagger space-y-2">
            {soon.map((r) => (
              <li key={r.booking.id} className="rounded-[22px] bg-card p-3 shadow-card">
                <button type="button" onClick={() => setOpen(open === r.booking.id ? null : r.booking.id)} aria-expanded={open === r.booking.id} className="flex w-full cursor-pointer items-center gap-3 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{r.booking.guestName}</span>
                    <span className="block truncate text-xs text-muted">
                      {r.booking.unitCode} · due {shortDay(r.dueOn)}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="text-sm font-semibold tabular">{money(r.outstanding)}</span>
                    <Tag tone={AGING_TONE[r.bucket]}>{AGING_LABEL[r.bucket]}</Tag>
                  </span>
                </button>
                {open === r.booking.id && (
                  <form onSubmit={(e) => void take(e, r)} className="mt-3 animate-pop-in space-y-3 border-t border-line pt-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Method" htmlFor={`m-meth-${r.booking.id}`}>
                        <Select id={`m-meth-${r.booking.id}`} name="method" className="w-full" options={[{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Transfer' }]} />
                      </Field>
                      <Field label="Amount" htmlFor={`m-amt-${r.booking.id}`} error={errors.amount}>
                        <Input id={`m-amt-${r.booking.id}`} name="amount" type="number" inputMode="numeric" defaultValue={r.outstanding} className="tabular" />
                      </Field>
                    </div>
                    <Field label="Reference" htmlFor={`m-ref-${r.booking.id}`} error={errors.reference ?? errors.form}>
                      <Input id={`m-ref-${r.booking.id}`} name="reference" placeholder="For a transfer" />
                    </Field>
                    <Button type="submit" variant="accent" className="w-full" loading={saving}>
                      <Banknote aria-hidden className="size-4" /> Take payment
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <Link to="/payments/receivables" className="block rounded-[22px] bg-card p-3 text-center text-sm text-accent-text shadow-card">
            Every balance on the console
          </Link>
        </>
      )}
    </Screen>
  )
}

import { useState, type FormEvent } from 'react'
import { LogIn } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { CheckInDetails } from '@/domain/booking'
import type { CashAccount } from '@/domain/finance'
import { ID_TYPE_LABEL } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { CheckRow } from './CheckRow'

interface CheckInFormProps {
  booking: BookingView
  cashbox: CashAccount | null
  save: (details: CheckInDetails) => Promise<unknown>
  onDone: () => void
  onCancel?: () => void
}

const nowClock = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The front-desk arrival checklist: ID, party, deposit, keys, house rules, notes. */
export function CheckInForm({ booking: b, cashbox, save, onDone, onCancel }: CheckInFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({
        idVerified: f.get('idVerified') === 'on',
        deposit: Number(f.get('deposit')) || 0,
        keysHanded: f.get('keysHanded') === 'on',
        rulesExplained: f.get('rulesExplained') === 'on',
        arrivalTime: String(f.get('arrivalTime') ?? ''),
        adults: Number(f.get('adults')),
        children: Number(f.get('children')) || 0,
        notes: String(f.get('notes') ?? ''),
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={`Check in ${b.guestName}`}>
      <div className="rounded-panel bg-info-soft p-3.5 text-sm text-body">
        <span className="font-semibold">{b.guestName}</span> · {b.unitCode} · {shortDay(b.checkIn)} to {shortDay(b.checkOut)} · {plural(b.nights, 'night')} · {money(b.total)}
        {b.notes && <span className="mt-1 block text-xs">{b.notes}</span>}
      </div>
      <CheckRow name="idVerified" label={`${ID_TYPE_LABEL[b.guest.idType]} matches the booking`} hint={<>On file: <span className="font-mono">{b.guest.idNumber || 'no number'}</span> · {b.guest.nationality}</>} error={errors.idVerified} />
      <div className="grid grid-cols-3 gap-3">
        <Field label="Adults" htmlFor="ci-adults" error={errors.adults}>
          <Input id="ci-adults" name="adults" type="number" inputMode="numeric" min={1} defaultValue={b.arrival?.adults ?? 2} className="tabular" />
        </Field>
        <Field label="Children" htmlFor="ci-children" error={errors.children}>
          <Input id="ci-children" name="children" type="number" inputMode="numeric" min={0} defaultValue={b.arrival?.children ?? 0} className="tabular" />
        </Field>
        <Field label="Arrived at" htmlFor="ci-time">
          <Input id="ci-time" name="arrivalTime" type="time" defaultValue={nowClock()} />
        </Field>
      </div>
      <Field label="Security deposit, Rp" htmlFor="ci-deposit" error={errors.deposit} hint={cashbox ? `Recorded as cash in on ${cashbox.name}, submitted for approval` : 'No cashbox for this location; the deposit is noted on the stay only'}>
        <Input id="ci-deposit" name="deposit" type="number" inputMode="numeric" min={0} step={100_000} defaultValue={b.source === 'direct' ? 1_000_000 : 0} className="tabular" />
      </Field>
      <CheckRow name="keysHanded" label="Keys or access code handed over" error={errors.keysHanded} />
      <CheckRow name="rulesExplained" label="House rules and pool safety explained" hint="Quiet hours, smoking, pool depth, emergency numbers" />
      <Field label="Notes" htmlFor="ci-notes">
        <Textarea id="ci-notes" name="notes" rows={2} placeholder="Requests, allergies, late check-out asked" />
      </Field>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.form}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="accent" loading={saving}>
          {!saving && <LogIn aria-hidden className="size-4" />} Complete check-in
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

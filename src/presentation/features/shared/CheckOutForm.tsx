import { useState, type FormEvent } from 'react'
import { LogOut } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { CheckOutDetails } from '@/domain/booking'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { CheckRow } from './CheckRow'

interface CheckOutFormProps {
  booking: BookingView
  save: (details: CheckOutDetails) => Promise<unknown>
  onDone: () => void
  onCancel?: () => void
}

/** The departure checklist: room inspection, keys, deposit returned, departure charges, notes. */
export function CheckOutForm({ booking: b, save, onDone, onCancel }: CheckOutFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const held = b.arrival?.deposit ?? 0

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({
        depositReturned: Number(f.get('depositReturned')) || 0,
        extraCharges: Number(f.get('extraCharges')) || 0,
        roomInspected: f.get('roomInspected') === 'on',
        keysReturned: f.get('keysReturned') === 'on',
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
        <Field label="Departure charges, Rp" htmlFor="co-charges" error={errors.extraCharges} hint="Minibar, damage, late check-out; recorded as cash in">
          <Input id="co-charges" name="extraCharges" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={0} className="tabular" />
        </Field>
      </div>
      <Field label="Notes" htmlFor="co-notes">
        <Textarea id="co-notes" name="notes" rows={2} placeholder="What was charged and why, feedback from the guest" />
      </Field>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.form}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="accent" loading={saving}>
          {!saving && <LogOut aria-hidden className="size-4" />} Complete check-out
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

import { useState, type FormEvent } from 'react'
import { LogIn } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { CheckInDetails } from '@/domain/booking'
import type { CashAccount } from '@/domain/finance'
import { countryName, ID_TYPE_LABEL } from '@/domain/guest'
import { asksDeposit, placeTerms } from '@/domain/property'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { StayRegistration } from '../guests/StayRegistration'
import { CheckRow } from './CheckRow'
import { GuestAlerts } from './GuestAlerts'

interface CheckInFormProps {
  booking: BookingView
  cashbox: CashAccount | null
  save: (details: CheckInDetails) => Promise<unknown>
  /** What a verified online check-in already told the desk. */
  prefill?: Partial<CheckInDetails>
  onDone: () => void
  onCancel?: () => void
}

const nowClock = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The front-desk arrival checklist: ID, party, deposit, keys, house rules, notes. */
export function CheckInForm({ booking: b, cashbox, save, onDone, onCancel, prefill = {} }: CheckInFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  // Villas ask a security deposit by default and hotel rooms do not; the property's setting decides.
  const deposit = asksDeposit(b.place)
  const room = placeTerms(b.place).unit === 'Room'

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
        depositAsked: deposit,
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-panel bg-info-soft p-3.5 text-sm text-body">
        <span className="font-semibold">{b.guestName}</span> · {placeTerms(b.place).code(b.unitCode)} · {shortDay(b.checkIn)} to {shortDay(b.checkOut)} · {plural(b.nights, 'night')} · {money(b.total)}
        {b.notes && <span className="mt-1 block text-xs">{b.notes}</span>}
      </div>
      <GuestAlerts guest={b.guest} />
      <StayRegistration bookingId={b.id} adults={b.partySize?.adults} />
      <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={`Check in ${b.guestName}`}>
        <CheckRow name="idVerified" label={`${ID_TYPE_LABEL[b.guest.idType]} matches the booking`} defaultChecked={prefill.idVerified} hint={<>On file: <span className="font-mono">{b.guest.idNumber || 'no number'}</span> · {countryName(b.guest.nationality)}</>} error={errors.idVerified} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Adults" htmlFor="ci-adults" error={errors.adults}>
            <Input id="ci-adults" name="adults" type="number" inputMode="numeric" min={1} defaultValue={b.arrival?.adults ?? prefill.adults ?? b.partySize?.adults ?? 2} className="tabular" />
          </Field>
          <Field label="Children" htmlFor="ci-children" error={errors.children}>
            <Input id="ci-children" name="children" type="number" inputMode="numeric" min={0} defaultValue={b.arrival?.children ?? prefill.children ?? b.partySize?.children ?? 0} className="tabular" />
          </Field>
          <Field label="Arrived at" htmlFor="ci-time">
            <Input id="ci-time" name="arrivalTime" type="time" defaultValue={prefill.arrivalTime ?? nowClock()} />
          </Field>
        </div>
        <Field label="Security deposit, Rp" htmlFor="ci-deposit" error={errors.deposit} hint={!deposit ? `${b.place.villa.name} takes no deposit at check-in; enter one only if the guest leaves it` : cashbox ? `Recorded as cash in on ${cashbox.name}, submitted for approval` : 'No cashbox for this location; the deposit is noted on the stay only'}>
          <Input id="ci-deposit" name="deposit" type="number" inputMode="numeric" min={0} step={100_000} defaultValue={deposit && b.source === 'direct' ? 1_000_000 : 0} className="tabular" />
        </Field>
        <CheckRow name="keysHanded" label={room ? 'Room key card handed over' : 'Keys or access code handed over'} error={errors.keysHanded} />
        <CheckRow name="rulesExplained" defaultChecked={prefill.rulesExplained} label={room ? 'Hotel rules and breakfast times explained' : 'House rules and pool safety explained'} hint={room ? 'Quiet hours, smoking, breakfast, emergency numbers' : 'Quiet hours, smoking, pool depth, emergency numbers'} />
        <Field label="Notes" htmlFor="ci-notes">
          <Textarea id="ci-notes" name="notes" rows={2} defaultValue={prefill.notes} placeholder="Requests, allergies, late check-out asked" />
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
    </div>
  )
}

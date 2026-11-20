import { useState, type FormEvent } from 'react'
import { type Meter, type MeterReading, type ReadingPurpose } from '@/domain/utilities'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Switch } from '../../ui/Switch'
import { PhotoField } from '../maintenance/PhotoField'

interface Props {
  meters: readonly Pick<Meter, 'id' | 'number' | 'unit'>[]
  today: string
  /** Fixed by the booking page: the stay and what the reading is for. */
  preset?: { meterId: string; purpose: ReadingPurpose; bookingId: string }
  onDone: (reading: MeterReading) => void
  onCancel: () => void
}

/** Records one meter reading: date, value, photo; monthly, or at a long stay's check-in or check-out. */
export function ReadingForm({ meters, today, preset, onDone, onCancel }: Props) {
  const { villaOps } = useServices()
  const [photo, setPhoto] = useState<string[]>([])
  const [replacement, setReplacement] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const id = preset ? `${preset.meterId}-${preset.purpose}` : 'reading'

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const purpose: ReadingPurpose = preset?.purpose ?? 'monthly'
      const reading = await villaOps.recordReading({
        meterId: preset?.meterId ?? String(f.get('meterId')),
        on: String(f.get('on')),
        value: Number(f.get('value')),
        photo: photo.at(-1) ?? null,
        purpose,
        bookingId: preset?.bookingId ?? null,
        replacement,
      })
      onDone(reading)
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  const unit = meters.find((m) => m.id === preset?.meterId)?.unit
  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-4 sm:grid-cols-2" aria-label="Record a reading">
      {!preset && (
        <Field label="Meter" htmlFor={`${id}-meter`} error={errors.meterId} hint="A monthly reading. Check-in and check-out readings are taken on a long stay's booking page." className="sm:col-span-2">
          <Select id={`${id}-meter`} name="meterId" className="w-full" options={meters.map((m) => ({ value: m.id, label: `${m.number}, ${m.unit}` }))} />
        </Field>
      )}
      <Field label="Date" htmlFor={`${id}-on`} error={errors.on}>
        <Input id={`${id}-on`} name="on" type="date" max={today} defaultValue={today} required />
      </Field>
      <Field label={unit ? `Value, ${unit}` : 'Value'} htmlFor={`${id}-value`} error={errors.value ?? errors.form ?? errors.bookingId}>
        <Input id={`${id}-value`} name="value" type="number" min={0} step="0.01" required />
      </Field>
      <Field label="Photo of the dial" htmlFor={`${id}-photo`}>
        <PhotoField id={`${id}-photo`} value={photo} onChange={(names) => setPhoto(names.slice(-1))} />
      </Field>
      <div className="flex items-center gap-3 self-end">
        <Switch checked={replacement} onChange={setReplacement} label="The meter was replaced" />
        <span className="text-sm">The meter was replaced</span>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="accent" loading={saving}>
          Record reading
        </Button>
        <Button variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

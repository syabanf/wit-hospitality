import { useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import type { BookingView, ServiceRequestView } from '@/application/views'
import type { Catalog } from '@/domain/property'
import { SERVICE_KIND_LABEL, SERVICE_KINDS, type ServiceKind, type ServicePriority, type ServiceRequestInput } from '@/domain/roomService'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'

interface RequestFormProps {
  initial?: ServiceRequestView
  catalog: Catalog
  inHouse: readonly BookingView[]
  initialBookingId?: string
  initialUnitId?: string
  save: (input: ServiceRequestInput) => Promise<unknown>
  onDone: () => void
  onCancel?: () => void
}

/** New room-service request: pick the stay (or a unit for housekeeping), what is needed, priority, charge, note. */
export function RequestForm({ initial, catalog, inHouse, initialBookingId, initialUnitId, save, onDone, onCancel }: RequestFormProps) {
  const [bookingId, setBookingId] = useState(initial?.bookingId ?? initialBookingId ?? '')
  const [unitId, setUnitId] = useState(initial?.unitId ?? initialUnitId ?? inHouse.find((b) => b.id === initialBookingId)?.unitId ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  function pickBooking(id: string) {
    setBookingId(id)
    const stay = inHouse.find((b) => b.id === id)
    if (stay) setUnitId(stay.unitId)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({
        unitId,
        bookingId: bookingId || null,
        kind: String(f.get('kind')) as ServiceKind,
        priority: f.get('urgent') === 'on' ? 'urgent' : ('normal' as ServicePriority),
        charge: Number(f.get('charge')) || 0,
        note: String(f.get('note') ?? ''),
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label="New request">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Guest in house" htmlFor="rq-booking" hint="Leave empty for housekeeping work on an empty unit">
          <Select id="rq-booking" className="w-full" value={bookingId} options={[{ value: '', label: 'No guest' }, ...(initial?.booking && !inHouse.some((b) => b.id === initial.booking?.id) ? [initial.booking] : []), ...inHouse].map((b) => ('id' in b ? { value: b.id, label: `${b.unitCode} · ${b.guestName}` } : b))} onChange={(e) => pickBooking(e.target.value)} />
        </Field>
        <Field label="Unit" htmlFor="rq-unit" error={errors.unitId}>
          <Select id="rq-unit" className="w-full" value={unitId} options={[{ value: '', label: 'Pick the unit' }, ...catalog.units.filter((u) => u.status !== 'inactive').map((u) => ({ value: u.id, label: `${u.code} · ${catalog.villa(u.villaId).name}` }))]} onChange={(e) => setUnitId(e.target.value)} />
        </Field>
        <Field label="What is needed" htmlFor="rq-kind" error={errors.kind}>
          <Select id="rq-kind" name="kind" className="w-full" defaultValue={initial?.kind ?? 'cleaning'} options={SERVICE_KINDS.map((k) => ({ value: k, label: SERVICE_KIND_LABEL[k] }))} />
        </Field>
        <Field label="Charge to the guest, Rp" htmlFor="rq-charge" error={errors.charge} hint="Zero when included in the stay">
          <Input id="rq-charge" name="charge" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={initial?.charge ?? 0} className="tabular" />
        </Field>
        <Field label="Details" htmlFor="rq-note" error={errors.note} className="sm:col-span-2">
          <Textarea id="rq-note" name="note" rows={2} defaultValue={initial?.note} placeholder="Two bath towels, express laundry by 18:00, AC drips" />
        </Field>
        <label className="flex h-12 items-center gap-3 rounded-full border border-line-strong bg-raised px-4 text-sm sm:col-span-2">
          <input type="checkbox" name="urgent" defaultChecked={initial?.priority === 'urgent'} className="size-4 accent-accent" />
          Urgent: the guest is waiting or safety is involved
        </label>
      </div>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.form}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="accent" loading={saving}>
          {!saving && <Plus aria-hidden className="size-4" />} {initial ? 'Save request' : 'Create request'}
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

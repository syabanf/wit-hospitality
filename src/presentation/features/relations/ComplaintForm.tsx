import { useState, type FormEvent } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { Guest } from '@/domain/guest'
import type { Catalog } from '@/domain/property'
import { COMPLAINT_CATEGORIES, COMPLAINT_CATEGORY_LABEL, SEVERITIES, SEVERITY_LABEL, type Complaint, type ComplaintCategory, type Severity } from '@/domain/relations'
import { useServices } from '../../hooks/useServices'
import { useAccess } from '../../hooks/useAccess'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { useToast } from '../../ui/useToast'
import { nowOn } from './shared'

interface ComplaintFormProps {
  catalog: Catalog
  guests: readonly Guest[]
  stays: readonly BookingView[]
  today: string
  /** Opens on this stay, as from the booking page. */
  bookingId?: string
  onDone: (c: Complaint) => void
  onCancel?: () => void
}

/** Log what a guest complained about, on a stay or on the guest alone. */
export function ComplaintForm({ catalog, guests, stays, today, bookingId: initialStay = '', onDone, onCancel }: ComplaintFormProps) {
  const { complaints } = useServices()
  const { user } = useAccess()
  const toast = useToast()
  const first = stays.find((b) => b.id === initialStay)
  const [villaId, setVillaId] = useState(first?.place.villa.id ?? catalog.villas[0]?.id ?? '')
  const [bookingId, setBookingId] = useState(initialStay)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const villaStays = stays.filter((b) => b.place.villa.id === villaId)
  const units = catalog.units.filter((u) => u.villaId === villaId)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const c = await complaints.log({
        villaId,
        unitId: bookingId ? null : String(f.get('unitId') ?? '') || null,
        bookingId: bookingId || null,
        guestId: bookingId ? null : String(f.get('guestId') ?? '') || null,
        category: String(f.get('category')) as ComplaintCategory,
        severity: String(f.get('severity')) as Severity,
        description: String(f.get('description') ?? ''),
        receivedBy: String(f.get('receivedBy') ?? ''),
        receivedAt: String(f.get('receivedAt') ?? ''),
        owner: String(f.get('owner') ?? ''),
      })
      toast({ title: `Logged ${c.number}`, description: COMPLAINT_CATEGORY_LABEL[c.category] })
      onDone(c)
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label="Log a complaint">
      <Field label="Property" htmlFor="cp-villa" error={errors.villaId}>
        <Select
          id="cp-villa"
          className="w-full"
          value={villaId}
          onChange={(e) => {
            setVillaId(e.target.value)
            setBookingId('')
          }}
          options={catalog.villas.map((v) => ({ value: v.id, label: v.name }))}
        />
      </Field>
      <Field label="Stay" htmlFor="cp-stay" hint="The stay gives the unit and the guest">
        <Select id="cp-stay" className="w-full" value={bookingId} onChange={(e) => setBookingId(e.target.value)} options={[{ value: '', label: 'No stay, pick the guest' }, ...villaStays.map((b) => ({ value: b.id, label: `${b.guestName} · ${b.code}, ${b.unitCode}` }))]} />
      </Field>
      {!bookingId && (
        <>
          <Field label="Guest" htmlFor="cp-guest" error={errors.guestId}>
            <Select id="cp-guest" name="guestId" className="w-full" options={[{ value: '', label: 'Pick the guest' }, ...[...guests].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ value: g.id, label: g.name }))]} />
          </Field>
          <Field label="Unit" htmlFor="cp-unit" hint="Optional">
            <Select id="cp-unit" name="unitId" className="w-full" options={[{ value: '', label: 'Not about a unit' }, ...units.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))]} />
          </Field>
        </>
      )}
      <Field label="Category" htmlFor="cp-category" error={errors.category}>
        <Select id="cp-category" name="category" className="w-full" options={COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: COMPLAINT_CATEGORY_LABEL[c] }))} />
      </Field>
      <Field label="Severity" htmlFor="cp-severity" error={errors.severity}>
        <Select id="cp-severity" name="severity" className="w-full" defaultValue="medium" options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))} />
      </Field>
      <Field label="What the guest said" htmlFor="cp-desc" error={errors.description} className="sm:col-span-2">
        <Textarea id="cp-desc" name="description" rows={3} placeholder="In the guest's words" />
      </Field>
      <Field label="Received by" htmlFor="cp-by" error={errors.receivedBy}>
        <Input id="cp-by" name="receivedBy" defaultValue={user.name} />
      </Field>
      <Field label="Received at" htmlFor="cp-at" error={errors.receivedAt}>
        <Input id="cp-at" name="receivedAt" type="datetime-local" max={`${today}T23:59`} defaultValue={nowOn(today)} />
      </Field>
      <Field label="Owner" htmlFor="cp-owner" error={errors.owner} hint="Who follows it up">
        <Input id="cp-owner" name="owner" defaultValue={user.name} />
      </Field>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">
          {errors.form}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="accent" loading={saving}>
          {!saving && <MessageSquarePlus aria-hidden className="size-4" />} Log the complaint
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

import { useState, type FormEvent } from 'react'
import { PackagePlus } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { Attachment } from '@/domain/attachment'
import type { Catalog } from '@/domain/property'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'

interface LostItemFormProps {
  catalog: Catalog
  /** Stays that started, newest first, to link the find to its owner. */
  stays: readonly BookingView[]
  today: string
  onDone: () => void
  onCancel?: () => void
}

/** Log a find: where, what, a photo and the stay it likely belongs to. Used on the desk and the phone. */
export function LostItemForm({ catalog, stays, today, onDone, onCancel }: LostItemFormProps) {
  const { lostFound } = useServices()
  const toast = useToast()
  const [villaId, setVillaId] = useState(catalog.villas[0]?.id ?? '')
  const [unitId, setUnitId] = useState('')
  const [photos, setPhotos] = useState<Attachment[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const units = catalog.units.filter((u) => u.villaId === villaId)
  const candidates = stays.filter((b) => b.place.villa.id === villaId && (!unitId || b.unitId === unitId)).slice(0, 8)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const bookingId = String(f.get('bookingId') ?? '') || null
    setSaving(true)
    setErrors({})
    try {
      const item = await lostFound.create({
        foundOn: String(f.get('foundOn') ?? ''),
        villaId,
        unitId: unitId || null,
        where: String(f.get('where') ?? ''),
        description: String(f.get('description') ?? ''),
        photos,
        guestId: null,
        bookingId,
        storage: String(f.get('storage') ?? ''),
      })
      toast({ title: `Logged ${item.number}`, description: item.description })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label="Log a find">
      <Field label="Villa" htmlFor="lf-villa" error={errors.villaId}>
        <Select
          id="lf-villa"
          className="w-full"
          value={villaId}
          onChange={(e) => {
            setVillaId(e.target.value)
            setUnitId('')
          }}
          options={catalog.villas.map((v) => ({ value: v.id, label: v.name }))}
        />
      </Field>
      <Field label="Unit" htmlFor="lf-unit">
        <Select id="lf-unit" className="w-full" value={unitId} onChange={(e) => setUnitId(e.target.value)} options={[{ value: '', label: 'Common area' }, ...units.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))]} />
      </Field>
      <Field label="Found on" htmlFor="lf-day" error={errors.foundOn}>
        <Input id="lf-day" name="foundOn" type="date" max={today} defaultValue={today} />
      </Field>
      <Field label="Where" htmlFor="lf-where" error={errors.where}>
        <Input id="lf-where" name="where" placeholder="Bedside drawer, pool deck" />
      </Field>
      <Field label="What it is" htmlFor="lf-desc" error={errors.description} className="sm:col-span-2">
        <Textarea id="lf-desc" name="description" rows={2} placeholder="Colour, brand, anything that tells it apart" />
      </Field>
      <Field label="Last guest in the room" htmlFor="lf-stay" hint="Leave empty when unknown">
        <Select id="lf-stay" name="bookingId" className="w-full" options={[{ value: '', label: 'Not known' }, ...candidates.map((b) => ({ value: b.id, label: `${b.guestName} · ${b.code}, ${b.unitCode}` }))]} />
      </Field>
      <Field label="Stored at" htmlFor="lf-store" hint="Optional">
        <Input id="lf-store" name="storage" placeholder="Office safe, shelf B" />
      </Field>
      <div className="sm:col-span-2">
        <p className="mb-1.5 text-sm font-medium">Photo</p>
        <AttachmentPicker id="lf-photo" value={photos} onChange={setPhotos} hint="A photo of the item" />
      </div>
      {errors.form && <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">{errors.form}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="accent" loading={saving}>
          {!saving && <PackagePlus aria-hidden className="size-4" />} Log the find
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

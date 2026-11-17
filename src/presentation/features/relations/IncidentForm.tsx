import { useState, type FormEvent } from 'react'
import { Plus, ShieldPlus, X } from 'lucide-react'
import type { BookingView } from '@/application/views'
import type { Attachment } from '@/domain/attachment'
import type { Catalog } from '@/domain/property'
import { INCIDENT_KIND_LABEL, INCIDENT_KINDS, PERSON_KIND_LABEL, PERSON_KINDS, SEVERITIES, SEVERITY_LABEL, type Incident, type IncidentKind, type IncidentPerson, type PersonKind, type Severity } from '@/domain/relations'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'
import { CheckRow } from '../shared/CheckRow'
import { nowOn } from './shared'

interface IncidentFormProps {
  catalog: Catalog
  stays: readonly BookingView[]
  today: string
  /** Editing an incident; without it the form logs a new one. */
  initial?: Incident
  onDone: (i: Incident) => void
  onCancel?: () => void
}

/** Log or edit an incident: what, where, when, who was involved, what was done, and the photos. */
export function IncidentForm({ catalog, stays, today, initial, onDone, onCancel }: IncidentFormProps) {
  const { incidents } = useServices()
  const toast = useToast()
  const [villaId, setVillaId] = useState(initial?.villaId ?? catalog.villas[0]?.id ?? '')
  const [bookingId, setBookingId] = useState(initial?.bookingId ?? '')
  const [people, setPeople] = useState<IncidentPerson[]>(initial?.people ?? [])
  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments ?? [])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const units = catalog.units.filter((u) => u.villaId === villaId)
  const villaStays = stays.filter((b) => b.place.villa.id === villaId)
  const setPerson = (i: number, change: Partial<IncidentPerson>) => setPeople((list) => list.map((p, j) => (j === i ? { ...p, ...change } : p)))

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input = {
      kind: String(f.get('kind')) as IncidentKind,
      severity: String(f.get('severity')) as Severity,
      villaId,
      unitId: bookingId ? null : String(f.get('unitId') ?? '') || null,
      area: String(f.get('area') ?? ''),
      occurredAt: String(f.get('occurredAt') ?? ''),
      bookingId: bookingId || null,
      people,
      description: String(f.get('description') ?? ''),
      actions: String(f.get('actions') ?? ''),
      policeCalled: f.get('policeCalled') === 'on',
      doctorCalled: f.get('doctorCalled') === 'on',
      policeReport: String(f.get('policeReport') ?? ''),
      attachments,
    }
    setSaving(true)
    setErrors({})
    try {
      const saved = initial ? await incidents.update(initial.id, input) : await incidents.log(input)
      toast({ title: initial ? `Saved ${saved.number}` : `Logged ${saved.number}`, description: INCIDENT_KIND_LABEL[saved.kind] })
      onDone(saved)
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label={initial ? `Edit ${initial.number}` : 'Log an incident'}>
      <Field label="What happened" htmlFor="in-kind" error={errors.kind}>
        <Select id="in-kind" name="kind" className="w-full" defaultValue={initial?.kind} options={INCIDENT_KINDS.map((k) => ({ value: k, label: INCIDENT_KIND_LABEL[k] }))} />
      </Field>
      <Field label="Severity" htmlFor="in-severity" error={errors.severity}>
        <Select id="in-severity" name="severity" className="w-full" defaultValue={initial?.severity ?? 'medium'} options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))} />
      </Field>
      <Field label="Property" htmlFor="in-villa" error={errors.villaId}>
        <Select
          id="in-villa"
          className="w-full"
          value={villaId}
          onChange={(e) => {
            setVillaId(e.target.value)
            setBookingId('')
          }}
          options={catalog.villas.map((v) => ({ value: v.id, label: v.name }))}
        />
      </Field>
      <Field label="When" htmlFor="in-at" error={errors.occurredAt}>
        <Input id="in-at" name="occurredAt" type="datetime-local" max={`${today}T23:59`} defaultValue={initial?.occurredAt ?? nowOn(today)} />
      </Field>
      <Field label="Guest's stay" htmlFor="in-stay" hint="Needed to charge damage to the guest">
        <Select id="in-stay" className="w-full" value={bookingId} onChange={(e) => setBookingId(e.target.value)} options={[{ value: '', label: 'No stay' }, ...villaStays.map((b) => ({ value: b.id, label: `${b.guestName} · ${b.code}, ${b.unitCode}` }))]} />
      </Field>
      {!bookingId && (
        <Field label="Unit" htmlFor="in-unit">
          <Select id="in-unit" name="unitId" className="w-full" defaultValue={initial?.unitId ?? ''} options={[{ value: '', label: 'Common area' }, ...units.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))]} />
        </Field>
      )}
      <Field label="Area" htmlFor="in-area" error={errors.area} hint="Pool deck, lobby, parking">
        <Input id="in-area" name="area" defaultValue={initial?.area} />
      </Field>
      <Field label="Description" htmlFor="in-desc" error={errors.description} className="sm:col-span-2">
        <Textarea id="in-desc" name="description" rows={3} defaultValue={initial?.description} />
      </Field>
      <Field label="Actions taken" htmlFor="in-actions" className="sm:col-span-2">
        <Textarea id="in-actions" name="actions" rows={2} defaultValue={initial?.actions} />
      </Field>
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="mb-1.5 text-sm font-medium">People involved</legend>
        {people.map((p, i) => (
          <div key={i} className="flex flex-wrap items-start gap-2 rounded-panel bg-raised p-3">
            <Select aria-label={`Person ${i + 1}, who`} value={p.kind} onChange={(e) => setPerson(i, { kind: e.target.value as PersonKind })} options={PERSON_KINDS.map((k) => ({ value: k, label: PERSON_KIND_LABEL[k] }))} />
            <div className="min-w-36 flex-1">
              <Input aria-label={`Person ${i + 1}, name`} placeholder="Name" value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} />
              {errors[`people.${i}.name`] && <p className="mt-1 text-xs font-medium text-danger">{errors[`people.${i}.name`]}</p>}
            </div>
            <Input aria-label={`Person ${i + 1}, note`} placeholder="Injured, witness, first aid" className="min-w-36 flex-1" value={p.note} onChange={(e) => setPerson(i, { note: e.target.value })} />
            <Button variant="ghost" size="icon-sm" aria-label={`Remove person ${i + 1}`} onClick={() => setPeople((list) => list.filter((_, j) => j !== i))}>
              <X aria-hidden className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="soft" size="sm" onClick={() => setPeople((list) => [...list, { kind: 'guest', name: '', guestId: null, note: '' }])}>
          <Plus aria-hidden className="size-4" /> Add a person
        </Button>
      </fieldset>
      <CheckRow name="policeCalled" label="Police called" defaultChecked={initial?.policeCalled} />
      <CheckRow name="doctorCalled" label="Doctor called" defaultChecked={initial?.doctorCalled} />
      <Field label="Police report number" htmlFor="in-police" hint="Optional">
        <Input id="in-police" name="policeReport" defaultValue={initial?.policeReport} />
      </Field>
      <div className="sm:col-span-2">
        <p className="mb-1.5 text-sm font-medium">Photos and documents</p>
        <AttachmentPicker id="in-files" value={attachments} onChange={setAttachments} hint="Photos of the scene, a doctor's note, the police report" />
        {errors.attachments && <p className="mt-1 text-xs font-medium text-danger">{errors.attachments}</p>}
      </div>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">
          {errors.form}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="accent" loading={saving}>
          {!saving && <ShieldPlus aria-hidden className="size-4" />} {initial ? 'Save' : 'Log the incident'}
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

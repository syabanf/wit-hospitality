import { useState, type FormEvent, type ReactNode } from 'react'
import { UNIT_AMENITIES, UNIT_STATUS_LABEL, UNIT_STATUSES, VILLA_FACILITIES, type Catalog, type GroupInput, type Location, type LocationInput, type Unit, type UnitGroup, type UnitInput, type UnitStatus, type Villa, type VillaInput } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { splitCustom } from '../../ui/splitCustom'

interface FormShellProps<I> {
  title: string
  submitLabel: string
  read: (f: FormData) => I
  save: (input: I) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
  children: (errors: Record<string, string>) => ReactNode
}

/** Inline master-data form: reads the fields, calls the use case, shows field errors under the inputs. */
function FormShell<I>({ title, submitLabel, read, save, onDone, onCancel, children }: FormShellProps<I>) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      await save(read(new FormData(e.currentTarget)))
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={title}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{title}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children(errors)}</div>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {submitLabel}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

const text = (f: FormData, key: string) => String(f.get(key) ?? '').trim()

interface Common<E, I> {
  initial?: E
  save: (input: I) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

export function LocationForm({ initial, ...rest }: Common<Location, LocationInput>) {
  return (
    <FormShell
      title={initial ? `Edit ${initial.name}` : 'New location'}
      submitLabel={initial ? 'Save location' : 'Add location'}
      read={(f) => ({ name: text(f, 'name'), area: text(f, 'area') })}
      {...rest}
    >
      {(errors) => (
        <>
          <Field label="Name" htmlFor="loc-name" error={errors.name}>
            <Input id="loc-name" name="name" defaultValue={initial?.name} placeholder="Canggu" />
          </Field>
          <Field label="Regency and island" htmlFor="loc-area" error={errors.area}>
            <Input id="loc-area" name="area" defaultValue={initial?.area} placeholder="Badung, Bali" />
          </Field>
        </>
      )}
    </FormShell>
  )
}

export function VillaForm({ initial, catalog, locationId, ...rest }: Common<Villa, VillaInput> & { catalog: Catalog; locationId?: string }) {
  return (
    <FormShell
      title={initial ? `Edit ${initial.name}` : 'New villa'}
      submitLabel={initial ? 'Save villa' : 'Add villa'}
      read={(f) => ({ locationId: text(f, 'locationId'), code: text(f, 'code').toUpperCase(), name: text(f, 'name'), description: text(f, 'description'), facilities: [...f.getAll('facilities').map(String), ...splitCustom(text(f, 'customFacilities'))] })}
      {...rest}
    >
      {(errors) => (
        <>
          <Field label="Location" htmlFor="villa-loc" error={errors.locationId}>
            <Select id="villa-loc" name="locationId" className="w-full" defaultValue={initial?.locationId ?? locationId ?? ''} options={[{ value: '', label: 'Pick the location' }, ...catalog.locations.map((l) => ({ value: l.id, label: l.name }))]} />
          </Field>
          <Field label="Code" htmlFor="villa-code" error={errors.code} hint="Two to four capital letters; unit codes start with it">
            <Input id="villa-code" name="code" defaultValue={initial?.code} placeholder="SK" className="font-mono uppercase" maxLength={4} />
          </Field>
          <Field label="Name" htmlFor="villa-name" error={errors.name}>
            <Input id="villa-name" name="name" defaultValue={initial?.name} placeholder="Villa Saka" />
          </Field>
          <Field label="Description" htmlFor="villa-desc" className="sm:col-span-2">
            <Textarea id="villa-desc" name="description" defaultValue={initial?.description} rows={2} />
          </Field>
          <Field label="Facilities" className="sm:col-span-2">
            <CheckboxGrid name="facilities" options={VILLA_FACILITIES} selected={initial?.facilities ?? []} />
          </Field>
          <Field label="Other facilities" htmlFor="villa-custom" hint="Comma separated" className="sm:col-span-2">
            <Input id="villa-custom" name="customFacilities" defaultValue={(initial?.facilities ?? []).filter((f) => !VILLA_FACILITIES.some((o) => o.id === f)).join(', ')} placeholder="Yoga deck, beach club" />
          </Field>
        </>
      )}
    </FormShell>
  )
}

export function GroupForm({ initial, villaId, ...rest }: Common<UnitGroup, GroupInput> & { villaId: string }) {
  return (
    <FormShell
      title={initial ? `Edit ${initial.name}` : 'New unit group'}
      submitLabel={initial ? 'Save group' : 'Add group'}
      read={(f) => ({ villaId, name: text(f, 'name'), interchangeable: f.get('interchangeable') === 'on' })}
      {...rest}
    >
      {(errors) => (
        <>
          <Field label="Name" htmlFor="grp-name" error={errors.name} hint="Units with the same design, for example the eight standard units">
            <Input id="grp-name" name="name" defaultValue={initial?.name} placeholder="Saka standard" />
          </Field>
          <label className="flex h-12 items-center gap-3 self-end rounded-full border border-line-strong bg-raised px-4 text-sm">
            <input type="checkbox" name="interchangeable" defaultChecked={initial?.interchangeable ?? true} className="size-4 accent-accent" />
            Bookings may move between these units
          </label>
        </>
      )}
    </FormShell>
  )
}

export function UnitForm({ initial, villa, groups, ...rest }: Common<Unit, UnitInput> & { villa: Villa; groups: readonly UnitGroup[] }) {
  return (
    <FormShell
      title={initial ? `Edit ${initial.code}` : `New unit in ${villa.name}`}
      submitLabel={initial ? 'Save unit' : 'Add unit'}
      read={(f) => ({
        villaId: villa.id,
        groupId: text(f, 'groupId') || null,
        code: text(f, 'code').toUpperCase(),
        name: text(f, 'name'),
        bedrooms: Number(f.get('bedrooms')),
        nightlyRate: Number(f.get('nightlyRate')),
        status: (text(f, 'status') || 'active') as UnitStatus,
        amenities: [...f.getAll('amenities').map(String), ...splitCustom(text(f, 'customAmenities'))],
      })}
      {...rest}
    >
      {(errors) => (
        <>
          <Field label="Code" htmlFor="unit-code" error={errors.code} hint={`${villa.code}-01, ${villa.code}-02, …`}>
            <Input id="unit-code" name="code" defaultValue={initial?.code ?? `${villa.code}-`} className="font-mono uppercase" maxLength={7} />
          </Field>
          <Field label="Name" htmlFor="unit-name" error={errors.name}>
            <Input id="unit-name" name="name" defaultValue={initial?.name} placeholder="Saka 9" />
          </Field>
          <Field label="Bedrooms" htmlFor="unit-beds" error={errors.bedrooms}>
            <Input id="unit-beds" name="bedrooms" type="number" inputMode="numeric" min={1} defaultValue={initial?.bedrooms ?? 1} className="tabular" />
          </Field>
          <Field label="Nightly rate, Rp" htmlFor="unit-rate" error={errors.nightlyRate} hint="Airbnb price; direct stays take 10% off">
            <Input id="unit-rate" name="nightlyRate" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={initial?.nightlyRate ?? ''} className="tabular" />
          </Field>
          <Field label="Group" htmlFor="unit-group" error={errors.groupId}>
            <Select id="unit-group" name="groupId" className="w-full" defaultValue={initial?.groupId ?? ''} options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          </Field>
          <Field label="Status" htmlFor="unit-status" error={errors.status}>
            <Select id="unit-status" name="status" className="w-full" defaultValue={initial?.status ?? 'active'} options={UNIT_STATUSES.map((s) => ({ value: s, label: UNIT_STATUS_LABEL[s] }))} />
          </Field>
          <Field label="Amenities" className="sm:col-span-2">
            <CheckboxGrid name="amenities" options={UNIT_AMENITIES} selected={initial?.amenities ?? []} />
          </Field>
          <Field label="Other amenities" htmlFor="unit-custom" hint="Comma separated" className="sm:col-span-2">
            <Input id="unit-custom" name="customAmenities" defaultValue={(initial?.amenities ?? []).filter((a) => !UNIT_AMENITIES.some((o) => o.id === a)).join(', ')} placeholder="Coffee machine, hammock" />
          </Field>
        </>
      )}
    </FormShell>
  )
}

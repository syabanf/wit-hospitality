import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  BED_LABEL,
  BED_TYPES,
  CANCELLATION_LABEL,
  CANCELLATION_POLICIES,
  CANCELLATION_TEXT,
  DEPOSIT_KINDS,
  DEPOSIT_LABEL,
  MAX_EXTRA_BEDS,
  MAX_HOUSE_RULES,
  UNIT_AMENITIES,
  UNIT_VIEWS,
  unitSetupDefaults,
  VIEW_LABEL,
  VILLA_FACILITIES,
  VILLA_PROFILE_DEFAULTS,
  type Bed,
  type BedType,
  type CancellationPolicy,
  type Catalog,
  type DepositKind,
  type GroupInput,
  type Location,
  type LocationInput,
  type Unit,
  type UnitGroup,
  type UnitInput,
  type UnitView,
  type Villa,
  type VillaInput,
} from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { splitCustom } from '../../ui/splitCustom'
import type { UnitSaved } from './unitToast'

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

/** A heading that starts a group of fields across both columns. */
function Group({ title }: { title: string }) {
  return <p className="border-t border-line pt-4 text-sm font-semibold first:border-0 first:pt-0 sm:col-span-2">{title}</p>
}

const numberOrNull = (f: FormData, key: string) => (text(f, key) === '' ? null : Number(text(f, key)))

export function VillaForm({ initial, catalog, locationId, ...rest }: Common<Villa, VillaInput> & { catalog: Catalog; locationId?: string }) {
  const v = initial ?? VILLA_PROFILE_DEFAULTS
  const [deposit, setDeposit] = useState<DepositKind>(v.depositKind)
  return (
    <FormShell
      title={initial ? `Edit ${initial.name}` : 'New villa'}
      submitLabel={initial ? 'Save villa' : 'Add villa'}
      read={(f) => ({
        locationId: text(f, 'locationId'),
        code: text(f, 'code').toUpperCase(),
        name: text(f, 'name'),
        description: text(f, 'description'),
        facilities: [...f.getAll('facilities').map(String), ...splitCustom(text(f, 'customFacilities'))],
        address: text(f, 'address'),
        lat: numberOrNull(f, 'lat'),
        lng: numberOrNull(f, 'lng'),
        phone: text(f, 'phone'),
        email: text(f, 'email'),
        checkInTime: text(f, 'checkInTime'),
        checkOutTime: text(f, 'checkOutTime'),
        licenseNo: text(f, 'licenseNo'),
        bankName: text(f, 'bankName'),
        bankAccountNo: text(f, 'bankAccountNo').replace(/[\s-]/g, ''),
        bankAccountName: text(f, 'bankAccountName'),
        houseRules: text(f, 'houseRules'),
        cancellationPolicy: text(f, 'cancellationPolicy') as CancellationPolicy,
        depositKind: deposit,
        depositValue: deposit === 'none' ? 0 : Number(text(f, 'depositValue')),
        photos: v.photos,
      })}
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

          <Group title="Location and contact" />
          <Field label="Address" htmlFor="villa-address" error={errors.address} className="sm:col-span-2">
            <Input id="villa-address" name="address" defaultValue={v.address} placeholder="Jl. Pantai Batu Bolong No. 88, Canggu, Badung" />
          </Field>
          <Field label="Latitude" htmlFor="villa-lat" error={errors.lat} hint="From the pin in Google Maps, for example -8.6559">
            <Input id="villa-lat" name="lat" type="number" inputMode="decimal" step="any" defaultValue={v.lat ?? ''} className="tabular" />
          </Field>
          <Field label="Longitude" htmlFor="villa-lng" error={errors.lng} hint="For example 115.1306">
            <Input id="villa-lng" name="lng" type="number" inputMode="decimal" step="any" defaultValue={v.lng ?? ''} className="tabular" />
          </Field>
          <Field label="Phone" htmlFor="villa-phone" error={errors.phone}>
            <Input id="villa-phone" name="phone" type="tel" defaultValue={v.phone} placeholder="+62 …" />
          </Field>
          <Field label="Email" htmlFor="villa-email" error={errors.email}>
            <Input id="villa-email" name="email" type="email" defaultValue={v.email} placeholder="villa@balivillas.id" />
          </Field>

          <Group title="Check-in and check-out" />
          <Field label="Check-in from" htmlFor="villa-in" error={errors.checkInTime} hint="Bali time">
            <Input id="villa-in" name="checkInTime" type="time" defaultValue={v.checkInTime} className="tabular" />
          </Field>
          <Field label="Check-out by" htmlFor="villa-out" error={errors.checkOutTime}>
            <Input id="villa-out" name="checkOutTime" type="time" defaultValue={v.checkOutTime} className="tabular" />
          </Field>

          <Group title="Licence and bank" />
          <Field label="Licence" htmlFor="villa-licence" error={errors.licenseNo} hint="NIB or Pondok Wisata permit" className="sm:col-span-2">
            <Input id="villa-licence" name="licenseNo" defaultValue={v.licenseNo} placeholder="NIB 9120001234567" />
          </Field>
          <Field label="Bank" htmlFor="villa-bank" error={errors.bankName}>
            <Input id="villa-bank" name="bankName" defaultValue={v.bankName} placeholder="BCA" />
          </Field>
          <Field label="Account number" htmlFor="villa-account" error={errors.bankAccountNo}>
            <Input id="villa-account" name="bankAccountNo" inputMode="numeric" defaultValue={v.bankAccountNo} className="font-mono" />
          </Field>
          <Field label="Account name" htmlFor="villa-holder" error={errors.bankAccountName} className="sm:col-span-2">
            <Input id="villa-holder" name="bankAccountName" defaultValue={v.bankAccountName} placeholder="PT Bali Villa Kelola" />
          </Field>

          <Group title="Policies" />
          <Field label="Cancellation policy" htmlFor="villa-cancel" error={errors.cancellationPolicy} className="sm:col-span-2">
            <Select id="villa-cancel" name="cancellationPolicy" className="w-full" defaultValue={v.cancellationPolicy} options={CANCELLATION_POLICIES.map((c) => ({ value: c, label: `${CANCELLATION_LABEL[c]}: ${CANCELLATION_TEXT[c]}` }))} />
          </Field>
          <Field label="Security deposit" htmlFor="villa-deposit">
            <Select id="villa-deposit" className="w-full" value={deposit} onChange={(e) => setDeposit(e.target.value as DepositKind)} options={DEPOSIT_KINDS.map((d) => ({ value: d, label: DEPOSIT_LABEL[d] }))} />
          </Field>
          {deposit !== 'none' && (
            <Field label={deposit === 'percent' ? 'Deposit, percent' : 'Deposit, Rp'} htmlFor="villa-deposit-value" error={errors.depositValue}>
              <Input id="villa-deposit-value" name="depositValue" type="number" inputMode="numeric" min={1} max={deposit === 'percent' ? 100 : undefined} step={deposit === 'percent' ? 1 : 50_000} defaultValue={v.depositKind === deposit ? v.depositValue : ''} className="tabular" />
            </Field>
          )}

          <Group title="House rules" />
          <Field label="House rules" htmlFor="villa-rules" error={errors.houseRules} hint={`One rule a line; guests see them on the website, up to ${MAX_HOUSE_RULES} characters`} className="sm:col-span-2">
            <Textarea id="villa-rules" name="houseRules" defaultValue={v.houseRules} rows={5} maxLength={MAX_HOUSE_RULES} placeholder="Quiet hours from 22:00 to 07:00." />
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
      read={(f) => ({ villaId, name: text(f, 'name'), interchangeable: f.get('interchangeable') === 'on', operatorAssigns: f.get('operatorAssigns') === 'on' })}
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
          <label className="flex min-h-12 items-center gap-3 self-end rounded-full border border-line-strong bg-raised px-4 py-2 text-sm">
            <input type="checkbox" name="operatorAssigns" defaultChecked={initial?.operatorAssigns ?? false} className="size-4 accent-accent" />
            Guests book the room type; the operator assigns the unit
          </label>
          {errors.operatorAssigns && <p className="text-xs font-medium text-danger">{errors.operatorAssigns}</p>}
        </>
      )}
    </FormShell>
  )
}

/** Rows of bed type and count; the list rides in a hidden field so the form reads it with the rest. */
function BedsField({ initial, error }: { initial: readonly Bed[]; error?: string }) {
  const [beds, setBeds] = useState<Bed[]>(() => initial.map((b) => ({ ...b })))
  const free = BED_TYPES.filter((t) => !beds.some((b) => b.type === t))
  const set = (i: number, patch: Partial<Bed>) => setBeds(beds.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  return (
    <Field label="Beds" error={error} hint="Each bed type once, with how many" className="sm:col-span-2">
      <input type="hidden" name="beds" value={JSON.stringify(beds)} />
      <ul className="space-y-2">
        {beds.map((b, i) => (
          <li key={b.type} className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-center gap-2">
            <Select aria-label={`Bed type, row ${i + 1}`} className="w-full" value={b.type} onChange={(e) => set(i, { type: e.target.value as BedType })} options={[b.type, ...free].map((t) => ({ value: t, label: BED_LABEL[t] }))} />
            <Input aria-label={`How many ${BED_LABEL[b.type].toLowerCase()} beds`} type="number" inputMode="numeric" min={1} value={b.count} onChange={(e) => set(i, { count: Number(e.target.value) })} className="tabular" />
            <Button variant="ghost" size="icon" aria-label={`Remove ${BED_LABEL[b.type].toLowerCase()} beds`} onClick={() => setBeds(beds.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      {free[0] && (
        <Button variant="soft" size="sm" className="mt-2" onClick={() => setBeds([...beds, { type: free[0]!, count: 1 }])}>
          <Plus aria-hidden className="size-4" /> Add bed
        </Button>
      )}
    </Field>
  )
}

type UnitFormProps = Omit<Common<Unit, UnitInput>, 'save' | 'onDone'> & { villa: Villa; groups: readonly UnitGroup[]; save: (input: UnitInput) => Promise<UnitSaved>; onDone: (saved: UnitSaved) => void }

/** The unit's details and what it sleeps. Status changes go through the status dialog on the unit page, with a reason. */
export function UnitForm({ initial, villa, groups, save, onDone, ...rest }: UnitFormProps) {
  const saved = useRef<UnitSaved | null>(null)
  const setup = initial ?? unitSetupDefaults(1)
  return (
    <FormShell
      save={async (input: UnitInput) => {
        saved.current = await save(input)
      }}
      onDone={() => saved.current && onDone(saved.current)}
      title={initial ? `Edit ${initial.code}` : `New unit in ${villa.name}`}
      submitLabel={initial ? 'Save unit' : 'Add unit'}
      read={(f) => {
        const extraBeds = Number(text(f, 'extraBeds') || 0)
        return {
          villaId: villa.id,
          groupId: text(f, 'groupId') || null,
          code: text(f, 'code').toUpperCase(),
          name: text(f, 'name'),
          bedrooms: Number(f.get('bedrooms')),
          nightlyRate: Number(f.get('nightlyRate')),
          status: initial?.status ?? 'active',
          amenities: [...f.getAll('amenities').map(String), ...splitCustom(text(f, 'customAmenities'))],
          maxAdults: Number(f.get('maxAdults')),
          maxChildren: Number(f.get('maxChildren')),
          beds: JSON.parse(text(f, 'beds') || '[]') as Bed[],
          sizeSqm: numberOrNull(f, 'sizeSqm'),
          view: text(f, 'view') as UnitView,
          extraBeds,
          extraBedRate: extraBeds > 0 ? Number(text(f, 'extraBedRate')) : 0,
          photos: setup.photos,
        }
      }}
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
          <Field label="Base price, Rp" htmlFor="unit-rate" error={errors.nightlyRate} hint="The Airbnb listing price; direct stays start from it">
            <Input id="unit-rate" name="nightlyRate" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={initial?.nightlyRate ?? ''} className="tabular" />
          </Field>
          <Field label="Group" htmlFor="unit-group" error={errors.groupId} hint="A room type without a rate plan starts one from this base price" className="sm:col-span-2">
            <Select id="unit-group" name="groupId" className="w-full" defaultValue={initial?.groupId ?? ''} options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          </Field>

          <Group title="Capacity and beds" />
          <Field label="Adults" htmlFor="unit-adults" error={errors.maxAdults}>
            <Input id="unit-adults" name="maxAdults" type="number" inputMode="numeric" min={1} defaultValue={setup.maxAdults} className="tabular" />
          </Field>
          <Field label="Children" htmlFor="unit-children" error={errors.maxChildren}>
            <Input id="unit-children" name="maxChildren" type="number" inputMode="numeric" min={0} defaultValue={setup.maxChildren} className="tabular" />
          </Field>
          <BedsField initial={setup.beds} error={errors.beds} />
          <Field label="Extra beds" htmlFor="unit-extra" error={errors.extraBeds} hint={`Up to ${MAX_EXTRA_BEDS}; each sleeps one more guest`}>
            <Input id="unit-extra" name="extraBeds" type="number" inputMode="numeric" min={0} max={MAX_EXTRA_BEDS} defaultValue={setup.extraBeds} className="tabular" />
          </Field>
          <Field label="Extra bed, Rp a night" htmlFor="unit-extra-rate" error={errors.extraBedRate} hint="Left at 0 without extra beds">
            <Input id="unit-extra-rate" name="extraBedRate" type="number" inputMode="numeric" min={0} step={50_000} defaultValue={setup.extraBedRate} className="tabular" />
          </Field>
          <Field label="Size, m²" htmlFor="unit-size" error={errors.sizeSqm}>
            <Input id="unit-size" name="sizeSqm" type="number" inputMode="numeric" min={1} defaultValue={setup.sizeSqm ?? ''} className="tabular" />
          </Field>
          <Field label="View" htmlFor="unit-view" error={errors.view}>
            <Select id="unit-view" name="view" className="w-full" defaultValue={setup.view} options={UNIT_VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))} />
          </Field>

          <Group title="Amenities" />
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

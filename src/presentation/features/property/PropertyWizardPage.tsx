import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, BedDouble, Building2, Check, Home, Plus, Trash2 } from 'lucide-react'
import {
  BED_LABEL,
  BED_TYPES,
  CANCELLATION_LABEL,
  CANCELLATION_POLICIES,
  CANCELLATION_TEXT,
  defaultDepositOnCheckIn,
  defaultMinStay,
  defaultStayoverEvery,
  facilityLabel,
  KIND_PLURAL,
  KIND_RULES,
  MAX_FLOOR,
  MAX_MIN_STAY,
  MAX_STAYOVER_EVERY,
  OPERATION_KINDS,
  OPERATION_LABEL,
  OPERATION_TEXT,
  OPERATIONS,
  propertyTerms,
  roomNumbers,
  UNIT_AMENITIES,
  validateProperty,
  VILLA_FACILITIES,
  VILLA_PROFILE_DEFAULTS,
  wizardTypes,
  type BedType,
  type CancellationPolicy,
  type Operation,
  type PropertyInput,
  type UnitKind,
  type VillaInput,
  type WizardGroup,
  type WizardRoom,
} from '@/domain/property'
import type { RatePlanInput } from '@/domain/ratePlan'
import { cn } from '@/lib/cn'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { splitCustom } from '../../ui/splitCustom'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { RatePlanFields } from './RatePlanForm'

type StepName = 'Operation' | 'Details' | 'Hotel rooms' | 'Villas' | 'Rates' | 'Facilities' | 'Review'
const OPERATION_ICON = { hotel: Building2, villa: Home, mixed: BedDouble } as const
/** The rules a choice brings, as step 1 summarises them. */
const SUMMARY_RULES = new Set(['Sold', 'Rate', 'Minimum stay', 'Deposit at check-in', 'Cleaning', 'Reports'])

/** A hotel room type and the room numbers generated for it. */
interface HotelType {
  id: number
  name: string
  rate: number
  maxAdults: number
  maxChildren: number
  bed: BedType
  operatorAssigns: boolean
  minStay: number
  amenities: readonly string[]
  /** The generator: floor 2 from 201, six rooms. */
  floor: string
  start: number
  count: number
  rooms: ReadonlyArray<{ code: string; floor: string }>
}

/** One villa, sold by name. */
interface VillaDraft {
  id: number
  code: string
  name: string
  bedrooms: number
  maxAdults: number
  maxChildren: number
  rate: number
  amenities: readonly string[]
}

const newType = (id: number): HotelType => ({ id, name: id === 1 ? 'Standard' : '', rate: 1_200_000, maxAdults: 2, maxChildren: 1, bed: 'king', operatorAssigns: true, minStay: defaultMinStay('room'), amenities: ['ac', 'tv', 'safe'], floor: '1', start: 101, count: 4, rooms: [] })
const roomName = (code: string) => `Room ${code.split('-')[1] ?? code}`

/** Errors for one room type's plan, keyed as validateRatePlan keys them. */
const planErrors = (errors: Record<string, string>, key: string) => Object.fromEntries(Object.entries(errors).flatMap(([k, v]) => (k.startsWith(`plans.${key}.`) ? [[k.slice(`plans.${key}.`.length), v]] : [])))

/**
 * The wizard input built from the hotel types and the villas: one room type per hotel type with its
 * generated rooms, one per villa. `groupKeys` and `roomKeys` map the field errors back to the step that owns them.
 */
function buildInput(villa: VillaInput, hotel: readonly HotelType[], villas: readonly VillaDraft[], villaMinStay: number, plans: Record<string, RatePlanInput>) {
  const kinds = OPERATION_KINDS[villa.operation]
  const groups: WizardGroup[] = []
  const rooms: WizardRoom[] = []
  const groupKeys: string[] = []
  const roomKeys: string[] = []
  const planOf = (key: string) => (plans[key] ? { plan: plans[key] } : {})
  if (kinds.includes('room'))
    for (const t of hotel) {
      const groupIndex = groups.length
      groupKeys.push(`h${t.id}`)
      groups.push({ name: t.name, kind: 'room', interchangeable: true, operatorAssigns: t.operatorAssigns, minStay: t.minStay, ...planOf(`h${t.id}`) })
      for (const r of t.rooms) {
        roomKeys.push(`h${t.id}`)
        rooms.push({ code: r.code, name: roomName(r.code), bedrooms: 1, nightlyRate: t.rate, groupIndex, amenities: t.amenities, maxAdults: t.maxAdults, maxChildren: t.maxChildren, beds: [{ type: t.bed, count: 1 }], floor: r.floor })
      }
    }
  if (kinds.includes('villa'))
    for (const v of villas) {
      const groupIndex = groups.length
      groupKeys.push(`v${v.id}`)
      roomKeys.push(`v${v.id}`)
      groups.push({ name: v.name, kind: 'villa', interchangeable: false, operatorAssigns: false, minStay: villaMinStay, ...planOf(`v${v.id}`) })
      rooms.push({ code: v.code, name: v.name, bedrooms: v.bedrooms, nightlyRate: v.rate, groupIndex, amenities: v.amenities, maxAdults: v.maxAdults, maxChildren: v.maxChildren })
    }
  return { input: { villa, groups, rooms } satisfies PropertyInput, groupKeys, roomKeys }
}

/** Operation, details, hotel rooms and villas each with their own rules, rate plans and facilities, saved together at the end. */
export default function PropertyWizardPage() {
  const { property } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const options = useResource('property.overview', () => property.overview())
  const [step, setStep] = useState(0)
  const [villa, setVillaState] = useState<VillaInput>({ ...VILLA_PROFILE_DEFAULTS, locationId: '', code: '', name: '', description: '', facilities: [] })
  const [hotel, setHotel] = useState<HotelType[]>([newType(1)])
  const [villas, setVillas] = useState<VillaDraft[]>([])
  const [villaMinStay, setVillaMinStay] = useState(defaultMinStay('villa'))
  const [plans, setPlans] = useState<Record<string, RatePlanInput>>({})
  const [nextId, setNextId] = useState(2)
  const [customFacilities, setCustomFacilities] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={8} />
  const locations = options.data.locations.map((l) => l.location)
  const existingVillas = options.data.locations.flatMap((l) => l.villas.map((v) => v.villa))
  const existingUnits = options.data.locations.flatMap((l) => l.villas.flatMap((v) => v.units.map((u) => u.place.unit)))

  const operation = villa.operation
  const kinds = OPERATION_KINDS[operation]
  const terms = propertyTerms(villa)
  const built = buildInput({ ...villa, facilities: [...villa.facilities, ...splitCustom(customFacilities)] }, hotel, villas, villaMinStay, plans)
  const full = built.input
  const steps: StepName[] = ['Operation', 'Details', ...(kinds.includes('room') ? (['Hotel rooms'] as const) : []), ...(kinds.includes('villa') ? (['Villas'] as const) : []), 'Rates', 'Facilities', 'Review']
  const current = steps[step] ?? 'Review'
  const last = steps.length - 1
  const unitsStep: StepName = kinds.includes('villa') ? 'Villas' : 'Hotel rooms'
  const setVilla = (patch: Partial<VillaInput>) => setVillaState({ ...villa, ...patch })
  const setType = (id: number, patch: Partial<HotelType>) => setHotel(hotel.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  const setVillaDraft = (id: number, patch: Partial<VillaDraft>) => setVillas(villas.map((v) => (v.id === id ? { ...v, ...patch } : v)))
  const groupError = (key: string, field: string) => errors[`groups.${built.groupKeys.indexOf(key)}.${field}`]
  const roomErrors = (key: string) => Object.entries(errors).flatMap(([k, v]) => {
    const m = /^rooms\.(\d+)\./.exec(k)
    return m && built.roomKeys[Number(m[1])] === key ? [v] : []
  })
  const villaError = (key: string, field: string) => errors[`rooms.${built.roomKeys.indexOf(key)}.${field}`]

  /** Which step owns a field error. */
  function stepOf(key: string): StepName {
    if (key === 'villa.operation') return 'Operation'
    if (key === 'villa.wholeRental' || key === 'villa.wholeNightlyRate') return 'Villas'
    if (key === 'villa.stayoverEvery') return kinds.includes('room') ? 'Hotel rooms' : 'Villas'
    if (key.startsWith('villa.')) return 'Details'
    if (key === 'rooms') return unitsStep
    if (key.startsWith('plans.')) return 'Rates'
    const m = /^(groups|rooms)\.(\d+)\./.exec(key)
    const owner = m ? (m[1] === 'groups' ? built.groupKeys : built.roomKeys)[Number(m[2])] : undefined
    return owner?.startsWith('h') ? 'Hotel rooms' : 'Villas'
  }

  function next() {
    const found = Object.fromEntries(Object.entries(validateProperty(full, existingVillas, existingUnits)).filter(([k]) => stepOf(k) === current))
    setErrors(found)
    if (Object.keys(found).length === 0) setStep(Math.min(last, step + 1))
  }

  /** Each operation brings its defaults: the stayover schedule and the deposit at check-in. */
  function pickOperation(next: Operation) {
    setVilla({ operation: next, stayoverEvery: defaultStayoverEvery(next), depositOnCheckIn: defaultDepositOnCheckIn(next), wholeRental: next === 'hotel' ? false : villa.wholeRental, wholeNightlyRate: next === 'hotel' ? 0 : villa.wholeNightlyRate })
  }

  function generate(t: HotelType) {
    const taken = new Set([...existingUnits.map((u) => u.code), ...hotel.filter((x) => x.id !== t.id).flatMap((x) => x.rooms.map((r) => r.code)), ...villas.map((v) => v.code)])
    const codes = roomNumbers(villa.code, t.start, t.count)
    setType(t.id, { rooms: codes.map((code) => ({ code, floor: t.floor.trim() })) })
    const clash = codes.filter((c) => taken.has(c))
    if (clash.length) toast({ tone: 'danger', title: 'Some room numbers are taken', description: `${clash.join(', ')} already exist. Pick another starting number.` })
  }

  function addVilla() {
    const taken = new Set([...existingUnits.map((u) => u.code), ...villas.map((v) => v.code), ...hotel.flatMap((t) => t.rooms.map((r) => r.code))])
    let n = 1
    while (taken.has(`${villa.code}-${String(n).padStart(2, '0')}`) && n < 99) n++
    setVillas([...villas, { id: nextId, code: `${villa.code}-${String(n).padStart(2, '0')}`, name: `Villa ${villas.length + 1}`, bedrooms: 2, maxAdults: 4, maxChildren: 2, rate: 3_000_000, amenities: ['ac', 'private-pool', 'kitchen'] }])
    setNextId(nextId + 1)
  }

  async function save() {
    setSaving(true)
    setErrors({})
    try {
      const created = await property.createProperty(full)
      toast({ title: `Created ${created.name}`, description: `${full.rooms.length} ${(full.rooms.length === 1 ? terms.unit : terms.units).toLowerCase()} across ${plural(full.groups.length, 'room type')}` })
      navigate(`/property/villas/${created.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      const owner = steps.indexOf(stepOf(Object.keys(e)[0] ?? ''))
      setStep(owner >= 0 ? owner : last)
    } finally {
      setSaving(false)
    }
  }

  const stayoverText = (n: number) => (n === 0 ? 'Departure clean only' : n === 1 ? 'Stayover every day, plus departure' : `Stayover every ${n} days, plus departure`)
  /** The rules that will apply to one kind, with the values this property sets. */
  const appliedRules = (kind: UnitKind): ReadonlyArray<readonly [string, string]> =>
    KIND_RULES[kind].map(([rule, text]) => {
      if (rule === 'Minimum stay') return [rule, kind === 'villa' ? plural(villaMinStay, 'night') : [...new Set(hotel.map((t) => plural(t.minStay, 'night')))].join(' or ')] as const
      if (rule === 'Deposit at check-in') return [rule, villa.depositOnCheckIn && (operation !== 'mixed' || kind === 'villa') ? 'Asked' : 'Not asked'] as const
      if (rule === 'Cleaning') return [rule, stayoverText(operation === 'mixed' && kind === 'villa' ? 0 : villa.stayoverEvery)] as const
      return [rule, text] as const
    })
  const villaCount = villas.length

  return (
    <>
      <PageBar fallback="/property" label="Property" />
      <ol className="mb-4 flex flex-wrap gap-2" aria-label="Steps">
        {steps.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              disabled={i > step}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => setStep(i)}
              className={cn(
                'flex h-9 items-center gap-2 rounded-full px-3 text-sm transition-colors disabled:cursor-not-allowed',
                i === step ? 'bg-invert font-medium text-on-invert' : i < step ? 'cursor-pointer bg-success-soft text-success' : 'bg-raised text-muted',
              )}
            >
              <span className="grid size-5 place-items-center rounded-full bg-current/15 text-[11px] font-semibold">{i < step ? <Check aria-hidden className="size-3" strokeWidth={3} /> : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card as="div" aria-label={current} className="min-w-0">
          {current === 'Operation' && (
            <div className="space-y-5">
              <p className="text-lg font-semibold tracking-tight">How does this property operate?</p>
              <div role="radiogroup" aria-label="How the property operates" className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {OPERATIONS.map((o) => {
                  const Icon = OPERATION_ICON[o]
                  const on = operation === o
                  return (
                    <button key={o} type="button" role="radio" aria-checked={on} onClick={() => pickOperation(o)} className={cn('flex flex-col gap-2 rounded-panel border p-4 text-left transition-colors', on ? 'border-accent bg-accent-soft' : 'border-line-strong bg-raised hover:bg-control')}>
                      <Icon aria-hidden className={cn('size-5', on ? 'text-accent-text' : 'text-muted')} />
                      <span className="font-semibold">{OPERATION_LABEL[o]}</span>
                      <span className="text-xs text-muted">{OPERATION_TEXT[o]}</span>
                    </button>
                  )
                })}
              </div>
              <div className={cn('grid grid-cols-1 gap-3', kinds.length > 1 && 'md:grid-cols-2')}>
                {kinds.map((kind) => (
                  <section key={kind} aria-label={`${KIND_PLURAL[kind]} rules`} className="rounded-panel bg-raised p-4">
                    <p className="mb-2 text-sm font-semibold">{kinds.length > 1 ? `${KIND_PLURAL[kind]} follow ${kind === 'room' ? 'hotel' : 'villa'} rules` : `${OPERATION_LABEL[operation]} rules`}</p>
                    <dl className="space-y-1.5 text-sm">
                      {KIND_RULES[kind]
                        .filter(([rule]) => SUMMARY_RULES.has(rule))
                        .map(([rule, text]) => (
                          <div key={rule} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
                            <dt className="text-muted">{rule}</dt>
                            <dd>{text}</dd>
                          </div>
                        ))}
                    </dl>
                  </section>
                ))}
              </div>
              <p className="text-xs text-muted">Every default here can be changed in the next steps and later on the property page.</p>
            </div>
          )}

          {current === 'Details' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <p className="text-lg font-semibold tracking-tight sm:col-span-2">The {terms.place.toLowerCase()}</p>
              <Field label="Location" htmlFor="w-loc" error={errors['villa.locationId']}>
                <Select id="w-loc" className="w-full" value={villa.locationId} options={[{ value: '', label: 'Pick the location' }, ...locations.map((l) => ({ value: l.id, label: l.name }))]} onChange={(e) => setVilla({ locationId: e.target.value })} />
              </Field>
              <Field label="Code" htmlFor="w-code" error={errors['villa.code']} hint={`Two to four capital letters; ${terms.unit.toLowerCase()} codes start with it`}>
                <Input id="w-code" value={villa.code} maxLength={4} className="font-mono uppercase" placeholder="NS" onChange={(e) => setVilla({ code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Name" htmlFor="w-name" error={errors['villa.name']} className="sm:col-span-2">
                <Input id="w-name" value={villa.name} placeholder={operation === 'hotel' ? 'Hotel Nusa' : 'Villa Nusa'} onChange={(e) => setVilla({ name: e.target.value })} />
              </Field>
              <Field label="Description" htmlFor="w-desc" className="sm:col-span-2">
                <Textarea id="w-desc" value={villa.description} rows={3} placeholder="What the property is, where it stands, what makes it sell" onChange={(e) => setVilla({ description: e.target.value })} />
              </Field>
              <Field label="Address" htmlFor="w-address" error={errors['villa.address']} hint="Map pin, contact, licence and bank go on the property page after saving" className="sm:col-span-2">
                <Input id="w-address" value={villa.address} placeholder="Jl. Petitenget No. 12A, Kerobokan, Badung" onChange={(e) => setVilla({ address: e.target.value })} />
              </Field>
              <Field label="Check-in from" htmlFor="w-in" error={errors['villa.checkInTime']} hint="Bali time">
                <Input id="w-in" type="time" value={villa.checkInTime} className="tabular" onChange={(e) => setVilla({ checkInTime: e.target.value })} />
              </Field>
              <Field label="Check-out by" htmlFor="w-out" error={errors['villa.checkOutTime']}>
                <Input id="w-out" type="time" value={villa.checkOutTime} className="tabular" onChange={(e) => setVilla({ checkOutTime: e.target.value })} />
              </Field>
              <Field label="Cancellation policy" htmlFor="w-cancel" error={errors['villa.cancellationPolicy']} className="sm:col-span-2">
                <Select id="w-cancel" className="w-full" value={villa.cancellationPolicy} options={CANCELLATION_POLICIES.map((c) => ({ value: c, label: `${CANCELLATION_LABEL[c]}: ${CANCELLATION_TEXT[c]}` }))} onChange={(e) => setVilla({ cancellationPolicy: e.target.value as CancellationPolicy })} />
              </Field>
            </div>
          )}

          {current === 'Hotel rooms' && (
            <div className="space-y-4">
              <p className="text-lg font-semibold tracking-tight">Hotel rooms</p>
              <section aria-label="Hotel room defaults" className="grid grid-cols-1 gap-3 rounded-panel bg-info-soft p-3 sm:grid-cols-2">
                <p className="text-sm font-semibold sm:col-span-2">Hotel defaults</p>
                <Field label="Stayover clean every" htmlFor="w-stayover" error={errors['villa.stayoverEvery']} hint={`Days, 0 to ${MAX_STAYOVER_EVERY}; 0 means departure only`}>
                  <Input id="w-stayover" type="number" inputMode="numeric" min={0} max={MAX_STAYOVER_EVERY} value={villa.stayoverEvery} className="tabular" onChange={(e) => setVilla({ stayoverEvery: Number(e.target.value) })} />
                </Field>
                {operation === 'hotel' ? (
                  <label className="flex min-h-12 items-center gap-3 self-end rounded-full border border-line-strong bg-card px-4 py-2 text-sm">
                    <input type="checkbox" checked={villa.depositOnCheckIn} className="size-4 accent-accent" onChange={(e) => setVilla({ depositOnCheckIn: e.target.checked })} />
                    Ask a security deposit at check-in
                  </label>
                ) : (
                  <p className="self-end text-xs text-muted">No deposit for hotel rooms; the deposit setting in the villas step covers villas only.</p>
                )}
              </section>
              {!villa.code && <p className="text-sm text-muted">Set the code in the details step so room numbers can be generated.</p>}
              <ul className="space-y-3">
                {hotel.map((t, i) => (
                  <li key={t.id} className="space-y-3 rounded-panel border border-line p-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_5rem_5rem_auto] sm:items-start">
                      <Field label={`Room type ${i + 1}`} htmlFor={`w-type-${t.id}`} error={groupError(`h${t.id}`, 'name')} className="col-span-2 sm:col-span-1">
                        <Input id={`w-type-${t.id}`} value={t.name} placeholder="Deluxe double" onChange={(e) => setType(t.id, { name: e.target.value })} />
                      </Field>
                      <Field label="Rate a night" htmlFor={`w-type-rate-${t.id}`}>
                        <Input id={`w-type-rate-${t.id}`} type="number" inputMode="numeric" min={0} step={50_000} value={t.rate} className="tabular" onChange={(e) => setType(t.id, { rate: Number(e.target.value) })} />
                      </Field>
                      <Field label="Adults" htmlFor={`w-type-adults-${t.id}`}>
                        <Input id={`w-type-adults-${t.id}`} type="number" inputMode="numeric" min={1} value={t.maxAdults} className="tabular" onChange={(e) => setType(t.id, { maxAdults: Number(e.target.value) })} />
                      </Field>
                      <Field label="Children" htmlFor={`w-type-children-${t.id}`}>
                        <Input id={`w-type-children-${t.id}`} type="number" inputMode="numeric" min={0} value={t.maxChildren} className="tabular" onChange={(e) => setType(t.id, { maxChildren: Number(e.target.value) })} />
                      </Field>
                      <Button variant="ghost" size="icon" className="sm:mt-6" aria-label={`Remove room type ${t.name || i + 1}`} disabled={hotel.length === 1} onClick={() => setHotel(hotel.filter((x) => x.id !== t.id))}>
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[8rem_6rem_minmax(0,1fr)] sm:items-end">
                      <Field label="Bed" htmlFor={`w-type-bed-${t.id}`}>
                        <Select id={`w-type-bed-${t.id}`} className="w-full" value={t.bed} options={BED_TYPES.map((b) => ({ value: b, label: BED_LABEL[b] }))} onChange={(e) => setType(t.id, { bed: e.target.value as BedType })} />
                      </Field>
                      <Field label="Minimum stay" htmlFor={`w-type-min-${t.id}`} error={groupError(`h${t.id}`, 'minStay')}>
                        <Input id={`w-type-min-${t.id}`} type="number" inputMode="numeric" min={1} max={MAX_MIN_STAY} value={t.minStay} className="tabular" onChange={(e) => setType(t.id, { minStay: Number(e.target.value) })} />
                      </Field>
                      <label className="col-span-2 flex min-h-12 items-center gap-3 rounded-full border border-line-strong bg-raised px-4 py-2 text-sm sm:col-span-1">
                        <input type="checkbox" checked={t.operatorAssigns} className="size-4 accent-accent" onChange={(e) => setType(t.id, { operatorAssigns: e.target.checked })} />
                        Sold by type; the front desk assigns the room
                      </label>
                    </div>
                    <div className="grid grid-cols-3 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[5rem_7rem_5rem_auto] sm:items-end">
                      <Field label="Floor" htmlFor={`w-type-floor-${t.id}`}>
                        <Input id={`w-type-floor-${t.id}`} value={t.floor} maxLength={MAX_FLOOR} onChange={(e) => setType(t.id, { floor: e.target.value })} />
                      </Field>
                      <Field label="First number" htmlFor={`w-type-start-${t.id}`}>
                        <Input id={`w-type-start-${t.id}`} type="number" inputMode="numeric" min={1} max={9999} value={t.start} className="tabular" onChange={(e) => setType(t.id, { start: Number(e.target.value) })} />
                      </Field>
                      <Field label="Rooms" htmlFor={`w-type-count-${t.id}`}>
                        <Input id={`w-type-count-${t.id}`} type="number" inputMode="numeric" min={1} max={60} value={t.count} className="tabular" onChange={(e) => setType(t.id, { count: Number(e.target.value) || 1 })} />
                      </Field>
                      <Button variant="solid" className="col-span-3 sm:col-span-1" disabled={!villa.code} onClick={() => generate(t)}>
                        Generate room numbers
                      </Button>
                    </div>
                    {t.rooms.length > 0 ? (
                      <ul aria-label={`Rooms of ${t.name || `type ${i + 1}`}`} className="flex flex-wrap gap-1.5">
                        {t.rooms.map((r) => (
                          <li key={r.code} className="rounded-full bg-raised px-2.5 py-1 font-mono text-xs">
                            {r.code}
                            {r.floor && <span className="ml-1 font-sans text-muted">floor {r.floor}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">No rooms yet. Floor 2 from 201 gives 201, 202 and on.</p>
                    )}
                    {roomErrors(`h${t.id}`).length > 0 && (
                      <p role="alert" className="text-xs font-medium text-danger">
                        {[...new Set(roomErrors(`h${t.id}`))].join(' ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <Button
                variant="soft"
                onClick={() => {
                  setHotel([...hotel, newType(nextId)])
                  setNextId(nextId + 1)
                }}
              >
                <Plus aria-hidden className="size-4" /> Add room type
              </Button>
              {unitsStep === 'Hotel rooms' && errors.rooms && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {errors.rooms}
                </p>
              )}
            </div>
          )}

          {current === 'Villas' && (
            <div className="space-y-4">
              <p className="text-lg font-semibold tracking-tight">Villas</p>
              <section aria-label="Villa defaults" className="grid grid-cols-1 gap-3 rounded-panel bg-info-soft p-3 sm:grid-cols-2">
                <p className="text-sm font-semibold sm:col-span-2">Villa defaults</p>
                <Field label="Minimum stay" htmlFor="w-villa-min" hint="Nights, for every villa; 2 by default">
                  <Input id="w-villa-min" type="number" inputMode="numeric" min={1} max={MAX_MIN_STAY} value={villaMinStay} className="tabular" onChange={(e) => setVillaMinStay(Number(e.target.value))} />
                </Field>
                <label className="flex min-h-12 items-center gap-3 self-end rounded-full border border-line-strong bg-card px-4 py-2 text-sm">
                  <input type="checkbox" checked={villa.depositOnCheckIn} className="size-4 accent-accent" onChange={(e) => setVilla({ depositOnCheckIn: e.target.checked })} />
                  Ask a security deposit at check-in
                </label>
                {operation === 'villa' ? (
                  <Field label="Stayover clean every" htmlFor="w-villa-stayover" error={errors['villa.stayoverEvery']} hint="Days; 0 keeps the departure clean only">
                    <Input id="w-villa-stayover" type="number" inputMode="numeric" min={0} max={MAX_STAYOVER_EVERY} value={villa.stayoverEvery} className="tabular" onChange={(e) => setVilla({ stayoverEvery: Number(e.target.value) })} />
                  </Field>
                ) : (
                  <p className="self-end text-xs text-muted">Villas get a departure clean only; the stayover schedule serves the hotel rooms.</p>
                )}
                {villaCount > 1 && (
                  <label className="flex min-h-12 items-center gap-3 self-end rounded-full border border-line-strong bg-card px-4 py-2 text-sm">
                    <input type="checkbox" checked={villa.wholeRental} className="size-4 accent-accent" onChange={(e) => setVilla({ wholeRental: e.target.checked, wholeNightlyRate: e.target.checked ? villa.wholeNightlyRate : 0 })} />
                    Rent the whole villa to one party
                  </label>
                )}
                {errors['villa.wholeRental'] && <p className="text-xs font-medium text-danger sm:col-span-2">{errors['villa.wholeRental']}</p>}
                {villaCount > 1 && villa.wholeRental && (
                  <Field label="Whole villa, Rp a night" htmlFor="w-whole-rate" error={errors['villa.wholeNightlyRate']} hint="0 adds up each villa's own price for the night">
                    <Input id="w-whole-rate" type="number" inputMode="numeric" min={0} step={50_000} value={villa.wholeNightlyRate} className="tabular" onChange={(e) => setVilla({ wholeNightlyRate: Number(e.target.value) })} />
                  </Field>
                )}
              </section>
              {!villa.code && <p className="text-sm text-muted">Set the code in the details step so villa codes can be generated.</p>}
              <ul className="space-y-2">
                {villas.map((v) => (
                  <li key={v.id} className="grid grid-cols-2 gap-3 rounded-panel border border-line p-3 sm:grid-cols-[6rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem_8rem_auto] sm:items-start">
                    <Field label="Code" htmlFor={`w-villa-code-${v.id}`} error={villaError(`v${v.id}`, 'code')}>
                      <Input id={`w-villa-code-${v.id}`} value={v.code} className="font-mono uppercase" onChange={(e) => setVillaDraft(v.id, { code: e.target.value.toUpperCase() })} />
                    </Field>
                    <Field label="Name" htmlFor={`w-villa-name-${v.id}`} error={villaError(`v${v.id}`, 'name') ?? groupError(`v${v.id}`, 'name')}>
                      <Input id={`w-villa-name-${v.id}`} value={v.name} onChange={(e) => setVillaDraft(v.id, { name: e.target.value })} />
                    </Field>
                    <Field label="Bedrooms" htmlFor={`w-villa-beds-${v.id}`} error={villaError(`v${v.id}`, 'bedrooms')}>
                      <Input id={`w-villa-beds-${v.id}`} type="number" inputMode="numeric" min={1} value={v.bedrooms} className="tabular" onChange={(e) => setVillaDraft(v.id, { bedrooms: Number(e.target.value) })} />
                    </Field>
                    <Field label="Adults" htmlFor={`w-villa-adults-${v.id}`} error={villaError(`v${v.id}`, 'maxAdults')}>
                      <Input id={`w-villa-adults-${v.id}`} type="number" inputMode="numeric" min={1} value={v.maxAdults} className="tabular" onChange={(e) => setVillaDraft(v.id, { maxAdults: Number(e.target.value) })} />
                    </Field>
                    <Field label="Children" htmlFor={`w-villa-children-${v.id}`}>
                      <Input id={`w-villa-children-${v.id}`} type="number" inputMode="numeric" min={0} value={v.maxChildren} className="tabular" onChange={(e) => setVillaDraft(v.id, { maxChildren: Number(e.target.value) })} />
                    </Field>
                    <Field label="Rate a night" htmlFor={`w-villa-rate-${v.id}`} error={villaError(`v${v.id}`, 'nightlyRate')}>
                      <Input id={`w-villa-rate-${v.id}`} type="number" inputMode="numeric" min={0} step={50_000} value={v.rate} className="tabular" onChange={(e) => setVillaDraft(v.id, { rate: Number(e.target.value) })} />
                    </Field>
                    <Button variant="ghost" size="icon" className="sm:mt-6" aria-label={`Remove ${v.name || v.code}`} onClick={() => setVillas(villas.filter((x) => x.id !== v.id))}>
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                    <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-7">
                      <input type="checkbox" checked={v.amenities.includes('private-pool')} className="size-4 accent-accent" onChange={(e) => setVillaDraft(v.id, { amenities: e.target.checked ? [...v.amenities, 'private-pool'] : v.amenities.filter((a) => a !== 'private-pool') })} />
                      Private pool <span className="text-xs text-muted">· other amenities in the facilities step</span>
                    </label>
                  </li>
                ))}
              </ul>
              <Button variant="soft" disabled={!villa.code} onClick={addVilla}>
                <Plus aria-hidden className="size-4" /> Add villa
              </Button>
              {errors.rooms && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {errors.rooms}
                </p>
              )}
            </div>
          )}

          {current === 'Rates' && (
            <div className="space-y-4">
              <p className="text-lg font-semibold tracking-tight">Rate plans</p>
              <p className="text-sm text-muted">Hotel rooms sell at their room type&apos;s plan; a villa without a live Airbnb listing sells at its own. Each plan starts from the base price, with weekends about 20% higher; seasons are optional.</p>
              <ul className="space-y-3">
                {wizardTypes(full).map((t, i) => {
                  const key = built.groupKeys[i] ?? t.key
                  return (
                    <li key={key} className="rounded-panel border border-line p-3">
                      <p className="mb-3 text-sm font-semibold">
                        {t.name || 'Unnamed type'} <span className="font-normal text-muted">· {KIND_PLURAL[t.kind]} · {t.rooms.map((j) => full.rooms[j]?.code).join(', ') || 'None yet'}</span>
                      </p>
                      <RatePlanFields idPrefix={`w-plan-${key}`} value={t.plan} onChange={(plan) => setPlans({ ...plans, [key]: plan })} errors={planErrors(errors, t.key)} />
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {current === 'Facilities' && (
            <div className="space-y-6">
              <div>
                <p className="text-lg font-semibold tracking-tight">Shared facilities</p>
                <p className="mb-3 text-sm text-muted">Shared by every guest of the property.</p>
                <CheckboxGrid name="facilities" options={VILLA_FACILITIES} selected={villa.facilities} onChange={(facilities) => setVilla({ facilities })} />
                <Field label="Other facilities" htmlFor="w-custom" hint="Comma separated" className="mt-3">
                  <Input id="w-custom" value={customFacilities} placeholder="Yoga deck, beach club" onChange={(e) => setCustomFacilities(e.target.value)} />
                </Field>
              </div>
              <div>
                <p className="text-lg font-semibold tracking-tight">Amenities</p>
                <p className="mb-3 text-sm text-muted">Hotel rooms take their room type&apos;s amenities; each villa has its own.</p>
                <ul className="space-y-3">
                  {kinds.includes('room') &&
                    hotel.map((t) => (
                      <li key={`h${t.id}`} className="rounded-panel bg-raised p-3">
                        <p className="mb-2 text-sm font-semibold">{t.name || 'Unnamed type'} <span className="font-normal text-muted">· {plural(t.rooms.length, 'room')}</span></p>
                        <CheckboxGrid name={`amenities-h${t.id}`} options={UNIT_AMENITIES} selected={t.amenities} onChange={(amenities) => setType(t.id, { amenities })} />
                      </li>
                    ))}
                  {kinds.includes('villa') &&
                    villas.map((v) => (
                      <li key={`v${v.id}`} className="rounded-panel bg-raised p-3">
                        <p className="mb-2 text-sm font-semibold">
                          <span className="font-mono">{v.code}</span> · {v.name}
                        </p>
                        <CheckboxGrid name={`amenities-v${v.id}`} options={UNIT_AMENITIES} selected={v.amenities} onChange={(amenities) => setVillaDraft(v.id, { amenities })} />
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          )}

          {current === 'Review' && (
            <div className="space-y-5">
              <p className="text-lg font-semibold tracking-tight">Review</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {(
                  [
                    ['Operates as', OPERATION_LABEL[operation]],
                    [terms.place, `${villa.name} (${villa.code})`],
                    ['Location', locations.find((l) => l.id === villa.locationId)?.name ?? 'Not picked'],
                    ['Check-in and check-out', `From ${villa.checkInTime}, by ${villa.checkOutTime}`],
                    ['Cancellation', CANCELLATION_LABEL[villa.cancellationPolicy]],
                    ['Whole villa', operation === 'hotel' ? 'Not for a hotel' : villa.wholeRental ? (villa.wholeNightlyRate > 0 ? `${money(villa.wholeNightlyRate)} a night` : "Each villa's own price") : 'Not rented whole'],
                    ['Facilities', full.villa.facilities.map(facilityLabel).join(', ') || 'None'],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="rounded-panel bg-raised p-3">
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className="mt-1 text-sm font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              {kinds.map((kind) => (
                <section key={kind} aria-label={`${KIND_PLURAL[kind]} rules`}>
                  <p className="mb-2 text-sm font-semibold">
                    {KIND_PLURAL[kind]}: {full.rooms.filter((r) => full.groups[r.groupIndex ?? -1]?.kind === kind).map((r) => r.code).join(', ') || 'none yet'}
                  </p>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-line">
                      {appliedRules(kind).map(([rule, value]) => (
                        <tr key={rule}>
                          <th scope="row" className="w-36 py-2 text-left font-normal text-muted">{rule}</th>
                          <td className="py-2">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
              {errors.form && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {errors.form}
                </p>
              )}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            {step > 0 && (
              <Button variant="soft" onClick={() => setStep(Math.max(0, step - 1))}>
                <ArrowLeft aria-hidden className="size-4" /> Back
              </Button>
            )}
            {step < last ? (
              <Button variant="accent" className="ml-auto" onClick={next}>
                Next <ArrowRight aria-hidden className="size-4" />
              </Button>
            ) : (
              <Button variant="accent" className="ml-auto" loading={saving} onClick={() => void save()}>
                <Check aria-hidden className="size-4" /> Create property
              </Button>
            )}
          </div>
        </Card>

        <Card aria-labelledby="w-summary">
          <p id="w-summary" className="text-lg font-semibold tracking-tight">So far</p>
          <dl className="mt-3 space-y-2 text-sm">
            {(
              [
                ['Operates as', OPERATION_LABEL[operation]],
                [terms.place, villa.name || 'Not named'],
                ...kinds.map((k) => [KIND_PLURAL[k], String(full.rooms.filter((r) => full.groups[r.groupIndex ?? -1]?.kind === k).length)] as const),
                ['Room types', String(full.groups.length)],
                ['Facilities', String(full.villa.facilities.length)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd className="truncate text-right font-medium tabular">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted">Nothing is saved until the last step, so you can go back and change anything.</p>
        </Card>
      </div>
    </>
  )
}

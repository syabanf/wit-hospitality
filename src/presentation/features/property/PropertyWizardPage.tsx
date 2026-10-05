import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from 'lucide-react'
import { amenityLabel, facilityLabel, UNIT_AMENITIES, validateProperty, VILLA_FACILITIES, type PropertyInput, type WizardRoom } from '@/domain/property'
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

const STEPS = ['Villa', 'Room types', 'Rooms', 'Facilities', 'Review'] as const
type Step = 0 | 1 | 2 | 3 | 4

const emptyRoom = (code: string, name: string, groupIndex: number | null, rate: number, amenities: readonly string[]): WizardRoom => ({ code, name, bedrooms: 1, nightlyRate: rate, groupIndex, amenities })

/** Villa, room types, rooms and facilities in four steps, saved together at the end. */
export default function PropertyWizardPage() {
  const { property } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const options = useResource('property.overview', () => property.overview())
  const [step, setStep] = useState<Step>(0)
  const [input, setInput] = useState<PropertyInput>({
    villa: { locationId: '', code: '', name: '', description: '', facilities: [] },
    groups: [{ name: 'Standard', interchangeable: true }],
    rooms: [],
  })
  const [customFacilities, setCustomFacilities] = useState('')
  const [bulk, setBulk] = useState({ count: 4, name: 'Room', rate: 1_500_000, groupIndex: 0 as number | null })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={8} />
  const locations = options.data.locations.map((l) => l.location)
  const existingVillas = options.data.locations.flatMap((l) => l.villas.map((v) => v.villa))
  const existingUnits = options.data.locations.flatMap((l) => l.villas.flatMap((v) => v.units.map((u) => u.place.unit)))
  const full: PropertyInput = { ...input, villa: { ...input.villa, facilities: [...input.villa.facilities, ...splitCustom(customFacilities)] } }

  const villa = input.villa
  const setVilla = (patch: Partial<typeof villa>) => setInput({ ...input, villa: { ...villa, ...patch } })
  const setRoom = (i: number, patch: Partial<WizardRoom>) => setInput({ ...input, rooms: input.rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const nextCode = (n: number) => `${villa.code}-${String(n).padStart(2, '0')}`

  /** Validation scoped to the current step, so an early step never shows later errors. */
  function stepErrors(at: Step): Record<string, string> {
    const all = validateProperty(full, existingVillas, existingUnits)
    const prefix = at === 0 ? 'villa.' : at === 1 ? 'groups.' : at === 2 ? 'rooms' : null
    return Object.fromEntries(Object.entries(all).filter(([k]) => (prefix ? k.startsWith(prefix) : false)))
  }

  function next() {
    const found = stepErrors(step)
    setErrors(found)
    if (Object.keys(found).length) return
    setStep((s) => Math.min(4, s + 1) as Step)
  }

  function addRooms() {
    const taken = new Set([...existingUnits.map((u) => u.code), ...input.rooms.map((r) => r.code)])
    const rooms: WizardRoom[] = []
    for (let n = 1, made = 0; made < bulk.count && n < 100; n++) {
      const code = nextCode(n)
      if (taken.has(code)) continue
      rooms.push(emptyRoom(code, `${bulk.name} ${n}`, bulk.groupIndex, bulk.rate, ['ac', 'tv', 'safe']))
      made++
    }
    setInput({ ...input, rooms: [...input.rooms, ...rooms] })
  }

  async function save() {
    setSaving(true)
    setErrors({})
    try {
      const created = await property.createProperty(full)
      toast({ title: `Created ${created.name}`, description: `${plural(input.rooms.length, 'room')} across ${plural(input.groups.length, 'room type')}` })
      navigate(`/property/villas/${created.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      const first = Object.keys(e)[0] ?? ''
      setStep(first.startsWith('villa') ? 0 : first.startsWith('groups') ? 1 : first.startsWith('rooms') ? 2 : 4)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageBar fallback="/property" label="Property" />
      <ol className="mb-4 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              disabled={i > step}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => setStep(i as Step)}
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
        <Card as="div" aria-label={STEPS[step]} className="min-w-0">
          {step === 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <p className="text-lg font-semibold tracking-tight sm:col-span-2">The villa</p>
              <Field label="Location" htmlFor="w-loc" error={errors['villa.locationId']}>
                <Select id="w-loc" className="w-full" value={villa.locationId} options={[{ value: '', label: 'Pick the location' }, ...locations.map((l) => ({ value: l.id, label: l.name }))]} onChange={(e) => setVilla({ locationId: e.target.value })} />
              </Field>
              <Field label="Code" htmlFor="w-code" error={errors['villa.code']} hint="Two to four capital letters; room codes start with it">
                <Input id="w-code" value={villa.code} maxLength={4} className="font-mono uppercase" placeholder="NS" onChange={(e) => setVilla({ code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Name" htmlFor="w-name" error={errors['villa.name']} className="sm:col-span-2">
                <Input id="w-name" value={villa.name} placeholder="Villa Nusa" onChange={(e) => setVilla({ name: e.target.value })} />
              </Field>
              <Field label="Description" htmlFor="w-desc" className="sm:col-span-2">
                <Textarea id="w-desc" value={villa.description} rows={3} placeholder="What the property is, where it stands, what makes it sell" onChange={(e) => setVilla({ description: e.target.value })} />
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-lg font-semibold tracking-tight">Room types</p>
              <p className="text-sm text-muted">Rooms with the same design share a type. Interchangeable types let the front desk move a booking between those rooms.</p>
              <ul className="space-y-2">
                {input.groups.map((g, i) => (
                  <li key={i} className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                    <Field label={`Type ${i + 1}`} htmlFor={`w-group-${i}`} error={errors[`groups.${i}.name`]}>
                      <Input id={`w-group-${i}`} value={g.name} placeholder="Pool suite" onChange={(e) => setInput({ ...input, groups: input.groups.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                    </Field>
                    <label className="flex h-12 items-center gap-3 rounded-full border border-line-strong bg-card px-4 text-sm">
                      <input type="checkbox" checked={g.interchangeable} className="size-4 accent-accent" onChange={(e) => setInput({ ...input, groups: input.groups.map((x, j) => (j === i ? { ...x, interchangeable: e.target.checked } : x)) })} />
                      Interchangeable
                    </label>
                    <Button variant="ghost" size="icon" aria-label={`Remove type ${g.name || i + 1}`} disabled={input.groups.length === 1} onClick={() => setInput({ ...input, groups: input.groups.filter((_, j) => j !== i), rooms: input.rooms.map((r) => ({ ...r, groupIndex: r.groupIndex === i ? null : r.groupIndex !== null && r.groupIndex > i ? r.groupIndex - 1 : r.groupIndex })) })}>
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button variant="soft" onClick={() => setInput({ ...input, groups: [...input.groups, { name: '', interchangeable: true }] })}>
                <Plus aria-hidden className="size-4" /> Add room type
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-lg font-semibold tracking-tight">Rooms</p>
              <div className="grid grid-cols-2 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <Field label="How many" htmlFor="w-count">
                  <Input id="w-count" type="number" min={1} max={30} value={bulk.count} className="tabular" onChange={(e) => setBulk({ ...bulk, count: Number(e.target.value) || 1 })} />
                </Field>
                <Field label="Name prefix" htmlFor="w-prefix">
                  <Input id="w-prefix" value={bulk.name} onChange={(e) => setBulk({ ...bulk, name: e.target.value })} />
                </Field>
                <Field label="Rate per night" htmlFor="w-rate">
                  <Input id="w-rate" type="number" min={0} step={50_000} value={bulk.rate} className="tabular" onChange={(e) => setBulk({ ...bulk, rate: Number(e.target.value) || 0 })} />
                </Field>
                <Field label="Room type" htmlFor="w-bulk-group">
                  <Select id="w-bulk-group" className="w-full" value={bulk.groupIndex === null ? '' : String(bulk.groupIndex)} options={[{ value: '', label: 'No type' }, ...input.groups.map((g, i) => ({ value: String(i), label: g.name || `Type ${i + 1}` }))]} onChange={(e) => setBulk({ ...bulk, groupIndex: e.target.value === '' ? null : Number(e.target.value) })} />
                </Field>
                <Button variant="solid" onClick={addRooms} disabled={!villa.code}>
                  <Plus aria-hidden className="size-4" /> Add rooms
                </Button>
              </div>
              {errors.rooms && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {errors.rooms}
                </p>
              )}
              {!villa.code && <p className="text-sm text-muted">Set the villa code in step 1 so room codes can be generated.</p>}
              <ul className="space-y-2">
                {input.rooms.map((r, i) => (
                  <li key={i} className="grid grid-cols-2 gap-3 rounded-panel border border-line p-3 sm:grid-cols-[6rem_minmax(0,1fr)_5rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                    <Field label="Code" htmlFor={`w-room-code-${i}`} error={errors[`rooms.${i}.code`]}>
                      <Input id={`w-room-code-${i}`} value={r.code} className="font-mono uppercase" onChange={(e) => setRoom(i, { code: e.target.value.toUpperCase() })} />
                    </Field>
                    <Field label="Name" htmlFor={`w-room-name-${i}`} error={errors[`rooms.${i}.name`]}>
                      <Input id={`w-room-name-${i}`} value={r.name} onChange={(e) => setRoom(i, { name: e.target.value })} />
                    </Field>
                    <Field label="Beds" htmlFor={`w-room-beds-${i}`} error={errors[`rooms.${i}.bedrooms`]}>
                      <Input id={`w-room-beds-${i}`} type="number" min={1} value={r.bedrooms} className="tabular" onChange={(e) => setRoom(i, { bedrooms: Number(e.target.value) })} />
                    </Field>
                    <Field label="Rate" htmlFor={`w-room-rate-${i}`} error={errors[`rooms.${i}.nightlyRate`]}>
                      <Input id={`w-room-rate-${i}`} type="number" min={0} step={50_000} value={r.nightlyRate} className="tabular" onChange={(e) => setRoom(i, { nightlyRate: Number(e.target.value) })} />
                    </Field>
                    <Field label="Type" htmlFor={`w-room-group-${i}`} error={errors[`rooms.${i}.groupIndex`]}>
                      <Select id={`w-room-group-${i}`} className="w-full" value={r.groupIndex === null ? '' : String(r.groupIndex)} options={[{ value: '', label: 'No type' }, ...input.groups.map((g, gi) => ({ value: String(gi), label: g.name || `Type ${gi + 1}` }))]} onChange={(e) => setRoom(i, { groupIndex: e.target.value === '' ? null : Number(e.target.value) })} />
                    </Field>
                    <Button variant="ghost" size="icon" className="sm:mt-6" aria-label={`Remove ${r.code}`} onClick={() => setInput({ ...input, rooms: input.rooms.filter((_, j) => j !== i) })}>
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <p className="text-lg font-semibold tracking-tight">Villa facilities</p>
                <p className="mb-3 text-sm text-muted">Shared by every room.</p>
                <CheckboxGrid name="facilities" options={VILLA_FACILITIES} selected={villa.facilities} onChange={(facilities) => setVilla({ facilities })} />
                <Field label="Other facilities" htmlFor="w-custom" hint="Comma separated" className="mt-3">
                  <Input id="w-custom" value={customFacilities} placeholder="Yoga deck, beach club" onChange={(e) => setCustomFacilities(e.target.value)} />
                </Field>
              </div>
              <div>
                <p className="text-lg font-semibold tracking-tight">Room amenities</p>
                <p className="mb-3 text-sm text-muted">Tick what each room has. Use the first room as the pattern and copy it down.</p>
                <ul className="space-y-3">
                  {input.rooms.map((r, i) => (
                    <li key={i} className="rounded-panel bg-raised p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-semibold">
                          <span className="font-mono">{r.code}</span> · {r.name}
                        </p>
                        {i === 0 && input.rooms.length > 1 && (
                          <Button size="sm" variant="soft" onClick={() => setInput({ ...input, rooms: input.rooms.map((x) => ({ ...x, amenities: r.amenities })) })}>
                            Copy to all rooms
                          </Button>
                        )}
                      </div>
                      <CheckboxGrid name={`amenities-${i}`} options={UNIT_AMENITIES} selected={r.amenities} onChange={(amenities) => setRoom(i, { amenities })} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <p className="text-lg font-semibold tracking-tight">Review</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {(
                  [
                    ['Villa', `${villa.name} (${villa.code})`],
                    ['Location', locations.find((l) => l.id === villa.locationId)?.name ?? 'Not picked'],
                    ['Room types', input.groups.map((g) => `${g.name}${g.interchangeable ? ' (interchangeable)' : ''}`).join(', ')],
                    ['Rooms', plural(input.rooms.length, 'room')],
                    ['Rate range', input.rooms.length ? `${money(Math.min(...input.rooms.map((r) => r.nightlyRate)))} to ${money(Math.max(...input.rooms.map((r) => r.nightlyRate)))}` : 'None'],
                    ['Facilities', full.villa.facilities.map(facilityLabel).join(', ') || 'None'],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="rounded-panel bg-raised p-3">
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className="mt-1 text-sm font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs tracking-wide text-muted uppercase">
                    <th className="py-2 font-medium">Code</th>
                    <th className="py-2 font-medium">Name</th>
                    <th className="py-2 font-medium">Type</th>
                    <th className="py-2 text-right font-medium">Rate</th>
                    <th className="py-2 font-medium">Amenities</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {input.rooms.map((r, i) => (
                    <tr key={i}>
                      <td className="py-2 font-mono">{r.code}</td>
                      <td className="py-2">{r.name}</td>
                      <td className="py-2 text-muted">{r.groupIndex === null ? 'None' : input.groups[r.groupIndex]?.name}</td>
                      <td className="py-2 text-right tabular">{money(r.nightlyRate)}</td>
                      <td className="py-2 text-xs text-muted">{r.amenities.map(amenityLabel).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {errors.form && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {errors.form}
                </p>
              )}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            {step > 0 && (
              <Button variant="soft" onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}>
                <ArrowLeft aria-hidden className="size-4" /> Back
              </Button>
            )}
            {step < 4 ? (
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
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Villa</dt>
              <dd className="truncate text-right font-medium">{villa.name || 'Not named'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Room types</dt>
              <dd className="font-medium tabular">{input.groups.length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Rooms</dt>
              <dd className="font-medium tabular">{input.rooms.length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Facilities</dt>
              <dd className="font-medium tabular">{full.villa.facilities.length}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted">Nothing is saved until the last step, so you can go back and change anything.</p>
        </Card>
      </div>
    </>
  )
}

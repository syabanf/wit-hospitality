import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { SEASON_KIND_LABEL, type RatePlanInput, type Season, type SeasonKind } from '@/domain/ratePlan'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'

const EMPTY_PLAN: RatePlanInput = { weekdayRate: 0, weekendRate: 0, seasons: [] }

interface RatePlanFieldsProps {
  /** Keeps input ids unique when several plans share a page. */
  idPrefix: string
  value: RatePlanInput
  onChange: (plan: RatePlanInput) => void
  /** Field errors keyed `weekdayRate` or `seasons.0.name`, as validateRatePlan returns them. */
  errors: Record<string, string>
}

/** Weekday and weekend rates and the seasons on top, as controlled inputs. */
export function RatePlanFields({ idPrefix: p, value, onChange, errors }: RatePlanFieldsProps) {
  const setSeason = (i: number, patch: Partial<Season>) => onChange({ ...value, seasons: value.seasons.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const amount = (raw: string) => Number(raw) || 0
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Weekday rate, Rp" htmlFor={`${p}-weekday`} error={errors.weekdayRate} hint="Sunday to Thursday nights">
          <Input id={`${p}-weekday`} type="number" inputMode="numeric" min={0} step={10_000} value={value.weekdayRate || ''} onChange={(e) => onChange({ ...value, weekdayRate: amount(e.target.value) })} className="tabular" />
        </Field>
        <Field label="Weekend rate, Rp" htmlFor={`${p}-weekend`} error={errors.weekendRate} hint="Friday and Saturday nights">
          <Input id={`${p}-weekend`} type="number" inputMode="numeric" min={0} step={10_000} value={value.weekendRate || ''} onChange={(e) => onChange({ ...value, weekendRate: amount(e.target.value) })} className="tabular" />
        </Field>
      </div>
      <div className="space-y-3">
        <p className="text-sm font-medium">Seasons</p>
        <p className="text-xs text-muted">Optional. Every year, first to last night. Where two seasons overlap, the shorter one prices the night.</p>
        {value.seasons.map((s, i) => (
          <div key={i} className="grid grid-cols-2 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[minmax(0,1fr)_88px_88px_140px_120px_auto] sm:items-end">
            <Field label="Name" htmlFor={`${p}-${i}-name`} error={errors[`seasons.${i}.name`]} className="col-span-2 sm:col-span-1">
              <Input id={`${p}-${i}-name`} value={s.name} onChange={(e) => setSeason(i, { name: e.target.value })} placeholder="High season" />
            </Field>
            <Field label="From" htmlFor={`${p}-${i}-from`} error={errors[`seasons.${i}.from`]}>
              <Input id={`${p}-${i}-from`} value={s.from} onChange={(e) => setSeason(i, { from: e.target.value })} placeholder="MM-DD" className="font-mono" />
            </Field>
            <Field label="To" htmlFor={`${p}-${i}-to`} error={errors[`seasons.${i}.to`]}>
              <Input id={`${p}-${i}-to`} value={s.to} onChange={(e) => setSeason(i, { to: e.target.value })} placeholder="MM-DD" className="font-mono" />
            </Field>
            <Field label="Price" htmlFor={`${p}-${i}-kind`}>
              <Select id={`${p}-${i}-kind`} className="w-full" value={s.kind} options={(['surcharge', 'fixed'] as const).map((k) => ({ value: k, label: SEASON_KIND_LABEL[k] }))} onChange={(e) => setSeason(i, { kind: e.target.value as SeasonKind })} />
            </Field>
            <Field label={s.kind === 'fixed' ? 'Per night, Rp' : 'Percent over'} htmlFor={`${p}-${i}-value`} error={errors[`seasons.${i}.value`]}>
              <Input id={`${p}-${i}-value`} type="number" inputMode="numeric" min={0} step={s.kind === 'fixed' ? 10_000 : 1} value={s.value || ''} onChange={(e) => setSeason(i, { value: amount(e.target.value) })} className="tabular" />
            </Field>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name || 'season'}`} onClick={() => onChange({ ...value, seasons: value.seasons.filter((_, j) => j !== i) })}>
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="soft" onClick={() => onChange({ ...value, seasons: [...value.seasons, { name: '', from: '', to: '', kind: 'surcharge', value: 0 }] })}>
          <Plus aria-hidden className="size-4" /> Season
        </Button>
      </div>
    </div>
  )
}

interface RatePlanFormProps {
  name: string
  initial: RatePlanInput | null
  /** Where a new plan starts when the room type has none yet. */
  suggested?: RatePlanInput | null
  save: (input: RatePlanInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** The room type's rate plan, for units of the type without a live listing. */
export function RatePlanForm({ name, initial, suggested, save, onDone, onCancel }: RatePlanFormProps) {
  const [plan, setPlan] = useState<RatePlanInput>(() => initial ?? suggested ?? EMPTY_PLAN)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      await save({ weekdayRate: plan.weekdayRate, weekendRate: plan.weekendRate, seasons: plan.seasons })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={`Rate plan for ${name}`}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? 'Edit the rate plan' : 'New rate plan'}</p>
        <RatePlanFields idPrefix="rp" value={plan} onChange={setPlan} errors={errors} />
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            Save rate plan
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { SEASON_KIND_LABEL, type RatePlan, type RatePlanInput, type SeasonKind } from '@/domain/ratePlan'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'

interface SeasonDraft {
  name: string
  from: string
  to: string
  kind: SeasonKind
  value: string
}

const toDraft = (plan: RatePlan | null) => ({
  weekdayRate: plan ? String(plan.weekdayRate) : '',
  weekendRate: plan ? String(plan.weekendRate) : '',
  seasons: (plan?.seasons ?? []).map((s): SeasonDraft => ({ ...s, value: String(s.value) })),
})

interface RatePlanFormProps {
  name: string
  initial: RatePlan | null
  save: (input: RatePlanInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** Weekday and weekend rates and the seasons on top, for units of the room type without a live listing. */
export function RatePlanForm({ name, initial, save, onDone, onCancel }: RatePlanFormProps) {
  const [draft, setDraft] = useState(() => toDraft(initial))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const setSeason = (i: number, patch: Partial<SeasonDraft>) => setDraft({ ...draft, seasons: draft.seasons.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      await save({ weekdayRate: Number(draft.weekdayRate), weekendRate: Number(draft.weekendRate), seasons: draft.seasons.map((s) => ({ ...s, value: Number(s.value) })) })
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Weekday rate, Rp" htmlFor="rp-weekday" error={errors.weekdayRate} hint="Sunday to Thursday nights">
            <Input id="rp-weekday" type="number" inputMode="numeric" min={0} step={10_000} value={draft.weekdayRate} onChange={(e) => setDraft({ ...draft, weekdayRate: e.target.value })} className="tabular" />
          </Field>
          <Field label="Weekend rate, Rp" htmlFor="rp-weekend" error={errors.weekendRate} hint="Friday and Saturday nights">
            <Input id="rp-weekend" type="number" inputMode="numeric" min={0} step={10_000} value={draft.weekendRate} onChange={(e) => setDraft({ ...draft, weekendRate: e.target.value })} className="tabular" />
          </Field>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-medium">Seasons</p>
          <p className="text-xs text-muted">Every year, first to last night. Where two seasons overlap, the shorter one prices the night.</p>
          {draft.seasons.map((s, i) => (
            <div key={i} className="grid grid-cols-2 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[minmax(0,1fr)_88px_88px_140px_120px_auto] sm:items-end">
              <Field label="Name" htmlFor={`rp-${i}-name`} error={errors[`seasons.${i}.name`]} className="col-span-2 sm:col-span-1">
                <Input id={`rp-${i}-name`} value={s.name} onChange={(e) => setSeason(i, { name: e.target.value })} placeholder="High season" />
              </Field>
              <Field label="From" htmlFor={`rp-${i}-from`} error={errors[`seasons.${i}.from`]}>
                <Input id={`rp-${i}-from`} value={s.from} onChange={(e) => setSeason(i, { from: e.target.value })} placeholder="MM-DD" className="font-mono" />
              </Field>
              <Field label="To" htmlFor={`rp-${i}-to`} error={errors[`seasons.${i}.to`]}>
                <Input id={`rp-${i}-to`} value={s.to} onChange={(e) => setSeason(i, { to: e.target.value })} placeholder="MM-DD" className="font-mono" />
              </Field>
              <Field label="Price" htmlFor={`rp-${i}-kind`}>
                <Select id={`rp-${i}-kind`} className="w-full" value={s.kind} options={(['surcharge', 'fixed'] as const).map((k) => ({ value: k, label: SEASON_KIND_LABEL[k] }))} onChange={(e) => setSeason(i, { kind: e.target.value as SeasonKind })} />
              </Field>
              <Field label={s.kind === 'fixed' ? 'Per night, Rp' : 'Percent over'} htmlFor={`rp-${i}-value`} error={errors[`seasons.${i}.value`]}>
                <Input id={`rp-${i}-value`} type="number" inputMode="numeric" min={0} step={s.kind === 'fixed' ? 10_000 : 1} value={s.value} onChange={(e) => setSeason(i, { value: e.target.value })} className="tabular" />
              </Field>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name || 'season'}`} onClick={() => setDraft({ ...draft, seasons: draft.seasons.filter((_, j) => j !== i) })}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="soft" onClick={() => setDraft({ ...draft, seasons: [...draft.seasons, { name: '', from: '', to: '', kind: 'surcharge', value: '' }] })}>
            <Plus aria-hidden className="size-4" /> Season
          </Button>
        </div>
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

import { useState, type FormEvent, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type { RestrictionView } from '@/application/stayRules'
import { RESTRICTION_RULE_HINT, RESTRICTION_RULE_LABEL, RESTRICTION_RULES, WEEKDAY_LABEL, withNights, type RestrictionRule } from '@/domain/restriction'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Switch } from '../../ui/Switch'
import { Tag } from '../../ui/Badge'
import type { RestrictionDraft } from './restrictionDraft'

const WEEKDAYS = WEEKDAY_LABEL.map((label, i) => ({ id: String(i), label }))

interface FieldsProps {
  idPrefix: string
  value: RestrictionDraft
  onChange: (draft: RestrictionDraft) => void
  errors: Record<string, string>
  /** The units of the type, for a rule on one unit; leave out for the bulk editor. */
  units?: ReadonlyArray<{ id: string; code: string }>
}

/** The rule, its nights, the range and the days of the week, as controlled inputs. */
export function RestrictionFields({ idPrefix: p, value, onChange, errors, units }: FieldsProps) {
  const set = (patch: Partial<RestrictionDraft>) => onChange({ ...value, ...patch })
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
        <Field label="Rule" htmlFor={`${p}-rule`} error={errors.rule} hint={RESTRICTION_RULE_HINT[value.rule]}>
          <Select id={`${p}-rule`} className="w-full" value={value.rule} options={RESTRICTION_RULES.map((r) => ({ value: r, label: RESTRICTION_RULE_LABEL[r] }))} onChange={(e) => set({ rule: e.target.value as RestrictionRule, nights: withNights(e.target.value as RestrictionRule) ? (value.nights ?? 3) : null })} />
        </Field>
        {withNights(value.rule) && (
          <Field label="Nights" htmlFor={`${p}-nights`} error={errors.nights}>
            <Input id={`${p}-nights`} type="number" inputMode="numeric" min={1} max={90} value={value.nights ?? ''} onChange={(e) => set({ nights: Number(e.target.value) || null })} className="tabular" />
          </Field>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Switch checked={value.yearly} label="Every year" onChange={(yearly) => set({ yearly, from: '', to: '' })} />
        <span className="text-sm">{value.yearly ? 'Every year, like a season' : 'Once, on these dates'}</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="First day" htmlFor={`${p}-from`} error={errors.from} hint={value.yearly ? 'MM-DD' : undefined}>
          {value.yearly ? <Input id={`${p}-from`} value={value.from} onChange={(e) => set({ from: e.target.value })} placeholder="07-01" className="font-mono" /> : <Input id={`${p}-from`} type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} />}
        </Field>
        <Field label="Last day" htmlFor={`${p}-to`} error={errors.to} hint={value.yearly ? 'MM-DD, may run over the new year' : undefined}>
          {value.yearly ? <Input id={`${p}-to`} value={value.to} onChange={(e) => set({ to: e.target.value })} placeholder="08-31" className="font-mono" /> : <Input id={`${p}-to`} type="date" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} />}
        </Field>
      </div>
      <Field label="Days of the week" error={errors.weekdays} hint="None picked means every day">
        <CheckboxGrid name={`${p}-days`} options={WEEKDAYS} selected={value.weekdays.map(String)} onChange={(ids) => set({ weekdays: ids.map(Number).sort() })} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {units && (
          <Field label="Applies to" htmlFor={`${p}-unit`}>
            <Select id={`${p}-unit`} className="w-full" value={value.unitId ?? ''} options={[{ value: '', label: 'Every room of the type' }, ...units.map((u) => ({ value: u.id, label: `${u.code} only` }))]} onChange={(e) => set({ unitId: e.target.value || null })} />
          </Field>
        )}
        <Field label="Note" htmlFor={`${p}-note`}>
          <Input id={`${p}-note`} value={value.note} onChange={(e) => set({ note: e.target.value })} placeholder="High season, renovation" />
        </Field>
      </div>
    </div>
  )
}

interface FormProps {
  title: string
  initial: RestrictionDraft
  units?: FieldsProps['units']
  save: (draft: RestrictionDraft) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
  /** Extra controls above the rule, such as the room types of the bulk editor. */
  children?: (errors: Record<string, string>) => ReactNode
  submitLabel?: string
}

export function RestrictionForm({ title, initial, units, save, onDone, onCancel, children, submitLabel = 'Save restriction' }: FormProps) {
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      await save(draft)
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
        {children?.(errors)}
        <RestrictionFields idPrefix="rst" value={draft} onChange={setDraft} errors={errors} units={units} />
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

const RULE_TONE: Record<RestrictionRule, 'danger' | 'warning' | 'info'> = { stop_sell: 'danger', closed_to_arrival: 'warning', closed_to_departure: 'warning', min_stay: 'info', min_stay_through: 'info', max_stay: 'info' }

/** Restrictions as rows, each with its rule, range and an edit and remove control when allowed. */
export function RestrictionRows({ rows, showType, onEdit, onRemove }: { rows: readonly RestrictionView[]; showType?: boolean; onEdit?: (r: RestrictionView) => void; onRemove?: (r: RestrictionView) => void }) {
  if (rows.length === 0) return <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No restrictions. Every night sells for any length of stay.</p>
  return (
    <ul className="divide-y divide-line text-sm" aria-label="Restrictions">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
          <Tag tone={RULE_TONE[r.rule]}>{r.label}</Tag>
          <span className="min-w-0 flex-1">
            {showType && <span className="font-medium">{r.groupName} · </span>}
            {r.unitCode && <span className="font-mono">{r.unitCode} · </span>}
            <span className="text-muted">{r.when}</span>
            {r.note && <span className="text-muted"> · {r.note}</span>}
          </span>
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={() => onEdit(r)}>
              Edit
            </Button>
          )}
          {onRemove && (
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${r.label}, ${r.when}`} onClick={() => onRemove(r)}>
              <Trash2 aria-hidden className="size-4" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

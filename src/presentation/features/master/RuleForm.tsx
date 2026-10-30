import { useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { ROLE_LABEL, ROLES, type Role } from '@/domain/access'
import type { ApprovalRule, ApprovalRuleInput } from '@/domain/approval'
import { KIND_LABEL } from '@/domain/finance'
import type { Villa } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { Switch } from '../../ui/Switch'

interface RuleFormProps {
  initial?: ApprovalRule
  villas: readonly Villa[]
  save: (input: ApprovalRuleInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** Name, scope and threshold of a rule, and the ordered roles that sign. */
export function RuleForm({ initial, villas, save, onDone, onCancel }: RuleFormProps) {
  const [levels, setLevels] = useState<Role[]>([...(initial?.levels ?? ['manager'])])
  const [active, setActive] = useState(initial?.active ?? true)
  const [adding, setAdding] = useState<Role>('finance')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const free = ROLES.filter((r) => !levels.includes(r))

  function move(i: number, by: -1 | 1) {
    const next = [...levels]
    const target = i + by
    const a = next[i]
    const b = next[target]
    if (a === undefined || b === undefined) return
    next[i] = b
    next[target] = a
    setLevels(next)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const kind = String(f.get('kind') ?? 'all')
    setSaving(true)
    setErrors({})
    try {
      await save({ name: String(f.get('name') ?? ''), kind: kind === 'cash_in' || kind === 'cash_out' ? kind : 'all', villaId: String(f.get('villaId') ?? '') || null, minAmount: Number(f.get('minAmount')), levels, active })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.name}` : 'New approval rule'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.name}` : 'New approval rule'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Name" htmlFor="rule-name" error={errors.name}>
            <Input id="rule-name" name="name" defaultValue={initial?.name} placeholder="Large expenses" />
          </Field>
          <Field label="Applies to" htmlFor="rule-kind">
            <Select id="rule-kind" name="kind" className="w-full" defaultValue={initial?.kind ?? 'cash_out'} options={[{ value: 'all', label: 'Cash in and out' }, { value: 'cash_in', label: KIND_LABEL.cash_in }, { value: 'cash_out', label: KIND_LABEL.cash_out }]} />
          </Field>
          <Field label="Villa" htmlFor="rule-villa" hint="Leave on every villa for a portfolio rule">
            <Select id="rule-villa" name="villaId" className="w-full" defaultValue={initial?.villaId ?? ''} options={[{ value: '', label: 'Every villa' }, ...villas.map((v) => ({ value: v.id, label: v.name }))]} />
          </Field>
          <Field label="From amount, Rp" htmlFor="rule-min" error={errors.minAmount}>
            <Input id="rule-min" name="minAmount" type="number" inputMode="numeric" min={0} step={100000} defaultValue={initial?.minAmount ?? 0} className="tabular" />
          </Field>
        </div>
        <Field label="Who signs, in order" error={errors.levels}>
          <ol className="space-y-1.5">
            {levels.map((role, i) => (
              <li key={role} className="flex items-center gap-2 rounded-panel bg-raised px-3 py-2 text-sm">
                <span className="grid size-6 place-items-center rounded-full bg-control text-xs font-semibold text-muted">{i + 1}</span>
                <span className="flex-1 font-medium">{ROLE_LABEL[role]}</span>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${ROLE_LABEL[role]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp aria-hidden className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${ROLE_LABEL[role]} down`} disabled={i === levels.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown aria-hidden className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${ROLE_LABEL[role]}`} onClick={() => setLevels(levels.filter((r) => r !== role))}>
                  <X aria-hidden className="size-4" />
                </Button>
              </li>
            ))}
          </ol>
          {free.length > 0 && (
            <div className="mt-2 flex gap-2">
              <Select aria-label="Role to add" value={free.includes(adding) ? adding : (free[0] ?? adding)} options={free.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} onChange={(e) => setAdding(e.target.value as Role)} />
              <Button variant="soft" onClick={() => setLevels([...levels, free.includes(adding) ? adding : (free[0] as Role)])}>
                <Plus aria-hidden className="size-4" /> Add level
              </Button>
            </div>
          )}
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <Switch label="Rule active" checked={active} onChange={setActive} />
          {active ? 'Active' : 'Switched off'}
        </label>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save rule' : 'Add rule'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

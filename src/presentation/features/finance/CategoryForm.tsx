import { useState, type FormEvent } from 'react'
import type { CategoryInput } from '@/application/ports'
import { isSystemCategory, KIND_LABEL, type Category, type TransactionKind } from '@/domain/finance'
import type { Villa } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'

interface CategoryFormProps {
  initial?: Category
  villas: readonly Villa[]
  save: (input: CategoryInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** Name, kind and the villas a category is enabled for; empty means every villa. */
export function CategoryForm({ initial, villas, save, onDone, onCancel }: CategoryFormProps) {
  const [villaIds, setVillaIds] = useState<string[]>([...(initial?.villaIds ?? [])])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const locked = initial ? isSystemCategory(initial.id) : false

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({ name: locked && initial ? initial.name : String(f.get('name') ?? ''), kind: locked && initial ? initial.kind : (f.get('kind') as TransactionKind), villaIds })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.name}` : 'New category'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.name}` : 'New category'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
          <Field label="Name" htmlFor="cf-name" error={errors.name} hint={locked ? 'A system category keeps its name and kind.' : undefined}>
            <Input id="cf-name" name="name" defaultValue={initial?.name} placeholder="Garden and pool" readOnly={locked} />
          </Field>
          <Field label="Kind" htmlFor="cf-kind">
            <Select id="cf-kind" name="kind" className="w-full" defaultValue={initial?.kind ?? 'cash_out'} disabled={locked} options={[{ value: 'cash_out', label: KIND_LABEL.cash_out }, { value: 'cash_in', label: KIND_LABEL.cash_in }]} />
          </Field>
        </div>
        <Field label="Enabled for" hint={villaIds.length === 0 ? 'Every villa can use it. Tick villas to limit it.' : `Only ${villaIds.length} villa${villaIds.length === 1 ? '' : 's'} can book into it.`}>
          <CheckboxGrid name="villaIds" options={villas.map((v) => ({ id: v.id, label: v.name }))} selected={villaIds} onChange={setVillaIds} />
        </Field>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save category' : 'Add category'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

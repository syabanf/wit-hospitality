import { useState, type FormEvent } from 'react'
import type { AccountKind, CashAccount, CashAccountInput } from '@/domain/finance'
import type { Location } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'

interface AccountFormProps {
  initial?: CashAccount
  locations: readonly Location[]
  today: string
  save: (input: CashAccountInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** Open a cashbox or bank account with its opening balance, or rename and re-map an existing one. */
export function AccountForm({ initial, locations, today, save, onDone, onCancel }: AccountFormProps) {
  const [kind, setKind] = useState<AccountKind>(initial?.kind ?? 'cashbox')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({
        name: String(f.get('name') ?? '').trim(),
        kind,
        locationId: String(f.get('locationId') ?? '') || null,
        openingBalance: Number(f.get('openingBalance')),
        openedOn: String(f.get('openedOn') ?? ''),
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.name}` : 'Open an account'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.name}` : 'Open an account'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="acc-name" error={errors.name}>
            <Input id="acc-name" name="name" defaultValue={initial?.name} placeholder="Nusa Dua cashbox" />
          </Field>
          <Field label="Kind" htmlFor="acc-kind">
            <Select id="acc-kind" className="w-full" value={kind} options={[{ value: 'cashbox', label: 'Cashbox' }, { value: 'bank', label: 'Bank account' }]} onChange={(e) => setKind(e.target.value as AccountKind)} />
          </Field>
          <Field label="Location" htmlFor="acc-loc" error={errors.locationId} hint={kind === 'bank' ? 'Optional for a bank account' : undefined}>
            <Select id="acc-loc" name="locationId" className="w-full" defaultValue={initial?.locationId ?? ''} options={[{ value: '', label: kind === 'bank' ? 'All locations' : 'Pick the location' }, ...locations.map((l) => ({ value: l.id, label: l.name }))]} />
          </Field>
          <Field label="Opening balance, Rp" htmlFor="acc-open" error={errors.openingBalance} hint={initial ? 'Changing it moves every running balance' : undefined}>
            <Input id="acc-open" name="openingBalance" type="number" inputMode="numeric" min={0} step={1000} defaultValue={initial?.openingBalance ?? 0} className="tabular" />
          </Field>
          <Field label="Opened on" htmlFor="acc-date" error={errors.openedOn}>
            <Input id="acc-date" name="openedOn" type="date" defaultValue={initial?.openedOn ?? today} max={today} />
          </Field>
        </div>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save account' : 'Open account'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

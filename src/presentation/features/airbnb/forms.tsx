import { useState, type FormEvent } from 'react'
import { LISTING_STATUS_LABEL, type AirbnbAccount, type AirbnbAccountInput, type Listing, type ListingInput } from '@/domain/airbnb'
import type { Catalog } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'

function useSave<I>(save: (input: I) => Promise<unknown>, onDone: () => void) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  async function submit(input: I) {
    setSaving(true)
    setErrors({})
    try {
      await save(input)
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }
  return { errors, saving, submit }
}

const text = (f: FormData, key: string) => String(f.get(key) ?? '').trim()

interface Common<E, I> {
  initial?: E
  save: (input: I) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

export function AirbnbAccountForm({ initial, save, onDone, onCancel }: Common<AirbnbAccount, AirbnbAccountInput>) {
  const { errors, saving, submit } = useSave(save, onDone)
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    void submit({ name: text(f, 'name'), email: text(f, 'email'), status: text(f, 'status') === 'paused' ? 'paused' : 'active' })
  }
  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.name}` : 'New Airbnb account'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.name}` : 'New Airbnb account'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Host name" htmlFor="aa-name" error={errors.name}>
            <Input id="aa-name" name="name" defaultValue={initial?.name} placeholder="Saka Stays" />
          </Field>
          <Field label="Login email" htmlFor="aa-email" error={errors.email}>
            <Input id="aa-email" name="email" type="email" defaultValue={initial?.email} />
          </Field>
          <Field label="Status" htmlFor="aa-status">
            <Select id="aa-status" name="status" className="w-full" defaultValue={initial?.status ?? 'active'} options={[{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }]} />
          </Field>
        </div>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>{initial ? 'Save account' : 'Add account'}</Button>
          <Button variant="soft" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  )
}

export function ListingForm({ initial, catalog, accounts, listings, unitId, accountId, save, onDone, onCancel }: Common<Listing, ListingInput> & { catalog: Catalog; accounts: readonly AirbnbAccount[]; listings: readonly Listing[]; unitId?: string; accountId?: string }) {
  const { errors, saving, submit } = useSave(save, onDone)
  const free = catalog.units.filter((u) => u.id === initial?.unitId || !listings.some((l) => l.unitId === u.id))
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    void submit({ accountId: text(f, 'accountId'), unitId: text(f, 'unitId'), title: text(f, 'title'), airbnbId: text(f, 'airbnbId'), status: text(f, 'status') === 'paused' ? 'paused' : 'active' })
  }
  return (
    <Card as="div" aria-label={initial ? `Edit listing ${initial.airbnbId}` : 'New listing'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? 'Edit listing' : 'New listing'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Unit" htmlFor="ls-unit" error={errors.unitId} hint="One listing per unit">
            <Select id="ls-unit" name="unitId" className="w-full" defaultValue={initial?.unitId ?? unitId ?? ''} options={[{ value: '', label: 'Pick the unit' }, ...free.map((u) => ({ value: u.id, label: `${u.code} · ${catalog.villa(u.villaId).name}` }))]} />
          </Field>
          <Field label="Host account" htmlFor="ls-account" error={errors.accountId}>
            <Select id="ls-account" name="accountId" className="w-full" defaultValue={initial?.accountId ?? accountId ?? ''} options={[{ value: '', label: 'Pick the account' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
          </Field>
          <Field label="Listing title" htmlFor="ls-title" error={errors.title} className="sm:col-span-2">
            <Input id="ls-title" name="title" defaultValue={initial?.title} placeholder="As it reads on Airbnb" />
          </Field>
          <Field label="Airbnb listing id" htmlFor="ls-id" error={errors.airbnbId} hint="The digits at the end of the listing URL">
            <Input id="ls-id" name="airbnbId" inputMode="numeric" defaultValue={initial?.airbnbId} className="font-mono" />
          </Field>
          <Field label="Status" htmlFor="ls-status">
            <Select id="ls-status" name="status" className="w-full" defaultValue={initial?.status ?? 'active'} options={(['active', 'paused'] as const).map((s) => ({ value: s, label: LISTING_STATUS_LABEL[s] }))} />
          </Field>
        </div>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>{initial ? 'Save listing' : 'Add listing'}</Button>
          <Button variant="soft" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  )
}

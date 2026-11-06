import { useState, type FormEvent } from 'react'
import { CITY_LEDGER_KIND_LABEL, type CityLedgerAccountInput, type CityLedgerKind } from '@/domain/cityLedger'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'

/** Opens or edits a company or travel agent account. */
export function AccountForm({ id, initial, villas, onDone }: { id: string | null; initial: CityLedgerAccountInput; villas: ReadonlyArray<{ id: string; name: string }>; onDone: () => void }) {
  const { cityLedger } = useServices()
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (patch: Partial<CityLedgerAccountInput>) => setForm((f) => ({ ...f, ...patch }))
  const text = (key: 'name' | 'contact' | 'billingEmail' | 'phone' | 'address' | 'npwp') => ({ id: `cla-${key}`, value: form[key], onChange: (e: { target: { value: string } }) => set({ [key]: e.target.value }) })
  const num = (key: 'creditLimit' | 'termsDays' | 'commissionPct') => ({ id: `cla-${key}`, inputMode: 'decimal' as const, className: 'tabular', value: String(form[key]), onChange: (e: { target: { value: string } }) => set({ [key]: Number(e.target.value) || 0 }) })

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await cityLedger.saveAccount(id, form)
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Name" htmlFor="cla-name" error={errors.name ?? errors.form}>
        <Input {...text('name')} />
      </Field>
      <Field label="Kind" htmlFor="cla-kind" error={errors.kind}>
        <Select id="cla-kind" className="w-full" value={form.kind} options={(Object.keys(CITY_LEDGER_KIND_LABEL) as CityLedgerKind[]).map((k) => ({ value: k, label: CITY_LEDGER_KIND_LABEL[k] }))} onChange={(e) => set({ kind: e.target.value as CityLedgerKind, commissionPct: e.target.value === 'company' ? 0 : form.commissionPct })} />
      </Field>
      <Field label="Contact" htmlFor="cla-contact" error={errors.contact}>
        <Input {...text('contact')} />
      </Field>
      <Field label="Billing email" htmlFor="cla-billingEmail" error={errors.billingEmail}>
        <Input type="email" {...text('billingEmail')} />
      </Field>
      <Field label="Phone" htmlFor="cla-phone">
        <Input {...text('phone')} />
      </Field>
      <Field label="NPWP (optional)" htmlFor="cla-npwp">
        <Input {...text('npwp')} />
      </Field>
      <Field label="Address" htmlFor="cla-address" className="sm:col-span-2 lg:col-span-3">
        <Input {...text('address')} />
      </Field>
      <Field label="Credit limit, Rp" htmlFor="cla-creditLimit" error={errors.creditLimit}>
        <Input {...num('creditLimit')} />
      </Field>
      <Field label="Payment terms, days" htmlFor="cla-termsDays" error={errors.termsDays} hint="From the invoice date to its due date">
        <Input {...num('termsDays')} />
      </Field>
      <Field label="Commission, percent" htmlFor="cla-commissionPct" error={errors.commissionPct} hint="Travel agents only, on the charges before service and PB1">
        <Input {...num('commissionPct')} disabled={form.kind === 'company'} />
      </Field>
      <fieldset className="sm:col-span-2 lg:col-span-3">
        <legend className="mb-1.5 text-xs font-medium text-muted">Villas it may book; none ticked means every villa</legend>
        <CheckboxGrid name="cla-villas" options={villas.map((v) => ({ id: v.id, label: v.name }))} selected={form.villaIds} onChange={(villaIds) => set({ villaIds })} />
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} /> Open for new bookings
      </label>
      <div className="flex items-end gap-2 lg:col-span-2">
        <Button type="submit" variant="accent">Save account</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  )
}

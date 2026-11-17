import { useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { PACKAGE_RATE_LABEL, PACKAGE_RATES, packageSummary, ROOM_ONLY, type PackageRate, type RatePackage, type RatePackageInput } from '@/domain/ratePackage'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { useToast } from '../../ui/useToast'

const NEW_PACKAGE: RatePackageInput = { name: '', rate: 'plan', value: 0, breakfast: 0, accountId: null }

/** A hotel room type's rate packages beside Room only: breakfast, fixed and percent rates, corporate rates. */
export function PackagesCard({ groupId, name, packages, mayEdit, onSaved }: { groupId: string; name: string; packages: readonly RatePackage[]; mayEdit: boolean; onSaved: () => void }) {
  const { desk } = useServices()
  const toast = useToast()
  const [draft, setDraft] = useState<RatePackageInput[] | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const companies = useResource('desk.companies', () => desk.companies())
  const companyName = (id: string | null) => companies.data?.find((c) => c.id === id)?.name ?? id ?? ''

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!draft) return
    setSaving(true)
    setErrors({})
    try {
      await desk.savePackages(groupId, draft)
      toast({ title: `Saved the packages of ${name}`, description: 'New bookings can sell on them; booked stays keep their price.' })
      setDraft(null)
      onSaved()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }
  const set = (i: number, patch: Partial<RatePackageInput>) => setDraft((d) => d && d.map((k, j) => (j === i ? { ...k, ...patch } : k)))

  return (
    <Card aria-labelledby="packages-title">
      <CardHeader
        id="packages-title"
        title="Rate packages"
        action={
          mayEdit && !draft ? (
            <Button size="sm" variant="soft" onClick={() => setDraft(packages.map((k) => ({ ...k })))}>
              <Pencil aria-hidden className="size-4" /> Edit
            </Button>
          ) : undefined
        }
      />
      {!draft ? (
        <ul className="divide-y divide-line text-sm" aria-label="Packages">
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0">
            <span className="min-w-0 flex-1 font-medium">{ROOM_ONLY}</span>
            <span className="text-xs text-muted">The plan's nightly rate, no breakfast</span>
          </li>
          {packages.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 last:pb-0">
              <span className="min-w-0 flex-1 font-medium">{k.name}</span>
              {k.accountId && <Tag tone="info">{companyName(k.accountId)}</Tag>}
              <span className="text-xs text-muted">{packageSummary(k, money)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <p className="text-xs text-muted">Room only is always offered. Breakfast posts on the folio per person each night the audit runs.</p>
          {(errors.packages || errors.form) && (
            <p role="alert" className="text-xs font-medium text-danger">
              {errors.packages ?? errors.form}
            </p>
          )}
          {draft.map((k, i) => (
            <div key={i} className="grid grid-cols-2 gap-3 rounded-panel bg-raised p-3 lg:grid-cols-[minmax(0,1fr)_170px_130px_130px_minmax(0,1fr)_auto] lg:items-end">
              <Field label="Name" htmlFor={`pk-${i}-name`} error={errors[`packages.${i}.name`]} className="col-span-2 lg:col-span-1">
                <Input id={`pk-${i}-name`} value={k.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="With breakfast" />
              </Field>
              <Field label="Room price" htmlFor={`pk-${i}-rate`} error={errors[`packages.${i}.rate`]}>
                <Select id={`pk-${i}-rate`} className="w-full" value={k.rate} options={PACKAGE_RATES.map((r) => ({ value: r, label: PACKAGE_RATE_LABEL[r] }))} onChange={(e) => set(i, { rate: e.target.value as PackageRate })} />
              </Field>
              <Field label={k.rate === 'percent' ? 'Percent off' : 'Per night, Rp'} htmlFor={`pk-${i}-value`} error={errors[`packages.${i}.value`]}>
                <Input id={`pk-${i}-value`} type="number" inputMode="numeric" min={0} disabled={k.rate === 'plan'} value={k.rate === 'plan' ? '' : k.value || ''} onChange={(e) => set(i, { value: Number(e.target.value) || 0 })} className="tabular" />
              </Field>
              <Field label="Breakfast, Rp" htmlFor={`pk-${i}-bf`} error={errors[`packages.${i}.breakfast`]} hint="Per person a night">
                <Input id={`pk-${i}-bf`} type="number" inputMode="numeric" min={0} step={10_000} value={k.breakfast || ''} onChange={(e) => set(i, { breakfast: Number(e.target.value) || 0 })} className="tabular" />
              </Field>
              <Field label="Company" htmlFor={`pk-${i}-acct`} error={errors[`packages.${i}.accountId`]} className="col-span-2 lg:col-span-1">
                <Select id={`pk-${i}-acct`} className="w-full" value={k.accountId ?? ''} options={[{ value: '', label: 'Anyone' }, ...(companies.data ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))]} onChange={(e) => set(i, { accountId: e.target.value || null })} />
              </Field>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${k.name || 'package'}`} onClick={() => setDraft((d) => d && d.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="soft" onClick={() => setDraft((d) => d && [...d, { ...NEW_PACKAGE }])}>
              <Plus aria-hidden className="size-4" /> Package
            </Button>
            <Button type="submit" size="sm" variant="accent" loading={saving}>
              Save packages
            </Button>
            <Button size="sm" variant="ghost" onClick={() => (setDraft(null), setErrors({}))}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

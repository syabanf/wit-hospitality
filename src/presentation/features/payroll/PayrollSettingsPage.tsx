import { useState } from 'react'
import { Save } from 'lucide-react'
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from '@/domain/payroll'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

type Key = keyof PayrollSettings

const GROUPS: ReadonlyArray<{ title: string; blurb: string; fields: ReadonlyArray<{ key: Key; label: string; hint: string; step?: number }> }> = [
  {
    title: 'Working time',
    blurb: 'Absence and overtime are priced from these.',
    fields: [
      { key: 'workingDaysPerMonth', label: 'Working days per month', hint: 'One absent day deducts basic ÷ this.' },
      { key: 'overtimeDivisor', label: 'Overtime divisor', hint: 'Hourly rate is basic ÷ divisor; the government formula uses 173.' },
      { key: 'overtimeMultiplier', label: 'Overtime multiplier', hint: '1.5 pays time and a half for every approved hour.', step: 0.1 },
      { key: 'lateGraceMinutes', label: 'Late grace, minutes', hint: 'Minutes late before any deduction.' },
      { key: 'lateDeductionPerMinute', label: 'Late deduction per minute, Rp', hint: 'Applied to minutes beyond the grace.', step: 500 },
    ],
  },
  {
    title: 'BPJS',
    blurb: 'Percentages of the basic salary; the employee shares come off the payslip, the company shares add to the villa cost.',
    fields: [
      { key: 'bpjsHealthEmployeePct', label: 'Kesehatan, employee %', hint: 'Statutory 1%.', step: 0.01 },
      { key: 'bpjsHealthCompanyPct', label: 'Kesehatan, company %', hint: 'Statutory 4%.', step: 0.01 },
      { key: 'bpjsEmploymentEmployeePct', label: 'Ketenagakerjaan, employee %', hint: 'JHT 2% plus JP 1%.', step: 0.01 },
      { key: 'bpjsEmploymentCompanyPct', label: 'Ketenagakerjaan, company %', hint: 'JHT, JP, JKK and JKM together.', step: 0.01 },
    ],
  },
  {
    title: 'PPh 21',
    blurb: 'A simplified monthly calculation: gross less employee BPJS less the monthly PTKP, taxed in two bands.',
    fields: [
      { key: 'ptkpMonthly', label: 'PTKP per month, Rp', hint: 'Annual PTKP ÷ 12.', step: 100_000 },
      { key: 'pph21LowerPct', label: 'Lower band %', hint: 'On taxable pay up to the band limit.', step: 0.5 },
      { key: 'pph21Band', label: 'Band limit per month, Rp', hint: 'Taxable pay above this uses the upper rate.', step: 500_000 },
      { key: 'pph21UpperPct', label: 'Upper band %', hint: 'On taxable pay above the band limit.', step: 0.5 },
    ],
  },
  {
    title: 'THR and service charge',
    blurb: 'THR pays one basic salary after a year, pro rata from one month; the service charge pool is split equally between eligible staff.',
    fields: [
      { key: 'thrMonth', label: 'THR month', hint: '1 to 12; the run of that month includes THR.' },
      { key: 'serviceChargePct', label: 'Service charge, % of room revenue', hint: 'Pooled from the month’s room revenue.', step: 0.5 },
    ],
  },
]

export default function PayrollSettingsPage() {
  const { payroll } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('payroll.settings', () => payroll.settings())
  const [draft, setDraft] = useState<PayrollSettings | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!draft) return
    setSaving(true)
    setErrors({})
    try {
      data.setData(await payroll.saveSettings(draft))
      setDraft(null)
      toast({ title: 'Payroll settings saved', description: 'The next calculation uses them.' })
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the settings', description: Object.values(e)[0] })
    } finally {
      setSaving(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const s = draft ?? data.data
  const editable = can('payroll', 'edit')

  return (
    <>
      <PageBar fallback="/payroll" label="Payroll" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        className="space-y-4"
      >
        <p className="max-w-xl text-sm text-muted">The rules every payroll calculation applies. Changing them does not touch a closed period.</p>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {GROUPS.map((g) => (
            <Card key={g.title} aria-label={g.title}>
              <CardHeader title={g.title} />
              <p className="mb-4 text-sm text-muted">{g.blurb}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {g.fields.map((f) => (
                  <Field key={f.key} label={f.label} htmlFor={`ps-${f.key}`} error={errors[f.key]} hint={f.hint}>
                    <Input id={`ps-${f.key}`} type="number" inputMode="decimal" step={f.step ?? 1} className="tabular" value={s[f.key]} disabled={!editable} onChange={(e) => setDraft({ ...s, [f.key]: Number(e.target.value) })} />
                  </Field>
                ))}
              </div>
            </Card>
          ))}
        </div>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="accent" loading={saving} disabled={!draft}>
              {!saving && <Save aria-hidden className="size-4" />} Save settings
            </Button>
            <Button variant="soft" disabled={!draft} onClick={() => setDraft(null)}>
              Discard changes
            </Button>
            <Button variant="ghost" onClick={() => setDraft({ ...DEFAULT_PAYROLL_SETTINGS })}>
              Reset to defaults
            </Button>
          </div>
        )}
      </form>
    </>
  )
}

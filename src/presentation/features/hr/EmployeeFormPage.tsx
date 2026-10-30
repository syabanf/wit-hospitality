import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Plus, Save, Trash2 } from 'lucide-react'
import { DEPARTMENT_LABEL, DEPARTMENTS, EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUSES, type Allowance, type Department, type EmployeeInput, type EmployeeStatus, type VillaAllocation } from '@/domain/hr'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'

const EMPTY: EmployeeInput = {
  code: '',
  name: '',
  position: '',
  department: 'housekeeping',
  status: 'probation',
  joinedOn: '',
  leftOn: null,
  phone: '',
  email: '',
  bankName: '',
  bankAccount: '',
  npwp: '',
  allocations: [],
  basicSalary: 0,
  allowances: [{ name: 'Meal', amount: 600_000 }],
  serviceChargeEligible: true,
  bpjsEnrolled: true,
  annualLeaveDays: 12,
}

/** New employee, or edit one: the same form, keyed on the route's `id`. */
export default function EmployeeFormPage() {
  const { id } = useParams()
  const { hr } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const data = useResource(`hr.employees:form:${id ?? 'new'}`, () => hr.employees())
  const [draft, setDraft] = useState<EmployeeInput | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  const d = data.data
  const existing = id ? d.employees.find((e) => e.id === id) : undefined
  const villas = d.catalog.villas
  const next = String(d.employees.length + 1).padStart(3, '0')
  const form: EmployeeInput = draft ?? (existing ? { ...existing } : { ...EMPTY, code: `EMP-${next}`, joinedOn: d.today, allocations: villas[0] ? [{ villaId: villas[0].id, percent: 100 }] : [] })
  const patch = (p: Partial<EmployeeInput>) => setDraft({ ...form, ...p })
  const setAllocation = (i: number, p: Partial<VillaAllocation>) => patch({ allocations: form.allocations.map((a, n) => (n === i ? { ...a, ...p } : a)) })
  const setAllowance = (i: number, p: Partial<Allowance>) => patch({ allowances: form.allowances.map((a, n) => (n === i ? { ...a, ...p } : a)) })
  const shareTotal = form.allocations.reduce((s, a) => s + a.percent, 0)

  async function save() {
    setSaving(true)
    setErrors({})
    try {
      const saved = existing ? await hr.updateEmployee(existing.id, form) : await hr.createEmployee(form)
      toast({ title: existing ? `Saved ${saved.name}` : `Added ${saved.name}`, description: `${saved.code} · ${saved.position}` })
      navigate(`/hr/employees/${saved.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the employee', description: Object.values(e)[0] })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageBar fallback={existing ? `/hr/employees/${existing.id}` : '/hr/employees'} label={existing ? existing.name : 'Employees'} />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="emp-person">
            <CardHeader id="emp-person" title="Person" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Code" htmlFor="e-code" error={errors.code} hint="EMP- and three digits">
                <Input id="e-code" className="font-mono" value={form.code} onChange={(e) => patch({ code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Full name" htmlFor="e-name" error={errors.name}>
                <Input id="e-name" value={form.name} onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              <Field label="Position" htmlFor="e-pos" error={errors.position}>
                <Input id="e-pos" value={form.position} onChange={(e) => patch({ position: e.target.value })} placeholder="Front desk" />
              </Field>
              <Field label="Department" htmlFor="e-dept" error={errors.department}>
                <Select id="e-dept" className="w-full" value={form.department} options={DEPARTMENTS.map((x) => ({ value: x, label: DEPARTMENT_LABEL[x] }))} onChange={(e) => patch({ department: e.target.value as Department })} />
              </Field>
              <Field label="Status" htmlFor="e-status" error={errors.status}>
                <Select id="e-status" className="w-full" value={form.status} options={EMPLOYEE_STATUSES.map((x) => ({ value: x, label: EMPLOYEE_STATUS_LABEL[x] }))} onChange={(e) => patch({ status: e.target.value as EmployeeStatus })} />
              </Field>
              <Field label="Joined on" htmlFor="e-joined" error={errors.joinedOn}>
                <Input id="e-joined" type="date" value={form.joinedOn} onChange={(e) => patch({ joinedOn: e.target.value })} />
              </Field>
              {form.status === 'inactive' && (
                <Field label="Left on" htmlFor="e-left" error={errors.leftOn}>
                  <Input id="e-left" type="date" value={form.leftOn ?? ''} onChange={(e) => patch({ leftOn: e.target.value || null })} />
                </Field>
              )}
              <Field label="Phone" htmlFor="e-phone" error={errors.phone}>
                <Input id="e-phone" value={form.phone} onChange={(e) => patch({ phone: e.target.value })} placeholder="+62 …" />
              </Field>
              <Field label="Email" htmlFor="e-email" error={errors.email}>
                <Input id="e-email" type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} />
              </Field>
            </div>
          </Card>
          <Card aria-labelledby="emp-pay">
            <CardHeader id="emp-pay" title="Pay and bank" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Basic salary, Rp" htmlFor="e-basic" error={errors.basicSalary}>
                <Input id="e-basic" type="number" inputMode="numeric" min={0} step={50_000} className="tabular" value={form.basicSalary || ''} onChange={(e) => patch({ basicSalary: Number(e.target.value) })} />
              </Field>
              <Field label="Annual leave days" htmlFor="e-leave" error={errors.annualLeaveDays}>
                <Input id="e-leave" type="number" inputMode="numeric" min={0} max={30} className="tabular" value={form.annualLeaveDays} onChange={(e) => patch({ annualLeaveDays: Number(e.target.value) })} />
              </Field>
              <Field label="Bank" htmlFor="e-bank">
                <Input id="e-bank" value={form.bankName} onChange={(e) => patch({ bankName: e.target.value })} placeholder="BCA" />
              </Field>
              <Field label="Account number" htmlFor="e-acc">
                <Input id="e-acc" className="font-mono" value={form.bankAccount} onChange={(e) => patch({ bankAccount: e.target.value })} />
              </Field>
              <Field label="NPWP" htmlFor="e-npwp" hint="Leave empty when the employee has none">
                <Input id="e-npwp" className="font-mono" value={form.npwp} onChange={(e) => patch({ npwp: e.target.value })} />
              </Field>
            </div>
            <ul className="mt-4 divide-y divide-line">
              <li className="flex items-center gap-4 py-3">
                <span className="flex-1">
                  <span className="block text-sm font-medium">Service charge</span>
                  <span className="block text-xs text-muted">Shares the monthly pool with the other eligible staff.</span>
                </span>
                <Switch label="Service charge eligible" checked={form.serviceChargeEligible} onChange={(on) => patch({ serviceChargeEligible: on })} />
              </li>
              <li className="flex items-center gap-4 py-3">
                <span className="flex-1">
                  <span className="block text-sm font-medium">BPJS enrolled</span>
                  <span className="block text-xs text-muted">Kesehatan and Ketenagakerjaan contributions on the payslip.</span>
                </span>
                <Switch label="BPJS enrolled" checked={form.bpjsEnrolled} onChange={(on) => patch({ bpjsEnrolled: on })} />
              </li>
            </ul>
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted">Allowances</p>
              {errors.allowances && <p role="alert" className="mb-2 text-xs font-medium text-danger">{errors.allowances}</p>}
              <ul className="space-y-2">
                {form.allowances.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <Input aria-label={`Allowance ${i + 1} name`} className="min-w-0 flex-1" value={a.name} onChange={(e) => setAllowance(i, { name: e.target.value })} placeholder="Transport" />
                    <Input aria-label={`Allowance ${i + 1} amount`} className="w-40 tabular" type="number" inputMode="numeric" min={0} step={50_000} value={a.amount || ''} onChange={(e) => setAllowance(i, { amount: Number(e.target.value) })} />
                    <Button variant="ghost" size="icon" aria-label={`Remove allowance ${a.name || i + 1}`} onClick={() => patch({ allowances: form.allowances.filter((_, n) => n !== i) })}>
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button variant="soft" size="sm" className="mt-2" onClick={() => patch({ allowances: [...form.allowances, { name: '', amount: 0 }] })}>
                <Plus aria-hidden className="size-3.5" /> Allowance
              </Button>
            </div>
          </Card>
          <Card aria-labelledby="emp-villas">
            <CardHeader id="emp-villas" title="Villas" />
            <p className="mb-3 text-sm text-muted">Where the person works, and how payroll splits the cost. The shares add up to 100%.</p>
            {errors.allocations && <p role="alert" className="mb-2 text-xs font-medium text-danger">{errors.allocations}</p>}
            <ul className="space-y-2">
              {form.allocations.map((a, i) => (
                <li key={i} className="flex gap-2">
                  <Select aria-label={`Villa ${i + 1}`} className="min-w-0 flex-1" value={a.villaId} options={[{ value: '', label: 'Pick a villa' }, ...villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => setAllocation(i, { villaId: e.target.value })} />
                  <Input aria-label={`Share ${i + 1}, percent`} className="w-28 tabular" type="number" inputMode="numeric" min={0} max={100} value={a.percent} onChange={(e) => setAllocation(i, { percent: Number(e.target.value) })} />
                  <Button variant="ghost" size="icon" aria-label={`Remove villa ${i + 1}`} onClick={() => patch({ allocations: form.allocations.filter((_, n) => n !== i) })}>
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-3">
              <Button variant="soft" size="sm" onClick={() => patch({ allocations: [...form.allocations, { villaId: '', percent: Math.max(0, 100 - shareTotal) }] })}>
                <Plus aria-hidden className="size-3.5" /> Villa
              </Button>
              <span className={shareTotal === 100 ? 'text-xs text-muted' : 'text-xs font-medium text-danger'}>{shareTotal}% assigned</span>
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          <Card aria-labelledby="emp-sum">
            <CardHeader id="emp-sum" title="Summary" />
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Basic</dt>
                <dd className="tabular">{money(form.basicSalary)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Allowances</dt>
                <dd className="tabular">{money(form.allowances.reduce((s, a) => s + a.amount, 0))}</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-line-strong pt-2 font-semibold">
                <dt>Monthly gross</dt>
                <dd className="tabular">{money(form.basicSalary + form.allowances.reduce((s, a) => s + a.amount, 0))}</dd>
              </div>
            </dl>
            {errors.form && <p role="alert" className="mt-3 text-xs font-medium text-danger">{errors.form}</p>}
            <div className="mt-4 flex flex-col gap-2">
              <Button type="submit" variant="accent" loading={saving}>
                {!saving && <Save aria-hidden className="size-4" />} {existing ? 'Save employee' : 'Add employee'}
              </Button>
              <Button variant="soft" onClick={() => navigate(existing ? `/hr/employees/${existing.id}` : '/hr/employees')}>
                Cancel
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted">Overtime, BPJS and tax come from the payroll settings, not from here.</p>
          </Card>
        </div>
      </form>
    </>
  )
}

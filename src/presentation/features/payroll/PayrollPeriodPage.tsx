import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { Calculator, CircleCheck, Landmark, Lock, RotateCcw, Search, Send, ShieldCheck } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { DEPARTMENT_LABEL, DEPARTMENTS, type Department } from '@/domain/hr'
import type { PayrollLine } from '@/domain/payroll'
import { payrollFlow } from '@/domain/flow'
import { ADJUSTMENT_KIND_LABEL, ADJUSTMENT_KINDS, PAYROLL_STATUS_LABEL, type AdjustmentKind, type PayrollStatus } from '@/domain/payroll'
import { shortDay } from '@/lib/dates'
import { money, moneyCompact, plural } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { ListTable } from '../../ui/ListTable'
import { PageBar } from '../../ui/PageBar'
import { Popover } from '../../ui/Popover'
import { EmptyState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Steps, type Step } from '../../ui/Steps'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { PAYROLL_TONE } from '../shared/tones'
import { BreakdownDonut } from '../hr/BreakdownDonut'
import { PAY_SERIES } from '../hr/chartSeries'
import { FlowBar } from '../shared/FlowBar'
import { useFilters } from '../hr/useFilters'

const ORDER: PayrollStatus[] = ['draft', 'calculated', 'approved', 'closed']

function steps(status: PayrollStatus, history: ReadonlyArray<{ kind: string; on: string }>): Step[] {
  const at = ORDER.indexOf(status)
  const when = (kind: string) => history.filter((h) => h.kind === kind).at(-1)?.on
  return ORDER.map((s, i) => {
    const on = when(s === 'draft' ? 'created' : s)
    return { id: s, label: PAYROLL_STATUS_LABEL[s], hint: on ? shortDay(on) : undefined, state: i < at ? 'done' : i === at ? 'current' : 'upcoming' }
  })
}

export default function PayrollPeriodPage() {
  const { id = '' } = useParams()
  const { payroll } = useServices()
  const toast = useToast()
  const resource = useResource(`payroll.period:${id}`, () => payroll.period(id), { keepPrevious: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { values, set, clear, active } = useFilters(['q', 'department'] as const)

  async function run(key: string, label: string, action: () => Promise<unknown>, description?: string) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title: label, description })
      resource.reload()
      return true
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not ${label.toLowerCase()}`, description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="payroll period" back={{ to: '/payroll', label: 'Back to payroll' }}>
      {({ period: p, label, totals, byVilla, lines, employees, accounts, canApprove, canClose, canEdit, statutory }) => {
        const unpaid = statutory.filter((r) => r.amount > 0 && !r.entry)
        const editable = canEdit && (p.status === 'draft' || p.status === 'calculated')
        const departmentOf = (employeeId: string) => employees.find((e) => e.id === employeeId)?.department ?? 'management'
        const q = values.q.trim().toLowerCase()
        const visible = lines.filter((l) => (!q || l.employeeName.toLowerCase().includes(q)) && (!values.department || departmentOf(l.employeeId) === values.department))
        const departments = DEPARTMENTS.filter((dep) => lines.some((l) => departmentOf(l.employeeId) === dep))
        const byDepartment = departments.map((dep) => {
          const mine = lines.filter((l) => departmentOf(l.employeeId) === dep)
          return { department: dep, gross: mine.reduce((s, l) => s + l.gross, 0), deductions: mine.reduce((s, l) => s + l.deductions, 0), net: mine.reduce((s, l) => s + l.net, 0) }
        })
        const adjust = (line: PayrollLine) => (
          <Popover
            align="right"
            className="w-80 p-4"
            trigger={(props) => (
              <Button {...props} size="sm" variant="ghost">
                Adjust
              </Button>
            )}
          >
            {(close) => (
              <form
                onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault()
                  const f = new FormData(e.currentTarget)
                  void run(`adj-${line.employeeId}`, `Adjusted ${line.employeeName}`, () => payroll.addAdjustment(p.id, line.employeeId, { kind: f.get('kind') as AdjustmentKind, amount: Number(f.get('amount')), reason: String(f.get('reason') ?? '') })).then((ok) => ok && close())
                }}
                className="space-y-3"
              >
                <p className="text-sm font-semibold">{line.employeeName}</p>
                <Field label="Kind" htmlFor={`adj-kind-${line.employeeId}`}>
                  <Select id={`adj-kind-${line.employeeId}`} name="kind" className="w-full" options={ADJUSTMENT_KINDS.map((k) => ({ value: k, label: ADJUSTMENT_KIND_LABEL[k] }))} />
                </Field>
                <Field label="Amount, Rp" htmlFor={`adj-amount-${line.employeeId}`} error={errors.amount}>
                  <Input id={`adj-amount-${line.employeeId}`} name="amount" type="number" inputMode="numeric" min={0} step={50_000} className="tabular" />
                </Field>
                <Field label="Reason" htmlFor={`adj-reason-${line.employeeId}`} error={errors.reason ?? errors.form}>
                  <Input id={`adj-reason-${line.employeeId}`} name="reason" placeholder="Stays on the payslip" />
                </Field>
                <Button type="submit" size="sm" variant="accent" loading={busy === `adj-${line.employeeId}`}>
                  Add adjustment
                </Button>
                {line.adjustments.length > 0 && (
                  <ul className="divide-y divide-line border-t border-line pt-2 text-xs">
                    {line.adjustments.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="min-w-0 truncate">
                          {ADJUSTMENT_KIND_LABEL[a.kind]} {money(a.amount)} · {a.reason}
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => void run(`rm-${a.id}`, 'Removed the adjustment', () => payroll.removeAdjustment(p.id, line.employeeId, a.id)).then((ok) => ok && close())}>
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </form>
            )}
          </Popover>
        )
        return (
          <>
            <PageBar
              fallback="/payroll"
              label="Payroll"
              actions={
                <>
                  {canEdit && (p.status === 'calculated' || p.status === 'approved') && (
                    <Popover
                      align="right"
                      className="w-72 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <RotateCcw aria-hidden className="size-4" /> Reopen
                        </Button>
                      )}
                    >
                      {(close) => (
                        <form
                          onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault()
                            void run('reopen', `Reopened ${label}`, () => payroll.transition(p.id, 'draft', String(new FormData(e.currentTarget).get('note') ?? ''))).then((ok) => ok && close())
                          }}
                          className="space-y-3"
                        >
                          <Field label="Why" htmlFor="reopen-note" error={errors.note ?? errors.form}>
                            <Input id="reopen-note" name="note" placeholder="What changes before it runs again" />
                          </Field>
                          <Button type="submit" size="sm" variant="accent" loading={busy === 'reopen'}>
                            Reopen as draft
                          </Button>
                        </form>
                      )}
                    </Popover>
                  )}
                  {editable && (
                    <Button variant={p.status === 'draft' ? 'accent' : 'card'} loading={busy === 'calc'} onClick={() => void run('calc', `Calculated ${label}`, () => payroll.calculate(p.id))}>
                      <Calculator aria-hidden className="size-4" /> {p.status === 'draft' ? 'Calculate' : 'Recalculate'}
                    </Button>
                  )}
                  {canApprove && p.status === 'calculated' && (
                    <Button variant="accent" loading={busy === 'approve'} onClick={() => void run('approve', `Approved ${label}`, () => payroll.transition(p.id, 'approved'))}>
                      <ShieldCheck aria-hidden className="size-4" /> Approve
                    </Button>
                  )}
                  {canClose && p.status === 'approved' && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="accent">
                          <Lock aria-hidden className="size-4" /> Close and pay
                        </Button>
                      )}
                    >
                      {(close) => (
                        <form
                          onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault()
                            void run('close', `Closed ${label}`, () => payroll.transition(p.id, 'closed', '', String(new FormData(e.currentTarget).get('account') ?? '')), `${money(totals.net)} posted to the bank`).then((ok) => ok && close())
                          }}
                          className="space-y-3"
                        >
                          <p className="text-sm">Posts one cash-out of {money(totals.net)}, books the loan repayments and locks every payslip.</p>
                          <Field label="Paid from" htmlFor="close-account" error={errors.accountId ?? errors.form}>
                            <Select id="close-account" name="account" className="w-full" options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
                          </Field>
                          <Button type="submit" size="sm" variant="accent" loading={busy === 'close'}>
                            Close {label}
                          </Button>
                        </form>
                      )}
                    </Popover>
                  )}
                  {canClose && unpaid.length > 0 && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <Landmark aria-hidden className="size-4" /> Pay statutory
                        </Button>
                      )}
                    >
                      {(close) => (
                        <form
                          onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault()
                            void run('statutory', `Submitted the ${label} remittance`, () => payroll.payStatutory(p.id, String(new FormData(e.currentTarget).get('account') ?? '')), 'Waiting for approval like any cash-out').then((ok) => ok && close())
                          }}
                          className="space-y-3"
                        >
                          <p className="text-sm">Submits one cash-out per office for what {label} owes. Posting them pays the payables down.</p>
                          <ul className="divide-y divide-line text-sm">
                            {unpaid.map((r) => (
                              <li key={r.key} className="flex justify-between gap-2 py-1.5">
                                <span>{r.label}</span>
                                <span className="font-semibold tabular">{money(r.amount)}</span>
                              </li>
                            ))}
                          </ul>
                          <Field label="Paid from" htmlFor="statutory-account" error={errors.accountId ?? errors.form}>
                            <Select id="statutory-account" name="account" className="w-full" options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
                          </Field>
                          <Button type="submit" size="sm" variant="accent" loading={busy === 'statutory'}>
                            Submit for approval
                          </Button>
                        </form>
                      )}
                    </Popover>
                  )}
                  {canEdit && p.status === 'closed' && !p.published && (
                    <Button variant="accent" loading={busy === 'publish'} onClick={() => void run('publish', 'Payslips published', () => payroll.publish(p.id), 'Employees can open them now')}>
                      <Send aria-hidden className="size-4" /> Publish payslips
                    </Button>
                  )}
                </>
              }
            />
            <FlowBar label={`Where ${p.month} stands`} steps={payrollFlow(p)} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                <Card aria-label={`Payroll ${label}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">{p.id}</p>
                      <Headline className="mt-1">{label}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        {plural(totals.employees, 'employee')} · {p.published ? 'payslips published' : 'payslips not published'}
                      </p>
                    </div>
                    <StatusPill tone={PAYROLL_TONE[p.status]}>{PAYROLL_STATUS_LABEL[p.status]}</StatusPill>
                  </div>
                  <p className="mt-6 text-xs text-muted">Net pay</p>
                  <p className="min-w-0 text-[44px] leading-none font-medium tracking-tight break-words tabular">{money(totals.net)}</p>
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-4"
                    facts={[
                      ['Gross', money(totals.gross)],
                      ['Deductions', money(totals.deductions)],
                      ['Company BPJS', money(totals.companyBpjs)],
                      ['Villa cost', money(totals.cost)],
                      ['Service charge base', money(p.revenueBase)],
                      ['Paid from', p.paidFromAccountId ? (accounts.find((a) => a.id === p.paidFromAccountId)?.name ?? p.paidFromAccountId) : 'Not yet'],
                      ['Bank entry', p.transactionId ? <Link key="t" to={`/finance/transactions/${p.transactionId}`} className="font-mono hover:underline">{p.transactionId.replace('tx-', 'TX-24')}</Link> : 'Not yet'],
                      ...statutory.map((r): [string, ReactNode] => [`${r.label} remittance`, r.entry ? <Link key={r.key} to={`/finance/transactions/${r.entry.id}`} className="font-mono hover:underline">{r.entry.number} · {TRANSACTION_STATUS_LABEL[r.entry.status]}</Link> : r.amount > 0 ? `${money(r.amount)} owed` : 'Nothing owed']),
                    ]}
                  />
                </Card>
                <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <StatTile label="Overtime" value={money(lines.reduce((s, l) => s + l.overtimePay, 0))} hint={`${lines.reduce((s, l) => s + l.overtimeHours, 0)} hours`} to="/hr/overtime?status=approved" />
                  <StatTile label="Loans repaid" value={money(lines.reduce((s, l) => s + l.loanDeduction, 0))} to="/hr/loans?status=active" />
                  <StatTile label="PPh 21" value={money(lines.reduce((s, l) => s + l.pph21, 0))} hint="Withheld" to="/payroll/settings" />
                  <StatTile label="Late and absence" value={money(lines.reduce((s, l) => s + l.lateDeduction + l.absentDeduction, 0))} to="/hr/attendance" />
                </div>
                {byDepartment.length > 0 && (
                  <Card aria-labelledby="pay-dept">
                    <CardHeader
                      id="pay-dept"
                      title="Gross, deductions and net by department"
                      action={
                        <ul className="flex flex-wrap gap-3 text-xs text-muted">
                          {PAY_SERIES.map((s) => (
                            <li key={s.id} className="flex items-center gap-1.5">
                              <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} /> {s.label}
                            </li>
                          ))}
                        </ul>
                      }
                    />
                    <GroupedColumns
                      label="Pay by department"
                      className="h-56 lg:h-64"
                      labels={byDepartment.map((r) => DEPARTMENT_LABEL[r.department].split(' ')[0] ?? r.department)}
                      series={PAY_SERIES}
                      values={PAY_SERIES.map((s) => byDepartment.map((r) => r[s.id]))}
                      format={moneyCompact}
                    />
                  </Card>
                )}
                <Card className="p-0" aria-labelledby="lines-title">
                  <div className="p-5 pb-0">
                    <CardHeader id="lines-title" title="Payslips" />
                  </div>
                  <TableToolbar
                    summary={`${visible.length} of ${lines.length} payslips`}
                    search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Employee" aria-label="Search payslips" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
                    filters={<Select aria-label="Department" value={values.department} options={[{ value: '', label: 'All departments' }, ...departments.map((dep) => ({ value: dep, label: DEPARTMENT_LABEL[dep as Department] }))]} onChange={(e) => set({ department: e.target.value })} />}
                    active={active}
                    onClear={clear}
                  />
                  <ListTable
                    label="Payslips"
                    rows={visible}
                    rowKey={(l) => l.employeeId}
                    href={(l) => `/payroll/${p.id}/${l.employeeId}`}
                    exportName={`payroll-${p.month}`}
                    exportDate={p.month}
                    empty={<EmptyState title="No lines yet">Calculate the period to build the payslips.</EmptyState>}
                    columns={[
                      { key: 'name', header: 'Employee', cell: (l) => l.employeeName, value: (l) => l.employeeName },
                      { key: 'basic', header: 'Basic', align: 'right', cell: (l) => <span className="tabular">{money(l.basic)}</span>, value: (l) => l.basic, hide: 'lg', total: (sum) => money(sum) },
                      { key: 'allow', header: 'Allowances', align: 'right', cell: (l) => <span className="tabular">{money(l.allowances)}</span>, value: (l) => l.allowances, hide: 'xl', total: (sum) => money(sum) },
                      { key: 'ot', header: 'Overtime', align: 'right', cell: (l) => <span className="tabular">{money(l.overtimePay)}</span>, value: (l) => l.overtimePay, hide: 'xl', total: (sum) => money(sum) },
                      { key: 'extra', header: 'SC, THR, bonus', align: 'right', cell: (l) => <span className="tabular">{money(l.serviceCharge + l.thr + l.bonus + l.reimbursement)}</span>, value: (l) => l.serviceCharge + l.thr + l.bonus + l.reimbursement, hide: 'xl', total: (sum) => money(sum) },
                      { key: 'gross', header: 'Gross', align: 'right', cell: (l) => <span className="tabular">{money(l.gross)}</span>, value: (l) => l.gross, hide: 'lg', total: (sum) => money(sum) },
                      { key: 'ded', header: 'Deductions', align: 'right', cell: (l) => <span className="tabular text-muted">{money(l.deductions)}</span>, value: (l) => l.deductions, total: (sum) => money(sum) },
                      { key: 'net', header: 'Net', align: 'right', cell: (l) => <span className="font-semibold tabular">{money(l.net)}</span>, value: (l) => l.net, total: (sum) => money(sum) },
                      { key: 'adj', header: '', align: 'right', cell: (l) => (editable ? <span onClick={(e) => e.stopPropagation()}>{adjust(l)}</span> : l.adjustments.length ? <span className="text-xs text-muted">{plural(l.adjustments.length, 'adjustment')}</span> : null) },
                    ]}
                    card={(l) => (
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{l.employeeName}</p>
                          <p className="text-xs text-muted">
                            Gross {money(l.gross)} · deductions {money(l.deductions)}
                          </p>
                        </div>
                        <span className="text-sm font-semibold tabular">{money(l.net)}</span>
                      </div>
                    )}
                  />
                </Card>
              </div>
              <div className="space-y-4">
                <Card aria-labelledby="psteps-title">
                  <CardHeader id="psteps-title" title="Lifecycle" />
                  <Steps label="Payroll lifecycle" steps={steps(p.status, p.history)} />
                </Card>
                <Card aria-labelledby="villa-cost">
                  <CardHeader id="villa-cost" title="Cost by villa" />
                  <BreakdownDonut label="Payroll cost by villa" stacked size={150} slices={byVilla.map((v, i) => ({ id: v.villaId, label: v.villa?.name ?? v.villaId, value: v.amount, color: seriesColor((i % 5) + 1) }))} format={moneyCompact} centre={moneyCompact(totals.cost)} empty="Calculate the period to see the split." />
                </Card>
                <Card aria-labelledby="phist-title">
                  <CardHeader id="phist-title" title="History" />
                  <ol className="divide-y divide-line text-sm">
                    {[...p.history].reverse().map((h, i) => (
                      <li key={i} className="py-2">
                        <p className="font-medium">
                          {h.kind.charAt(0).toUpperCase() + h.kind.slice(1)} <span className="font-normal text-muted">by {h.by}</span>
                        </p>
                        <p className="text-xs text-muted">
                          {shortDay(h.on)}
                          {h.note && ` · ${h.note}`}
                        </p>
                      </li>
                    ))}
                  </ol>
                </Card>
                {p.status === 'closed' && (
                  <p className="flex items-center gap-2 text-xs text-muted">
                    <CircleCheck aria-hidden className="size-4 text-success" /> Closed periods never change; reopen is not offered.
                  </p>
                )}
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

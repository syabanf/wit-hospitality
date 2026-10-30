import { Printer } from 'lucide-react'
import type { Employee } from '@/domain/hr'
import { ADJUSTMENT_KIND_LABEL, type PayrollLine, type PayrollPeriod } from '@/domain/payroll'
import type { Catalog } from '@/domain/property'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { FactGrid, Headline } from '../../ui/Headline'
import { PAYROLL_TONE } from './tones'
import { StatusPill } from '../../ui/Badge'
import { PAYROLL_STATUS_LABEL } from '@/domain/payroll'

interface PayslipSheetProps {
  period: PayrollPeriod
  label: string
  line: PayrollLine
  employee: Employee
  catalog: Catalog
}

function Lines({ title, rows, total, totalLabel }: { title: string; rows: ReadonlyArray<readonly [string, number]>; total: number; totalLabel: string }) {
  return (
    <Card aria-label={title}>
      <CardHeader title={title} />
      <dl className="divide-y divide-line text-sm">
        {rows
          .filter(([, v]) => v !== 0)
          .map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 py-2">
              <dt className="min-w-0 text-body">{k}</dt>
              <dd className="shrink-0 tabular">{money(v)}</dd>
            </div>
          ))}
        <div className="flex items-center justify-between gap-3 pt-3 font-semibold">
          <dt>{totalLabel}</dt>
          <dd className="tabular">{money(total)}</dd>
        </div>
      </dl>
    </Card>
  )
}

/** One employee's pay for a period, laid out to print: earnings, deductions, net, villa shares. */
export function PayslipSheet({ period, label, line, employee, catalog }: PayslipSheetProps) {
  const closedOn = period.history.find((h) => h.kind === 'closed')?.on
  const otherPlus = line.gross - (line.basic + line.allowances + line.overtimePay + line.serviceCharge + line.thr + line.bonus + line.reimbursement)
  const villaName = (id: string) => catalog.villas.find((v) => v.id === id)?.name ?? id
  return (
    <div className="space-y-4">
      <Card aria-label={`Payslip ${label}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted">
              {employee.code} · {label}
            </p>
            <Headline className="mt-1">{employee.name}</Headline>
            <p className="mt-1 text-sm text-muted">
              {employee.position} · {employee.allocations.map((a) => villaName(a.villaId)).join(', ')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill tone={PAYROLL_TONE[period.status]}>{PAYROLL_STATUS_LABEL[period.status]}</StatusPill>
            <Button variant="card" size="sm" className="print:hidden" onClick={() => window.print()}>
              <Printer aria-hidden className="size-3.5" /> Print
            </Button>
          </div>
        </div>
        <p className="mt-6 text-xs text-muted">Net pay</p>
        <p className="min-w-0 text-[40px] leading-none font-medium tracking-tight break-words tabular">{money(line.net)}</p>
        <FactGrid
          className="mt-6 grid-cols-2 sm:grid-cols-4"
          facts={[
            ['Gross', money(line.gross)],
            ['Deductions', money(line.deductions)],
            ['Bank', employee.bankName ? `${employee.bankName} ${employee.bankAccount}` : 'Not on file'],
            ['Paid', closedOn ? shortDay(closedOn) : 'Not yet'],
          ]}
        />
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Lines
          title="Earnings"
          totalLabel="Gross"
          total={line.gross}
          rows={[
            ['Basic salary', line.basic],
            ['Allowances', line.allowances],
            [`Overtime, ${line.overtimeHours} h`, line.overtimePay],
            ['Service charge', line.serviceCharge],
            ['THR', line.thr],
            ['Bonus', line.bonus],
            ['Reimbursement', line.reimbursement],
            ['Other', otherPlus],
          ]}
        />
        <Lines
          title="Deductions"
          totalLabel="Total deductions"
          total={line.deductions}
          rows={[
            [`Late, ${line.lateMinutes} min`, line.lateDeduction],
            [`Absent, ${line.absentDays} days`, line.absentDeduction],
            ['Loan repayment', line.loanDeduction],
            ['BPJS Kesehatan', line.bpjsHealth],
            ['BPJS Ketenagakerjaan', line.bpjsEmployment],
            ['PPh 21', line.pph21],
            ['Other deductions', line.otherDeduction],
          ]}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card aria-labelledby="alloc-title">
          <CardHeader id="alloc-title" title="Cost per villa" />
          <ul className="divide-y divide-line text-sm">
            {line.allocation.map((a) => (
              <li key={a.villaId} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">
                  {villaName(a.villaId)} <span className="text-muted">· {a.percent}%</span>
                </span>
                <span className="shrink-0 tabular">{money(a.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Net pay plus the company BPJS share of {money(line.companyBpjs)}.</p>
        </Card>
        <Card aria-labelledby="adj-title">
          <CardHeader id="adj-title" title="Adjustments" />
          {line.adjustments.length === 0 ? (
            <p className="text-sm text-muted">No manual changes this period.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {line.adjustments.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span>{ADJUSTMENT_KIND_LABEL[a.kind]}</span>
                    <span className="tabular">{money(a.amount)}</span>
                  </div>
                  <p className="text-xs text-muted">
                    {a.reason} · {a.by}, {shortDay(a.on)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

import { Link } from 'react-router'
import { Search, UserRoundPlus } from 'lucide-react'
import { DEPARTMENT_LABEL, DEPARTMENTS, EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUSES, type Department, type EmployeeStatus } from '@/domain/hr'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { ViewToggle } from '../../ui/ViewToggle'
import { EMPLOYEE_TONE } from '../shared/tones'
import { useFilters } from './useFilters'

type StatusFilter = EmployeeStatus | 'all'
const CHIPS: StatusFilter[] = ['all', ...EMPLOYEE_STATUSES]

export default function EmployeesPage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const data = useResource('hr.employees', () => hr.employees())
  const [layout, setLayout] = useLayout()
  const { values, set, clear, active } = useFilters(['status', 'department', 'villa', 'q'] as const)
  const status = (CHIPS.find((c) => c === values.status) ?? 'all') as StatusFilter

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const q = values.q.trim().toLowerCase()
  const rows = d.employees.filter(
    (e) =>
      (status === 'all' || e.status === status) &&
      (!values.department || e.department === values.department) &&
      (!values.villa || e.allocations.some((a) => a.villaId === values.villa)) &&
      (!q || [e.name, e.code, e.position, e.villaNames].some((v) => v.toLowerCase().includes(q))),
  )
  const active_ = d.employees.filter((e) => e.status !== 'inactive')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Everyone on the payroll, with the villas their cost is shared across. Rows open the employee record.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          {can('hr', 'create') && (
            <Link to="/hr/employees/new" className={buttonStyles({ variant: 'accent' })}>
              <UserRoundPlus aria-hidden className="size-4" /> New employee
            </Link>
          )}
        </div>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Active" value={active_.length} hint={`${d.employees.length - active_.length} left`} active={status === 'active'} onClick={() => set({ status: status === 'active' ? '' : 'active' })} />
        <StatTile label="On probation" value={active_.filter((e) => e.status === 'probation').length} active={status === 'probation'} onClick={() => set({ status: status === 'probation' ? '' : 'probation' })} />
        <StatTile label="Monthly basic" value={money(active_.reduce((s, e) => s + e.basicSalary, 0))} hint="Before allowances" to="/payroll" />
        <StatTile label="With open loans" value={active_.filter((e) => e.openLoan).length} to="/hr/loans?status=active" />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : EMPLOYEE_STATUS_LABEL[c], count: c === 'all' ? d.employees.length : d.employees.filter((e) => e.status === c).length }))}
          chip={status}
          onChip={(c) => set({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.employees.length} employees`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Name, code or position" aria-label="Search employees" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Department" value={values.department} options={[{ value: '', label: 'All departments' }, ...DEPARTMENTS.map((x) => ({ value: x, label: DEPARTMENT_LABEL[x] }))]} onChange={(e) => set({ department: e.target.value })} />
              <Select aria-label="Villa" value={values.villa} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => set({ villa: e.target.value })} />
            </>
          }
          active={active}
          onClear={clear}
        />
        {layout === 'cards' ? (
          rows.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No employee matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((e) => (
                <li key={e.id}>
                  <Link to={`/hr/employees/${e.id}`} className="flex h-full gap-3 rounded-panel border border-line bg-raised p-4 transition-colors hover:bg-control">
                    <Avatar name={e.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{e.name}</span>
                        <Tag tone={EMPLOYEE_TONE[e.status]}>{EMPLOYEE_STATUS_LABEL[e.status]}</Tag>
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {e.position} · {DEPARTMENT_LABEL[e.department as Department]}
                      </span>
                      <span className="mt-2 block truncate text-xs text-muted">{e.villaNames}</span>
                      <span className="mt-1 block text-sm tabular">{money(e.basicSalary)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ListTable
            label="Employees"
            rows={rows}
            rowKey={(e) => e.id}
            href={(e) => `/hr/employees/${e.id}`}
            exportName="employees"
            exportDate={clock.today()}
            empty={<EmptyState title="No employee matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />}
            columns={[
              { key: 'name', header: 'Employee', cell: (e) => e.name, value: (e) => e.name },
              { key: 'code', header: 'Code', cell: (e) => <span className="font-mono text-xs text-muted">{e.code}</span>, value: (e) => e.code, hide: 'xl' },
              { key: 'position', header: 'Position', cell: (e) => e.position, value: (e) => e.position },
              { key: 'dept', header: 'Department', cell: (e) => DEPARTMENT_LABEL[e.department as Department], value: (e) => DEPARTMENT_LABEL[e.department as Department], hide: 'lg' },
              { key: 'villas', header: 'Villas', cell: (e) => <span className="line-clamp-1">{e.villaNames}</span>, value: (e) => e.villaNames, hide: 'lg' },
              { key: 'joined', header: 'Joined', cell: (e) => shortDay(e.joinedOn), value: (e) => e.joinedOn, hide: 'xl' },
              { key: 'leave', header: 'Leave left', align: 'right', cell: (e) => plural(e.leaveLeft, 'day'), value: (e) => e.leaveLeft, hide: 'xl' },
              { key: 'status', header: 'Status', cell: (e) => <StatusPill tone={EMPLOYEE_TONE[e.status]}>{EMPLOYEE_STATUS_LABEL[e.status]}</StatusPill>, value: (e) => EMPLOYEE_STATUS_LABEL[e.status] },
              { key: 'basic', header: 'Basic salary', align: 'right', cell: (e) => <span className="tabular">{money(e.basicSalary)}</span>, value: (e) => e.basicSalary, total: (sum) => money(sum) },
            ]}
            card={(e) => (
              <div className="flex items-center gap-3">
                <Avatar name={e.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{e.name}</p>
                  <p className="truncate text-xs text-muted">
                    {e.position} · {e.villaNames}
                  </p>
                </div>
                <StatusPill tone={EMPLOYEE_TONE[e.status]}>{EMPLOYEE_STATUS_LABEL[e.status]}</StatusPill>
              </div>
            )}
          />
        )}
      </Card>
    </div>
  )
}

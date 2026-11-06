import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { Scale, Wallet } from 'lucide-react'
import type { ShiftView } from '@/application/cashier'
import { SHIFT_STATUS_LABEL, SHIFT_STATUSES, type ShiftStatus } from '@/domain/cashier'
import { shortDay, withinRange } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { ListTable, type Column } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { ShiftStatusPill } from './DrawerCount'
import { differenceText } from './shiftText'
import { OpenShiftForm } from './ShiftForms'

type StatusFilter = ShiftStatus | 'all'

const COLUMNS: readonly Column<ShiftView>[] = [
  { key: 'number', header: 'Shift', cell: (s) => <span className="font-mono text-xs">{s.number}</span>, value: (s) => s.number },
  { key: 'date', header: 'Business date', cell: (s) => shortDay(s.businessDate), value: (s) => s.businessDate },
  { key: 'cashbox', header: 'Cashbox', cell: (s) => s.accountName, value: (s) => s.accountName },
  { key: 'cashier', header: 'Cashier', cell: (s) => s.cashierName, value: (s) => s.cashierName },
  { key: 'status', header: 'Status', cell: (s) => <ShiftStatusPill status={s.status} />, value: (s) => SHIFT_STATUS_LABEL[s.status] },
  { key: 'float', header: 'Float', cell: (s) => money(s.float), value: (s) => s.float, align: 'right', hide: 'xl' },
  { key: 'expected', header: 'Expected', cell: (s) => money(s.expected ?? s.totals.expected), value: (s) => s.expected ?? s.totals.expected, align: 'right', hide: 'lg' },
  { key: 'counted', header: 'Counted', cell: (s) => (s.counted === null ? '' : money(s.counted)), value: (s) => s.counted, align: 'right', hide: 'lg' },
  { key: 'difference', header: 'Over or short', cell: (s) => <span className={s.difference ? 'font-semibold text-danger' : 'text-muted'}>{differenceText(s.difference)}</span>, value: (s) => s.difference, align: 'right', total: (sum) => money(sum) },
]

/** The tolerance a drawer may be off before a manager signs the difference. */
function ToleranceCard({ tolerance, editable, onSaved }: { tolerance: number; editable: boolean; onSaved: () => void }) {
  const { cashier } = useServices()
  const toast = useToast()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(undefined)
    try {
      const next = await cashier.savePolicy({ tolerance: Number(new FormData(e.currentTarget).get('tolerance')) })
      toast({ title: `Shift tolerance set to ${money(next.tolerance)}` })
      onSaved()
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0])
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby="shift-tolerance">
      <CardHeader id="shift-tolerance" title="Drawer tolerance" icon={<Scale aria-hidden className="size-5 text-muted" />} />
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
        <Field label="Over or short up to, Rp" htmlFor="tolerance" error={error} hint="A larger difference needs a reason and a manager’s sign-off before it posts." className="min-w-0 flex-1">
          <Input id="tolerance" name="tolerance" type="number" inputMode="numeric" min={0} step={1000} defaultValue={tolerance} disabled={!editable} className="tabular" />
        </Field>
        {editable && (
          <Button type="submit" variant="solid" loading={saving}>
            Save
          </Button>
        )}
      </form>
    </Card>
  )
}

/** Front desk cashier shifts: open and closed drawers with their counts, and a shift to open. */
export default function ShiftsPage() {
  const { cashier, clock } = useServices()
  const { can } = useAccess()
  const data = useResource('cashier.list', () => cashier.list())
  const desk = useResource('cashier.desk', () => (can('payments', 'create') ? cashier.desk() : Promise.resolve(null)))
  const [params, setParams] = useSearchParams()
  const status = ((SHIFT_STATUSES as readonly string[]).includes(params.get('status') ?? '') ? params.get('status') : 'all') as StatusFilter
  const accountId = params.get('cashbox') ?? ''
  const cashierName = params.get('cashier') ?? ''
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined

  function update(next: Partial<Record<'status' | 'cashbox' | 'cashier' | 'from' | 'to', string>>) {
    const merged = { status, cashbox: accountId, cashier: cashierName, from: from ?? '', to: to ?? '', ...next }
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(merged)) if (value && value !== 'all') search.set(key, value)
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const rows = d.shifts.filter((s) => (status === 'all' || s.status === status) && (!accountId || s.accountId === accountId) && (!cashierName || s.cashierName === cashierName) && withinRange(s.businessDate, from, to))
  const counted = rows.filter((s) => s.difference !== null)
  const reload = () => {
    data.reload()
    desk.reload()
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">Each cashier opens a shift on a counted float and closes it on a counted drawer. Desk cash, payments and refunds recorded while it is open land on the shift; a difference posts through the cash count.</p>
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 min-[1360px]:grid-cols-4">
        <StatTile label="Open now" value={d.shifts.filter((s) => s.status === 'open').length} hint="One per cashbox at most" active={status === 'open'} onClick={() => update({ status: status === 'open' ? 'all' : 'open' })} />
        <StatTile label="Awaiting sign-off" value={d.shifts.filter((s) => s.status === 'awaiting_signoff').length} hint={`Past ${money(d.policy.tolerance)} either way`} active={status === 'awaiting_signoff'} onClick={() => update({ status: status === 'awaiting_signoff' ? 'all' : 'awaiting_signoff' })} />
        <StatTile label="Over or short" value={money(counted.reduce((sum, s) => sum + (s.difference ?? 0), 0))} hint={`${counted.filter((s) => s.difference).length} of ${counted.length} counted drawers off`} />
        <StatTile label="Shifts listed" value={rows.length} hint="With the filters below" />
      </div>

      {desk.data && (
        <Card aria-labelledby="open-shift">
          <CardHeader id="open-shift" title="Open a shift" icon={<Wallet aria-hidden className="size-5 text-muted" />} />
          <OpenShiftForm desk={desk.data} onOpened={reload} />
        </Card>
      )}

      <Card className="p-0">
        <TableToolbar
          chips={(['all', ...SHIFT_STATUSES] as StatusFilter[]).map((f) => ({ value: f, label: f === 'all' ? 'All' : SHIFT_STATUS_LABEL[f], count: f === 'all' ? d.shifts.length : d.shifts.filter((s) => s.status === f).length }))}
          chip={status}
          onChip={(f) => update({ status: f })}
          summary={`${rows.length} of ${d.shifts.length} shifts`}
          filters={
            <>
              <Select aria-label="Cashbox" value={accountId} options={[{ value: '', label: 'All cashboxes' }, ...d.cashboxes.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => update({ cashbox: e.target.value })} />
              <Select aria-label="Cashier" value={cashierName} options={[{ value: '', label: 'All cashiers' }, ...d.cashiers.map((c) => ({ value: c, label: c }))]} onChange={(e) => update({ cashier: e.target.value })} />
            </>
          }
          date={<DateRangeFilter today={clock.today()} label="Business date" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={status !== 'all' || !!accountId || !!cashierName || !!from || !!to}
          onClear={() => setParams({}, { replace: true })}
        />
        <ListTable
          label="Cashier shifts"
          rows={rows}
          columns={COLUMNS}
          rowKey={(s) => s.id}
          href={(s) => `/finance/shifts/${s.id}`}
          exportName="cashier-shifts"
          exportDate={clock.today()}
          card={(s) => (
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {s.number} · {s.accountName}
                </span>
                <span className="block truncate text-xs text-muted">
                  {shortDay(s.businessDate)} · {s.cashierName} · {differenceText(s.difference)}
                </span>
              </span>
              <ShiftStatusPill status={s.status} />
            </div>
          )}
          empty={<EmptyState title="No shift matches">Nothing fits these filters.</EmptyState>}
        />
      </Card>

      <ToleranceCard tolerance={d.policy.tolerance} editable={d.canEditPolicy} onSaved={data.reload} />
    </div>
  )
}

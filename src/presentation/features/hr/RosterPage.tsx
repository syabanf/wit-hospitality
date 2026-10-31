import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { DEPARTMENT_LABEL, DEPARTMENTS, type ShiftAssignment } from '@/domain/hr'
import { cn } from '@/lib/cn'
import { addDays, shortDay, weekdayDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

const SHIFT_CLASS: Record<string, string> = { 'sh-morning': 'bg-pop-blue text-ink', 'sh-afternoon': 'bg-pop-blush text-ink', 'sh-night': 'bg-pop-ink text-white' }
const shiftClass = (id: string) => SHIFT_CLASS[id] ?? 'bg-pop-mist text-ink'

/** Two weeks of shifts per employee; HR clicks a cell to set the shift, the villa or a day off. */
export default function RosterPage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? clock.today()
  const villaId = params.get('villa') ?? ''
  const department = params.get('department') ?? ''
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const data = useResource(`hr.roster:${from}|${villaId}`, () => hr.roster(from, villaId || undefined))
  const [editing, setEditing] = useState<{ employeeId: string; date: string; current: ShiftAssignment | null } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  function go(next: { from?: string; villa?: string; department?: string; q?: string }) {
    const search = new URLSearchParams(params)
    const merged = { from, villa: villaId, department, q: params.get('q') ?? '', ...next }
    search.set('from', merged.from)
    for (const key of ['villa', 'department', 'q'] as const) {
      if (merged[key]) search.set(key, merged[key])
      else search.delete(key)
    }
    setParams(search, { replace: true })
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!editing) return
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await hr.assignShift({ employeeId: editing.employeeId, date: editing.date, shiftId: String(f.get('shift') ?? '') || null, villaId: String(f.get('villa') ?? '') })
      toast({ title: 'Roster saved', description: shortDay(editing.date) })
      setEditing(null)
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const employee = editing ? d.rows.find((r) => r.employee.id === editing.employeeId)?.employee : undefined
  const rows = d.rows.filter((r) => (!department || r.employee.department === department) && (!q || [r.employee.name, r.employee.position].some((v) => v.toLowerCase().includes(q))))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Who works which shift and where, two weeks from Monday {shortDay(d.start)}.{can('hr', 'edit') ? ' Click a cell to change it.' : ''}</p>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <Input tone="card" className="col-span-2 h-10 sm:w-44" icon={<Search className="size-4" />} placeholder="Name or position" aria-label="Search the roster" value={params.get('q') ?? ''} onChange={(e) => go({ q: e.target.value })} />
          <Select aria-label="Department" tone="card" className="w-full sm:w-auto" value={department} options={[{ value: '', label: 'All departments' }, ...DEPARTMENTS.map((x) => ({ value: x, label: DEPARTMENT_LABEL[x] }))]} onChange={(e) => go({ department: e.target.value })} />
          <Select aria-label="Villa" tone="card" className="w-full sm:w-auto" value={villaId} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => go({ villa: e.target.value })} />
          <div className="col-span-2 flex gap-2">
            <Button variant="card" size="icon" aria-label="Previous two weeks" onClick={() => go({ from: addDays(d.start, -14) })}>
              <ChevronLeft aria-hidden className="size-4" />
            </Button>
            <Button variant="card" className="flex-1 sm:flex-none" onClick={() => go({ from: d.today })}>
              Today
            </Button>
            <Button variant="card" size="icon" aria-label="Next two weeks" onClick={() => go({ from: addDays(d.start, 14) })}>
              <ChevronRight aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {d.shifts.map((s) => (
          <span key={s.id} className="flex items-center gap-1.5">
            <span className={cn('inline-block size-3 rounded-sm', shiftClass(s.id))} />
            {s.name} {s.start} to {s.end}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-sm bg-raised ring-1 ring-line-strong" /> Day off
        </span>
      </div>
      {editing && employee && (
        <Card as="div" aria-label="Edit roster cell">
          <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
            <p className="w-full text-sm font-semibold sm:w-auto">
              {employee.name}, {weekdayDay(editing.date)}
            </p>
            <Field label="Shift" htmlFor="r-shift" error={errors.shiftId}>
              <Select id="r-shift" name="shift" defaultValue={editing.current?.shiftId ?? ''} options={[{ value: '', label: 'Day off' }, ...d.shifts.map((s) => ({ value: s.id, label: `${s.name} ${s.start}` }))]} />
            </Field>
            <Field label="Villa" htmlFor="r-villa" error={errors.villaId ?? errors.form}>
              <Select id="r-villa" name="villa" defaultValue={editing.current?.villaId ?? employee.allocations[0]?.villaId ?? ''} options={d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))} />
            </Field>
            <Button type="submit" variant="accent" loading={saving}>
              Save
            </Button>
            <Button variant="soft" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </form>
        </Card>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm" aria-label="Shift roster">
          <thead>
            <tr className="text-left text-xs tracking-wide text-muted uppercase">
              <th scope="col" className="sticky left-0 bg-card py-2 pl-5 pr-3 font-medium">
                Employee
              </th>
              {d.days.map((day) => (
                <th key={day} scope="col" className={cn('px-1 py-2 text-center font-medium whitespace-nowrap', day === d.today && 'text-accent-text')}>
                  {weekdayDay(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.employee.id}>
                <th scope="row" className="sticky left-0 min-w-40 bg-card py-2 pl-5 pr-3 text-left font-medium">
                  <span className="block truncate">{row.employee.name}</span>
                  <span className="block truncate text-xs font-normal text-muted">{row.employee.position}</span>
                </th>
                {row.cells.map((cell, i) => {
                  const date = d.days[i] as string
                  const shift = cell?.shiftId ? d.shifts.find((s) => s.id === cell.shiftId) : null
                  const villa = cell ? d.catalog.villas.find((v) => v.id === cell.villaId)?.code : ''
                  const label = shift ? `${shift.name.slice(0, 1)} ${villa ?? ''}` : cell ? 'Off' : ''
                  return (
                    <td key={date} className="px-1 py-1 text-center">
                      <button
                        type="button"
                        disabled={!can('hr', 'edit')}
                        aria-label={`${row.employee.name}, ${weekdayDay(date)}: ${shift ? `${shift.name} at ${villa}` : cell ? 'day off' : 'not set'}`}
                        onClick={() => setEditing({ employeeId: row.employee.id, date, current: cell })}
                        className={cn('h-9 w-full min-w-11 rounded-lg text-xs font-medium transition-opacity enabled:cursor-pointer enabled:hover:opacity-80', shift ? shiftClass(shift.id) : cell ? 'bg-raised text-muted ring-1 ring-line-strong' : 'bg-transparent text-subtle', date === d.today && 'ring-2 ring-accent')}
                      >
                        {label}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-muted">{rows.length} of {d.rows.length} people on the roster from {shortDay(d.start)}.</p>
    </div>
  )
}

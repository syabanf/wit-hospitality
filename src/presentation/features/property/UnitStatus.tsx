import { useEffect, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { outOfService, UNIT_STATUS_LABEL, UNIT_STATUSES, type StatusChange, type Unit, type UnitStatus } from '@/domain/property'
import { shortDay } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { UNIT_STATUS_TONE } from '../shared/tones'

/** A modal that changes a unit's status: a reason for maintenance or inactive, and the day it should be back. */
export function UnitStatusDialog({ unit, today, onClose, onDone }: { unit: Unit; today: string; onClose: () => void; onDone: () => void }) {
  const { property } = useServices()
  const toast = useToast()
  const ref = useRef<HTMLDialogElement>(null)
  const [status, setStatus] = useState<UnitStatus>(unit.status === 'active' ? 'maintenance' : 'active')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const out = outOfService(status)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await property.setUnitStatus(unit.id, { status, statusReason: out ? String(f.get('reason') ?? '') : '', statusUntil: out ? String(f.get('until') ?? '') || null : null })
      toast({ title: `${unit.code} is now ${UNIT_STATUS_LABEL[status].toLowerCase()}` })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="status-title" onClose={onClose} className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-card p-5 text-fg shadow-float backdrop:bg-ink/50">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p id="status-title" className="text-lg font-semibold tracking-tight">
              Change the status of {unit.code}
            </p>
            <p className="text-xs text-muted">Now {UNIT_STATUS_LABEL[unit.status].toLowerCase()}{unit.statusReason ? `: ${unit.statusReason}` : ''}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => ref.current?.close()}>
            <X aria-hidden className="size-4" />
          </Button>
        </div>
        <Field label="New status" htmlFor="status-new" error={errors.status}>
          <Select id="status-new" className="w-full" value={status} onChange={(e) => setStatus(e.target.value as UnitStatus)} options={UNIT_STATUSES.map((s) => ({ value: s, label: UNIT_STATUS_LABEL[s] }))} />
        </Field>
        {out && (
          <>
            <Field label="Reason" htmlFor="status-reason" error={errors.statusReason} hint="Required; the board and the history show it">
              <Input id="status-reason" name="reason" defaultValue={unit.status === status ? unit.statusReason : ''} placeholder={status === 'maintenance' ? 'AC unit replaced, waiting on the part' : 'Closed for renovation'} />
            </Field>
            <Field label="Expected back" htmlFor="status-until" error={errors.statusUntil} hint="Optional; past this day the board shows it overdue">
              <Input id="status-until" name="until" type="date" min={today} defaultValue={unit.status === status ? (unit.statusUntil ?? '') : ''} />
            </Field>
          </>
        )}
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            Save status
          </Button>
          <Button variant="soft" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  )
}

/** Status changes newest first, with who made them. */
export function StatusHistory({ rows }: { rows: readonly StatusChange[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted">No status changes yet.</p>
  return (
    <ol className="divide-y divide-line">
      {rows.map((h) => (
        <li key={h.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={UNIT_STATUS_TONE[h.to]}>{UNIT_STATUS_LABEL[h.to]}</StatusPill>
            <span className="text-xs text-muted">{h.from ? `from ${UNIT_STATUS_LABEL[h.from].toLowerCase()}` : 'when the unit was added'}</span>
          </div>
          {h.reason && <p className="mt-1 text-sm">{h.reason}</p>}
          <p className="mt-0.5 text-xs text-muted">
            {shortDay(h.at.slice(0, 10))} {h.at.slice(11, 16)} · {h.by}
            {h.until && ` · back by ${shortDay(h.until)}`}
          </p>
        </li>
      ))}
    </ol>
  )
}

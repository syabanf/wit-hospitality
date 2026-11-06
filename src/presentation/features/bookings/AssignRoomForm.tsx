import { useState } from 'react'
import { BedDouble } from 'lucide-react'
import type { RestrictionOverrideInput } from '@/domain/restriction'
import type { Unit } from '@/domain/property'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { restrictionCleared, RestrictionNotice } from './RestrictionNotice'

/** Picks the room for a stay booked by type. A rule on the picked room shows here and needs a manager's reason. */
export function AssignRoomForm({ bookingId, units, assigned, busy, errors, onAssign }: { bookingId: string; units: readonly Unit[]; assigned: boolean; busy: boolean; errors: Record<string, string>; onAssign: (unitId: string, override: RestrictionOverrideInput | null) => void }) {
  const { stayRules } = useServices()
  const [unitId, setUnitId] = useState(units[0]?.id ?? '')
  const [reason, setReason] = useState('')
  const picked = units.some((u) => u.id === unitId) ? unitId : (units[0]?.id ?? '')
  const check = useResource(`stayRules.assignCheck:${bookingId}:${picked}`, () => (picked ? stayRules.assignCheck(bookingId, picked) : Promise.resolve(null)))
  const result = check.data ?? null
  const needsOverride = Boolean(result && result.violations.length > 0 && !result.channel)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onAssign(picked, needsOverride ? { reason } : null)
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Room" htmlFor="assign-unit" error={errors.unitId} className="min-w-48 flex-1">
          <Select id="assign-unit" name="unit" className="w-full" value={picked} onChange={(e) => setUnitId(e.target.value)} options={units.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))} />
        </Field>
        <Button type="submit" variant={assigned ? 'solid' : 'accent'} loading={busy} disabled={!restrictionCleared(result, reason)}>
          <BedDouble aria-hidden className="size-4" /> {assigned ? 'Change room' : 'Assign room'}
        </Button>
      </div>
      {result && <RestrictionNotice id="assign-override" violations={result.violations} channel={result.channel} mayOverride={result.mayOverride} reason={reason} onReason={setReason} error={errors.form} />}
    </form>
  )
}

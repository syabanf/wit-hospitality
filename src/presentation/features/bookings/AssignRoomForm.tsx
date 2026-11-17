import { useState } from 'react'
import { BedDouble, KeyRound } from 'lucide-react'
import { restrictionCleared, type RestrictionOverrideInput } from '@/domain/restriction'
import type { Unit } from '@/domain/property'
import { RACK_HK_LABEL } from '@/domain/rack'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { RestrictionNotice } from './RestrictionNotice'

/**
 * Picks the room for a stay booked by type: rooms housekeeping released first, then the rest with a
 * warning. A rule on the picked room shows here and needs a manager's reason. `checkInToo` offers
 * "Assign and check in" on the arrival day.
 */
export function AssignRoomForm({ bookingId, units, assigned, busy, errors, checkInToo = false, onAssign }: { bookingId: string; units: readonly Unit[]; assigned: boolean; busy: boolean; errors: Record<string, string>; checkInToo?: boolean; onAssign: (unitId: string, override: RestrictionOverrideInput | null, checkIn: boolean) => void }) {
  const { stayRules, desk } = useServices()
  const ranked = useResource(`desk.assignChoices:${bookingId}:${units.length}`, () => desk.assignChoices(bookingId))
  // The ranked list when it has loaded, else the free rooms as the page passed them.
  const choices = ranked.data?.filter((c) => units.some((u) => u.id === c.unit.id)) ?? units.map((unit) => ({ unit, state: null, warning: null }))
  const [unitId, setUnitId] = useState('')
  const [reason, setReason] = useState('')
  const picked = choices.some((c) => c.unit.id === unitId) ? unitId : (choices[0]?.unit.id ?? '')
  const warning = choices.find((c) => c.unit.id === picked)?.warning ?? null
  const check = useResource(`stayRules.assignCheck:${bookingId}:${picked}`, () => (picked ? stayRules.assignCheck(bookingId, picked) : Promise.resolve(null)))
  const result = check.data ?? null
  const needsOverride = Boolean(result && result.violations.length > 0 && !result.channel)
  const submit = (checkIn: boolean) => onAssign(picked, needsOverride ? { reason } : null, checkIn)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit(false)
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Room" htmlFor="assign-unit" error={errors.unitId} className="min-w-48 flex-1">
          <Select id="assign-unit" className="w-full" value={picked} onChange={(e) => setUnitId(e.target.value)} options={choices.map((c) => ({ value: c.unit.id, label: `${c.unit.code} · ${c.unit.name}${c.state ? ` · ${RACK_HK_LABEL[c.state]}` : ''}` }))} />
        </Field>
        <Button type="submit" variant={assigned || checkInToo ? 'card' : 'accent'} loading={busy} disabled={!restrictionCleared(result, reason)}>
          <BedDouble aria-hidden className="size-4" /> {assigned ? 'Change room' : 'Assign room'}
        </Button>
        {checkInToo && (
          <Button type="button" variant="accent" loading={busy} disabled={!restrictionCleared(result, reason)} onClick={() => submit(true)}>
            <KeyRound aria-hidden className="size-4" /> Assign and check in
          </Button>
        )}
      </div>
      {warning && <p className="rounded-panel bg-warning-soft px-3 py-2 text-sm text-warning">{warning}</p>}
      {result && <RestrictionNotice id="assign-override" violations={result.violations} channel={result.channel} mayOverride={result.mayOverride} reason={reason} onReason={setReason} error={errors.form} />}
    </form>
  )
}

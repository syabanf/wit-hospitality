import { useState } from 'react'
import type { GroupStayOverrides } from '@/application/ports'
import type { GroupStayInput } from '@/domain/group'
import type { Unit } from '@/domain/property'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { restrictionCleared, RestrictionNotice } from './RestrictionNotice'

/**
 * Adds a unit to a live group. The stay meets the stay restrictions as a new group does, and a
 * blacklisted lead needs a manager's reason again.
 */
export function GroupStayForm({ name, units, checkIn, checkOut, leadBlacklisted, busy, errors, onAdd }: { name: string; units: readonly Unit[]; checkIn: string; checkOut: string; leadBlacklisted: boolean; busy: boolean; errors: Record<string, string>; onAdd: (stay: GroupStayInput, overrides: GroupStayOverrides) => void }) {
  const { stayRules } = useServices()
  const [stay, setStay] = useState({ unitId: units[0]?.id ?? '', checkIn, checkOut, adults: 2, children: 0 })
  const [reason, setReason] = useState('')
  const [blacklistReason, setBlacklistReason] = useState('')
  const key = stay.unitId && stay.checkIn && stay.checkOut ? `${stay.unitId}:${stay.checkIn}:${stay.checkOut}` : ''
  const check = useResource(`stayRules.check:group:${key}`, () => (key ? stayRules.check({ unitId: stay.unitId, groupId: null, checkIn: stay.checkIn, checkOut: stay.checkOut, source: 'direct' }) : Promise.resolve(null)))
  const result = check.data ?? null
  const needsOverride = Boolean(result && result.violations.length > 0)
  const set = (patch: Partial<typeof stay>) => setStay({ ...stay, ...patch })

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        onAdd({ ...stay, roomTypeId: null, price: null }, { override: needsOverride ? { reason } : null, blacklistOverride: leadBlacklisted ? blacklistReason : undefined })
      }}
    >
      <p className="text-sm font-semibold">Add a unit to {name}</p>
      <Field label="Unit" htmlFor="add-unit" error={errors.unitId}>
        <Select id="add-unit" className="w-full" value={stay.unitId} onChange={(e) => set({ unitId: e.target.value })} options={units.map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Check-in" htmlFor="add-in">
          <Input id="add-in" type="date" value={stay.checkIn} onChange={(e) => set({ checkIn: e.target.value })} />
        </Field>
        <Field label="Check-out" htmlFor="add-out" error={errors.checkOut}>
          <Input id="add-out" type="date" value={stay.checkOut} onChange={(e) => set({ checkOut: e.target.value })} />
        </Field>
        <Field label="Adults" htmlFor="add-adults" error={errors.adults}>
          <Input id="add-adults" type="number" min={1} value={stay.adults} onChange={(e) => set({ adults: Number(e.target.value) })} />
        </Field>
        <Field label="Children" htmlFor="add-children">
          <Input id="add-children" type="number" min={0} value={stay.children} onChange={(e) => set({ children: Number(e.target.value) || 0 })} />
        </Field>
      </div>
      {result && <RestrictionNotice id="add-override" violations={result.violations} channel={false} mayOverride={result.mayOverride} reason={reason} onReason={setReason} />}
      {leadBlacklisted && (
        <Field label="Book the blacklisted lead because" htmlFor="add-blacklist" hint="Only a villa manager may; the reason goes on the audit trail">
          <Input id="add-blacklist" value={blacklistReason} onChange={(e) => setBlacklistReason(e.target.value)} placeholder="Why the operator takes this guest again" />
        </Field>
      )}
      {errors.form && <p className="text-xs text-danger">{errors.form}</p>}
      <Button type="submit" variant="solid" size="sm" loading={busy} disabled={!restrictionCleared(result, reason)}>
        Add stay
      </Button>
    </form>
  )
}

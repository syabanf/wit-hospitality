import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { TriangleAlert } from 'lucide-react'
import { WALK_DESTINATION_LABEL, WALK_METHOD_LABEL, type WalkDestination, type WalkMethod } from '@/domain/overbooking'
import { RESTRICTION_RULE_LABEL } from '@/domain/restriction'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'

/**
 * The stay rules side of a booking: the restrictions it was sold past or came in against, the walk
 * when the guest was walked, and the walk form on an overbooked arrival day.
 */
export function StayRulesCard({ bookingId, version, onChange }: { bookingId: string; /** Changes with the stay, so the card reloads after an edit elsewhere on the page. */ version: string; onChange: () => void }) {
  const { stayRules } = useServices()
  const toast = useToast()
  const data = useResource(`stayRules.forBooking:${bookingId}:${version}`, () => stayRules.forBooking(bookingId))
  const [open, setOpen] = useState(false)
  const [destination, setDestination] = useState<WalkDestination>('group_villa')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const { walk } = await stayRules.walk(bookingId, {
        destination,
        unitId: destination === 'group_villa' ? String(f.get('unit') || '') || null : null,
        property: String(f.get('property') ?? ''),
        cost: Number(f.get('cost') || 0),
        method: String(f.get('method')) as WalkMethod,
        compensation: String(f.get('compensation') ?? ''),
        reason: String(f.get('reason') ?? ''),
      })
      toast({ title: `Walked the guest, ${walk.number}`, description: walk.cost ? `${money(walk.cost)} went for approval as a Guest relocation cash-out` : undefined })
      setOpen(false)
      data.reload()
      onChange()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  const d = data.data
  if (!d || (!d.note && !d.walk && !d.walkable)) return null
  return (
    <Card aria-labelledby="rules-title" className={d.walkable && !d.walk ? 'ring-2 ring-warning' : undefined}>
      <CardHeader
        id="rules-title"
        title={d.walkable ? 'Overbooked tonight' : 'Stay rules'}
        action={
          d.walkable &&
          !open && (
            <Button size="sm" variant="accent" onClick={() => setOpen(true)}>
              Walk guest
            </Button>
          )
        }
      />
      {d.note && (
        <div className="flex gap-3 rounded-panel bg-warning-soft p-3.5 text-sm text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {d.note.kind === 'override' ? `Sold past stay restrictions by ${d.note.by}` : 'Sold by the channel against stay restrictions'}
              {d.note.rules.map((r) => (
                <Tag key={r} tone="warning">
                  {RESTRICTION_RULE_LABEL[r]}
                </Tag>
              ))}
            </p>
            {d.note.messages.map((m) => (
              <p key={m}>{m}</p>
            ))}
            {d.note.reason && <p>Reason: {d.note.reason}</p>}
          </div>
        </div>
      )}
      {d.walk && (
        <p className="mt-3 rounded-panel bg-raised p-3.5 text-sm">
          {[`${d.walk.number} on ${shortDay(d.walk.date)} by ${d.walk.by}: walked to ${d.walk.destination === 'outside' ? d.walk.property : WALK_DESTINATION_LABEL[d.walk.destination].toLowerCase()}`, d.walk.reason, d.walk.compensation && `Compensation: ${d.walk.compensation}`, d.walk.cost > 0 && `Cost ${money(d.walk.cost)}`].filter(Boolean).join('. ')}.
          {d.walk.transactionId && (
            <Link to={`/finance/transactions/${d.walk.transactionId}`} className="ml-1 font-medium hover:underline">
              Open the relocation cash-out
            </Link>
          )}
        </p>
      )}
      {d.walkable && !open && !d.walk && <p className="text-sm text-muted">The room type holds {d.over} more stays than rooms tonight. Assign a freed room, or walk this guest to another villa or an outside property.</p>}
      {open && (
        <form onSubmit={(e) => void submit(e)} className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Walk to" className="sm:col-span-2">
            <Tabs label="Walk to" options={[{ value: 'group_villa', label: WALK_DESTINATION_LABEL.group_villa }, { value: 'outside', label: WALK_DESTINATION_LABEL.outside }]} value={destination} onChange={setDestination} />
          </Field>
          {destination === 'group_villa' ? (
            <Field label="Unit" htmlFor="walk-unit" error={errors.unitId} hint={d.targets.length ? 'Free for the whole stay; the guest keeps the price' : 'No other unit is free for the stay'} className="sm:col-span-2">
              <Select id="walk-unit" name="unit" className="w-full" options={[{ value: '', label: 'Pick a unit' }, ...d.targets.map((t) => ({ value: t.unit.id, label: `${t.unit.code} ${t.unit.name}, ${t.villaName}` }))]} />
            </Field>
          ) : (
            <Field label="Property" htmlFor="walk-property" error={errors.property} hint="The stay is cancelled and everything paid goes back to the guest" className="sm:col-span-2">
              <Input id="walk-property" name="property" placeholder="Hotel and its address" />
            </Field>
          )}
          <Field label="Cost to us, Rp" htmlFor="walk-cost" error={errors.cost} hint="Goes for approval as Guest relocation">
            <Input id="walk-cost" name="cost" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={0} className="tabular" />
          </Field>
          <Field label="Paid by" htmlFor="walk-method">
            <Select id="walk-method" name="method" className="w-full" options={(['cash', 'bank_transfer'] as const).map((m) => ({ value: m, label: WALK_METHOD_LABEL[m] }))} />
          </Field>
          <Field label="Compensation" htmlFor="walk-comp" hint="What the guest gets: a transfer, a dinner, a night back">
            <Input id="walk-comp" name="compensation" />
          </Field>
          <Field label="Reason" htmlFor="walk-reason" error={errors.reason}>
            <Input id="walk-reason" name="reason" defaultValue="Room type overbooked tonight" />
          </Field>
          {errors.form && (
            <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">
              {errors.form}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" variant="accent" loading={saving}>
              Walk guest
            </Button>
            <Button variant="soft" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

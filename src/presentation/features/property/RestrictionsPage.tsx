import { useState } from 'react'
import { Link } from 'react-router'
import { CalendarRange } from 'lucide-react'
import { MAX_OVERBOOK } from '@/domain/overbooking'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { RestrictionForm, RestrictionRows } from './RestrictionForm'
import { EMPTY_RESTRICTION } from './restrictionDraft'

/** Every stay restriction across the room types, the bulk editor, and the overbooking policy per room type. */
export default function RestrictionsPage() {
  const { stayRules } = useServices()
  const toast = useToast()
  const data = useResource('stayRules.overview', () => stayRules.overview())
  const [bulk, setBulk] = useState(false)
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [limits, setLimits] = useState<Record<string, number>>({})

  async function attempt(title: string, run: () => Promise<unknown>) {
    try {
      await run()
      toast({ title })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', description: error instanceof Error ? error.message : undefined })
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data

  return (
    <>
      <PageBar
        fallback="/property"
        label="Property"
        actions={
          d.mayEdit && (
            <Button variant="accent" aria-pressed={bulk} onClick={() => setBulk((v) => !v)}>
              <CalendarRange aria-hidden className="size-4" /> Bulk edit
            </Button>
          )
        }
      />
      <div className="space-y-4">
        <p className="max-w-2xl text-sm text-muted">New direct stays, changes of dates and group stays that break a restriction are refused; a villa manager can sell past them with a reason. Airbnb stays come in with a warning. Stays already booked keep their dates.</p>
        {bulk && (
          <RestrictionForm
            title="Add one rule to several room types"
            initial={EMPTY_RESTRICTION}
            submitLabel="Add to the room types"
            save={(draft) => stayRules.bulk({ ...draft, groupIds })}
            onDone={() => {
              toast({ title: `Added the rule to ${groupIds.length} room types` })
              setBulk(false)
              setGroupIds([])
              data.reload()
            }}
            onCancel={() => setBulk(false)}
          >
            {(errors) => (
              <Field label="Room types" error={errors.groupIds}>
                <CheckboxGrid name="bulk-types" options={d.groups.map((g) => ({ id: g.group.id, label: `${g.group.name}, ${g.villaName}` }))} selected={groupIds} onChange={setGroupIds} />
              </Field>
            )}
          </RestrictionForm>
        )}

        <Card aria-labelledby="rst-all">
          <CardHeader id="rst-all" title="Stay restrictions" action={<span className="text-xs text-muted">{d.restrictions.length} rules</span>} />
          <RestrictionRows rows={d.restrictions} showType onRemove={d.mayEdit ? (r) => void attempt(`Removed ${r.label} on ${r.groupName}`, () => stayRules.remove(r.id)) : undefined} />
        </Card>

        <Card aria-labelledby="ob-title">
          <CardHeader id="ob-title" title="Overbooking policy" />
          <p className="mb-4 max-w-2xl text-sm text-muted">A room type sold by type may take this many stays a night past its rooms. When a night is still overbooked on the arrival day, walk a guest from the booking page. Rooms sold one by one never overbook.</p>
          <ul className="divide-y divide-line">
            {d.groups.map(({ group, villaName, sellsByType, overbook }) => (
              <li key={group.id} className="flex flex-wrap items-center gap-3 py-3 text-sm first:pt-0 last:pb-0">
                <Link to={`/property/room-types/${group.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="font-medium">{group.name}</span> <span className="text-muted">· {villaName}</span>
                </Link>
                {!sellsByType ? (
                  <Tag tone="neutral">Room by room</Tag>
                ) : d.mayEdit ? (
                  <div className="flex items-end gap-2">
                    <Field label="Past the rooms, a night" htmlFor={`ob-${group.id}`}>
                      <Input id={`ob-${group.id}`} type="number" inputMode="numeric" min={0} max={MAX_OVERBOOK} value={limits[group.id] ?? overbook} onChange={(e) => setLimits({ ...limits, [group.id]: Number(e.target.value) })} className="w-24 tabular" />
                    </Field>
                    <Button size="sm" variant="soft" disabled={(limits[group.id] ?? overbook) === overbook} onClick={() => void attempt(`${group.name} sells ${limits[group.id] ?? overbook} past its rooms`, () => stayRules.setOverbooking(group.id, limits[group.id] ?? overbook))}>
                      Save
                    </Button>
                  </div>
                ) : (
                  <Tag tone={overbook ? 'warning' : 'neutral'}>{overbook ? `${overbook} past the rooms` : 'No overbooking'}</Tag>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  )
}

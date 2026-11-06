import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import { PRICE_LIST_LABEL, SEASON_KIND_LABEL } from '@/domain/ratePlan'
import { cn } from '@/lib/cn'
import { weekdayDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { EmptyState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { RatePlanForm } from './RatePlanForm'

/** A room type with its rooms and the rate plan that prices the ones without a live Airbnb listing. */
export default function RoomTypePage() {
  const { id = '' } = useParams()
  const { property } = useServices()
  const toast = useToast()
  const resource = useResource(`property.roomType:${id}`, () => property.roomType(id), { keepPrevious: false })
  const [editing, setEditing] = useState(false)

  return (
    <Gate resource={resource} what="room type" back={{ to: '/property', label: 'Back to property' }}>
      {(d) => {
        const fallback = d.units.filter((u) => u.priceList === 'plan')
        const startEdit = (
          <Button variant="accent" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
            {d.plan ? <Pencil aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />} {d.plan ? 'Edit rate plan' : 'Add rate plan'}
          </Button>
        )
        return (
          <>
            <PageBar fallback={`/property/villas/${d.villa.id}`} label={d.villa.name} actions={d.mayEdit ? startEdit : undefined} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                <Card aria-label={d.group.name}>
                  <p className="text-xs text-muted">Room type</p>
                  <Headline className="mt-1">{d.group.name}</Headline>
                  <p className="mt-1 text-sm text-muted">
                    <Link to={`/property/villas/${d.villa.id}`} className="hover:underline">
                      {d.villa.name}
                    </Link>
                  </p>
                  <p className="mt-4 max-w-2xl text-sm text-body">
                    A room with a live Airbnb listing sells direct stays at the listing price. The others sell at this rate plan; stays already booked keep their price.
                  </p>
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Rooms', plural(d.units.length, 'room')],
                      ['On the rate plan', fallback.length ? fallback.map((u) => u.unit.code).join(', ') : 'None'],
                      ['Sold as', d.group.operatorAssigns ? 'Room type' : 'Room by room'],
                    ]}
                  />
                </Card>

                {editing && (
                  <RatePlanForm
                    name={d.group.name}
                    initial={d.plan}
                    save={(input) => property.saveRatePlan(d.group.id, input)}
                    onDone={() => {
                      toast({ title: `Saved the rate plan for ${d.group.name}`, description: 'New direct stays sell at it; booked stays keep their price.' })
                      setEditing(false)
                      resource.reload()
                    }}
                    onCancel={() => setEditing(false)}
                  />
                )}

                <Card aria-labelledby="plan-title">
                  <CardHeader id="plan-title" title="Rate plan" />
                  {!d.plan ? (
                    <EmptyState title="No rate plan">Rooms of this type without a live Airbnb listing cannot be sold direct until it has one.</EmptyState>
                  ) : (
                    <div className="space-y-4">
                      <FactGrid
                        className="grid-cols-2"
                        facts={[
                          ['Weekday, Sunday to Thursday', money(d.plan.weekdayRate)],
                          ['Weekend, Friday and Saturday', money(d.plan.weekendRate)],
                        ]}
                      />
                      {d.plan.seasons.length === 0 ? (
                        <p className="text-sm text-muted">No seasons. Every night sells at the weekday or weekend rate.</p>
                      ) : (
                        <ul className="divide-y divide-line text-sm" aria-label="Seasons">
                          {d.plan.seasons.map((s, i) => (
                            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                              <span className="min-w-0 flex-1 font-medium">{s.name}</span>
                              <span className="font-mono text-xs text-muted">
                                {s.from} to {s.to}
                              </span>
                              <Tag tone="neutral">{SEASON_KIND_LABEL[s.kind]}</Tag>
                              <span className="w-32 text-right tabular">{s.kind === 'fixed' ? money(s.value) : `+${s.value}%`}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </Card>

                {d.nights.length > 0 && (
                  <Card aria-labelledby="plan-nights">
                    <CardHeader id="plan-nights" title="Next 14 nights on the plan" />
                    <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-7">
                      {d.nights.map((n) => (
                        <li key={n.date} className={cn('rounded-xl p-2 text-xs', n.name === 'Weekday' ? 'bg-raised' : 'bg-info-soft text-info-text')}>
                          <p className="font-medium">{weekdayDay(n.date)}</p>
                          <p className="tabular">{money(n.rate)}</p>
                          <p className="truncate opacity-70">{n.name}</p>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>

              <div className="space-y-4">
                <Card aria-labelledby="rt-rooms">
                  <CardHeader id="rt-rooms" title="Rooms and their price list" />
                  <ul className="divide-y divide-line">
                    {d.units.map(({ unit, priceList }) => (
                      <li key={unit.id}>
                        <Link to={`/property/units/${unit.id}`} className="flex items-center gap-3 py-3 text-sm hover:underline">
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-mono font-medium">{unit.code}</span> {unit.name}
                          </span>
                          <Tag tone={priceList === 'listing' ? 'info' : priceList ? 'neutral' : 'danger'}>{PRICE_LIST_LABEL[priceList ?? 'none']}</Tag>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

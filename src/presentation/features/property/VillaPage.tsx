import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import { facilityLabel, type UnitGroup } from '@/domain/property'
import { buildCatalog } from '@/domain/property'
import { money, percent, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'

import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { EmptyState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { BookingRows } from '../shared/BookingRows'
import { GroupForm, UnitForm, VillaForm } from './forms'
import { UnitTable } from './UnitTable'

export default function VillaPage() {
  const { id = '' } = useParams()
  const { property } = useServices()
  const toast = useToast()
  const resource = useResource(`property.villa:${id}`, () => property.villa(id), { keepPrevious: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState<'villa' | 'group' | 'unit' | null>(null)
  const [editGroup, setEditGroup] = useState<UnitGroup | null>(null)

  function done(title: string) {
    toast({ title })
    setForm(null)
    resource.reload()
  }

  async function toggleGroup(groupId: string, name: string, on: boolean) {
    setBusy(groupId)
    try {
      await property.setGroupInterchangeable(groupId, on)
      toast({ title: on ? `${name} units are now interchangeable` : `${name} units are now fixed`, description: on ? 'Bookings may move between them.' : 'Bookings stay on the unit the guest chose.' })
      resource.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not change the group', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="villa" back={{ to: '/property', label: 'Back to property' }}>
      {(d) => (
        <>
          <PageBar
            fallback="/property"
            label="Property"
            actions={
              <>
                <Button variant="card" aria-pressed={form === 'villa'} onClick={() => setForm(form === 'villa' ? null : 'villa')}>
                  <Pencil aria-hidden className="size-4" /> Edit villa
                </Button>
                <Button variant="card" aria-pressed={form === 'group'} onClick={() => setForm(form === 'group' ? null : 'group')}>
                  <Plus aria-hidden className="size-4" /> Group
                </Button>
                <Button variant="accent" aria-pressed={form === 'unit'} onClick={() => setForm(form === 'unit' ? null : 'unit')}>
                  <Plus aria-hidden className="size-4" /> Unit
                </Button>
              </>
            }
          />
          {form === 'villa' && (
            <div className="mb-4">
              <VillaForm initial={d.villa} catalog={buildCatalog(d.locations, [d.villa], [], [])} save={(input) => property.updateVilla(d.villa.id, input)} onDone={() => done(`Saved ${d.villa.name}`)} onCancel={() => setForm(null)} />
            </div>
          )}
          {form === 'group' && (
            <div className="mb-4">
              <GroupForm villaId={d.villa.id} save={(input) => property.createGroup(input)} onDone={() => done('Added the group')} onCancel={() => setForm(null)} />
            </div>
          )}
          {form === 'unit' && (
            <div className="mb-4">
              <UnitForm villa={d.villa} groups={d.groups.map((g) => g.group)} save={(input) => property.createUnit(input)} onDone={() => done('Added the unit')} onCancel={() => setForm(null)} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <Card aria-label={d.villa.name}>
                <p className="font-mono text-xs text-muted">{d.villa.code}</p>
                <Headline className="mt-1">{d.villa.name}</Headline>
                <p className="mt-1 text-sm text-muted">
                  {d.location.name}, {d.location.area}
                </p>
                <p className="mt-4 max-w-2xl text-sm text-body">{d.villa.description}</p>
                {d.villa.facilities.length > 0 && (
                  <ul className="mt-4 flex flex-wrap gap-2" aria-label="Facilities">
                    {d.villa.facilities.map((f) => (
                      <li key={f} className="rounded-full border border-line-strong bg-raised px-3 py-1 text-xs font-medium">
                        {facilityLabel(f)}
                      </li>
                    ))}
                  </ul>
                )}
                <FactGrid
                  className="mt-6 grid-cols-2 sm:grid-cols-4"
                  facts={[
                    ['Units', plural(d.units.length, 'unit')],
                    ['In house', plural(d.inHouse.length, 'guest')],
                    ['Occupancy, 30 days', percent(d.occupancy30, { digits: 0 })],
                    ['Revenue, 30 days', money(d.revenue30)],
                  ]}
                />
              </Card>

              <Card aria-labelledby="groups-title">
                <CardHeader id="groups-title" title="Unit groups" />
                {editGroup && (
                  <div className="mb-4">
                    <GroupForm initial={editGroup} villaId={d.villa.id} save={(input) => property.updateGroup(editGroup.id, input)} onDone={() => { setEditGroup(null); done(`Saved ${editGroup.name}`) }} onCancel={() => setEditGroup(null)} />
                  </div>
                )}
                {d.groups.length === 0 ? (
                  <EmptyState title="No groups">Every unit in this villa is booked on its own.</EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {d.groups.map(({ group, units }) => (
                      <li key={group.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{group.name}</p>
                          <p className="truncate text-xs text-muted">{units.map((u) => u.code).join(' · ')}</p>
                        </div>
                        <span className="hidden text-xs text-muted sm:block">{group.interchangeable ? 'Bookings may move between these units' : 'Bookings stay on their unit'}</span>
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${group.name}`} onClick={() => setEditGroup(editGroup?.id === group.id ? null : group)}>
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                        <Switch label={`${group.name} interchangeable`} checked={group.interchangeable} disabled={busy === group.id} onChange={(on) => void toggleGroup(group.id, group.name, on)} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="p-0" aria-labelledby="units-title">
                <div className="p-5 pb-0">
                  <CardHeader id="units-title" title="Units" />
                </div>
                <UnitTable label="Units" rows={d.units} />
              </Card>
            </div>

            <div className="space-y-4">
              <Card aria-labelledby="villa-upcoming">
                <CardHeader id="villa-upcoming" title="Upcoming arrivals" />
                <BookingRows bookings={d.upcoming} empty="No confirmed arrivals." />
                <Link to={`/calendar?villa=${d.villa.id}`} className="mt-4 flex items-center justify-between rounded-panel bg-raised px-4 py-3 text-sm transition-colors hover:bg-control">
                  Open the calendar for {d.villa.name}
                  <span aria-hidden>→</span>
                </Link>
              </Card>
            </div>
          </div>
        </>
      )}
    </Gate>
  )
}

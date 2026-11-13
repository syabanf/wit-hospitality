import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ExternalLink, Pencil, Plus } from 'lucide-react'
import { buildCatalog, CANCELLATION_LABEL, CANCELLATION_TEXT, DEPOSIT_LABEL, facilityLabel, mapLink, type UnitGroup, type Villa } from '@/domain/property'
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
import { useToast, type ToastInput } from '../../ui/useToast'
import { BookingRows } from '../shared/BookingRows'
import { GroupForm, UnitForm, VillaForm } from './forms'
import { useUnitToast } from './unitToast'
import { UnitTable } from './UnitTable'
import { PhotoGallery } from './PhotoGallery'
import { VillaStockCard } from '../stock/VillaStockCard'

export default function VillaPage() {
  const { id = '' } = useParams()
  const { property } = useServices()
  const toast = useToast()
  const resource = useResource(`property.villa:${id}`, () => property.villa(id), { keepPrevious: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState<'villa' | 'group' | 'unit' | null>(null)
  const [editGroup, setEditGroup] = useState<UnitGroup | null>(null)
  const unitToast = useUnitToast()

  function done(note: string | ToastInput) {
    toast(typeof note === 'string' ? { title: note } : note)
    setForm(null)
    resource.reload()
  }

  async function toggleGroup(groupId: string, name: string, on: boolean, setting: 'interchangeable' | 'roomType') {
    setBusy(groupId)
    try {
      if (setting === 'interchangeable') {
        await property.setGroupInterchangeable(groupId, on)
        toast({ title: on ? `${name} units are now interchangeable` : `${name} units are now fixed`, description: on ? 'Bookings may move between them.' : 'Bookings stay on the unit the guest chose.' })
      } else {
        await property.setGroupRoomType(groupId, on)
        toast({ title: on ? `${name} now sells as a room type` : `${name} now sells room by room`, description: on ? 'Guests book the type; you assign the room before check-in.' : 'Each booking names its room.' })
      }
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
              <GroupForm villaId={d.villa.id} save={(input) => property.createGroup(input)} onDone={() => done({ title: 'Added the group', description: 'The first unit you add to it starts its rate plan from the base price.' })} onCancel={() => setForm(null)} />
            </div>
          )}
          {form === 'unit' && (
            <div className="mb-4">
              <UnitForm villa={d.villa} groups={d.groups.map((g) => g.group)} save={(input) => property.createUnit(input)} onDone={(saved) => done(unitToast('Added the unit', saved))} onCancel={() => setForm(null)} />
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

              <PhotoGallery id="villa-photos" title="Photos" photos={d.photos} empty="No photos yet. The website shows stand-in pictures until you add some." onSave={(photos) => property.setVillaPhotos(d.villa.id, photos).then(resource.reload)} />

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
                      <li key={group.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1 basis-48">
                          <Link to={`/property/room-types/${group.id}`} className="font-medium hover:underline">
                            {group.name}
                          </Link>
                          <p className="truncate text-xs text-muted">{units.map((u) => u.code).join(' · ')}</p>
                        </div>
                        <span className="hidden text-xs text-muted sm:block">{group.operatorAssigns ? 'Guests book the type; you assign the room' : group.interchangeable ? 'Bookings may move between these units' : 'Bookings stay on their unit'}</span>
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${group.name}`} onClick={() => setEditGroup(editGroup?.id === group.id ? null : group)}>
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                        <span className="flex items-center gap-2 text-xs text-muted">
                          <span aria-hidden>Swap</span>
                          <Switch label={`${group.name} interchangeable`} checked={group.interchangeable} disabled={busy === group.id} onChange={(on) => void toggleGroup(group.id, group.name, on, 'interchangeable')} />
                        </span>
                        <span className="flex items-center gap-2 text-xs text-muted">
                          <span aria-hidden>Room type</span>
                          <Switch label={`${group.name} sold as a room type`} checked={group.operatorAssigns} disabled={busy === group.id || !group.interchangeable} onChange={(on) => void toggleGroup(group.id, group.name, on, 'roomType')} />
                        </span>
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
              <VillaProfileCard villa={d.villa} onEdit={() => setForm('villa')} />
              <Card aria-labelledby="villa-upcoming">
                <CardHeader id="villa-upcoming" title="Upcoming arrivals" />
                <BookingRows bookings={d.upcoming} empty="No confirmed arrivals." />
                <Link to={`/calendar?villa=${d.villa.id}`} className="mt-4 flex items-center justify-between rounded-panel bg-raised px-4 py-3 text-sm transition-colors hover:bg-control">
                  Open the calendar for {d.villa.name}
                  <span aria-hidden>→</span>
                </Link>
              </Card>
              <VillaStockCard villaId={d.villa.id} />
            </div>
          </div>
        </>
      )}
    </Gate>
  )
}

/** Address, times, policies, house rules, licence and bank, grouped as on the edit form. */
function VillaProfileCard({ villa, onEdit }: { villa: Villa; onEdit: () => void }) {
  const map = mapLink(villa)
  const deposit = villa.depositKind === 'none' ? DEPOSIT_LABEL.none : villa.depositKind === 'percent' ? `${villa.depositValue}% of the stay` : money(villa.depositValue)
  const rules = villa.houseRules.split('\n').map((r) => r.trim()).filter(Boolean)
  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value || <span className="text-muted">Not set</span>}</dd>
    </div>
  )
  return (
    <Card aria-labelledby="villa-profile">
      <CardHeader id="villa-profile" title="Villa profile" action={<Button size="sm" variant="soft" onClick={onEdit}>Edit</Button>} />
      <div className="space-y-5 text-sm">
        <section aria-label="Location and contact" className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Location and contact</p>
          <p className="break-words">{villa.address || <span className="text-muted">No address yet</span>}</p>
          {map && (
            <a href={map} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
              Open in Google Maps <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
          <dl className="space-y-1.5">
            {row('Phone', villa.phone)}
            {row('Email', villa.email)}
          </dl>
        </section>
        <section aria-label="Check-in and check-out" className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Check-in and check-out</p>
          <dl className="space-y-1.5">
            {row('Check-in from', villa.checkInTime)}
            {row('Check-out by', villa.checkOutTime)}
          </dl>
        </section>
        <section aria-label="Policies" className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Policies</p>
          <dl className="space-y-1.5">
            {row('Cancellation', CANCELLATION_LABEL[villa.cancellationPolicy])}
            {row('Deposit', deposit)}
          </dl>
          <p className="text-xs text-muted">{CANCELLATION_TEXT[villa.cancellationPolicy]}</p>
        </section>
        <section aria-label="House rules" className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">House rules</p>
          {rules.length ? (
            <ul className="list-disc space-y-1 pl-4">
              {rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No house rules yet.</p>
          )}
        </section>
        <section aria-label="Licence and bank" className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Licence and bank</p>
          <dl className="space-y-1.5">
            {row('Licence', villa.licenseNo)}
            {row('Bank', villa.bankName)}
            {row('Account', villa.bankAccountNo)}
            {row('Account name', villa.bankAccountName)}
          </dl>
        </section>
      </div>
    </Card>
  )
}

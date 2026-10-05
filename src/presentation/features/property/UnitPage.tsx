import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Ban, Pencil, Trash2 } from 'lucide-react'
import { BLOCK_REASON_LABEL, BLOCK_REASONS, type BlockReason } from '@/domain/booking'
import { amenityLabel, UNIT_STATUS_LABEL } from '@/domain/property'
import { LISTING_STATUS_LABEL } from '@/domain/airbnb'
import { cn } from '@/lib/cn'
import { addDays, shortDay, weekdayDay } from '@/lib/dates'
import { money, percent, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'
import { BookingRows } from '../shared/BookingRows'
import { NIGHT_CLASS, NIGHT_LABEL, NIGHT_TONE } from '../shared/tones'
import { UnitForm } from './forms'
import { ListingForm } from '../airbnb/forms'

export default function UnitPage() {
  const { id = '' } = useParams()
  const { property, booking, airbnb } = useServices()
  const toast = useToast()
  const resource = useResource(`property.unit:${id}`, () => property.unit(id), { keepPrevious: false })
  const [blocking, setBlocking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [listingForm, setListingForm] = useState(false)
  const options = useResource('airbnb.formOptions', () => airbnb.formOptions())
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function addBlock(e: FormEvent<HTMLFormElement>, code: string) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await booking.addBlock({ unitId: id, from: String(f.get('from')), to: String(f.get('to')), reason: f.get('reason') as BlockReason, note: String(f.get('note') ?? '') })
      toast({ title: `Blocked ${code}`, description: `${f.get('from')} to ${f.get('to')}` })
      setBlocking(false)
      resource.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  async function removeBlock(blockId: string, code: string) {
    try {
      await booking.removeBlock(blockId)
      toast({ title: `Unblocked ${code}` })
      resource.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not remove the block', description: error instanceof Error ? error.message : undefined })
    }
  }

  return (
    <Gate resource={resource} what="unit" back={{ to: '/property', label: 'Back to property' }}>
      {(d) => {
        const unit = d.place.unit
        const today = d.strip[0]?.date ?? ''
        return (
          <>
            <PageBar
              fallback="/property"
              label="Property"
              actions={
                <>
                  <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                    <Pencil aria-hidden className="size-4" /> Edit unit
                  </Button>
                  <Button variant="accent" aria-pressed={blocking} onClick={() => setBlocking((b) => !b)}>
                    <Ban aria-hidden className="size-4" /> Block unit
                  </Button>
                </>
              }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                <Card aria-label={unit.code}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-xs text-muted">{unit.code}</p>
                      <Headline className="mt-1">{unit.name}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        <Link to={`/property/villas/${d.place.villa.id}`} className="hover:underline">
                          {d.place.villa.name}
                        </Link>
                        , {d.place.location.name}
                      </p>
                    </div>
                    <StatusPill tone={NIGHT_TONE[d.tonight]}>{NIGHT_LABEL[d.tonight]} tonight</StatusPill>
                  </div>
                  <p className="mt-6 text-[44px] leading-none font-medium tracking-tight tabular">{money(unit.nightlyRate)}</p>
                  <p className="mt-1 text-sm text-muted">per night on Airbnb; direct stays take 10% off</p>
                  {unit.amenities.length > 0 && (
                    <ul className="mt-4 flex flex-wrap gap-2" aria-label="Amenities">
                      {unit.amenities.map((a) => (
                        <li key={a} className="rounded-full border border-line-strong bg-raised px-3 py-1 text-xs font-medium">
                          {amenityLabel(a)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Bedrooms', plural(unit.bedrooms, 'bedroom')],
                      ['Group', d.place.group ? `${d.place.group.name}${d.place.group.interchangeable ? ' · interchangeable' : ''}` : 'None'],
                      ['Status', UNIT_STATUS_LABEL[unit.status]],
                      ['Occupancy, 30 days', percent(d.occupancy30, { digits: 0 })],
                      ['Revenue, 30 days', money(d.revenue30)],
                      ['Past stays', d.past],
                    ]}
                  />
                </Card>

                {editing && (
                  <UnitForm
                    initial={unit}
                    villa={d.place.villa}
                    groups={d.groups}
                    save={(input) => property.updateUnit(unit.id, input)}
                    onDone={() => {
                      toast({ title: `Saved ${unit.code}` })
                      setEditing(false)
                      resource.reload()
                    }}
                    onCancel={() => setEditing(false)}
                  />
                )}

                {blocking && (
                  <Card as="div" aria-label="Block this unit">
                    <form onSubmit={(e) => void addBlock(e, unit.code)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="From" htmlFor="block-from" error={errors.from}>
                        <Input id="block-from" name="from" type="date" defaultValue={today} required />
                      </Field>
                      <Field label="To (morning)" htmlFor="block-to" error={errors.to ?? errors.form}>
                        <Input id="block-to" name="to" type="date" defaultValue={addDays(today, 2)} required />
                      </Field>
                      <Field label="Reason" htmlFor="block-reason">
                        <Select id="block-reason" name="reason" className="w-full" options={BLOCK_REASONS.map((r) => ({ value: r, label: BLOCK_REASON_LABEL[r] }))} />
                      </Field>
                      <Field label="Note" htmlFor="block-note">
                        <Input id="block-note" name="note" placeholder="What happens in the unit" />
                      </Field>
                      <div className="flex gap-2 sm:col-span-2">
                        <Button type="submit" variant="accent" loading={saving}>
                          Save block
                        </Button>
                        <Button variant="soft" onClick={() => setBlocking(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </Card>
                )}

                <Card aria-labelledby="strip-title">
                  <CardHeader id="strip-title" title="Next 14 nights" action={<Link to={`/calendar?villa=${d.place.villa.id}`} className="text-sm text-accent-text hover:underline">Calendar</Link>} />
                  <ul className="grid grid-cols-7 gap-1.5">
                    {d.strip.map((n) => (
                      <li key={n.date}>
                        <Link
                          to={n.state === 'free' ? `/bookings/new?unit=${unit.id}&checkIn=${n.date}&checkOut=${addDays(n.date, 1)}` : `/calendar?villa=${d.place.villa.id}&from=${n.date}`}
                          title={`${shortDay(n.date)}: ${NIGHT_LABEL[n.state]}`}
                          className={cn('flex h-14 flex-col items-center justify-center rounded-xl text-xs transition-transform active:scale-95', NIGHT_CLASS[n.state])}
                        >
                          <span className="font-medium">{weekdayDay(n.date)}</span>
                          <span className="opacity-70">{NIGHT_LABEL[n.state]}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>

                <Card aria-labelledby="unit-bookings">
                  <CardHeader id="unit-bookings" title="Stays ahead" action={<Link to={`/bookings/new?unit=${unit.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>New booking</Link>} />
                  <BookingRows bookings={d.upcoming} empty="Nothing booked ahead." />
                </Card>
              </div>

              <div className="space-y-4">
                <Card aria-labelledby="blocks-title">
                  <CardHeader id="blocks-title" title="Blocks" />
                  {d.blocks.length === 0 ? (
                    <p className="text-sm text-muted">No blocks ahead.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {d.blocks.map((k) => (
                        <li key={k.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{BLOCK_REASON_LABEL[k.reason]}</p>
                            <p className="truncate text-xs text-muted">
                              {shortDay(k.from)} to {shortDay(k.to)}
                              {k.note && ` · ${k.note}`}
                            </p>
                          </div>
                          <Button variant="ghost" size="icon-sm" aria-label={`Remove block ${k.note || k.reason}`} onClick={() => void removeBlock(k.id, unit.code)}>
                            <Trash2 aria-hidden className="size-4" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card aria-labelledby="listing-title">
                  <CardHeader id="listing-title" title="Airbnb listing" action={<Button size="sm" variant="soft" aria-pressed={listingForm} onClick={() => setListingForm((v) => !v)}>{d.listing ? 'Edit' : 'Add listing'}</Button>} />
                  {listingForm && options.data && (
                    <div className="mb-4">
                      <ListingForm
                        initial={d.listing ?? undefined}
                        catalog={options.data.catalog}
                        accounts={options.data.accounts}
                        listings={options.data.listings}
                        unitId={unit.id}
                        save={(input) => (d.listing ? airbnb.updateListing(d.listing.id, input) : airbnb.createListing(input))}
                        onDone={() => {
                          toast({ title: d.listing ? 'Saved the listing' : 'Added the listing' })
                          setListingForm(false)
                          resource.reload()
                          options.reload()
                        }}
                        onCancel={() => setListingForm(false)}
                      />
                    </div>
                  )}
                  {d.listing && d.account ? (
                    <div className="space-y-3 text-sm">
                      <p className="font-medium">{d.listing.title}</p>
                      <div className="flex items-center gap-2">
                        <Tag tone={d.listing.status === 'active' ? 'success' : 'neutral'}>{LISTING_STATUS_LABEL[d.listing.status]}</Tag>
                        <span className="font-mono text-xs text-muted">{d.listing.airbnbId}</span>
                      </div>
                      <Link to={`/airbnb/accounts/${d.account.id}`} className="flex items-center justify-between rounded-panel bg-raised px-4 py-3 transition-colors hover:bg-control">
                        {d.account.name}
                        <span aria-hidden>→</span>
                      </Link>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">This unit sells direct only.</p>
                  )}
                </Card>
                {d.mates.length > 0 && (
                  <Card aria-labelledby="mates-title">
                    <CardHeader id="mates-title" title="Interchangeable with" />
                    <ul className="flex flex-wrap gap-2">
                      {d.mates.map((m) => (
                        <li key={m.id}>
                          <Link to={`/property/units/${m.id}`} className={buttonStyles({ variant: 'soft', size: 'sm', className: 'font-mono' })}>
                            {m.code}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import { BOOKING_STATUS_LABEL } from '@/domain/booking'
import { LISTING_STATUS_LABEL } from '@/domain/airbnb'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { useToast } from '../../ui/useToast'
import { AirbnbAccountForm, ListingForm } from './forms'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { ListTable } from '../../ui/ListTable'
import { PageBar } from '../../ui/PageBar'
import { EmptyState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { filterBookings } from '@/domain/booking'
import { BOOKING_TONE } from '../shared/tones'

export default function AccountPage() {
  const { id = '' } = useParams()
  const { airbnb, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  function setRange(r: { from?: string; to?: string }) {
    const search = new URLSearchParams(params)
    if (r.from) search.set('from', r.from)
    else search.delete('from')
    if (r.to) search.set('to', r.to)
    else search.delete('to')
    search.delete('page')
    setParams(search, { replace: true })
  }
  const resource = useResource(`airbnb.account:${id}`, () => airbnb.account(id), { keepPrevious: false })
  const options = useResource('airbnb.formOptions', () => airbnb.formOptions())
  const toast = useToast()
  const [form, setForm] = useState<'account' | 'listing' | null>(null)

  function done(title: string) {
    toast({ title })
    setForm(null)
    resource.reload()
    options.reload()
  }

  return (
    <Gate resource={resource} what="Airbnb account" back={{ to: '/airbnb', label: 'Back to Airbnb' }}>
      {(d) => (
        <>
          <PageBar
            fallback="/airbnb"
            label="Airbnb"
            actions={
              <>
                <Button variant="card" aria-pressed={form === 'account'} onClick={() => setForm(form === 'account' ? null : 'account')}>
                  <Pencil aria-hidden className="size-4" /> Edit account
                </Button>
                <Button variant="card" aria-pressed={form === 'listing'} onClick={() => setForm(form === 'listing' ? null : 'listing')}>
                  <Plus aria-hidden className="size-4" /> Listing
                </Button>
                <Link to={`/bookings/new?source=airbnb&account=${d.account.id}`} className={buttonStyles({ variant: 'accent' })}>
                  <Plus aria-hidden className="size-4" /> Enter booking
                </Link>
              </>
            }
          />
          {form === 'account' && (
            <div className="mb-4">
              <AirbnbAccountForm initial={d.account} save={(input) => airbnb.updateAccount(d.account.id, input)} onDone={() => done(`Saved ${d.account.name}`)} onCancel={() => setForm(null)} />
            </div>
          )}
          {form === 'listing' && options.data && (
            <div className="mb-4">
              <ListingForm catalog={options.data.catalog} accounts={options.data.accounts} listings={options.data.listings} accountId={d.account.id} save={(input) => airbnb.createListing(input)} onDone={() => done('Added the listing')} onCancel={() => setForm(null)} />
            </div>
          )}
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile label="Listings" value={d.listings.length} hint={`${d.listings.filter((l) => l.listing.status === 'active').length} live`} to="/airbnb" />
            <StatTile label="Bookings, 30 days" value={d.bookings30} to={`/bookings?source=${d.account.id}`} />
            <StatTile label="Revenue, 30 days" value={money(d.revenue30)} to={`/?source=${d.account.id}`} />
            <StatTile label="Upcoming stays" value={d.upcoming} hint="Confirmed, arriving later" to={`/bookings?source=${d.account.id}&status=confirmed`} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-4">
              <Card aria-label={d.account.name}>
                <Headline>{d.account.name}</Headline>
                <a href={`mailto:${d.account.email}`} className="mt-1 block text-sm text-accent-text hover:underline">
                  {d.account.email}
                </a>
                <FactGrid className="mt-5 grid-cols-2" facts={[['Status', d.account.status === 'active' ? 'Active' : 'Paused'], ['Bookings on file', d.total]]} />
              </Card>
              <Card aria-labelledby="acc-listings">
                <CardHeader id="acc-listings" title="Listings" />
                <ul className="divide-y divide-line">
                  {d.listings.map(({ listing, place }) => (
                    <li key={listing.id}>
                      <Link to={`/property/units/${place.unit.id}`} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                        <span className="font-mono text-sm font-semibold">{place.unit.code}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">{listing.title}</span>
                        <Tag tone={listing.status === 'active' ? 'success' : 'neutral'}>{LISTING_STATUS_LABEL[listing.status]}</Tag>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
            <Card className="p-0" aria-labelledby="acc-bookings">
              <div className="p-5 pb-0">
                <CardHeader id="acc-bookings" title="Bookings" action={<DateRangeFilter today={clock.today()} label="Stay" value={{ from, to }} onChange={setRange} />} />
                <Link to={`/bookings?source=${d.account.id}`} className="mb-2 inline-block text-sm text-accent-text hover:underline">
                  All {d.total} on the bookings page
                </Link>
              </div>
              <ListTable
                label="Bookings"
                rows={filterBookings(d.bookings, { from, to })}
                rowKey={(b) => b.id}
                href={(b) => `/bookings/${b.id}`}
                defaultSort={{ key: 'in', dir: 'desc' }}
                empty={<EmptyState title="No bookings yet" />}
                columns={[
                  { key: 'guest', header: 'Guest', cell: (b) => b.guestName, value: (b) => b.guestName },
                  { key: 'code', header: 'Airbnb code', cell: (b) => <span className="font-mono text-xs">{b.airbnbCode}</span>, value: (b) => b.airbnbCode, hide: 'lg' },
                  { key: 'unit', header: 'Unit', cell: (b) => <span className="font-mono">{b.unitCode}</span>, value: (b) => b.unitCode },
                  { key: 'in', header: 'Check-in', cell: (b) => shortDay(b.checkIn), value: (b) => b.checkIn },
                  { key: 'n', header: 'Nights', align: 'right', cell: (b) => <span className="tabular">{b.nights}</span>, value: (b) => b.nights, hide: 'lg' },
                  { key: 'status', header: 'Status', cell: (b) => <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>, value: (b) => BOOKING_STATUS_LABEL[b.status] },
                  { key: 'total', header: 'Total', align: 'right', cell: (b) => <span className="font-semibold tabular">{money(b.total)}</span>, value: (b) => b.total },
                ]}
                card={(b) => (
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{b.guestName}</p>
                      <p className="text-xs text-muted">
                        {b.unitCode} · {shortDay(b.checkIn)} · {plural(b.nights, 'night')}
                      </p>
                    </div>
                    <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>
                  </div>
                )}
              />
            </Card>
          </div>
        </>
      )}
    </Gate>
  )
}

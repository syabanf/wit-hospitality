import { useState } from 'react'
import { Link } from 'react-router'
import { Pause, Play, Plus } from 'lucide-react'
import { LISTING_STATUS_LABEL } from '@/domain/airbnb'
import { shortDay } from '@/lib/dates'
import { money, percent } from '@/lib/format'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { ViewToggle } from '../../ui/ViewToggle'
import { AirbnbAccountForm, ListingForm } from './forms'

/** Every Airbnb account and the listing behind each unit, with manual booking entry one click away. */
export default function AirbnbPage() {
  const { airbnb, clock } = useServices()
  const toast = useToast()
  const data = useResource('airbnb.overview', () => airbnb.overview())
  const [busy, setBusy] = useState<string | null>(null)
  const [layout, setLayout] = useLayout()
  const [form, setForm] = useState<'account' | 'listing' | null>(null)
  const options = useResource('airbnb.formOptions', () => airbnb.formOptions())

  function done(title: string) {
    toast({ title })
    setForm(null)
    data.reload()
    options.reload()
  }

  async function toggle(id: string, title: string, status: 'active' | 'paused') {
    setBusy(id)
    try {
      await airbnb.setListingStatus(id, status)
      toast({ title: status === 'paused' ? `Paused ${title}` : `Resumed ${title}`, description: 'Pause the calendar on Airbnb too; this console tracks the state only.' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not change the listing', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const live = d.listings.filter((l) => l.listing.status === 'active').length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Airbnb bookings are entered by hand from the host inbox. Each unit lives on one listing under one of the accounts.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          <Button variant="card" aria-pressed={form === 'account'} onClick={() => setForm(form === 'account' ? null : 'account')}>
            <Plus aria-hidden className="size-4" /> Account
          </Button>
          <Button variant="card" aria-pressed={form === 'listing'} onClick={() => setForm(form === 'listing' ? null : 'listing')}>
            <Plus aria-hidden className="size-4" /> Listing
          </Button>
          <Link to="/bookings/new?source=airbnb" className={buttonStyles({ variant: 'accent' })}>
            <Plus aria-hidden className="size-4" /> Enter Airbnb booking
          </Link>
        </div>
      </div>
      {form === 'account' && <AirbnbAccountForm save={(input) => airbnb.createAccount(input)} onDone={() => done('Added the account')} onCancel={() => setForm(null)} />}
      {form === 'listing' && options.data && (
        <ListingForm catalog={options.data.catalog} accounts={options.data.accounts} listings={options.data.listings} save={(input) => airbnb.createListing(input)} onDone={() => done('Added the listing')} onCancel={() => setForm(null)} />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Airbnb revenue, 30 days" value={money(d.revenue30)} hint={`${percent(d.share30, { digits: 0 })} of room revenue`} to="/?source=acc-saka-stays" />
        <StatTile label="Accounts" value={d.accounts.length} hint="Host logins in use" to="/airbnb" />
        <StatTile label="Listings live" value={`${live}/${d.listings.length}`} hint={`${d.listings.length - live} paused`} to="/airbnb" />
        <StatTile label="Upcoming Airbnb stays" value={d.accounts.reduce((s, a) => s + a.upcoming, 0)} hint="Confirmed, arriving later" to="/bookings?status=confirmed" />
      </div>

      {layout === 'table' ? (
        <Card className="p-0" aria-labelledby="accounts-title">
          <div className="p-5 pb-0">
            <CardHeader id="accounts-title" title="Accounts" />
          </div>
          <ListTable
            label="Accounts"
            rows={d.accounts}
            rowKey={(a) => a.account.id}
            href={(a) => `/airbnb/accounts/${a.account.id}`}
            empty={<EmptyState title="No accounts" />}
            columns={[
              { key: 'name', header: 'Account', cell: (a) => a.account.name, value: (a) => a.account.name },
              { key: 'email', header: 'Email', cell: (a) => <span className="text-muted">{a.account.email}</span>, value: (a) => a.account.email, hide: 'lg' },
              { key: 'status', header: 'Status', cell: (a) => <Tag tone={a.account.status === 'active' ? 'success' : 'neutral'}>{a.account.status === 'active' ? 'Active' : 'Paused'}</Tag>, value: (a) => a.account.status },
              { key: 'l', header: 'Listings', align: 'right', cell: (a) => <span className="tabular">{a.listings}</span>, value: (a) => a.listings },
              { key: 'b', header: 'Bookings 30d', align: 'right', cell: (a) => <span className="tabular">{a.bookings30}</span>, value: (a) => a.bookings30 },
              { key: 'u', header: 'Upcoming', align: 'right', cell: (a) => <span className="tabular">{a.upcoming}</span>, value: (a) => a.upcoming, hide: 'lg' },
              { key: 'r', header: 'Revenue 30d', align: 'right', cell: (a) => <span className="font-semibold tabular">{money(a.revenue30)}</span>, value: (a) => a.revenue30 },
            ]}
            card={(a) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.account.name}</p>
                  <p className="text-xs text-muted">
                    {a.listings} listings · {a.bookings30} bookings in 30 days
                  </p>
                </div>
                <span className="text-sm font-semibold tabular">{money(a.revenue30)}</span>
              </div>
            )}
          />
        </Card>
      ) : (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {d.accounts.map((a) => (
          <Link key={a.account.id} to={`/airbnb/accounts/${a.account.id}`} className="min-w-0 rounded-card border border-line bg-card p-5 shadow-card transition-colors hover:bg-raised">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold tracking-tight">{a.account.name}</p>
                <p className="truncate text-xs text-muted">{a.account.email}</p>
              </div>
              <Tag tone={a.account.status === 'active' ? 'success' : 'neutral'}>{a.account.status === 'active' ? 'Active' : 'Paused'}</Tag>
            </div>
            <p className="mt-5 min-w-0 text-2xl leading-tight font-medium tracking-tight break-words tabular xl:text-[28px]">{money(a.revenue30)}</p>
            <p className="mt-1 text-xs text-muted">revenue, 30 days</p>
            <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
              {(
                [
                  ['Listings', a.listings],
                  ['Bookings', a.bookings30],
                  ['Upcoming', a.upcoming],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="min-w-0 rounded-panel bg-raised p-2.5">
                  <dt className="truncate text-muted">{label}</dt>
                  <dd className="mt-0.5 font-medium tabular">{n}</dd>
                </div>
              ))}
            </dl>
          </Link>
        ))}
      </div>
      )}

      <Card className="p-0" aria-labelledby="listings-title">
        <div className="p-5 pb-0">
          <CardHeader id="listings-title" title="Listings per unit" />
        </div>
        <ListTable
          label="Listings"
          rows={d.listings}
          rowKey={(r) => r.listing.id}
          href={(r) => `/property/units/${r.place.unit.id}`}
          defaultSort={{ key: 'unit', dir: 'asc' }}
          exportName="airbnb-listings"
          exportDate={clock.today()}
          empty={<EmptyState title="No listings" />}
          columns={[
            { key: 'unit', header: 'Unit', cell: (r) => <span className="font-mono">{r.place.unit.code}</span>, value: (r) => r.place.unit.code },
            { key: 'title', header: 'Listing', cell: (r) => <span className="line-clamp-1">{r.listing.title}</span>, value: (r) => r.listing.title },
            { key: 'account', header: 'Account', cell: (r) => r.account.name, value: (r) => r.account.name, hide: 'lg' },
            { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={r.listing.status === 'active' ? 'success' : 'neutral'}>{LISTING_STATUS_LABEL[r.listing.status]}</StatusPill>, value: (r) => LISTING_STATUS_LABEL[r.listing.status] },
            { key: 'b30', header: 'Bookings 30d', align: 'right', cell: (r) => <span className="tabular">{r.bookings30}</span>, value: (r) => r.bookings30, hide: 'lg' },
            { key: 'next', header: 'Next arrival', cell: (r) => (r.nextArrival ? `${shortDay(r.nextArrival.checkIn)} · ${r.nextArrival.guestName}` : <span className="text-muted">None</span>), value: (r) => r.nextArrival?.checkIn ?? '' },
            {
              key: 'act',
              header: '',
              align: 'right',
              cell: (r) => (
                <span onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="soft" loading={busy === r.listing.id} onClick={() => void toggle(r.listing.id, r.place.unit.code, r.listing.status === 'active' ? 'paused' : 'active')}>
                    {busy !== r.listing.id && (r.listing.status === 'active' ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />)}
                    {r.listing.status === 'active' ? 'Pause' : 'Resume'}
                  </Button>
                </span>
              ),
            },
          ]}
          card={(r) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-mono font-semibold">{r.place.unit.code}</p>
                <p className="truncate text-xs text-muted">
                  {r.account.name} · {r.listing.title}
                </p>
              </div>
              <StatusPill tone={r.listing.status === 'active' ? 'success' : 'neutral'}>{LISTING_STATUS_LABEL[r.listing.status]}</StatusPill>
            </div>
          )}
        />
      </Card>
    </div>
  )
}

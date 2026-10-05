import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowRight, Pencil, Plus, Repeat, Wand2 } from 'lucide-react'
import { buttonStyles } from '../../ui/buttonStyles'
import { buildCatalog } from '@/domain/property'
import { cn } from '@/lib/cn'
import { money, percent, plural } from '@/lib/format'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { useToast } from '../../ui/useToast'
import { ViewToggle } from '../../ui/ViewToggle'
import { UnitTable } from './UnitTable'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { NIGHT_CLASS, NIGHT_LABEL } from '../shared/tones'
import { LocationForm, VillaForm } from './forms'

/** Locations as filter tiles, then every villa with its unit grid and group rules. */
export default function PropertyPage() {
  const { property } = useServices()
  const data = useResource('property.overview', () => property.overview())
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const locationId = params.get('location') ?? ''
  const [form, setForm] = useState<'location' | 'edit-location' | 'villa' | null>(null)
  const [layout, setLayout] = useLayout()

  function done(title: string) {
    toast({ title })
    setForm(null)
    data.reload()
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />

  const all = data.data.locations
  const locations = all.filter((l) => !locationId || l.location.id === locationId)
  const current = all.find((l) => l.location.id === locationId)?.location
  const catalog = buildCatalog(
    all.map((l) => l.location),
    all.flatMap((l) => l.villas.map((v) => v.villa)),
    all.flatMap((l) => l.villas.flatMap((v) => v.units.map((u) => u.place.unit))),
    all.flatMap((l) => l.villas.flatMap((v) => v.groups)),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">
          {all.length} locations, {catalog.villas.length} villas, {catalog.units.length} units. Tap a location to focus on it; tap a unit to open its record.
        </p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          {current && (
            <Button variant="card" aria-pressed={form === 'edit-location'} onClick={() => setForm(form === 'edit-location' ? null : 'edit-location')}>
              <Pencil aria-hidden className="size-4" /> Edit {current.name}
            </Button>
          )}
          <Button variant="card" aria-pressed={form === 'location'} onClick={() => setForm(form === 'location' ? null : 'location')}>
            <Plus aria-hidden className="size-4" /> Location
          </Button>
          <Button variant="card" aria-pressed={form === 'villa'} onClick={() => setForm(form === 'villa' ? null : 'villa')}>
            <Plus aria-hidden className="size-4" /> Villa
          </Button>
          <Link to="/property/new" className={buttonStyles({ variant: 'accent' })}>
            <Wand2 aria-hidden className="size-4" /> New property
          </Link>
        </div>
      </div>
      {form === 'location' && <LocationForm save={(input) => property.createLocation(input)} onDone={() => done('Added the location')} onCancel={() => setForm(null)} />}
      {form === 'edit-location' && current && (
        <LocationForm initial={current} save={(input) => property.updateLocation(current.id, input)} onDone={() => done(`Saved ${current.name}`)} onCancel={() => setForm(null)} />
      )}
      {form === 'villa' && <VillaForm catalog={catalog} locationId={locationId || undefined} save={(input) => property.createVilla(input)} onDone={() => done('Added the villa')} onCancel={() => setForm(null)} />}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {all.map((l) => (
          <StatTile
            key={l.location.id}
            label={l.location.name}
            value={`${l.occupiedTonight}/${l.unitCount}`}
            hint={`${percent(l.occupancy30, { digits: 0 })} occupied · ${money(l.revenue30)} in 30 days`}
            active={locationId === l.location.id}
            onClick={() => {
              const search = new URLSearchParams(params)
              if (locationId === l.location.id) search.delete('location')
              else search.set('location', l.location.id)
              setParams(search, { replace: true })
            }}
          />
        ))}
      </div>

      {layout === 'table' ? (
        <Card className="p-0" aria-labelledby="units-all">
          <div className="p-5 pb-0">
            <CardHeader id="units-all" title={current ? `Units in ${current.name}` : 'All units'} />
          </div>
          <UnitTable label="Units" place rows={locations.flatMap((l) => l.villas.flatMap((v) => v.units))} exportName="units" exportDate={data.data.today} />
        </Card>
      ) : null}
      {layout === 'cards' && locations.map((l) =>
        l.villas.map(({ villa, groups, units }) => (
          <Card key={villa.id} aria-labelledby={`villa-${villa.id}`}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id={`villa-${villa.id}`} className="text-lg font-semibold tracking-tight">
                  <Link to={`/property/villas/${villa.id}`} className="hover:underline">
                    {villa.name}
                  </Link>
                  <span className="ml-2 font-mono text-xs font-normal text-muted">{villa.code}</span>
                </h2>
                <p className="text-sm text-muted">
                  {l.location.name}, {l.location.area} · {plural(units.length, 'unit')}
                </p>
              </div>
              <Link to={`/property/villas/${villa.id}`} className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                Open villa <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>
            <p className="mb-4 max-w-2xl text-sm text-body">{villa.description}</p>
            {groups.length > 0 && (
              <ul className="mb-4 flex flex-wrap gap-2">
                {groups.map((g) => (
                  <li key={g.id} className="flex h-8 items-center gap-2 rounded-full border border-line-strong bg-raised px-3 text-xs font-medium">
                    {g.name}
                    {g.interchangeable ? (
                      <Tag tone="info">
                        <Repeat aria-hidden className="mr-1 size-3" /> Interchangeable
                      </Tag>
                    ) : (
                      <Tag tone="neutral">Fixed</Tag>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {units.map((row) => (
                <li key={row.place.unit.id}>
                  <Link
                    to={`/property/units/${row.place.unit.id}`}
                    className={cn('flex h-20 flex-col justify-between rounded-panel p-3 transition-transform active:scale-[0.98]', NIGHT_CLASS[row.tonight])}
                  >
                    <span className="font-mono text-sm font-semibold">{row.place.unit.code}</span>
                    <span className="text-xs opacity-80">{NIGHT_LABEL[row.tonight]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )),
      )}
    </div>
  )
}

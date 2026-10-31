import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { shortDay, shortWeekday, weekdayIndex } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'

/**
 * The listing's price list: one base rate shared with the unit, and per-night prices for weekends,
 * the high season and events. New direct stays sell at these prices; Airbnb stays keep what Airbnb sold.
 */
export default function ListingPage() {
  const { id = '' } = useParams()
  const { airbnb } = useServices()
  const toast = useToast()
  const resource = useResource(`airbnb.listing:${id}`, () => airbnb.listing(id), { keepPrevious: false })
  const [picked, setPicked] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<'base' | 'nights' | 'clear' | null>(null)

  async function save(kind: NonNullable<typeof saving>, baseRate: number, dateRates: Record<string, number | null>, title: string) {
    setSaving(kind)
    setErrors({})
    try {
      await airbnb.setListingPrices(id, { baseRate, dateRates })
      toast({ title, description: 'New direct stays sell at this price. Stays already booked keep theirs.' })
      setPicked([])
      resource.reload()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the price', description: Object.values(e)[0] })
    } finally {
      setSaving(null)
    }
  }

  return (
    <Gate resource={resource} what="listing" back={{ to: '/airbnb', label: 'Back to Airbnb' }}>
      {(d) => {
        const lead = weekdayIndex(d.nights[0]?.date ?? d.today)
        const toggle = (date: string) => setPicked((p) => (p.includes(date) ? p.filter((x) => x !== date) : [...p, date]))
        return (
          <>
            <PageBar fallback="/airbnb" label="Airbnb" />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <Card aria-label={d.listing.title}>
                <p className="font-mono text-xs text-muted">Airbnb {d.listing.airbnbId}</p>
                <Headline className="mt-1">{d.listing.title}</Headline>
                <FactGrid
                  className="mt-6 grid-cols-2 sm:grid-cols-3"
                  facts={[
                    ['Unit', <Link key="u" to={`/property/units/${d.place.unit.id}`} className="hover:underline">{d.place.unit.code} · {d.place.unit.name}</Link>],
                    ['Host account', <Link key="a" to={`/airbnb/accounts/${d.account.id}`} className="hover:underline">{d.account.name}</Link>],
                    ['Base price', `${money(d.baseRate)} a night`],
                  ]}
                />
                <p className="mt-4 text-sm text-muted">One price list: the base price is the unit’s rate, so changing it here changes the unit, and the unit’s rate shows here. Direct bookings start from these prices.</p>
              </Card>
              <Card aria-labelledby="base-title">
                <CardHeader id="base-title" title="Base price" />
                <form
                  onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    void save('base', Number(new FormData(e.currentTarget).get('base')), {}, `Base price of ${d.place.unit.code} saved`)
                  }}
                  className="space-y-3"
                >
                  <Field label="Price per night, Rp" htmlFor="base" error={errors.baseRate}>
                    <Input id="base" name="base" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={d.baseRate} className="tabular" />
                  </Field>
                  <Button type="submit" variant="solid" loading={saving === 'base'}>
                    Save base price
                  </Button>
                </form>
              </Card>
            </div>

            <Card aria-labelledby="cal-title" className="mt-4">
              <CardHeader id="cal-title" title="Price calendar" action={<span className="text-xs text-muted">Pick nights, then set their price</span>} />
              <div className="grid grid-cols-7 gap-1.5" role="grid" aria-label="Nightly prices">
                {Array.from({ length: 7 }, (_, i) => (
                  <span key={i} className="pb-1 text-center text-[11px] font-semibold tracking-wider text-subtle uppercase">
                    {shortWeekday(d.nights[(i - lead + 7) % 7]?.date ?? d.today)}
                  </span>
                ))}
                {Array.from({ length: lead }, (_, i) => (
                  <span key={`pad-${i}`} aria-hidden />
                ))}
                {d.nights.map((n) => (
                  <button
                    key={n.date}
                    type="button"
                    aria-pressed={picked.includes(n.date)}
                    onClick={() => toggle(n.date)}
                    className={cn(
                      'min-w-0 rounded-panel border px-1 py-1.5 text-left transition-colors sm:p-2',
                      picked.includes(n.date) ? 'border-accent bg-accent-soft' : n.custom ? 'border-warning bg-warning-soft' : 'border-line bg-raised hover:bg-hover',
                    )}
                  >
                    <span className="block text-[11px] text-muted">
                      <span className="sm:hidden">{Number(n.date.slice(8))}</span>
                      <span className="hidden sm:inline">{shortDay(n.date)}</span>
                    </span>
                    {/* Phones show millions so the price fits a seventh of the screen. */}
                    <span className="block truncate text-xs font-semibold tabular sm:hidden">{(n.rate / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })}jt</span>
                    <span className="hidden truncate text-sm font-semibold tabular sm:block">{Math.round(n.rate / 1000).toLocaleString('id-ID')}k</span>
                    <span className="hidden text-[10px] text-muted sm:block">{n.state === 'occupied' ? 'Booked' : n.state === 'blocked' ? 'Blocked' : n.custom ? 'Custom' : 'Base'}</span>
                  </button>
                ))}
              </div>
              {picked.length > 0 && (
                <form
                  onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    const rate = Number(new FormData(e.currentTarget).get('rate'))
                    void save('nights', d.baseRate, Object.fromEntries(picked.map((date) => [date, rate])), `Priced ${plural(picked.length, 'night')}`)
                  }}
                  className="mt-4 flex flex-wrap items-end gap-2 rounded-panel bg-raised p-3"
                >
                  <Field label={`Price for ${plural(picked.length, 'night')}, Rp`} htmlFor="night-rate" error={errors.dateRates} className="min-w-48 flex-1">
                    <Input id="night-rate" name="rate" type="number" inputMode="numeric" min={0} step={10_000} defaultValue={d.baseRate} className="tabular" />
                  </Field>
                  <Button type="submit" variant="accent" loading={saving === 'nights'}>
                    Set price
                  </Button>
                  <Button variant="soft" loading={saving === 'clear'} onClick={() => void save('clear', d.baseRate, Object.fromEntries(picked.map((date) => [date, null])), `Back to the base price on ${plural(picked.length, 'night')}`)}>
                    Back to base
                  </Button>
                  <Button variant="ghost" onClick={() => setPicked([])}>
                    Clear selection
                  </Button>
                </form>
              )}
            </Card>
          </>
        )
      }}
    </Gate>
  )
}

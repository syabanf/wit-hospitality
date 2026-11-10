import { useSearchParams } from 'react-router'
import { fullDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { ArrowLink, OfferCard, SearchCard, SiteLoading, SiteProblem, WORDMARK } from './parts'
import { useTitle } from './helpers'

/** Room types free for the dates across the villas, cheapest first, with the search card to change them. */
export default function SiteSearchPage() {
  const [params] = useSearchParams()
  const { site } = useServices()
  const q = { location: params.get('location') ?? '', checkIn: params.get('checkIn') ?? '', checkOut: params.get('checkOut') ?? '', guests: Math.max(1, Number(params.get('guests')) || 2) }
  const data = useResource(`site.search:${params.toString()}`, () => site.search(q))
  useTitle(`Find dates · ${WORDMARK}`)

  if (data.status === 'error' && !data.data) return <SiteProblem title="The search did not run" onRetry={data.reload} />
  if (!data.data) return <SiteLoading label="Looking for free rooms" />
  const { results, problem, locations, unavailable, today } = data.data
  const place = locations.find((l) => l.id === q.location)?.name ?? 'Bali'
  const asked = Boolean(q.checkIn && q.checkOut)

  return (
    <div className="mx-auto max-w-7xl px-6 pt-14 pb-24 md:px-12 md:pt-20">
      <p className="s-label text-(--s-terra)">Availability</p>
      <h1 className="s-serif mt-3 text-5xl leading-[1.02] sm:text-7xl">{asked && !problem ? `${plural(results.length, 'stay')} free in ${place}` : 'Find your dates'}</h1>
      {asked && !problem && (
        <p className="mt-4 text-(--s-body)">
          {fullDay(q.checkIn)} to {fullDay(q.checkOut)}, {plural(q.guests, 'guest')}. Cheapest first; totals include service and PB1.
        </p>
      )}
      <SearchCard key={params.toString()} locations={locations} today={today} initial={q} className="mt-10 border border-(--s-line)" />

      <div aria-live="polite" className="mt-16 space-y-10">
        <h2 className="sr-only">Results</h2>
        {asked && problem && <p className="text-(--s-terra)">{problem}</p>}
        {results.map((r) => (
          <OfferCard key={`${r.villa.id}-${r.groupId}`} offer={r} checkIn={q.checkIn} checkOut={q.checkOut} guests={q.guests} />
        ))}
        {asked && !problem && results.length === 0 && (
          <div className="border-t border-(--s-line) pt-8">
            <p className="s-serif text-3xl">Nothing free for those dates and party.</p>
            <p className="mt-3 max-w-xl text-(--s-body)">Try other dates or anywhere in Bali. Our team can also combine rooms for a larger group or hold a waiting list.</p>
            <ArrowLink to="/stay/enquire" className="mt-6">
              Send a request instead
            </ArrowLink>
          </div>
        )}
        {asked && unavailable > 0 && results.length > 0 && <p className="text-sm text-(--s-muted)">{plural(unavailable, 'more room type')} full, too small or closed for these dates.</p>}
      </div>
    </div>
  )
}

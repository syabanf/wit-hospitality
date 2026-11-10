import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { DAY_MOMENTS, type DayMoment, type SiteMenuLine, type SiteVilla } from '@/application/site'
import { PRICE_UNIT_LABEL } from '@/domain/serviceOrder'
import { cn } from '@/lib/cn'
import { money, plural } from '@/lib/format'
import { panelEdges } from '../../hooks/motion'
import { useResource } from '../../hooks/useResource'
import { useScrollProgress } from '../../hooks/useScrollProgress'
import { useServices } from '../../hooks/useServices'
import { ArrowLink, CountMoney, ghostButton, Reveal, SearchCard, SectionHead, SiteImg, SiteProblem, solidButton, WORDMARK } from './parts'
import { useTitle } from './helpers'
import { CLOSING_PHOTO, DAY_PHOTOS, EXPERIENCE_PHOTOS, HERO_PHOTO, INTRO_PHOTO, photoSrcSet, photoUrl, villaPhotos } from './photos'

const NUMBER_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const numberWord = (n: number) => NUMBER_WORD[n] ?? String(n)

const DAY_LABEL: Record<DayMoment, { label: string; time: string }> = {
  morning: { label: 'Morning', time: '05:30' },
  breakfast: { label: 'Breakfast', time: '08:00' },
  afternoon: { label: 'Afternoon', time: '14:00' },
  sunset: { label: 'Sunset', time: '18:00' },
  night: { label: 'Night', time: '20:00' },
}

const priceLine = (i: SiteMenuLine) => `${money(i.price)} ${PRICE_UNIT_LABEL[i.unit]}`

/** The brand landing page: hero, promises, the villas, a day here, experiences and the way to ask. */
export default function SiteHomePage() {
  const { site } = useServices()
  const data = useResource('site.home', () => site.home())
  useTitle(`${WORDMARK} · Private villas in Bali`)

  if (data.status === 'error' && !data.data) return <SiteProblem title="The villas did not load" onRetry={data.reload} />
  // The hero is dark, so the wait is too: the cream header text stays readable.
  if (!data.data) return <div role="status" aria-label="Loading" className="h-[100svh] bg-(--s-ink)" />
  const h = data.data
  const open = h.villas.filter((v) => v.open)
  const villas = [...open, ...h.villas.filter((v) => !v.open)]
  const places = h.locations.map((l) => l.name)

  return (
    <>
      <Hero places={places} />
      <div className="relative z-10 -mt-28 px-4 md:-mt-20 md:px-12">
        <SearchCard locations={h.locations} today={h.today} className="s-rise mx-auto max-w-6xl" style={{ animationDelay: '1.4s' }} />
      </div>

      <section aria-labelledby="intro-title" className="mx-auto grid max-w-7xl gap-14 px-6 py-24 md:grid-cols-12 md:px-12 md:py-36">
        <div className="md:col-span-6">
          <SectionHead id="intro-title" eyebrow="Why stay with us" title="Room to slow down, and people close by when you need them.">
            {numberWord(h.villas.length)} villas in {places.join(', ')}. Our own team runs each one, from check-in to breakfast to the airport car.
          </SectionHead>
          <ol className="mt-12 border-t border-(--s-line)">
            {[
              { title: 'A pool a few steps away', text: 'Private pools in most villas, a shared lap pool at the lofts. Never a crowded hotel deck.' },
              { title: 'Breakfast served in the villa', text: 'Order it the evening before. It comes to your terrace, or floats in your pool.' },
              { title: 'One message away', text: 'Ask the villa team on WhatsApp for fresh towels, dinner, a driver or a massage in your room.' },
              { title: 'The price before you ask', text: `Nightly rates come from our live price list.${h.taxNote ? ` ${h.taxNote}.` : ''}` },
            ].map((p, i) => (
              <Reveal as="li" key={p.title} delay={i * 90} className="grid grid-cols-[3.5rem_1fr] gap-4 border-b border-(--s-line) py-6">
                <span className="s-serif text-3xl leading-none text-(--s-terra) tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                <span>
                  <span className="s-serif block text-2xl leading-tight">{p.title}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-(--s-muted)">{p.text}</span>
                </span>
              </Reveal>
            ))}
          </ol>
        </div>
        <Reveal kind="wipe-left" className="md:col-span-5 md:col-start-8 md:self-end">
          <SiteImg photo={INTRO_PHOTO} sizes="(min-width: 768px) 40vw, 100vw" ratio="3 / 4" />
        </Reveal>
      </section>

      <section id="villas" aria-labelledby="villas-title" className="scroll-mt-20 bg-(--s-stone) py-24 md:py-36">
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <SectionHead id="villas-title" eyebrow="The villas" title={`${numberWord(h.villas.length)} villas across Bali`}>
            Each villa page shows its rooms, the next two weeks of prices and what is free for your dates.
          </SectionHead>
          <div className="mt-20 space-y-28 md:space-y-40">
            {villas.map((v, i) => (
              <VillaRow key={v.id} villa={v} index={i} />
            ))}
          </div>
        </div>
      </section>

      <DaySection day={h.day} />

      <section id="experiences" aria-labelledby="exp-title" className="scroll-mt-20 mx-auto max-w-7xl px-6 py-24 md:px-12 md:py-36">
        <SectionHead id="exp-title" eyebrow="Experiences" title="Booked through the villa, paid on your bill">
          The same menu our guests order from during their stay, at the prices they pay.
        </SectionHead>
        <ul className="mt-14 grid gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {h.experiences.map((e, i) => {
            const photo = EXPERIENCE_PHOTOS[e.category]
            return (
              <Reveal as="li" key={e.category} delay={i * 90} className="s-lift">
                {photo && <SiteImg photo={photo} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 45vw, 100vw" ratio="4 / 5" />}
                <p className="s-label mt-5 text-(--s-terra)">{e.label}</p>
                {e.from !== null && <p className="s-serif mt-1 text-2xl">From {money(e.from)}</p>}
                <ul className="mt-3 space-y-1.5 text-sm text-(--s-body)">
                  {e.items.map((item) => (
                    <li key={item.name} className="flex justify-between gap-3 border-b border-(--s-line) pb-1.5">
                      <span>{item.name}</span>
                      <span className="shrink-0 text-(--s-muted) tabular-nums">{money(item.price)}</span>
                    </li>
                  ))}
                </ul>
              </Reveal>
            )
          })}
        </ul>
      </section>

      <Marquee
        phrases={['Private pool villas', `${numberWord(h.villas.length)} villas across Bali`, 'Breakfast in your villa', ...places, 'Airport car on request', 'Spa therapists who come to you', 'Rates from our own price list']}
      />

      <section aria-labelledby="cta-title" className="on-dark relative isolate overflow-hidden bg-(--s-ink) text-(--s-cream)">
        <img src={photoUrl(CLOSING_PHOTO, 1800)} srcSet={photoSrcSet(CLOSING_PHOTO)} sizes="100vw" alt={CLOSING_PHOTO.alt} width={1800} height={1200} loading="lazy" decoding="async" className="absolute inset-0 -z-10 size-full bg-(--s-ink) object-cover opacity-55" />
        <div className="mx-auto flex min-h-[70svh] max-w-7xl flex-col items-start justify-end gap-8 px-6 py-24 md:px-12">
          <Reveal>
            <h2 id="cta-title" className="s-display max-w-4xl text-[clamp(3rem,10vw,8rem)] text-(--s-cream)">
              Tell us your dates
            </h2>
          </Reveal>
          <Reveal delay={150} className="flex flex-wrap gap-4">
            <Link to="/stay/enquire" className={cn(solidButton, 'bg-(--s-cream) text-(--s-ink) hover:bg-(--s-terra) hover:text-white')}>
              Request to book
              <ArrowRight aria-hidden className="size-4" />
            </Link>
            <Link to="/stay/search" className={cn(ghostButton, 'hover:bg-(--s-cream) hover:text-(--s-ink)')}>
              See what is free
            </Link>
          </Reveal>
        </div>
      </section>
    </>
  )
}

/** Full-bleed photo with a slow zoom, the hairline frame and the wordmark rising letter by letter. */
function Hero({ places }: { places: readonly string[] }) {
  // Each letter's delay counts on from the letters of the words before it.
  const words = WORDMARK.split(' ').map((word, w, all) => ({ word, first: all.slice(0, w).join('').length }))
  return (
    <section aria-labelledby="hero-title" className="on-dark relative isolate h-[100svh] min-h-[38rem] overflow-hidden bg-(--s-ink) text-(--s-cream)">
      <img src={photoUrl(HERO_PHOTO, 1800)} srcSet={photoSrcSet(HERO_PHOTO, [800, 1200, 1800, 2400])} sizes="100vw" alt={HERO_PHOTO.alt} width={1800} height={1200} fetchPriority="high" decoding="async" className="s-kenburns absolute inset-0 -z-20 size-full bg-(--s-ink) object-cover" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgb(10_14_12/0.55)_0%,rgb(10_14_12/0.15)_40%,rgb(10_14_12/0.7)_100%)]" />
      <div aria-hidden className="s-frame" />
      <div className="flex h-full flex-col items-center justify-center px-6 pb-24 text-center">
        <p className="s-label s-rise text-(--s-cream)" style={{ animationDelay: '0.2s' }}>
          Private villas in Bali
        </p>
        <h1 id="hero-title" className="s-display mt-4 text-[21vw] text-(--s-cream) md:text-[12.5vw]">
          <span className="sr-only">{WORDMARK}</span>
          {words.map(({ word, first }) => (
            <span key={word} aria-hidden className="s-mask block md:mx-[0.08em] md:inline-block">
              {[...word].map((ch, i) => (
                <span key={i} className="s-letter" style={{ animationDelay: `${300 + (first + i) * 70}ms` }}>
                  {ch}
                </span>
              ))}
            </span>
          ))}
        </h1>
      </div>
      <p className="s-label absolute bottom-8 left-8 hidden text-(--s-cream) md:block">{places.join(' · ')}</p>
      <p aria-hidden className="s-label absolute right-8 bottom-8 hidden text-(--s-cream) md:block">
        Scroll
      </p>
    </section>
  )
}

/** One villa as a large row: the photo wipes in, the name slides in, the from-price counts up. */
function VillaRow({ villa, index }: { villa: SiteVilla; index: number }) {
  const flip = index % 2 === 1
  const parallax = useScrollProgress<HTMLDivElement>()
  const beds = villa.bedrooms.min === villa.bedrooms.max ? plural(villa.bedrooms.max, 'bedroom') : `${villa.bedrooms.min} to ${villa.bedrooms.max} bedrooms`
  return (
    <article aria-labelledby={`villa-${villa.id}`} className="grid gap-8 md:grid-cols-12 md:items-center md:gap-12">
      <Reveal kind={flip ? 'wipe-left' : 'wipe'} className={cn('md:col-span-7', flip && 'md:order-2 md:col-start-6')}>
        <Link to={`/stay/villas/${villa.id}`} tabIndex={-1} aria-hidden className="block">
          <div ref={parallax}>
            <SiteImg photo={villaPhotos(villa.id).hero} sizes="(min-width: 768px) 58vw, 100vw" ratio="5 / 4" imgClassName="s-parallax" />
          </div>
        </Link>
      </Reveal>
      <div className={cn('md:col-span-5', flip && 'md:order-1 md:col-start-1')}>
        <p className="s-label text-(--s-muted)">
          {String(index + 1).padStart(2, '0')} · {villa.location.name}, {villa.location.area}
        </p>
        <Reveal kind={flip ? 'slide-right' : 'slide'}>
          <h3 id={`villa-${villa.id}`} className="s-display mt-4 text-[clamp(3rem,7.5vw,6.5rem)] text-(--s-ink)">
            {villa.name}
          </h3>
        </Reveal>
        <p className="mt-6 max-w-md leading-relaxed text-(--s-body)">{villa.description}</p>
        <dl className="mt-6 grid max-w-md grid-cols-2 gap-x-6 gap-y-3 border-t border-(--s-line) pt-5 text-sm">
          <div>
            <dt className="text-(--s-muted)">Rooms</dt>
            <dd className="text-(--s-ink)">{villa.open ? `${villa.rooms}, ${beds} each` : 'Closed for now'}</dd>
          </div>
          <div>
            <dt className="text-(--s-muted)">Room types</dt>
            <dd className="text-(--s-ink)">{villa.roomTypes.join(', ') || 'None on sale'}</dd>
          </div>
        </dl>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
          {villa.fromPrice !== null ? (
            <p className="text-sm text-(--s-muted)">
              From
              <CountMoney value={villa.fromPrice} className="s-serif block text-4xl text-(--s-ink)" />a night
            </p>
          ) : (
            <p className="text-sm text-(--s-muted)">Not taking stays right now</p>
          )}
          <ArrowLink to={`/stay/villas/${villa.id}`}>
            Discover <span className="sr-only">{villa.name}</span>
          </ArrowLink>
        </div>
      </div>
    </article>
  )
}

/** Five moments of a day: on wide screens a row whose open panel widens on hover, focus or tap; on phones a row of cards to swipe. */
function DaySection({ day }: { day: Record<DayMoment, SiteMenuLine | null> }) {
  const [open, setOpen] = useState(0)
  const edges = panelEdges(DAY_MOMENTS.length, open)
  return (
    <section id="day" aria-labelledby="day-title" className="scroll-mt-20 mx-auto max-w-[96rem] px-6 py-24 md:px-12 md:py-36">
      <SectionHead id="day-title" eyebrow="From sunrise to late" title={`A day at ${WORDMARK}`}>
        Every line below is on the menu in your villa, at the price you see.
      </SectionHead>

      <div className="relative mt-14 hidden h-[36rem] overflow-hidden bg-(--s-ink) md:block" role="group" aria-label="Moments of the day">
        {DAY_MOMENTS.map((m, i) => {
          const item = day[m]
          const edge = edges[i] ?? { left: 0, right: 0 }
          const isOpen = i === open
          return (
            <div
              key={m}
              className="s-day-panel group absolute inset-0"
              data-open={isOpen}
              style={{ '--left': `${edge.left}%`, '--right': `${edge.right}%` } as CSSProperties}
              onMouseEnter={() => setOpen(i)}
            >
              <img src={photoUrl(DAY_PHOTOS[m], 1600)} srcSet={photoSrcSet(DAY_PHOTOS[m], [800, 1200, 1600, 2000])} sizes="96vw" alt={DAY_PHOTOS[m].alt} width={1600} height={1000} loading="lazy" decoding="async" className="absolute inset-0 size-full bg-(--s-stone) object-cover" />
              <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(10_14_12/0.1)_30%,rgb(10_14_12/0.75)_100%)]" />
              <div className="s-day-caption on-dark absolute inset-0 text-(--s-cream)">
                <button
                  type="button"
                  className="absolute inset-y-0 left-0 w-[60%] text-left focus-visible:outline-none"
                  aria-expanded={isOpen}
                  aria-controls={`day-copy-${m}`}
                  onFocus={() => setOpen(i)}
                  onClick={() => setOpen(i)}
                >
                  <span className="absolute inset-3 border-2 border-(--s-cream) opacity-0 group-has-[:focus-visible]:opacity-100" aria-hidden />
                  <span className={cn('s-label absolute bottom-8 left-6 transition-opacity duration-500 [writing-mode:vertical-rl] rotate-180', isOpen && 'opacity-0')}>
                    {DAY_LABEL[m].label}
                  </span>
                  <span className="sr-only">{DAY_LABEL[m].label}</span>
                </button>
                <div id={`day-copy-${m}`} className="s-day-copy pointer-events-none absolute bottom-0 left-0 w-[60%] max-w-2xl p-10">
                  <p className="s-label text-(--s-sand)">
                    {DAY_LABEL[m].time} · {DAY_LABEL[m].label}
                  </p>
                  {item && (
                    <>
                      <p className="s-serif mt-3 text-4xl leading-tight text-(--s-cream)">{item.name}</p>
                      <p className="mt-2 max-w-md text-sm leading-relaxed text-(--s-cream)/85">{item.description}</p>
                      <p className="mt-3 text-sm font-semibold text-(--s-cream)">{priceLine(item)}</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <ul className="s-snap -mx-6 mt-12 flex gap-4 overflow-x-auto px-6 pb-2 md:hidden" aria-label="Moments of the day">
        {DAY_MOMENTS.map((m) => {
          const item = day[m]
          return (
            <li key={m} className="w-[78vw] max-w-sm shrink-0">
              <SiteImg photo={DAY_PHOTOS[m]} sizes="78vw" ratio="3 / 4" />
              <p className="s-label mt-4 text-(--s-terra)">
                {DAY_LABEL[m].time} · {DAY_LABEL[m].label}
              </p>
              {item && (
                <>
                  <p className="s-serif mt-1 text-2xl leading-tight">{item.name}</p>
                  <p className="mt-1 text-sm text-(--s-muted)">{item.description}</p>
                  <p className="mt-2 text-sm font-semibold text-(--s-ink)">{priceLine(item)}</p>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Neutral lines about the villas running past; two copies so the loop has no seam. */
function Marquee({ phrases }: { phrases: readonly string[] }) {
  const line = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {phrases.map((p) => (
        <li key={p} className="s-display flex items-center px-6 text-5xl whitespace-nowrap text-(--s-ink) md:text-7xl">
          {p}
          <span aria-hidden className="ml-12 inline-block size-2.5 rounded-full bg-(--s-terra)" />
        </li>
      ))}
    </ul>
  )
  return (
    <section aria-label="At a glance" className="s-marquee-box overflow-hidden border-y border-(--s-line) py-10">
      <div className="s-marquee">
        {line(false)}
        {line(true)}
      </div>
    </section>
  )
}

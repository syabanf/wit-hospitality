import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { DAY_MOMENTS, type DayMoment, type SiteFigures, type SiteMenuLine, type SiteVilla } from '@/application/site'
import { PRICE_UNIT_LABEL, type MenuCategory } from '@/domain/serviceOrder'
import { cn } from '@/lib/cn'
import { money, plural } from '@/lib/format'
import { panelEdges } from '../../hooks/motion'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { button } from './buttons'
import { GUEST_SERVICES, HOW_WE_WORK, listWords, numberWord, OWNER_SERVICES, type ServiceLine } from './content'
import { useHeroRef, useTitle } from './helpers'
import { ArrowLink, ContactBand, Contours, CountMoney, CountNumber, CoverImg, Float, Reveal, SearchCard, SectionHead, SiteImg, SiteProblem, WORDMARK } from './parts'
import { ABOUT_PHOTOS, DAY_FLOATS, DAY_PHOTOS, EXPERIENCE_PHOTOS, HERO_SLIDES, photoSrcSet, photoUrl, villaPhotos } from './photos'

const DAY_LABEL: Record<DayMoment, { label: string; time: string }> = {
  morning: { label: 'Morning', time: '05:30' },
  breakfast: { label: 'Breakfast', time: '08:00' },
  afternoon: { label: 'Afternoon', time: '14:00' },
  sunset: { label: 'Sunset', time: '18:00' },
  night: { label: 'Night', time: '20:00' },
}

const priceLine = (i: SiteMenuLine) => `${money(i.price)} ${PRICE_UNIT_LABEL[i.unit]}`

/** The company home page: who we are, the figures, the villas, services for guests and owners, a day here, how we work and contact. */
export default function SiteHomePage() {
  const { site } = useServices()
  const data = useResource('site.home', () => site.home())
  const heroRef = useHeroRef()
  useTitle(`${WORDMARK} · Villa operator in Bali`)

  if (data.status === 'error' && !data.data) return <SiteProblem title="The villas did not load" onRetry={data.reload} />
  // The hero is dark, so the wait is too: the transparent header stays readable.
  if (!data.data) return <div ref={heroRef} role="status" aria-label="Loading" className="h-[100svh] bg-(--s-ink)" />
  const h = data.data
  const villas = [...h.villas.filter((v) => v.open), ...h.villas.filter((v) => !v.open)]
  const places = h.locations.map((l) => l.name)

  return (
    <>
      <Hero places={places} heroRef={heroRef}>
        <SearchCard locations={h.locations} today={h.today} variant="strip" />
      </Hero>
      <div className="relative z-10 -mt-16 px-4 lg:hidden">
        <SearchCard locations={h.locations} today={h.today} className="s-rise mx-auto max-w-2xl" />
      </div>

      <About figures={h.figures} places={places} />
      <Numbers figures={h.figures} />

      <section id="villas" aria-labelledby="villas-title" className="scroll-mt-20 bg-(--s-stone) py-24 md:py-36">
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <SectionHead id="villas-title" eyebrow="Our villas" title={`${numberWord(h.villas.length)} villas across Bali`} lead="Each one with its own team, its own kitchen and a pool close by.">
            Every villa page shows its rooms, the next two weeks of prices and what is free for your dates. {h.taxNote && `${h.taxNote}.`}
          </SectionHead>
          <ul className="mt-16 grid gap-6 md:grid-cols-2">
            {villas.map((v, i) => (
              <li key={v.id} className={cn(i === 0 && 'md:col-span-2')}>
                <VillaCard villa={v} index={i} wide={i === 0} />
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Services experiences={h.experiences} />
      <DaySection day={h.day} />
      <HowWeWork />
      <ContactBand contact={h.contact} />
    </>
  )
}

/** Three photos crossfading under a slow zoom, the wordmark rising letter by letter, and the book strip pinned to the bottom. */
function Hero({ places, heroRef, children }: { places: readonly string[]; heroRef: (el: HTMLElement | null) => void; children: React.ReactNode }) {
  // Each letter's delay counts on from the letters of the words before it.
  const words = WORDMARK.split(' ').map((word, w, all) => ({ word, first: all.slice(0, w).join('').length }))
  return (
    <section ref={heroRef} aria-labelledby="hero-title" className="on-dark relative isolate h-[100svh] min-h-[38rem] overflow-hidden bg-(--s-ink) text-(--s-cream)">
      <div aria-hidden className="s-kenburns absolute inset-0 -z-20">
        {HERO_SLIDES.map((p, i) => (
          <img
            key={p.id}
            src={photoUrl(p, 1800)}
            srcSet={photoSrcSet(p, [800, 1200, 1800, 2400])}
            sizes="100vw"
            alt=""
            width={1800}
            height={1200}
            fetchPriority={i === 0 ? 'high' : 'low'}
            decoding="async"
            className={cn('absolute inset-0 size-full object-cover', i > 0 && 's-slide')}
            style={i > 0 ? { animationDelay: `${i * 7}s` } : undefined}
          />
        ))}
      </div>
      <div aria-hidden className="s-scrim-hero absolute inset-0 -z-10" />
      <div className="flex h-full flex-col items-center justify-center px-6 pb-28 text-center">
        <p className="s-label s-rise text-(--s-cream)" style={{ animationDelay: '0.2s' }}>
          Villa operator · Bali
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
        <p className="s-italic s-rise mt-6 max-w-xl text-2xl leading-snug text-(--s-cream)" style={{ animationDelay: '1.2s' }}>
          A villa operator in Bali. We host guests and run villas for their owners.
        </p>
      </div>
      <div className="absolute inset-x-0 bottom-0 hidden px-10 pb-8 lg:block">
        <p className="s-label mb-4 text-(--s-cream)">{places.join(' · ')}</p>
        <div className="s-rise" style={{ animationDelay: '1.5s' }}>
          {children}
        </div>
      </div>
    </section>
  )
}

/** Who we are: a short vertical headline beside layered photos that drift at their own speeds. */
function About({ figures, places }: { figures: SiteFigures; places: readonly string[] }) {
  return (
    <section id="about" aria-labelledby="about-title" className="scroll-mt-20 mx-auto grid max-w-7xl gap-16 px-6 pt-28 pb-24 md:grid-cols-12 md:px-12 md:pt-40 md:pb-40">
      <div className="md:col-span-5">
        <Reveal as="p" className="s-label s-eyebrow text-(--s-terra)">
          Who we are
        </Reveal>
        <Reveal delay={80}>
          <h2 id="about-title" className="s-serif mt-6 text-[2.6rem] leading-[1.05] text-(--s-ink) sm:text-6xl">
            <span className="block">{numberWord(figures.villas)} villas.</span>
            <span className="block pl-[1.2em]">{numberWord(figures.locations)} places in Bali.</span>
            <span className="block">One team</span>
            <span className="block pl-[1.2em]">on every job.</span>
          </h2>
        </Reveal>
        <Reveal as="p" delay={160} className="s-italic mt-8 text-2xl leading-snug text-(--s-body)">
          We host the guests and run the villas for their owners.
        </Reveal>
        <Reveal delay={220} className="mt-6 space-y-4 leading-relaxed text-(--s-body)">
          <p>
            {WORDMARK} runs {numberWord(figures.villas).toLowerCase()} villas across {listWords(places)}. Our own staff do the hosting, housekeeping and maintenance, and our finance team keeps the books and reports to each owner every month.
          </p>
          <p>Reservations, cleaning rounds, repairs, the kitchen, payroll and owner statements run in one system, so a guest&rsquo;s request and an owner&rsquo;s question reach the same people.</p>
        </Reveal>
        <ArrowLink to="/stay/about" className="mt-8">
          More about us
        </ArrowLink>
      </div>
      <div className="relative md:col-span-7 md:pl-10">
        <Float speed={6} className="absolute -top-10 left-0 z-10 hidden w-[38%] md:block">
          <SiteImg photo={ABOUT_PHOTOS.top} sizes="20vw" ratio="4 / 5" load="early" className="shadow-2xl" />
        </Float>
        <Reveal kind="wipe-up" className="relative isolate md:ml-[22%]">
          <SiteImg photo={ABOUT_PHOTOS.main} sizes="(min-width: 768px) 45vw, 100vw" ratio="3 / 4" load="early" />
          <div aria-hidden className="s-scrim-card absolute inset-0" />
          <figure className="on-dark absolute inset-x-0 bottom-0 p-6 md:p-10">
            <blockquote className="s-italic text-3xl leading-tight text-(--s-cream) md:text-4xl">&ldquo;A good stay is a hundred small jobs, done on time.&rdquo;</blockquote>
            <figcaption className="s-label mt-4 text-(--s-cream)">How we run every villa</figcaption>
          </figure>
        </Reveal>
        <Float speed={-5} className="relative z-10 -mt-24 ml-auto w-[46%] md:-mr-6 md:-mb-48">
          <SiteImg photo={ABOUT_PHOTOS.bottom} sizes="(min-width: 768px) 22vw, 46vw" ratio="1 / 1" load="early" className="shadow-2xl" />
        </Float>
      </div>
    </section>
  )
}

/** The figures, every one counted from the console's records. */
function Numbers({ figures }: { figures: SiteFigures }) {
  const items = [
    { label: 'Villas', value: figures.villas },
    { label: 'Locations in Bali', value: figures.locations },
    { label: 'Rooms open for sale', value: figures.rooms },
    { label: 'Room types', value: figures.roomTypes },
    { label: 'Services on the villa menu', value: figures.services },
  ]
  return (
    <section aria-labelledby="numbers-title" className="on-dark relative isolate overflow-hidden bg-(--s-forest) py-20 text-(--s-cream) md:py-28">
      <Contours />
      <div className="mx-auto max-w-7xl px-6 md:px-12">
        <h2 id="numbers-title" className="s-label s-eyebrow text-(--s-sand)">
          In numbers
        </h2>
        <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
          {items.map((it, i) => (
            <Reveal key={it.label} delay={i * 90} className="border-t border-(--s-line-light) pt-5">
              <dt className="s-label text-(--s-sand)">{it.label}</dt>
              <dd className="s-display mt-3 text-[clamp(3.5rem,8vw,6rem)] text-(--s-cream)">
                <CountNumber value={it.value} />
              </dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  )
}

/**
 * A villa as a large photo card: name, place and from-price on a scrim at the bottom. Hover or
 * focus lifts a glass panel with the room types; a fine pointer gets a "View" chip that follows it.
 */
function VillaCard({ villa, index, wide }: { villa: SiteVilla; index: number; wide: boolean }) {
  const follow = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--cx', `${e.clientX - box.left}px`)
    e.currentTarget.style.setProperty('--cy', `${e.clientY - box.top}px`)
  }
  const beds = villa.bedrooms.min === villa.bedrooms.max ? plural(villa.bedrooms.max, 'bedroom') : `${villa.bedrooms.min} to ${villa.bedrooms.max} bedrooms`
  return (
    <Reveal kind="wipe-up" delay={wide ? 0 : (index % 2) * 120}>
      <article aria-labelledby={`villa-${villa.id}`} onPointerMove={follow} className={cn('s-card on-dark relative isolate flex flex-col justify-end overflow-hidden bg-(--s-ink) text-(--s-cream) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-(--s-cream) has-[:focus-visible]:-outline-offset-8', wide ? 'aspect-[4/5] sm:aspect-[16/10] lg:aspect-[21/9]' : 'aspect-[4/5] lg:aspect-[5/4]')}>
        <CoverImg photo={villaPhotos(villa.id).hero} sizes={wide ? '(min-width: 768px) 90vw, 100vw' : '(min-width: 768px) 45vw, 100vw'} load="early" className="-z-30" />
        <div aria-hidden className="s-scrim-card absolute inset-0 -z-20" />
        <div aria-hidden className="s-card-dim absolute inset-0 -z-10" />
        <span aria-hidden className="s-cursor z-10 size-20 place-items-center rounded-full bg-(--s-cream) text-xs font-semibold tracking-[0.2em] text-(--s-ink) uppercase">
          View
        </span>
        <div className="p-5 md:p-8">
          <div className="s-card-panel s-glass mb-5 max-w-md p-5">
            <p className="s-label text-(--s-cream)">{villa.open ? `${plural(villa.rooms, 'room')}, ${beds} each` : 'Closed for now'}</p>
            {villa.roomTypes.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-(--s-cream)">
                {villa.roomTypes.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <span aria-hidden className="mt-4 inline-flex items-center gap-2 border-b border-current pb-1 text-sm font-semibold text-(--s-cream)">
              Discover <ArrowUpRight className="size-4" />
            </span>
          </div>
          <p className="s-label text-(--s-cream)">
            {String(index + 1).padStart(2, '0')} · {villa.location.name}, {villa.location.area}
          </p>
          <h3 id={`villa-${villa.id}`} className="s-display mt-3 text-[clamp(2.5rem,6vw,5rem)] text-(--s-cream)">
            <Link to={`/stay/villas/${villa.id}`} className="after:absolute after:inset-0 focus-visible:outline-none">
              {villa.name}
            </Link>
          </h3>
          <p className="mt-3 text-sm text-(--s-cream)">
            {villa.fromPrice !== null ? (
              <>
                From <CountMoney value={villa.fromPrice} className="s-serif text-2xl text-(--s-cream)" /> a night
              </>
            ) : (
              'Not taking stays right now'
            )}
          </p>
        </div>
      </article>
    </Reveal>
  )
}

/** Two audiences side by side, then the in-villa menu on a warm brown band. */
function Services({ experiences }: { experiences: ReadonlyArray<{ category: MenuCategory; label: string; from: number | null; items: SiteMenuLine[] }> }) {
  return (
    <section id="services" aria-labelledby="services-title" className="scroll-mt-20">
      <div className="mx-auto max-w-7xl px-6 py-24 md:px-12 md:py-36">
        <SectionHead id="services-title" eyebrow="Services" title="What we do, and for whom" lead="Guests get a quiet stay. Owners get a villa that runs and a statement they can check." />
        <div className="mt-16 grid gap-14 md:grid-cols-2 md:gap-10">
          <ServiceList title="For guests" items={GUEST_SERVICES} />
          <ServiceList title="For villa owners" items={OWNER_SERVICES} />
        </div>
      </div>
      {experiences.length > 0 && (
        <div className="on-dark bg-(--s-brown) py-20 text-(--s-cream) md:py-28">
          <div className="mx-auto max-w-7xl px-6 md:px-12">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <SectionHead id="menu-title" eyebrow="On the villa menu" title="Booked through the villa, paid on your bill" lead="The menu guests order from during their stay, at the prices they pay." surface="dark" />
              <ul className="flex flex-wrap gap-x-6 gap-y-2">
                {[
                  { to: '/stay#day', label: 'A day here' },
                  { to: '/stay/search', label: 'Find dates' },
                  { to: '/stay/enquire', label: 'Request to book' },
                ].map((l) => (
                  <li key={l.to}>
                    <Link to={l.to} className="s-label tracking-[0.22em] text-(--s-cream) underline underline-offset-8 hover:text-(--s-sand)">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {experiences.map((e, i) => {
                const photo = EXPERIENCE_PHOTOS[e.category]
                return (
                  <Reveal as="li" key={e.category} delay={i * 90} className="s-lift relative isolate flex aspect-[3/4] flex-col justify-end overflow-hidden bg-(--s-ink) p-5">
                    {photo && <CoverImg photo={photo} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 45vw, 100vw" className="-z-20" />}
                    <div aria-hidden className="s-scrim-card absolute inset-0 -z-10" />
                    <p className="s-label text-(--s-cream)">{e.label}</p>
                    {e.from !== null && <p className="s-serif mt-1 text-3xl text-(--s-cream)">From {money(e.from)}</p>}
                    <ul className="mt-3 space-y-1 text-sm text-(--s-cream)">
                      {e.items.map((item) => (
                        <li key={item.name} className="flex justify-between gap-3 border-b border-(--s-line-light) pb-1">
                          <span>{item.name}</span>
                          <span className="shrink-0 tabular-nums">{money(item.price)}</span>
                        </li>
                      ))}
                    </ul>
                  </Reveal>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}

function ServiceList({ title, items }: { title: string; items: readonly ServiceLine[] }) {
  return (
    <div>
      <h3 className="s-serif text-4xl text-(--s-ink)">{title}</h3>
      <ol className="mt-6 border-t border-(--s-line)">
        {items.map((s, i) => (
          <Reveal as="li" key={s.title} delay={i * 70} className="grid grid-cols-[3rem_1fr] gap-4 border-b border-(--s-line) py-5">
            <span className="s-serif text-2xl leading-none text-(--s-terra) tabular-nums">{String(i + 1).padStart(2, '0')}</span>
            <span>
              <span className="s-serif block text-2xl leading-tight text-(--s-ink)">{s.title}</span>
              <span className="mt-1 block text-sm leading-relaxed text-(--s-muted)">{s.text}</span>
              {s.to && s.link && (
                <Link to={s.to} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-(--s-ink) underline underline-offset-4 hover:text-(--s-terra)">
                  {s.link}
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              )}
            </span>
          </Reveal>
        ))}
      </ol>
    </div>
  )
}

/** Five moments of a day on dark green: on wide screens a row whose open panel widens on hover, focus or tap; on phones cards to swipe. */
function DaySection({ day }: { day: Record<DayMoment, SiteMenuLine | null> }) {
  const [open, setOpen] = useState(0)
  const edges = panelEdges(DAY_MOMENTS.length, open)
  return (
    <section id="day" aria-labelledby="day-title" className="on-dark relative isolate scroll-mt-20 overflow-hidden bg-(--s-forest) py-24 text-(--s-cream) md:py-36">
      <Contours />
      <div className="mx-auto grid max-w-[96rem] gap-10 px-6 md:grid-cols-12 md:px-12">
        <SectionHead id="day-title" eyebrow="From sunrise to late" title={`A day at ${WORDMARK}`} lead="Every line below is on the menu in your villa, at the price you see." surface="dark" className="md:col-span-6" />
        <div aria-hidden className="relative hidden h-72 md:col-span-6 md:block">
          <Float speed={7} className="absolute top-0 right-[38%] w-[36%]">
            <SiteImg photo={DAY_FLOATS[0] ?? DAY_PHOTOS.breakfast} sizes="18vw" ratio="4 / 5" className="shadow-2xl" />
          </Float>
          <Float speed={-4} className="absolute top-16 right-0 w-[34%]">
            <SiteImg photo={DAY_FLOATS[1] ?? DAY_PHOTOS.sunset} sizes="16vw" ratio="3 / 4" className="shadow-2xl" />
          </Float>
        </div>
      </div>

      <div className="mx-auto mt-14 hidden max-w-[96rem] px-12 md:block">
      <div className="relative h-[36rem] overflow-hidden bg-(--s-ink)" role="group" aria-label="Moments of the day">
        {DAY_MOMENTS.map((m, i) => {
          const item = day[m]
          const edge = edges[i] ?? { left: 0, right: 0 }
          const isOpen = i === open
          return (
            <div key={m} className="s-day-panel group absolute inset-0" data-open={isOpen} style={{ '--left': `${edge.left}%`, '--right': `${edge.right}%` } as CSSProperties} onMouseEnter={() => setOpen(i)}>
              <CoverImg photo={DAY_PHOTOS[m]} sizes="96vw" load="early" />
              <div aria-hidden className="s-scrim-card absolute inset-0" />
              <div aria-hidden className="s-day-shade absolute inset-0" />
              <div className="s-day-caption absolute inset-0 text-(--s-cream)">
                <button type="button" className="absolute inset-y-0 left-0 w-[60%] text-left focus-visible:outline-none" aria-expanded={isOpen} aria-controls={`day-copy-${m}`} onFocus={() => setOpen(i)} onClick={() => setOpen(i)}>
                  <span className="absolute inset-3 border-2 border-(--s-cream) opacity-0 group-has-[:focus-visible]:opacity-100" aria-hidden />
                  <span aria-hidden className={cn('s-label absolute bottom-8 left-6 rotate-180 text-(--s-cream) transition-opacity duration-500 [writing-mode:vertical-rl]', isOpen && 'opacity-0')}>
                    {DAY_LABEL[m].time} · {DAY_LABEL[m].label}
                  </span>
                  <span className="sr-only">{DAY_LABEL[m].label}</span>
                </button>
                <div id={`day-copy-${m}`} className="s-day-copy pointer-events-none absolute bottom-0 left-0 w-[60%] max-w-2xl p-10">
                  <p className="s-label text-(--s-cream)">
                    {DAY_LABEL[m].time} · {DAY_LABEL[m].label}
                  </p>
                  {item && (
                    <>
                      <p className="s-serif mt-3 text-4xl leading-tight text-(--s-cream)">{item.name}</p>
                      <p className="mt-2 max-w-md text-sm leading-relaxed text-(--s-cream)">{item.description}</p>
                      <p className="mt-3 text-sm font-semibold text-(--s-cream)">{priceLine(item)}</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      </div>

      <ul className="s-snap mt-12 flex gap-4 overflow-x-auto px-6 pb-2 md:hidden" aria-label="Moments of the day">
        {DAY_MOMENTS.map((m) => {
          const item = day[m]
          return (
            <li key={m} className="relative isolate flex aspect-[3/4] w-[78vw] max-w-sm shrink-0 flex-col justify-end overflow-hidden bg-(--s-ink) p-5">
              <CoverImg photo={DAY_PHOTOS[m]} sizes="78vw" className="-z-20" />
              <div aria-hidden className="s-scrim-card absolute inset-0 -z-10" />
              <p className="s-label text-(--s-cream)">
                {DAY_LABEL[m].time} · {DAY_LABEL[m].label}
              </p>
              {item && (
                <>
                  <p className="s-serif mt-1 text-2xl leading-tight text-(--s-cream)">{item.name}</p>
                  <p className="mt-1 line-clamp-3 text-sm text-(--s-cream)">{item.description}</p>
                  <p className="mt-2 text-sm font-semibold text-(--s-cream)">{priceLine(item)}</p>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Four steps for an owner, from the first visit to the monthly report. */
function HowWeWork() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 bg-(--s-stone) py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-6 md:px-12">
        <SectionHead id="how-title" eyebrow="For villa owners" title="How we work" lead="Four steps from the first visit to the first statement." />
        <ol className="mt-14 grid gap-px bg-(--s-line) sm:grid-cols-2 lg:grid-cols-4">
          {HOW_WE_WORK.map((s, i) => (
            <Reveal as="li" key={s.step} delay={i * 100} className="bg-(--s-stone) py-8 sm:px-6 lg:first:pl-0">
              <span className="s-display block text-6xl text-(--s-terra)">{String(i + 1).padStart(2, '0')}</span>
              <span className="s-serif mt-6 block text-3xl text-(--s-ink)">{s.step}</span>
              <span className="mt-2 block text-sm leading-relaxed text-(--s-body)">{s.text}</span>
            </Reveal>
          ))}
        </ol>
        <div className="mt-12 flex flex-wrap items-center gap-6">
          <Link to="/stay/enquire?topic=owner" className={button()}>
            Talk to us about your villa
            <ArrowRight aria-hidden className="size-4" />
          </Link>
          <ArrowLink to="/portal">Owner portal sign in</ArrowLink>
        </div>
      </div>
    </section>
  )
}

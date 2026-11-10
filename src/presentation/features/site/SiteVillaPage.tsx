import { useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { SiteRoomType } from '@/application/site'
import { NotFoundError } from '@/domain/errors'
import { addDays, shortWeekday } from '@/lib/dates'
import { moneyCompact, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { EnquiryForm } from './EnquiryForm'
import { button } from './buttons'
import { useHeroRef, useTitle } from './helpers'
import { ArrowLink, CountMoney, CountNumber, OfferCard, Reveal, SectionHead, SiteImg, SiteLoading, SiteProblem, WORDMARK } from './parts'
import { photoSrcSet, photoUrl, villaPhotos, type Photo } from './photos'

interface Ask {
  groupId: string | null
  checkIn: string
  checkOut: string
  guests: number
}

/** One villa's landing page: facts, gallery, room types with prices, stay rules, a free-room check and the request to book. */
export default function SiteVillaPage() {
  const { id = '' } = useParams()
  const { site } = useServices()
  const data = useResource(`site.villa:${id}`, () => site.villa(id), { keepPrevious: false })
  const options = useResource('site.enquiryOptions', () => site.enquiryOptions())
  const [ask, setAsk] = useState<Ask | null>(null)
  const heroRef = useHeroRef()
  useTitle(data.data ? `${data.data.villa.name} · ${WORDMARK}` : WORDMARK)

  if (data.status === 'error' && data.error instanceof NotFoundError) return <SiteProblem title="We have no villa at this address">The link may be old. All our villas are on the home page.</SiteProblem>
  if (data.status === 'error' && !data.data) return <SiteProblem title="The villa did not load" onRetry={data.reload} />
  if (!data.data) return <SiteLoading />
  const { villa, roomTypes, stayNotes, others, today, taxNote } = data.data
  const photos = villaPhotos(villa.id)
  const start: Ask = ask ?? { groupId: null, checkIn: addDays(today, 14), checkOut: addDays(today, 17), guests: 2 }

  function request(next: Ask) {
    setAsk(next)
    document.getElementById('request')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <>
      <section ref={heroRef} aria-labelledby="villa-title" className="on-dark relative isolate flex min-h-[88svh] items-end overflow-hidden bg-(--s-ink) text-(--s-cream)">
        <img src={photoUrl(photos.hero, 1800)} srcSet={photoSrcSet(photos.hero, [800, 1200, 1800, 2400])} sizes="100vw" alt={photos.hero.alt} width={1800} height={1200} fetchPriority="high" decoding="async" className="s-kenburns absolute inset-0 -z-20 size-full object-cover" />
        <div aria-hidden className="s-scrim-hero absolute inset-0 -z-10" />
        <div className="mx-auto w-full max-w-7xl px-8 pt-32 pb-16 md:px-14 md:pb-20">
          <nav aria-label="Breadcrumb" className="s-label s-rise text-(--s-cream)">
            <Link to="/stay#villas" className="underline-offset-4 hover:underline">
              Villas
            </Link>
            <span aria-hidden> / </span>
            <span aria-current="page">{villa.name}</span>
          </nav>
          <h1 id="villa-title" className="s-display s-rise mt-5 text-[clamp(3.5rem,13vw,11rem)] text-(--s-cream)" style={{ animationDelay: '0.15s' }}>
            {villa.name}
          </h1>
          <p className="s-rise mt-4 max-w-xl text-base text-(--s-cream)" style={{ animationDelay: '0.3s' }}>
            {villa.location.name}, {villa.location.area}. {villa.description}
          </p>
        </div>
      </section>

      <section aria-label="Key facts" className="border-b border-(--s-line)">
        <dl className="mx-auto grid max-w-7xl grid-cols-2 gap-px bg-(--s-line) xl:grid-cols-4">
          <Fact label="Rooms" delay={0}>
            <CountNumber value={villa.rooms} />
          </Fact>
          <Fact label="Sleeps up to" delay={90}>
            <CountNumber value={villa.sleeps} />
            <span className="ml-2 align-top text-base font-normal tracking-normal normal-case text-(--s-muted)">a room</span>
          </Fact>
          <Fact label="Location" delay={180} small>
            {villa.location.name}
          </Fact>
          <Fact label="From, a night" delay={270} small>
            {villa.fromPrice !== null ? <CountMoney value={villa.fromPrice} /> : 'Closed'}
          </Fact>
        </dl>
      </section>

      <section aria-labelledby="about-title" className="mx-auto grid max-w-7xl gap-12 px-6 py-24 md:grid-cols-12 md:px-12">
        <div className="md:col-span-6">
          <SectionHead id="about-title" eyebrow={`${villa.location.name}, ${villa.location.area}`} title="What the villa has">
            {villa.description}
          </SectionHead>
        </div>
        <div className="grid gap-10 sm:grid-cols-2 md:col-span-6">
          <List title="In every room" items={villa.amenities} />
          <List title="Around the villa" items={villa.facilities} />
        </div>
      </section>

      <Gallery name={villa.name} photos={photos.gallery} />

      <section aria-labelledby="rooms-title" className="bg-(--s-stone) py-24 md:py-32">
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <SectionHead id="rooms-title" eyebrow="Rooms and prices" title={roomTypes.length === 1 ? 'One kind of room' : `${roomTypes.length} kinds of room`}>
            The next two weeks at the price we sell direct, a night. {taxNote && `${taxNote}.`}
          </SectionHead>
          {roomTypes.length === 0 && <p className="mt-10 text-(--s-body)">No room is on sale here at the moment. Send a request and we will tell you when it opens.</p>}
          <div className="mt-14 space-y-16">
            {roomTypes.map((t) => (
              <RoomType key={t.id} type={t} onRequest={() => request({ ...start, groupId: t.id })} />
            ))}
          </div>
        </div>
      </section>

      {stayNotes.length > 0 && (
        <section aria-labelledby="rules-title" className="mx-auto max-w-7xl px-6 py-20 md:px-12">
          <h2 id="rules-title" className="s-label text-(--s-terra)">
            Stay notes
          </h2>
          <ul className="mt-6 grid gap-x-10 gap-y-4 md:grid-cols-2">
            {stayNotes.map((n) => (
              <li key={n} className="border-t border-(--s-line) pt-4 text-(--s-body)">
                {n}
              </li>
            ))}
          </ul>
        </section>
      )}

      {villa.open && <Checker villaId={villa.id} today={today} onRequest={request} />}

      <section id="request" aria-labelledby="request-title" className="scroll-mt-24 bg-(--s-stone) py-24 md:py-32">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 md:grid-cols-12 md:px-12">
          <div className="md:col-span-4">
            <SectionHead id="request-title" eyebrow="Request to book" title={`Stay at ${villa.name}`}>
              Send your dates and we reply by WhatsApp or email with the room and the total. Nothing is charged until you confirm.
            </SectionHead>
          </div>
          <div className="md:col-span-8">
            {options.data ? <EnquiryForm key={JSON.stringify(start)} options={options.data} initial={{ ...start, villaId: villa.id }} /> : <SiteLoading label="Loading the form" />}
          </div>
        </div>
      </section>

      {others.length > 0 && (
        <section aria-labelledby="others-title" className="mx-auto max-w-7xl px-6 py-24 md:px-12">
          <h2 id="others-title" className="s-serif text-4xl">
            Other villas
          </h2>
          <ul className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {others.map((o) => (
              <li key={o.id} className="s-lift">
                <Link to={`/stay/villas/${o.id}`} className="block">
                  <SiteImg photo={villaPhotos(o.id).hero} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 45vw, 100vw" ratio="4 / 3" />
                  <span className="s-label mt-4 block text-(--s-muted)">{o.location.name}</span>
                  <span className="s-serif mt-1 block text-2xl text-(--s-ink)">{o.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/** One key fact in huge display type; `small` for words and prices that would not fit the column. */
function Fact({ label, delay, small = false, children }: { label: string; delay: number; small?: boolean; children: ReactNode }) {
  return (
    <Reveal delay={delay} className="flex min-h-48 flex-col justify-between bg-(--s-cream) px-5 py-10 md:px-10 md:py-14">
      <dt className="s-label text-(--s-muted)">{label}</dt>
      <dd className={`s-display mt-4 break-words text-(--s-ink) ${small ? 'text-[clamp(1.35rem,3.2vw,2.6rem)] leading-tight' : 'text-[clamp(3.5rem,9vw,7.5rem)]'}`}>{children}</dd>
    </Reveal>
  )
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <h3 className="s-label text-(--s-terra)">{title}</h3>
      <ul className="mt-4 border-t border-(--s-line)">
        {items.map((i, n) => (
          <Reveal as="li" key={i} delay={n * 50} className="border-b border-(--s-line) py-3 text-(--s-ink)">
            {i}
          </Reveal>
        ))}
      </ul>
    </div>
  )
}

/** Photos in a row that snaps by picture; drag with the mouse, swipe on touch, or use the arrows. */
function Gallery({ name, photos }: { name: string; photos: readonly Photo[] }) {
  const track = useRef<HTMLUListElement>(null)
  const drag = useRef<{ x: number; left: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const scroll = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: 'smooth' })

  const down = (e: ReactPointerEvent<HTMLUListElement>) => {
    if (e.pointerType !== 'mouse' || !track.current) return
    drag.current = { x: e.clientX, left: track.current.scrollLeft }
  }
  const move = (e: ReactPointerEvent<HTMLUListElement>) => {
    if (!drag.current || !track.current) return
    const dx = e.clientX - drag.current.x
    if (!dragging && Math.abs(dx) > 4) {
      setDragging(true)
      track.current.setPointerCapture(e.pointerId)
    }
    track.current.scrollLeft = drag.current.left - dx
  }
  const up = () => {
    drag.current = null
    setDragging(false)
  }

  return (
    <section aria-labelledby="gallery-title" className="pb-24">
      <div className="mx-auto flex max-w-7xl items-end justify-between gap-6 px-6 md:px-12">
        <h2 id="gallery-title" className="s-serif text-4xl">
          Around {name}
        </h2>
        <div className="flex gap-2">
          <button type="button" className="inline-flex size-11 items-center justify-center rounded-full border border-(--s-line) text-(--s-ink) hover:bg-(--s-ink) hover:text-(--s-cream)" aria-label="Previous photos" onClick={() => scroll(-1)}>
            <ArrowLeft aria-hidden className="size-4" />
          </button>
          <button type="button" className="inline-flex size-11 items-center justify-center rounded-full border border-(--s-line) text-(--s-ink) hover:bg-(--s-ink) hover:text-(--s-cream)" aria-label="Next photos" onClick={() => scroll(1)}>
            <ArrowRight aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      <ul
        ref={track}
        className="s-snap mt-8 flex cursor-grab gap-4 overflow-x-auto px-6 select-none md:gap-6 md:px-12"
        data-dragging={dragging}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDragStart={(e) => e.preventDefault()}
        aria-label={`Photos of places like ${name}`}
      >
        {photos.map((p, i) => (
          <li key={p.id} className="w-[82vw] shrink-0 sm:w-[60vw] lg:w-[44vw]">
            <SiteImg photo={p} sizes="(min-width: 1024px) 44vw, (min-width: 640px) 60vw, 82vw" ratio={i % 2 ? '4 / 5' : '3 / 2'} className="max-h-[70svh]" />
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-4 max-w-7xl px-6 text-xs text-(--s-muted) md:px-12">Photos show villas like ours in Bali, not this villa.</p>
    </section>
  )
}

/** A room type with its from-price and the next fourteen nights. */
function RoomType({ type, onRequest }: { type: SiteRoomType; onRequest: () => void }) {
  return (
    <article aria-labelledby={`type-${type.id}`} className="grid gap-8 border-t border-(--s-line) pt-8 lg:grid-cols-12">
      <div className="lg:col-span-4">
        <h3 id={`type-${type.id}`} className="s-serif text-4xl leading-tight">
          {type.name}
        </h3>
        <p className="mt-2 text-sm text-(--s-muted)">
          {plural(type.bedrooms, 'bedroom')} · sleeps {type.sleeps} · {plural(type.rooms, 'room')} of this kind
        </p>
        <p className="mt-2 text-sm text-(--s-body)">{type.amenities.join(', ')}</p>
        {type.fromPrice !== null && (
          <p className="mt-5 text-sm text-(--s-muted)">
            From <CountMoney value={type.fromPrice} className="s-serif text-3xl text-(--s-ink)" /> a night
          </p>
        )}
        <button type="button" className={`${button()} mt-6`} onClick={onRequest}>
          Request this room
          <ArrowRight aria-hidden className="size-4" />
        </button>
      </div>
      <ol className="s-snap flex gap-px overflow-x-auto bg-(--s-line) lg:col-span-8 lg:grid lg:grid-cols-7" aria-label={`${type.name}, price a night for the next 14 nights`}>
        {type.strip.map((n) => (
          <li key={n.date} className="w-24 shrink-0 bg-(--s-cream) px-3 py-4 lg:w-auto">
            <span className="s-label block text-(--s-muted)">{shortWeekday(n.date)}</span>
            <span className="s-serif block text-2xl text-(--s-ink)">{Number(n.date.slice(8))}</span>
            <span className="mt-1 block text-xs text-(--s-body) tabular-nums">{moneyCompact(n.rate)}</span>
          </li>
        ))}
      </ol>
    </article>
  )
}

/** Dates and party in, free rooms and the total with service and PB1 out. */
function Checker({ villaId, today, onRequest }: { villaId: string; today: string; onRequest: (ask: Ask) => void }) {
  const { site } = useServices()
  const id = useId()
  const [draft, setDraft] = useState({ checkIn: addDays(today, 14), checkOut: addDays(today, 17), guests: 2 })
  const [query, setQuery] = useState(draft)
  const key = `${villaId}|${query.checkIn}|${query.checkOut}|${query.guests}`
  const result = useResource(`site.availability:${key}`, () => site.availability(villaId, query.checkIn, query.checkOut, query.guests))

  return (
    <section aria-labelledby="check-title" className="mx-auto max-w-7xl px-6 py-24 md:px-12">
      <SectionHead id="check-title" eyebrow="Availability" title="Check your dates" />
      <form
        className="mt-10 grid gap-6 sm:grid-cols-[1fr_1fr_0.7fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(draft)
        }}
      >
        <label htmlFor={`${id}-in`} className="block">
          <span className="s-label text-(--s-muted)">Check-in</span>
          <input id={`${id}-in`} type="date" className="s-field" min={today} value={draft.checkIn} onChange={(e) => setDraft({ ...draft, checkIn: e.target.value, checkOut: draft.checkOut > e.target.value ? draft.checkOut : addDays(e.target.value, 3) })} />
        </label>
        <label htmlFor={`${id}-out`} className="block">
          <span className="s-label text-(--s-muted)">Check-out</span>
          <input id={`${id}-out`} type="date" className="s-field" min={addDays(draft.checkIn || today, 1)} value={draft.checkOut} onChange={(e) => setDraft({ ...draft, checkOut: e.target.value })} />
        </label>
        <label htmlFor={`${id}-g`} className="block">
          <span className="s-label text-(--s-muted)">Guests</span>
          <select id={`${id}-g`} className="s-field" value={draft.guests} onChange={(e) => setDraft({ ...draft, guests: Number(e.target.value) })}>
            {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {plural(n, 'guest')}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={button()}>
          Check
        </button>
      </form>
      <div aria-live="polite" className="mt-10 space-y-8">
        {result.status === 'loading' && <p className="s-label text-(--s-muted)">Checking</p>}
        {result.status === 'error' && <p className="text-(--s-terra)">{result.error.message}</p>}
        {result.data?.problem && <p className="text-(--s-terra)">{result.data.problem}</p>}
        {result.status === 'ready' &&
          result.data.offers.map((o) => (
            <OfferCard key={o.groupId} offer={o} checkIn={query.checkIn} checkOut={query.checkOut} guests={query.guests} showVilla={false} onRequest={() => onRequest({ groupId: o.groupId, ...query })} />
          ))}
        {result.status === 'ready' && !result.data.problem && result.data.offers.length > 0 && (
          <ArrowLink to={`/stay/search?checkIn=${query.checkIn}&checkOut=${query.checkOut}&guests=${query.guests}&location=`}>See every villa for these dates</ArrowLink>
        )}
      </div>
    </section>
  )
}

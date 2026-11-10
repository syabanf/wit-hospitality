import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowRight, ArrowUpRight, Mail, MessageCircle } from 'lucide-react'
import type { SiteOffer } from '@/application/site'
import type { SiteContact } from '@/domain/site'
import type { Location } from '@/domain/property'
import { cn } from '@/lib/cn'
import { addDays, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useCountUp } from '../../hooks/useCountUp'
import { useReveal } from '../../hooks/useReveal'
import { useScrollProgress } from '../../hooks/useScrollProgress'
import { button, textLink, type LinkTone } from './buttons'
import { contactLines, searchQuery, type SearchValues } from './helpers'
import { CLOSING_PHOTO, photoSrcSet, photoUrl, villaPhotos, type Photo } from './photos'

export const WORDMARK = 'Bali Villas'

/**
 * How a photo loads. `lazy` for photos well below the fold; `early` for photos inside a clip-path
 * reveal, which start loading at once at low priority so they are there when the wipe runs;
 * `first` for the hero.
 */
type ImgLoad = 'lazy' | 'early' | 'first'
const imgLoad = (load: ImgLoad) => ({ loading: load === 'lazy' ? ('lazy' as const) : ('eager' as const), fetchPriority: load === 'first' ? ('high' as const) : load === 'early' ? ('low' as const) : undefined })

/** A photo with a stone placeholder and a fixed box so nothing shifts. */
export function SiteImg({ photo, sizes, ratio, load = 'lazy', className }: { photo: Photo; sizes: string; ratio?: string; load?: ImgLoad; className?: string }) {
  return (
    <div className={cn('relative overflow-hidden bg-(--s-stone)', className)} style={ratio ? { aspectRatio: ratio } : undefined}>
      <img src={photoUrl(photo, 1200)} srcSet={photoSrcSet(photo)} sizes={sizes} alt={photo.alt} width={1200} height={800} {...imgLoad(load)} decoding="async" className="absolute inset-0 size-full object-cover" />
    </div>
  )
}

/** A photo filling its positioned parent, for full-bleed sections with text set on it. */
export function CoverImg({ photo, sizes = '100vw', load = 'lazy', className }: { photo: Photo; sizes?: string; load?: ImgLoad; className?: string }) {
  return <img src={photoUrl(photo, 1800)} srcSet={photoSrcSet(photo, [800, 1200, 1800, 2400])} sizes={sizes} alt={photo.alt} width={1800} height={1200} {...imgLoad(load)} decoding="async" className={cn('absolute inset-0 size-full bg-(--s-ink) object-cover', className)} />
}

export type RevealKind = 'fade' | 'wipe-up'

/** A block that animates in the first time it scrolls into view. */
export function Reveal({ kind = 'fade', delay = 0, className, children, as: Tag = 'div' }: { kind?: RevealKind; delay?: number; className?: string; children: ReactNode; as?: 'div' | 'li' | 'p' | 'span' }) {
  const [ref, shown] = useReveal<HTMLElement>()
  return (
    <Tag ref={ref as never} data-reveal={kind} data-shown={shown} className={className} style={{ '--delay': `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
  )
}

/** A block that drifts against the scroll at its own speed (rem across the viewport); still under reduced motion. */
export function Float({ speed, className, children }: { speed: number; className?: string; children: ReactNode }) {
  const ref = useScrollProgress<HTMLDivElement>()
  return (
    <div ref={ref} className={cn('s-float', className)} style={{ '--speed': speed } as CSSProperties}>
      {children}
    </div>
  )
}

/** Rupiah that counts up once it scrolls into view. */
export function CountMoney({ value, className }: { value: number; className?: string }) {
  const [ref, shown] = useReveal<HTMLSpanElement>()
  const shownValue = useCountUp(value, shown, { step: 10_000 })
  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      <span aria-hidden>{money(shownValue)}</span>
      <span className="sr-only">{money(value)}</span>
    </span>
  )
}

/** A whole number that counts up once it scrolls into view. */
export function CountNumber({ value, className }: { value: number; className?: string }) {
  const [ref, shown] = useReveal<HTMLSpanElement>()
  const shownValue = useCountUp(value, shown, { duration: 1200 })
  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      <span aria-hidden>{shownValue}</span>
      <span className="sr-only">{value}</span>
    </span>
  )
}

/** Closed contour rings around a few peaks, like a survey map; drawn once. */
const CONTOURS = (() => {
  const peaks = [
    { x: 180, y: 160, r: 26, rings: 9, k: 0.7 },
    { x: 860, y: 420, r: 30, rings: 11, k: 1.9 },
    { x: 520, y: 760, r: 22, rings: 7, k: 3.1 },
  ]
  const paths: string[] = []
  for (const p of peaks) {
    for (let ring = 1; ring <= p.rings; ring++) {
      const points = Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2
        const wobble = 1 + 0.16 * Math.sin(3 * a + p.k + ring * 0.35) + 0.08 * Math.sin(5 * a - p.k * 2 + ring * 0.2)
        const r = p.r * ring * wobble
        return `${(p.x + r * Math.cos(a)).toFixed(1)} ${(p.y + r * 0.8 * Math.sin(a)).toFixed(1)}`
      })
      paths.push(`M${points.join('L')}Z`)
    }
  }
  return paths
})()

/** The faint contour-line pattern laid over the dark green sections. */
export function Contours({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 1000 900" preserveAspectRatio="xMidYMid slice" className={cn('pointer-events-none absolute inset-0 -z-10 size-full text-(--s-cream) opacity-[0.09]', className)}>
      {CONTOURS.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
}

type Surface = 'light' | 'dark'

/** A side label with a rule, a serif heading and an italic lead, the way every section opens. */
export function SectionHead({ id, eyebrow, title, lead, surface = 'light', className, children }: { id: string; eyebrow: string; title: ReactNode; lead?: string; surface?: Surface; className?: string; children?: ReactNode }) {
  const dark = surface === 'dark'
  return (
    <div className={cn('max-w-3xl', className)}>
      <Reveal as="p" className={cn('s-label s-eyebrow', dark ? 'text-(--s-sand)' : 'text-(--s-terra)')}>
        {eyebrow}
      </Reveal>
      <Reveal delay={80}>
        <h2 id={id} className={cn('s-serif mt-4 text-[2.5rem] leading-[1.02] sm:text-6xl', dark ? 'text-(--s-cream)' : 'text-(--s-ink)')}>
          {title}
        </h2>
      </Reveal>
      {lead && (
        <Reveal as="p" delay={140} className={cn('s-italic mt-4 text-2xl leading-snug', dark ? 'text-(--s-sand)' : 'text-(--s-body)')}>
          {lead}
        </Reveal>
      )}
      {children && (
        <Reveal delay={200} className={cn('mt-5 max-w-xl text-base leading-relaxed', dark ? 'text-(--s-cream)/85' : 'text-(--s-body)')}>
          {children}
        </Reveal>
      )}
    </div>
  )
}

export function ArrowLink({ to, tone = 'dark', children, className }: { to: string; tone?: LinkTone; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn(textLink(tone), className)}>
      {children}
      <ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-1" />
    </Link>
  )
}

/**
 * Location, dates and party: the availability search that opens the results page. `solid` is a
 * cream card; `strip` is the slim glass bar pinned to the bottom of a photo hero.
 */
export function SearchCard({ locations, today, initial, variant = 'solid', className }: { locations: readonly Location[]; today: string; initial?: Partial<SearchValues>; variant?: 'solid' | 'strip'; className?: string }) {
  const id = useId()
  const navigate = useNavigate()
  const [v, setV] = useState<SearchValues>({ location: initial?.location ?? '', checkIn: initial?.checkIn || addDays(today, 14), checkOut: initial?.checkOut || addDays(today, 17), guests: initial?.guests ?? 2 })
  const set = (patch: Partial<SearchValues>) => setV((x) => ({ ...x, ...patch }))
  const strip = variant === 'strip'
  const label = cn('s-label', strip ? 'text-(--s-cream)/85' : 'text-(--s-muted)')

  return (
    <form
      role="search"
      aria-label="Find a villa"
      className={cn(
        'grid gap-x-6 gap-y-4',
        strip ? 's-glass grid-cols-[auto_1.3fr_1fr_1fr_0.8fr_auto] items-end px-6 py-4' : 'bg-(--s-cream) p-5 text-(--s-ink) shadow-[0_30px_60px_-30px_rgb(22_32_27/0.45)] sm:grid-cols-2 sm:p-6 lg:grid-cols-[1.3fr_1fr_1fr_0.8fr_auto] lg:items-end',
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault()
        navigate(`/stay/search?${searchQuery(v)}`)
      }}
    >
      {strip && <p className="s-label self-center pr-2 text-(--s-cream)">Book with us</p>}
      <label className="block" htmlFor={`${id}-loc`}>
        <span className={label}>Location</span>
        <select id={`${id}-loc`} className="s-field" value={v.location} onChange={(e) => set({ location: e.target.value })}>
          <option value="">Anywhere in Bali</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block" htmlFor={`${id}-in`}>
        <span className={label}>Check-in</span>
        <input
          id={`${id}-in`}
          type="date"
          className="s-field"
          min={today}
          value={v.checkIn}
          required
          onChange={(e) => {
            const checkIn = e.target.value
            set({ checkIn, checkOut: v.checkOut > checkIn ? v.checkOut : addDays(checkIn, 3) })
          }}
        />
      </label>
      <label className="block" htmlFor={`${id}-out`}>
        <span className={label}>Check-out</span>
        <input id={`${id}-out`} type="date" className="s-field" min={v.checkIn ? addDays(v.checkIn, 1) : today} value={v.checkOut} required onChange={(e) => set({ checkOut: e.target.value })} />
      </label>
      <label className="block" htmlFor={`${id}-guests`}>
        <span className={label}>Guests</span>
        <select id={`${id}-guests`} className="s-field" value={v.guests} onChange={(e) => set({ guests: Number(e.target.value) })}>
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {plural(n, 'guest')}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={cn(button({ tone: strip ? 'cream' : 'ink' }), !strip && 'sm:col-span-2 lg:col-span-1')}>
        Search
        <ArrowRight aria-hidden className="size-4" />
      </button>
    </form>
  )
}

/** One room type free for the stay, with its quote: the card the search and the villa checker share. */
export function OfferCard({ offer, checkIn, checkOut, guests, showVilla = true, onRequest }: { offer: SiteOffer; checkIn: string; checkOut: string; guests: number; showVilla?: boolean; onRequest?: () => void }) {
  const q = offer.quote
  const nights = q?.nights.length ?? 0
  const ask = new URLSearchParams({ villa: offer.villa.id, group: offer.groupId, checkIn, checkOut, guests: String(guests) }).toString()
  const sells = offer.free > 0 && offer.fits && offer.rules.length === 0 && q !== null
  const requestClass = button({ tone: sells ? 'ink' : 'ghost-dark', size: 'sm' })
  return (
    <article className="s-lift grid gap-5 border-t border-(--s-line) pt-6 sm:grid-cols-[minmax(0,14rem)_1fr] lg:grid-cols-[minmax(0,18rem)_1fr_auto] lg:items-end">
      {showVilla && <SiteImg photo={villaPhotos(offer.villa.id).hero} sizes="(min-width: 1024px) 18rem, (min-width: 640px) 14rem, 100vw" ratio="4 / 3" />}
      <div className={cn('min-w-0', !showVilla && 'sm:col-span-2 lg:col-span-1')}>
        {showVilla && <p className="s-label text-(--s-muted)">{offer.villa.location.name}</p>}
        <h3 className="s-serif mt-1 text-3xl leading-tight">{showVilla ? offer.villa.name : offer.name}</h3>
        <p className="mt-1 text-sm text-(--s-muted)">
          {showVilla && `${offer.name} · `}Sleeps {offer.sleeps} · {offer.free > 0 ? `${plural(offer.free, 'room')} free` : 'Full for these dates'}
        </p>
        {offer.rules.map((r) => (
          <p key={r} className="mt-2 text-sm text-(--s-terra)">
            {r}
          </p>
        ))}
        {!offer.fits && <p className="mt-2 text-sm text-(--s-terra)">One room sleeps {offer.sleeps}. For a larger party, send a request and we will combine rooms.</p>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4 sm:col-span-2 lg:col-span-1 lg:flex-col lg:items-end">
        {q && (
          <div className="lg:text-right">
            <p className="s-serif text-3xl tabular-nums">{money(q.total)}</p>
            <p className="text-xs text-(--s-muted)">
              {plural(nights, 'night')}, {shortDay(checkIn)} to {shortDay(checkOut)} · about {money(q.perNight)} a night
            </p>
            <p className="text-xs text-(--s-muted)">
              Room {money(q.net)}
              {q.service > 0 && ` · service ${money(q.service)}`}
              {q.pb1 > 0 && ` · PB1 ${money(q.pb1)}`}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {showVilla && (
            <Link to={`/stay/villas/${offer.villa.id}`} className={textLink()}>
              Discover
            </Link>
          )}
          {onRequest ? (
            <button type="button" className={requestClass} onClick={onRequest}>
              Request to book <span className="sr-only">{offer.name}</span>
              <ArrowRight aria-hidden className="size-4" />
            </button>
          ) : (
            <Link to={`/stay/enquire?${ask}`} className={requestClass}>
              Request to book <span className="sr-only">{offer.name}</span>
              <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          )}
        </div>
      </div>
    </article>
  )
}

/** The closing band: guests write or request a stay, owners ask about management. Text sits on a scrim over the photo. */
export function ContactBand({ contact }: { contact: SiteContact | null | undefined }) {
  const lines = contactLines(contact ?? undefined)
  return (
    <section id="talk" aria-labelledby="talk-title" className="on-dark relative isolate overflow-hidden bg-(--s-ink) text-(--s-cream)">
      <CoverImg photo={CLOSING_PHOTO} className="-z-20" />
      <div aria-hidden className="s-scrim-full absolute inset-0 -z-10" />
      <div className="mx-auto max-w-7xl px-6 py-24 md:px-12 md:py-32">
        <Reveal as="p" className="s-label s-eyebrow text-(--s-sand)">
          Contact
        </Reveal>
        <Reveal delay={80}>
          <h2 id="talk-title" className="s-display mt-5 max-w-4xl text-[clamp(2.75rem,8vw,6.5rem)] text-(--s-cream)">
            Write to us, a person answers
          </h2>
        </Reveal>
        <div className="mt-14 grid gap-10 md:grid-cols-2">
          <Reveal className="s-glass p-6 md:p-8">
            <h3 className="s-serif text-3xl text-(--s-cream)">Planning a stay</h3>
            <p className="s-italic mt-2 text-xl text-(--s-cream)/90">The reservations team replies the same day, in English or Bahasa Indonesia.</p>
            <ul className="mt-6 space-y-2 text-sm">
              {[
                { name: 'WhatsApp', line: lines.whatsapp, Icon: MessageCircle },
                { name: 'Email', line: lines.email, Icon: Mail },
              ].map(({ name, line, Icon }) => (
                <li key={name} className="flex items-center gap-3">
                  <Icon aria-hidden className="size-4 shrink-0 text-(--s-sand)" />
                  <span className="sr-only">{name}:</span>
                  {line.href ? (
                    <a href={line.href} className="underline-offset-4 hover:underline">
                      {line.label}
                    </a>
                  ) : (
                    <span>
                      {line.label} <span className="text-(--s-sand)">(placeholder, not yet set in the console)</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <Link to="/stay/enquire" className={cn(button({ tone: 'cream' }), 'mt-8')}>
              Request to book
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Reveal>
          <Reveal delay={120} className="s-glass p-6 md:p-8">
            <h3 className="s-serif text-3xl text-(--s-cream)">Own a villa in Bali</h3>
            <p className="s-italic mt-2 text-xl text-(--s-cream)/90">Tell us where it is and how many rooms it has. We visit before we propose anything.</p>
            <p className="mt-6 text-sm leading-relaxed text-(--s-cream)/85">We take on management, revenue, housekeeping, maintenance and the monthly statement, and you follow it all in the owner portal.</p>
            <Link to="/stay/enquire?topic=owner" className={cn(button({ tone: 'ghost-light' }), 'mt-8')}>
              Talk to us about your villa
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

/** The cream page while data loads, the height of a screen so the footer does not jump up. */
export function SiteLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="grid min-h-[80svh] place-items-center px-6">
      <span className="s-label animate-pulse text-(--s-muted)">{label}</span>
    </div>
  )
}

/** A failed load or an unknown villa, with a way back. */
export function SiteProblem({ title, children, onRetry }: { title: string; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-auto flex min-h-[70svh] max-w-xl flex-col items-start justify-center gap-5 px-6 pt-24">
      <h1 className="s-serif text-5xl">{title}</h1>
      {children && <p className="text-(--s-body)">{children}</p>}
      <div className="flex flex-wrap gap-3">
        {onRetry && (
          <button type="button" className={button()} onClick={onRetry}>
            Try again
          </button>
        )}
        <Link to="/stay" className={button({ tone: 'ghost-dark' })}>
          Back to the villas
        </Link>
      </div>
    </div>
  )
}

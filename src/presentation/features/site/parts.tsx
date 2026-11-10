import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import type { SiteOffer } from '@/application/site'
import type { Location } from '@/domain/property'
import { cn } from '@/lib/cn'
import { addDays, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useCountUp } from '../../hooks/useCountUp'
import { useReveal } from '../../hooks/useReveal'
import { searchQuery, type SearchValues } from './helpers'
import { photoSrcSet, photoUrl, villaPhotos, type Photo } from './photos'

export const WORDMARK = 'Bali Villas'


/** A photo with a cream placeholder, a fixed box so nothing shifts, and lazy loading below the fold. */
export function SiteImg({ photo, sizes, ratio, priority = false, className, imgClassName }: { photo: Photo; sizes: string; ratio?: string; priority?: boolean; className?: string; imgClassName?: string }) {
  return (
    <div className={cn('relative overflow-hidden bg-(--s-stone)', className)} style={ratio ? { aspectRatio: ratio } : undefined}>
      <img
        src={photoUrl(photo, 1200)}
        srcSet={photoSrcSet(photo)}
        sizes={sizes}
        alt={photo.alt}
        width={1200}
        height={800}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : undefined}
        decoding="async"
        className={cn('absolute inset-0 size-full object-cover', imgClassName)}
      />
    </div>
  )
}

export type RevealKind = 'fade' | 'slide' | 'slide-right' | 'wipe' | 'wipe-left'

/** A block that animates in the first time it scrolls into view. */
export function Reveal({ kind = 'fade', delay = 0, className, children, as: Tag = 'div' }: { kind?: RevealKind; delay?: number; className?: string; children: ReactNode; as?: 'div' | 'li' | 'p' | 'span' }) {
  const [ref, shown] = useReveal<HTMLElement>()
  return (
    <Tag ref={ref as never} data-reveal={kind} data-shown={shown} className={className} style={{ '--delay': `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
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

/** Small uppercase label over a serif heading, the way every section opens. */
export function SectionHead({ id, eyebrow, title, className, children }: { id: string; eyebrow: string; title: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={cn('max-w-3xl', className)}>
      <Reveal as="p" className="s-label text-(--s-terra)">
        {eyebrow}
      </Reveal>
      <Reveal delay={80}>
        <h2 id={id} className="s-serif mt-3 text-[2.5rem] leading-[1.02] sm:text-6xl">
          {title}
        </h2>
      </Reveal>
      {children && (
        <Reveal delay={160} className="mt-5 max-w-xl text-base leading-relaxed text-(--s-body)">
          {children}
        </Reveal>
      )}
    </div>
  )
}

export const linkArrow = 'group inline-flex items-center gap-2 border-b border-current pb-1 text-sm font-semibold tracking-wide text-(--s-ink) transition-colors hover:text-(--s-terra)'
export const solidButton = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-(--s-ink) px-6 text-sm font-semibold tracking-wide text-(--s-cream) transition-colors hover:bg-(--s-terra) disabled:opacity-60'
export const ghostButton = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-current px-6 text-sm font-semibold tracking-wide transition-colors hover:bg-(--s-ink) hover:text-(--s-cream)'

export function ArrowLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn(linkArrow, className)}>
      {children}
      <ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-1" />
    </Link>
  )
}




/** Location, dates and party: the availability search that opens the results page. */
export function SearchCard({ locations, today, initial, className, style }: { locations: readonly Location[]; today: string; initial?: Partial<SearchValues>; className?: string; style?: CSSProperties }) {
  const id = useId()
  const navigate = useNavigate()
  const [v, setV] = useState<SearchValues>({ location: initial?.location ?? '', checkIn: initial?.checkIn || addDays(today, 14), checkOut: initial?.checkOut || addDays(today, 17), guests: initial?.guests ?? 2 })
  const set = (patch: Partial<SearchValues>) => setV((x) => ({ ...x, ...patch }))

  return (
    <form
      role="search"
      aria-label="Find a villa"
      className={cn('grid gap-x-6 gap-y-4 bg-(--s-cream) p-5 text-(--s-ink) shadow-[0_30px_60px_-30px_rgb(22_32_27/0.45)] sm:grid-cols-2 sm:p-6 lg:grid-cols-[1.3fr_1fr_1fr_0.8fr_auto] lg:items-end', className)}
      style={style}
      onSubmit={(e) => {
        e.preventDefault()
        navigate(`/stay/search?${searchQuery(v)}`)
      }}
    >
      <label className="block" htmlFor={`${id}-loc`}>
        <span className="s-label text-(--s-muted)">Location</span>
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
        <span className="s-label text-(--s-muted)">Check-in</span>
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
        <span className="s-label text-(--s-muted)">Check-out</span>
        <input id={`${id}-out`} type="date" className="s-field" min={v.checkIn ? addDays(v.checkIn, 1) : today} value={v.checkOut} required onChange={(e) => set({ checkOut: e.target.value })} />
      </label>
      <label className="block" htmlFor={`${id}-guests`}>
        <span className="s-label text-(--s-muted)">Guests</span>
        <select id={`${id}-guests`} className="s-field" value={v.guests} onChange={(e) => set({ guests: Number(e.target.value) })}>
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {plural(n, 'guest')}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={cn(solidButton, 'sm:col-span-2 lg:col-span-1')}>
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
            <Link to={`/stay/villas/${offer.villa.id}`} className={linkArrow}>
              Discover
            </Link>
          )}
          {onRequest ? (
            <button type="button" className={cn(sells ? solidButton : ghostButton, 'min-h-11 px-5')} onClick={onRequest}>
              Request to book <span className="sr-only">{offer.name}</span>
              <ArrowRight aria-hidden className="size-4" />
            </button>
          ) : (
            <Link to={`/stay/enquire?${ask}`} className={cn(sells ? solidButton : ghostButton, 'min-h-11 px-5')}>
              Request to book <span className="sr-only">{offer.name}</span>
              <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          )}
        </div>
      </div>
    </article>
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
          <button type="button" className={solidButton} onClick={onRetry}>
            Try again
          </button>
        )}
        <Link to="/stay" className={ghostButton}>
          Back to the villas
        </Link>
      </div>
    </div>
  )
}

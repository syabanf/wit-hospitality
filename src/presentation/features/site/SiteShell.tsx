import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { Mail, Menu, MessageCircle, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { button } from './buttons'
import { contactLines, type SiteFrame } from './helpers'
import { WORDMARK } from './parts'
import { MENU_PHOTO, photoUrl } from './photos'
import './site.css'

/** Header height in px: the hero counts as passed once its bottom edge goes under the header. */
const HEADER = 72

const NAV = [
  { to: '/stay#villas', label: 'Villas' },
  { to: '/stay/about', label: 'About' },
  { to: '/stay#services', label: 'Services' },
  { to: '/stay#day', label: 'A day here' },
]

const MENU_LINKS = [
  { to: '/stay', label: 'Home' },
  { to: '/stay/about', label: 'About us' },
  { to: '/stay#villas', label: 'Our villas' },
  { to: '/stay#services', label: 'Services' },
  { to: '/stay#how', label: 'For owners' },
  { to: '/stay/search', label: 'Find dates' },
]

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The public website's frame: a header that is transparent over a page's photo hero and frosted
 * after it, a menu overlay, contact buttons on the right edge (a Book bar on phones), and a
 * two-line footer. No console chrome and no sign-in: everything under it reads the public site use cases.
 */
export default function SiteShell() {
  const { site } = useServices()
  const options = useResource('site.enquiryOptions', () => site.enquiryOptions())
  const { pathname, hash, key } = useLocation()
  // The menu remembers the page it opened on, so following any link closes it.
  const [menuOn, setMenuOn] = useState<string | null>(null)
  const menu = menuOn === key
  const menuButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [hero, setHero] = useState<HTMLElement | null>(null)
  const [heroUnder, setHeroUnder] = useState(false)
  const overHero = hero !== null && heroUnder
  const contact = contactLines(options.data?.contact)
  const year = options.data?.today.slice(0, 4)
  const heroRef = useCallback((el: HTMLElement | null) => setHero(el), [])
  const frame: SiteFrame = { heroRef }
  const booking = pathname === '/stay/enquire' || pathname === '/stay/thanks'

  // A new page starts at the top; a link to a section waits for it to render, then scrolls to it.
  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0)
      return
    }
    let tries = 0
    let frame = requestAnimationFrame(function find() {
      const target = document.getElementById(hash.slice(1))
      if (target) target.scrollIntoView()
      else if (tries++ < 120) frame = requestAnimationFrame(find)
    })
    return () => cancelAnimationFrame(frame)
  }, [pathname, hash])

  // Transparent while the page's hero is under the header, frosted after it and on pages without one.
  useEffect(() => {
    if (!hero) return
    let frame = 0
    const update = () => {
      frame = 0
      setHeroUnder(hero.getBoundingClientRect().bottom > HEADER)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [hero])

  // While the menu is open: focus its first link, keep Tab inside it, close on Escape, lock the page.
  // On close, focus goes back to the menu button.
  useEffect(() => {
    if (!menu) return
    const opener = menuButton.current
    panel.current?.querySelector<HTMLElement>('a')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOn(null)
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) return
      if (e.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      opener?.focus()
    }
  }, [menu])

  return (
    <div className="site min-h-dvh pb-16 lg:pb-0">
      <a href="#site-main" className="sr-only z-50 rounded-full bg-(--s-ink) px-4 py-2 text-(--s-cream) focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <header className={cn('fixed inset-x-0 top-0 z-30 transition-colors duration-500', overHero ? 'on-dark text-(--s-cream)' : 's-frost text-(--s-ink)')}>
        <div className="mx-auto grid h-16 grid-cols-[1fr_auto] items-center gap-4 px-5 md:h-18 md:px-10 lg:grid-cols-[1fr_auto_1fr]">
          <Link to="/stay" className="flex flex-col justify-self-start leading-none">
            <span className="s-serif text-xl text-current">{WORDMARK}</span>
            <span className="s-label mt-1 hidden text-[0.6rem] opacity-80 sm:block">Villa operator, Bali</span>
          </Link>
          <nav aria-label="Main" className="hidden lg:block">
            <ul className="flex gap-8">
              {NAV.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="s-label tracking-[0.24em] underline-offset-8 hover:underline">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex items-center gap-2 justify-self-end">
            <span className="hidden sm:contents">
              <Link to="/stay/enquire" className={button({ tone: overHero ? 'cream' : 'ink', size: 'sm' })}>
                Book
              </Link>
            </span>
            <button ref={menuButton} type="button" className="inline-flex min-h-11 items-center gap-2 px-2 s-label tracking-[0.24em]" aria-expanded={menu} aria-controls="site-menu" onClick={() => setMenuOn(key)}>
              <Menu aria-hidden className="size-5" />
              Menu
            </button>
          </div>
        </div>
      </header>

      <div id="site-menu" hidden={!menu} className="fixed inset-0 z-40">
        <div aria-hidden className="s-menu-back absolute inset-0" onClick={() => setMenuOn(null)} />
        <div ref={panel} role="dialog" aria-modal="true" aria-label="Site menu" className="s-menu-panel on-dark absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col overflow-y-auto bg-(--s-forest) px-6 py-6 text-(--s-cream) md:px-12">
          <div className="flex items-center justify-between">
            <span className="s-serif text-xl text-(--s-cream)">{WORDMARK}</span>
            <button type="button" className="inline-flex size-11 items-center justify-center rounded-full border border-(--s-cream)/40" aria-label="Close the menu" onClick={() => setMenuOn(null)}>
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <nav aria-label="Site" className="mt-10 grid flex-1 gap-10 md:grid-cols-[1.3fr_1fr]">
            <ul className="space-y-1">
              {MENU_LINKS.map((l, i) => (
                <li key={l.to} className="s-rise" style={{ animationDelay: `${120 + i * 60}ms` }}>
                  <Link to={l.to} className="s-serif block text-5xl leading-tight text-(--s-cream) transition-colors hover:text-(--s-sand) sm:text-6xl">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="space-y-8">
              <img src={photoUrl(MENU_PHOTO, 600)} alt={MENU_PHOTO.alt} width={600} height={400} loading="lazy" decoding="async" className="aspect-[4/3] w-full max-w-xs bg-(--s-ink) object-cover" />
              <div>
                <p className="s-label text-(--s-sand)">The villas</p>
                <ul className="mt-3 space-y-1">
                  {options.data?.villas.map((v) => (
                    <li key={v.id}>
                      <NavLink to={`/stay/villas/${v.id}`} className="s-serif text-xl text-(--s-cream) hover:text-(--s-sand)">
                        {v.name}
                      </NavLink>
                      <span className="ml-2 text-sm text-(--s-cream)/75">{v.location.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-1 text-sm">
                <p className="s-label text-(--s-sand)">Contact</p>
                <ContactLink kind="WhatsApp" line={contact.whatsapp} />
                <ContactLink kind="Email" line={contact.email} />
              </div>
            </div>
          </nav>
        </div>
      </div>

      <main id="site-main" tabIndex={-1} className={cn('outline-none', !hero && 'pt-16 md:pt-18')}>
        <Outlet context={frame} />
      </main>

      <aside aria-label="Contact" className="fixed top-1/2 right-2 z-20 hidden -translate-y-1/2 flex-col gap-2 lg:flex">
        {[
          { kind: 'WhatsApp', line: contact.whatsapp, Icon: MessageCircle },
          { kind: 'Email', line: contact.email, Icon: Mail },
        ].map(({ kind, line, Icon }) => (
          <a key={kind} href={line.href ?? '#contact'} aria-label={line.placeholder ? `${kind}, not yet set` : `${kind} ${line.label}`} className="inline-flex size-10 items-center justify-center rounded-full border border-(--s-cream)/40 bg-(--s-ink) text-(--s-cream) shadow-lg transition-colors hover:bg-(--s-terra)">
            <Icon aria-hidden className="size-4" />
          </a>
        ))}
      </aside>

      {!booking && (
        <nav aria-label="Book" className="s-frost fixed inset-x-0 bottom-0 z-20 grid grid-cols-2 gap-3 px-4 py-3 lg:hidden">
          <Link to="/stay/search" className={button({ tone: 'ghost-dark', size: 'sm' })}>
            Find dates
          </Link>
          <Link to="/stay/enquire" className={button({ tone: 'ink', size: 'sm' })}>
            Book
          </Link>
        </nav>
      )}

      <footer id="contact" className="on-dark bg-(--s-forest) text-(--s-cream)">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-10 gap-y-5 px-6 pt-12 pb-6 md:px-12">
          <Link to="/stay" className="s-serif text-2xl text-(--s-cream)">
            {WORDMARK}
          </Link>
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {[...NAV.slice(0, 3), { to: '/stay/search', label: 'Find dates' }].map((l) => (
              <li key={l.to}>
                <Link to={l.to} className="s-label tracking-[0.22em] underline-offset-4 hover:underline">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm md:ml-auto">
            <ContactLink kind="Email" line={contact.email} />
            <ContactLink kind="WhatsApp" line={contact.whatsapp} />
          </div>
        </div>
        <div className="mx-auto flex max-w-7xl flex-wrap gap-x-6 gap-y-2 border-t border-(--s-line-light) px-6 py-5 text-xs text-(--s-cream)/80 md:px-12">
          <span>
            © {year && `${year} `}
            {WORDMARK}
          </span>
          <Link to="/stay/credits" className="underline underline-offset-4">
            Photo credits
          </Link>
          <Link to="/login" className="underline underline-offset-4">
            Staff sign in
          </Link>
        </div>
      </footer>
    </div>
  )
}

function ContactLink({ kind, line }: { kind: string; line: ReturnType<typeof contactLines>['email'] }) {
  return (
    <p>
      <span className="sr-only">{kind}: </span>
      {line.href ? (
        <a href={line.href} className="underline-offset-4 hover:underline">
          {line.label}
        </a>
      ) : (
        <span>
          {line.label} <span className="text-(--s-sand)">(placeholder)</span>
        </span>
      )}
    </p>
  )
}

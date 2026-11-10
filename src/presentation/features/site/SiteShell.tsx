import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { WORDMARK } from './parts'
import { contactLines } from './helpers'
import './site.css'

/**
 * The public website's frame: a top bar with the wordmark and the MENU and CONTACT corners, a menu
 * that covers the page, and the footer with contact and a cropped wordmark. No console chrome and
 * no sign-in: everything under it reads the public site use cases.
 */
export default function SiteShell() {
  const { site } = useServices()
  const options = useResource('site.enquiryOptions', () => site.enquiryOptions())
  const { pathname, hash, key } = useLocation()
  const home = pathname === '/stay'
  // The menu remembers the page it opened on, so following any link closes it.
  const [menuOn, setMenuOn] = useState<string | null>(null)
  const menu = menuOn === key
  const setMenu = (open: boolean) => setMenuOn(open ? key : null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const contact = contactLines(options.data?.contact)

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

  useEffect(() => {
    if (!menu) return
    panel.current?.querySelector<HTMLElement>('a')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOn(null)
        menuButton.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [menu])

  const links = [
    { to: '/stay#villas', label: 'Villas' },
    { to: '/stay#day', label: 'A day here' },
    { to: '/stay#experiences', label: 'Experiences' },
    { to: '/stay/search', label: 'Find dates' },
    { to: '/stay/enquire', label: 'Request to book' },
  ]

  return (
    <div className="site min-h-dvh">
      <a href="#site-main" className="sr-only z-50 rounded-full bg-(--s-ink) px-4 py-2 text-(--s-cream) focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <header className={cn('inset-x-0 top-0 z-30', home ? 'on-dark absolute text-(--s-cream)' : 'sticky border-b border-(--s-line) bg-(--s-cream)/95 text-(--s-ink) backdrop-blur')}>
        <div className={cn('mx-auto grid h-16 grid-cols-[1fr_auto_1fr] items-center px-6 md:h-20', home && 'md:px-12 md:pt-6')}>
          <button ref={menuButton} type="button" className="s-label justify-self-start py-3 tracking-[0.24em]" aria-expanded={menu} aria-controls="site-menu" onClick={() => setMenu(true)}>
            Menu
          </button>
          <Link to="/stay" className={cn('s-serif text-2xl leading-none text-current md:text-[1.75rem]', home && 'sr-only')}>
            {WORDMARK}
          </Link>
          <a href="#contact" className="s-label justify-self-end py-3 tracking-[0.24em]">
            Contact
          </a>
        </div>
      </header>

      <div
        id="site-menu"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        hidden={!menu}
        className="on-dark fixed inset-0 z-40 overflow-y-auto bg-(--s-ink) px-6 py-6 text-(--s-cream) md:px-12"
      >
        <div className="flex items-center justify-between">
          <span className="s-serif text-2xl text-(--s-cream)">{WORDMARK}</span>
          <button
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-full border border-(--s-cream)/40"
            aria-label="Close the menu"
            onClick={() => {
              setMenu(false)
              menuButton.current?.focus()
            }}
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <nav aria-label="Site" className="mt-12 grid gap-10 md:grid-cols-[1.4fr_1fr]">
          <ul className="space-y-2">
            {links.map((l, i) => (
              <li key={l.to} className="s-rise" style={{ animationDelay: `${i * 60}ms` }}>
                <Link to={l.to} className="s-display block text-5xl text-(--s-cream) transition-colors hover:text-(--s-sand) sm:text-7xl">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <div>
            <p className="s-label text-(--s-sand)">The villas</p>
            <ul className="mt-4 space-y-2">
              {options.data?.villas.map((v) => (
                <li key={v.id}>
                  <NavLink to={`/stay/villas/${v.id}`} className="s-serif text-2xl text-(--s-cream) hover:text-(--s-sand)">
                    {v.name}
                  </NavLink>
                  <span className="ml-2 text-sm text-(--s-cream)/70">{v.location.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>

      <main id="site-main" tabIndex={-1} className="outline-none">
        <Outlet />
      </main>

      <footer id="contact" className="on-dark relative overflow-hidden bg-(--s-ink) text-(--s-cream)">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 pt-20 pb-10 md:grid-cols-[1.5fr_1fr_1fr] md:px-12">
          <div>
            <p className="s-serif text-4xl leading-tight text-(--s-cream) sm:text-5xl">Write to us, a person answers.</p>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-(--s-cream)/80">The reservations team replies by WhatsApp or email, usually the same day, in English or Bahasa Indonesia.</p>
          </div>
          <div>
            <h2 className="s-label text-(--s-sand)">Contact</h2>
            <ul className="mt-4 space-y-3 text-sm">
              {[
                { name: 'WhatsApp', line: contact.whatsapp },
                { name: 'Email', line: contact.email },
              ].map(({ name, line }) => (
                <li key={name}>
                  <span className="block text-(--s-cream)/70">{name}</span>
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
          </div>
          <div>
            <h2 className="s-label text-(--s-sand)">Explore</h2>
            <ul className="mt-4 space-y-2 text-sm">
              {links.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="underline-offset-4 hover:underline">
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link to="/stay/credits" className="underline-offset-4 hover:underline">
                  Photos: Unsplash
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="mx-auto flex max-w-7xl flex-wrap justify-between gap-2 px-6 text-xs text-(--s-cream)/70 md:px-12">
          <span>balivillas.id</span>
          <span>
            Prices in rupiah. <Link to="/stay/credits" className="underline underline-offset-4">Photos: Unsplash</Link>
          </span>
        </div>
        <p aria-hidden className="s-display pointer-events-none -mb-[0.2em] mt-6 text-center text-[14.5vw] whitespace-nowrap text-(--s-terra) select-none">
          {WORDMARK}
        </p>
      </footer>
    </div>
  )
}

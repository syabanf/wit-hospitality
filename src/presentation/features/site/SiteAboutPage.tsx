import { Link } from 'react-router'
import { MapPin } from 'lucide-react'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { GUEST_SERVICES, HOW_WE_WORK, listWords, numberWord, OWNER_SERVICES } from './content'
import { useHeroRef, useTitle } from './helpers'
import { ContactBand, Contours, CountNumber, CoverImg, Float, Reveal, SectionHead, SiteImg, SiteProblem, WORDMARK } from './parts'
import { ABOUT_HERO, ABOUT_PHOTOS, OWNER_PHOTO } from './photos'

/** The company profile: our story, what we do, the team as roles and the places we work. */
export default function SiteAboutPage() {
  const { site } = useServices()
  const data = useResource('site.about', () => site.about())
  const heroRef = useHeroRef()
  useTitle(`About us · ${WORDMARK}`)

  if (data.status === 'error' && !data.data) return <SiteProblem title="This page did not load" onRetry={data.reload} />
  if (!data.data) return <div ref={heroRef} role="status" aria-label="Loading" className="h-[72svh] bg-(--s-ink)" />
  const { figures, locations, team, people, contact } = data.data
  const places = locations.map((l) => l.location.name)

  return (
    <>
      <section ref={heroRef} aria-labelledby="about-page-title" className="on-dark relative isolate flex min-h-[72svh] items-end overflow-hidden bg-(--s-ink) text-(--s-cream)">
        <CoverImg photo={ABOUT_HERO} load="first" className="s-kenburns -z-20" />
        <div aria-hidden className="s-scrim-hero absolute inset-0 -z-10" />
        <div className="mx-auto w-full max-w-7xl px-6 pt-32 pb-16 md:px-12 md:pb-20">
          <p className="s-label s-eyebrow s-rise text-(--s-cream)">About us</p>
          <h1 id="about-page-title" className="s-display s-rise mt-5 text-[clamp(3.25rem,11vw,9rem)] text-(--s-cream)" style={{ animationDelay: '0.15s' }}>
            {WORDMARK}
          </h1>
          <p className="s-italic s-rise mt-4 max-w-2xl text-2xl leading-snug text-(--s-cream)" style={{ animationDelay: '0.3s' }}>
            A villa operator running {numberWord(figures.villas).toLowerCase()} villas in {listWords(places)}.
          </p>
        </div>
      </section>

      <section aria-labelledby="story-title" className="mx-auto grid max-w-7xl gap-16 px-6 py-24 md:grid-cols-12 md:px-12 md:py-36">
        <div className="md:col-span-6">
          <SectionHead id="story-title" eyebrow="Our story" title="We run villas the way an owner would, every day" lead="Hosting on one side, the books on the other, one team in between." />
          <Reveal delay={220} className="mt-8 max-w-xl space-y-4 leading-relaxed text-(--s-body)">
            <p>
              {WORDMARK} is a villa operator. Owners hand us their villa and we run it: the guests, the staff, the suppliers, the repairs and the money. Today that is {plural(figures.villas, 'villa')} and {plural(figures.rooms, 'room')} open for sale across {plural(figures.locations, 'location')}.
            </p>
            <p>Every villa runs in the same system. A booking, a cleaning round, a repair ticket, a payslip and an owner statement are records the whole team sees, so nothing waits on one person&rsquo;s inbox.</p>
            <p>Guests notice a quiet stay with someone on call. Owners notice a statement they can check line by line, and a portal where they can see it any day.</p>
          </Reveal>
        </div>
        <div className="relative md:col-span-6">
          <Reveal kind="wipe-up">
            <SiteImg photo={ABOUT_PHOTOS.main} sizes="(min-width: 768px) 45vw, 100vw" ratio="4 / 5" load="early" />
          </Reveal>
          <Float speed={-6} className="relative z-10 -mt-20 -ml-4 w-1/2 md:-ml-16">
            <SiteImg photo={OWNER_PHOTO} sizes="(min-width: 768px) 22vw, 50vw" ratio="1 / 1" load="early" className="shadow-2xl" />
          </Float>
        </div>
      </section>

      <section aria-labelledby="do-title" className="on-dark relative isolate overflow-hidden bg-(--s-forest) py-24 text-(--s-cream) md:py-32">
        <Contours />
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <SectionHead id="do-title" eyebrow="What we do" title="Two kinds of client, one team" surface="dark" />
          <div className="mt-14 grid gap-14 md:grid-cols-2">
            {[
              { title: 'For guests', items: GUEST_SERVICES },
              { title: 'For villa owners', items: OWNER_SERVICES },
            ].map((col) => (
              <div key={col.title}>
                <h3 className="s-serif text-3xl text-(--s-cream)">{col.title}</h3>
                <ul className="mt-5 border-t border-(--s-line-light)">
                  {col.items.map((s) => (
                    <li key={s.title} className="border-b border-(--s-line-light) py-4">
                      <span className="s-serif block text-2xl text-(--s-cream)">{s.title}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-(--s-cream)/85">{s.text}</span>
                      {s.to && s.link && (
                        <Link to={s.to} className="mt-2 inline-block text-sm font-semibold text-(--s-cream) underline underline-offset-4 hover:text-(--s-sand)">
                          {s.link}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <ol className="mt-20 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {HOW_WE_WORK.map((s, i) => (
              <li key={s.step} className="border-t border-(--s-line-light) pt-5">
                <span className="s-label text-(--s-sand)">Step {i + 1}</span>
                <span className="s-serif mt-2 block text-3xl text-(--s-cream)">{s.step}</span>
                <span className="mt-2 block text-sm leading-relaxed text-(--s-cream)/85">{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="team-title" className="mx-auto max-w-7xl px-6 py-24 md:px-12 md:py-32">
        <div className="grid gap-12 md:grid-cols-12">
          <div className="md:col-span-5">
            <SectionHead id="team-title" eyebrow="The team" title={<>{<CountNumber value={people} />} people on the payroll</>} lead="Our own staff, by role. We name no one here, so ask us and we will introduce you." />
          </div>
          <div className="grid gap-10 sm:grid-cols-2 md:col-span-7">
            {team.map((d, i) => (
              <Reveal key={d.department} delay={i * 60}>
                <h3 className="s-label text-(--s-terra)">{d.department}</h3>
                <ul className="mt-3 border-t border-(--s-line)">
                  {d.roles.map((r) => (
                    <li key={r.position} className="flex items-baseline justify-between gap-4 border-b border-(--s-line) py-3">
                      <span className="text-(--s-ink)">{r.position}</span>
                      <span className="s-serif text-2xl text-(--s-ink) tabular-nums">{r.people}</span>
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="places-title" className="bg-(--s-stone) py-24 md:py-32">
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <SectionHead id="places-title" eyebrow="Where we are" title={`${numberWord(figures.locations)} places, from the rice fields to the cliffs`} />
          <ol className="mt-14 grid gap-px bg-(--s-line) sm:grid-cols-2 lg:grid-cols-4">
            {locations.map((l, i) => (
              <Reveal as="li" key={l.location.id} delay={i * 80} className="bg-(--s-stone) py-6 sm:px-6 lg:first:pl-0">
                <p className="flex items-center gap-2 s-label text-(--s-muted)">
                  <MapPin aria-hidden className="size-3.5 text-(--s-terra)" />
                  {l.location.area}
                </p>
                <h3 className="s-serif mt-2 text-4xl text-(--s-ink)">{l.location.name}</h3>
                <ul className="mt-4 space-y-1 text-sm">
                  {l.villas.map((v) => (
                    <li key={v.id}>
                      {v.open ? (
                        <Link to={`/stay/villas/${v.id}`} className="text-(--s-ink) underline underline-offset-4 hover:text-(--s-terra)">
                          {v.name}
                        </Link>
                      ) : (
                        <span className="text-(--s-body)">{v.name}, closed for now</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <ContactBand contact={contact} />
    </>
  )
}

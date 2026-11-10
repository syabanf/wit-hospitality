import { WORDMARK } from './parts'
import { useTitle } from './helpers'
import { CREDITS, photoUrl } from './photos'

/** Who took each photo on the site, with a link to it on Unsplash. */
export default function SiteCreditsPage() {
  useTitle(`Photo credits · ${WORDMARK}`)
  return (
    <div className="mx-auto max-w-7xl px-6 pt-14 pb-24 md:px-12 md:pt-20">
      <p className="s-label text-(--s-terra)">Photos: Unsplash</p>
      <h1 className="s-serif mt-3 text-5xl sm:text-6xl">Photo credits</h1>
      <p className="mt-5 max-w-2xl text-(--s-body)">
        The photos on this site come from photographers on{' '}
        <a href="https://unsplash.com" className="underline underline-offset-4" rel="noopener">
          Unsplash
        </a>{' '}
        under the Unsplash License. They show Bali and villas like ours, not our own rooms.
      </p>
      <ul className="mt-12 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {CREDITS.map((p) => (
          <li key={p.id} className="grid grid-cols-[4.5rem_1fr] items-center gap-4 border-t border-(--s-line) pt-4">
            <img src={photoUrl(p, 160)} alt="" width={72} height={72} loading="lazy" decoding="async" className="size-18 bg-(--s-stone) object-cover" />
            <span className="text-sm">
              <a href={p.page} className="text-(--s-ink) underline underline-offset-4" rel="noopener">
                {p.alt}
              </a>
              <span className="block text-(--s-muted)">by {p.by}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

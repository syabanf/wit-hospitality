import { useLocation } from 'react-router'
import { fullDay } from '@/lib/dates'
import type { EnquirySent } from './EnquiryForm'
import { ArrowLink, Reveal, WORDMARK } from './parts'
import { useTitle } from './helpers'

/** After a request to book: the reference, the stay asked for and how the team answers. */
export default function SiteThanksPage() {
  const sent = useLocation().state as EnquirySent | null
  useTitle(`Thank you · ${WORDMARK}`)

  return (
    <section aria-labelledby="thanks-title" className="mx-auto flex min-h-[80svh] max-w-4xl flex-col justify-center px-6 py-24 md:px-12">
      <Reveal as="p" className="s-label text-(--s-terra)">
        {sent ? `Reference ${sent.number}` : 'Request received'}
      </Reveal>
      <Reveal delay={100}>
        <h1 id="thanks-title" className="s-display mt-5 text-[clamp(3.5rem,11vw,9rem)] text-(--s-ink)">
          Thank you{sent?.firstName ? `, ${sent.firstName}` : ''}
        </h1>
      </Reveal>
      <Reveal delay={200} className="mt-8 max-w-2xl space-y-4 text-lg leading-relaxed text-(--s-body)">
        {sent?.topic === 'owner' ? (
          <p>We have your note about your villa. Our owner team replies by WhatsApp or email to arrange a visit.</p>
        ) : (
          <>
            {sent && (
              <p>
                We have your request for {sent.villaName}, {fullDay(sent.checkIn)} to {fullDay(sent.checkOut)}.
              </p>
            )}
            <p>Our reservations team checks the rooms and replies by WhatsApp or email, usually the same day. No room is held and nothing is charged until you confirm.</p>
          </>
        )}
      </Reveal>
      <Reveal delay={300} className="mt-10">
        <ArrowLink to={sent?.topic === 'owner' ? '/stay/about' : '/stay#villas'}>{sent?.topic === 'owner' ? 'Read about us' : 'Back to the villas'}</ArrowLink>
      </Reveal>
    </section>
  )
}

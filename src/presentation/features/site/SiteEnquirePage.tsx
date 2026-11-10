import { useSearchParams } from 'react-router'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { EnquiryForm } from './EnquiryForm'
import { SiteLoading, SiteProblem, WORDMARK } from './parts'
import { contactLines, useTitle } from './helpers'

/** The request to book on its own page, started from a search result or the closing call to action. */
export default function SiteEnquirePage() {
  const [params] = useSearchParams()
  const { site } = useServices()
  const options = useResource('site.enquiryOptions', () => site.enquiryOptions())
  const owner = params.get('topic') === 'owner'
  useTitle(`${owner ? 'Talk to us about your villa' : 'Request to book'} · ${WORDMARK}`)

  if (options.status === 'error' && !options.data) return <SiteProblem title="The form did not load" onRetry={options.reload} />
  if (!options.data) return <SiteLoading />
  const villaId = params.get('villa') ?? ''
  const known = options.data.villas.some((v) => v.id === villaId)
  const contact = contactLines(options.data.contact)

  return (
    <div className="mx-auto grid max-w-7xl gap-12 px-6 pt-14 pb-24 md:grid-cols-12 md:px-12 md:pt-20">
      <div className="md:col-span-4">
        <p className="s-label s-eyebrow text-(--s-terra)">{owner ? 'For villa owners' : 'Request to book'}</p>
        <h1 className="s-serif mt-4 text-5xl leading-[1.02] text-(--s-ink) sm:text-6xl">{owner ? 'Tell us about your villa' : 'Tell us when, and who is coming'}</h1>
        <p className="s-italic mt-4 text-2xl leading-snug text-(--s-body)">{owner ? 'We visit before we propose anything.' : 'A person reads every request.'}</p>
        <p className="mt-5 text-(--s-body)">
          {owner
            ? 'Write where the villa is, how many rooms it has and how it runs today. Our owner team replies by WhatsApp or email to arrange a visit.'
            : 'We check the rooms, then reply by WhatsApp or email with the total and a payment link. Nothing is charged until you say yes.'}
        </p>
        <p className="mt-6 text-sm text-(--s-muted)">
          Prefer to write? WhatsApp {contact.whatsapp.label}
          {contact.whatsapp.placeholder && ' (placeholder)'} or email {contact.email.label}
          {contact.email.placeholder && ' (placeholder)'}.
        </p>
      </div>
      <div className="md:col-span-8">
        <EnquiryForm
          key={owner ? 'owner' : 'stay'}
          options={options.data}
          chooseTopic
          initial={{
            topic: owner ? 'owner' : 'stay',
            villaId: known ? villaId : undefined,
            groupId: known ? params.get('group') || null : null,
            checkIn: params.get('checkIn') ?? undefined,
            checkOut: params.get('checkOut') ?? undefined,
            guests: Number(params.get('guests')) || undefined,
          }}
        />
      </div>
    </div>
  )
}

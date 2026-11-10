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
  useTitle(`Request to book · ${WORDMARK}`)

  if (options.status === 'error' && !options.data) return <SiteProblem title="The form did not load" onRetry={options.reload} />
  if (!options.data) return <SiteLoading />
  const villaId = params.get('villa') ?? ''
  const known = options.data.villas.some((v) => v.id === villaId)
  const contact = contactLines(options.data.contact)

  return (
    <div className="mx-auto grid max-w-7xl gap-12 px-6 pt-14 pb-24 md:grid-cols-12 md:px-12 md:pt-20">
      <div className="md:col-span-4">
        <p className="s-label text-(--s-terra)">Request to book</p>
        <h1 className="s-serif mt-3 text-5xl leading-[1.02] sm:text-6xl">Tell us when, and who is coming</h1>
        <p className="mt-5 text-(--s-body)">We check the rooms, then reply by WhatsApp or email with the total and a payment link. Nothing is charged until you say yes.</p>
        <p className="mt-6 text-sm text-(--s-muted)">
          Prefer to write? WhatsApp {contact.whatsapp.label}
          {contact.whatsapp.placeholder && ' (placeholder)'} or email {contact.email.label}
          {contact.email.placeholder && ' (placeholder)'}.
        </p>
      </div>
      <div className="md:col-span-8">
        <EnquiryForm
          options={options.data}
          initial={{
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

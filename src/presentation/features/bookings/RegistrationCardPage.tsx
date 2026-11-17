import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { CARD_PLACE_LABEL } from '@/domain/frontDesk'
import { countryName, ID_TYPE_LABEL } from '@/domain/guest'
import { placeTerms } from '@/domain/property'
import { ROOM_ONLY } from '@/domain/ratePackage'
import { fullDay, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { AccessProvider } from '../../layouts/AccessProvider'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { Gate } from '../../ui/Gate'
import { useToast } from '../../ui/useToast'
import { SignaturePad } from '../shared/SignaturePad'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  )
}

function Card() {
  const { id = '' } = useParams()
  const { frontDesk } = useServices()
  const toast = useToast()
  const resource = useResource(`frontDesk.card:${id}`, () => frontDesk.card(id), { keepPrevious: false })
  const [busy, setBusy] = useState<'screen' | 'paper' | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function sign(kind: 'screen' | 'paper', action: () => Promise<unknown>) {
    setBusy(kind)
    setErrors({})
    try {
      await action()
      toast({ title: 'Signed the registration card', description: kind === 'screen' ? 'The signature is stored with the booking.' : 'The paper card number is on the booking.' })
      resource.reload()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the card', description: Object.values(e)[0] })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="booking" back={{ to: '/bookings', label: 'Back to bookings' }}>
      {({ booking: b, today, houseRules, cancellation, deposit, party, required }) => {
        const card = b.registrationCard
        const v = b.place.villa
        const open = !card && (b.status === 'confirmed' || b.status === 'checked_in')
        return (
          <article className="mx-auto max-w-3xl rounded-card border border-line bg-card p-6 shadow-card print:border-0 print:shadow-none md:p-10">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <BrandMark className="size-8 text-fg" />
                <div>
                  <p className="text-base font-bold tracking-tight">{v.name}</p>
                  <p className="text-xs text-muted">{v.address || b.place.location.name}</p>
                </div>
              </div>
              <div className="text-right">
                <h1 className="text-2xl font-bold tracking-tight">
                  Registration card<span className="text-accent">.</span>
                </h1>
                <p className="font-mono text-xs text-muted">{b.code}</p>
                <p className="text-xs text-muted">Printed {fullDay(today)}</p>
              </div>
            </header>

            <section aria-label="The stay" className="mt-8">
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <Fact label={placeTerms(b.place).unit}>{b.unitCode}</Fact>
                <Fact label="Arrival">{shortDay(b.checkIn)}, from {v.checkInTime}</Fact>
                <Fact label="Departure">{shortDay(b.checkOut)}, by {v.checkOutTime}</Fact>
                <Fact label="Nights">{plural(b.nights, 'night')}</Fact>
                <Fact label="Rate">{money(b.rate)} a night</Fact>
                <Fact label="Package">{b.ratePackage?.name ?? ROOM_ONLY}</Fact>
                <Fact label="Party">{party ? `${plural(party.adults, 'adult')}${party.children ? `, ${party.children} children` : ''}` : 'Not said'}</Fact>
                <Fact label="Total">{money(b.total)}</Fact>
              </dl>
            </section>

            <section aria-label="The guest" className="mt-6 border-t border-line pt-6">
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
                <Fact label="Name">{b.guest.name}</Fact>
                <Fact label="Nationality">{countryName(b.guest.nationality)}</Fact>
                <Fact label="Document">
                  {ID_TYPE_LABEL[b.guest.idType]} <span className="font-mono">{b.guest.idNumber || 'not on file'}</span>
                </Fact>
                <Fact label="Address in Indonesia">{b.guest.addressInIndonesia || v.name}</Fact>
                <Fact label="Phone">{b.guest.phone || 'Not on file'}</Fact>
                <Fact label="Email">{b.guest.email || 'Not on file'}</Fact>
              </dl>
            </section>

            <section aria-label="House rules and policies" className="mt-6 border-t border-line pt-6 text-sm">
              <h2 className="font-semibold">House rules</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-body">
                {houseRules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <h2 className="mt-4 font-semibold">Cancellation and deposit</h2>
              <p className="mt-1 text-body">{cancellation} {deposit}</p>
              <p className="mt-4 text-xs text-muted">By signing, the guest confirms the details above and agrees to the house rules and the policies of {v.name}.</p>
            </section>

            <section aria-label="Signature" className="mt-6 border-t border-line pt-6">
              <h2 className="text-sm font-semibold">Guest signature</h2>
              {card ? (
                <div className="mt-2">
                  {card.method === 'screen' && card.signature ? (
                    <img src={card.signature.url} alt={`Signature of ${b.guest.name}`} className="h-28 max-w-full rounded-panel bg-white object-contain" />
                  ) : (
                    <p className="text-sm">
                      Signed on paper card <span className="font-mono font-medium">{card.cardNumber}</span>
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted">
                    {b.guest.name} · signed {CARD_PLACE_LABEL[card.where]} {card.signedAt.slice(0, 10) === today ? 'today' : `on ${shortDay(card.signedAt.slice(0, 10))}`} at {card.signedAt.slice(11, 16)}
                    {card.by !== 'Guest' && `, taken by ${card.by}`}
                  </p>
                </div>
              ) : open ? (
                <div className="mt-3 space-y-5 print:hidden">
                  {required && <p className="text-xs text-muted">{v.name} checks guests in once this card is signed.</p>}
                  <SignaturePad saving={busy === 'screen'} error={errors.signature} onSign={(png) => sign('screen', () => frontDesk.signOnScreen(b.id, png))} />
                  <form
                    className="flex flex-wrap items-end gap-3 border-t border-line pt-4"
                    onSubmit={(e: FormEvent<HTMLFormElement>) => {
                      e.preventDefault()
                      void sign('paper', () => frontDesk.signOnPaper(b.id, String(new FormData(e.currentTarget).get('cardNumber') ?? '')))
                    }}
                  >
                    <Field label="Signed on paper instead, card number" htmlFor="rc-number" error={errors.cardNumber} className="min-w-0 flex-1">
                      <Input id="rc-number" name="cardNumber" placeholder="RC-4120" className="font-mono" />
                    </Field>
                    <Button type="submit" variant="soft" loading={busy === 'paper'}>
                      Mark signed on paper
                    </Button>
                  </form>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">No card was signed for this stay.</p>
              )}
              {!card && <div className="mt-10 hidden h-16 border-b border-fg print:block" aria-hidden />}
            </section>
          </article>
        )
      }}
    </Gate>
  )
}

/** The registration card of one stay: printable, and signed on screen or marked signed on paper. */
export default function RegistrationCardPage() {
  const { id = '' } = useParams()
  return (
    <AccessProvider>
      <div className="min-h-dvh bg-canvas px-4 py-6 print:bg-white print:p-0">
        <div className="mx-auto mb-4 flex max-w-3xl justify-between gap-2 print:hidden">
          <Link to={`/bookings/${id}`} className={buttonStyles({ variant: 'card' })}>
            <ArrowLeft aria-hidden className="size-4" /> Booking
          </Link>
          <Button variant="accent" onClick={() => window.print()}>
            <Printer aria-hidden className="size-4" /> Print
          </Button>
        </div>
        <Card />
      </div>
    </AccessProvider>
  )
}

import { Link, useParams } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { fullDay, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { AccessProvider } from '../../layouts/AccessProvider'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Gate } from '../../ui/Gate'
import { FolioLines } from '../shared/FolioLines'

function Folio() {
  const { id = '' } = useParams()
  const { booking } = useServices()
  const resource = useResource(`booking.folio:${id}`, () => booking.folio(id), { keepPrevious: false })
  return (
    <Gate resource={resource} what="booking" back={{ to: '/bookings', label: 'Back to bookings' }}>
      {({ booking: b, folio: f, today }) => (
        <article className="mx-auto max-w-3xl rounded-card border border-line bg-card p-6 shadow-card print:border-0 print:shadow-none md:p-10">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <BrandMark className="size-8 text-fg" />
              <div>
                <p className="text-base font-bold tracking-tight">Bali Villas</p>
                <p className="text-xs text-muted">{b.place.villa.name}, {b.place.location.name}</p>
              </div>
            </div>
            <div className="text-right">
              <h1 className="text-2xl font-bold tracking-tight">
                Folio<span className="text-accent">.</span>
              </h1>
              <p className="font-mono text-xs text-muted">FOL-{b.code.replace('BK-', '')}</p>
              <p className="text-xs text-muted">Printed {fullDay(today)}</p>
            </div>
          </header>
          <dl className="mt-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Guest</dt>
              <dd className="font-medium">{b.guestName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Room</dt>
              <dd>{b.unitCode}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Stay</dt>
              <dd>{shortDay(b.checkIn)} to {shortDay(b.checkOut)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Source</dt>
              <dd>{b.sourceLabel}</dd>
            </div>
          </dl>
          <div className="mt-8">
            <FolioLines lines={f.lines} />
          </div>
          <dl className="mt-4 space-y-1 border-t border-line-strong pt-3 text-sm">
            <div className="flex justify-between gap-4 text-muted">
              <dt>Debits</dt>
              <dd className="tabular">{money(f.debits)}</dd>
            </div>
            <div className="flex justify-between gap-4 text-muted">
              <dt>Credits</dt>
              <dd className="tabular">−{money(f.credits)}</dd>
            </div>
            <div className="flex justify-between gap-4 text-base font-bold">
              <dt>{f.balance < 0 ? 'In credit' : 'Balance'}</dt>
              <dd className="tabular">{money(Math.abs(f.balance))}</dd>
            </div>
          </dl>
          {f.depositHeld > 0 && <p className="mt-4 text-xs text-muted">{money(f.depositHeld)} security deposit held, returned at check-out and outside the balance.</p>}
        </article>
      )}
    </Gate>
  )
}

/** A printable folio for one stay, styled like the invoice; the toolbar hides on paper. */
export default function FolioPage() {
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
        <Folio />
      </div>
    </AccessProvider>
  )
}

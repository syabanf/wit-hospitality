import { Link, useParams } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from '@/domain/payment'
import { fullDay, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { AccessProvider } from '../../layouts/AccessProvider'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Gate } from '../../ui/Gate'

function Invoice() {
  const { id = '' } = useParams()
  const { payments } = useServices()
  const resource = useResource(`payments.invoice:${id}`, () => payments.invoice(id), { keepPrevious: false })
  return (
    <Gate resource={resource} what="booking" back={{ to: '/bookings', label: 'Back to bookings' }}>
      {(inv) => {
        const b = inv.booking
        const separate = inv.lines.filter((l) => l.separate)
        return (
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
                  Invoice<span className="text-accent">.</span>
                </h1>
                <p className="font-mono text-xs text-muted">INV-{b.code.replace('BK-', '')}</p>
                <p className="text-xs text-muted">Issued {fullDay(b.createdOn)}</p>
              </div>
            </header>
            <dl className="mt-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Guest</dt>
                <dd className="font-medium">{b.guestName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Booking</dt>
                <dd className="font-mono">{b.code}</dd>
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
            <table className="mt-8 w-full text-sm">
              <thead>
                <tr className="border-b border-line-strong text-left text-xs tracking-wide text-muted uppercase">
                  <th scope="col" className="py-2 font-medium">Item</th>
                  <th scope="col" className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {inv.lines.filter((l) => !l.separate).map((l) => (
                  <tr key={l.label}>
                    <td className="py-3">
                      <p className="font-medium">{l.label}</p>
                      <p className="text-xs text-muted">{l.detail}</p>
                    </td>
                    <td className="py-3 text-right whitespace-nowrap tabular">{money(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr className="border-t border-line-strong">
                  <td className="pt-3 font-semibold">{b.source === 'airbnb' ? 'Payout expected' : 'Total'}</td>
                  <td className="pt-3 text-right whitespace-nowrap font-semibold tabular">{money(inv.expected)}</td>
                </tr>
                <tr>
                  <td className="pt-1 text-muted">Paid</td>
                  <td className="pt-1 text-right whitespace-nowrap tabular text-muted">-{money(inv.paid)}</td>
                </tr>
                <tr>
                  <td className="pt-1 pr-4 text-base font-bold">Balance due {inv.outstanding > 0 && `by ${shortDay(inv.dueOn)}`}</td>
                  <td className="pt-1 text-right whitespace-nowrap text-base font-bold tabular">{money(inv.outstanding)}</td>
                </tr>
              </tfoot>
            </table>
            {inv.payments.length > 0 && (
              <section aria-labelledby="inv-pay" className="mt-8">
                <h2 id="inv-pay" className="mb-2 text-sm font-semibold">Payments</h2>
                <ul className="divide-y divide-line text-sm">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>
                        <span className="font-mono text-xs">{p.number}</span> · {PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]} · {PAYMENT_STATUS_LABEL[p.status]}
                      </span>
                      <span className="tabular">{p.kind === 'refund' ? '-' : ''}{money(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {separate.length > 0 && (
              <section aria-labelledby="inv-extra" className="mt-6">
                <h2 id="inv-extra" className="mb-2 text-sm font-semibold">Settled at the desk</h2>
                <ul className="divide-y divide-line text-sm text-muted">
                  {separate.map((l) => (
                    <li key={l.label} className="flex justify-between gap-2 py-2">
                      <span>{l.label} · {l.detail}</span>
                      <span className="tabular">{money(l.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="mt-8 text-xs text-muted">Pay by bank transfer to BCA 123 456 7890 (Bali Villas), QRIS or the payment link your host sends. Quote {b.code}.</p>
          </article>
        )
      }}
    </Gate>
  )
}

/** A printable invoice for one booking; the toolbar hides on paper. */
export default function InvoicePage() {
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
        <Invoice />
      </div>
    </AccessProvider>
  )
}

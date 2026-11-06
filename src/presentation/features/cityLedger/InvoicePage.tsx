import { Link, useParams } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { BILLING_INSTRUCTION_LABEL, type BillingInstruction } from '@/domain/cityLedger'
import { fullDay, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Gate } from '../../ui/Gate'
import { INVOICE_TONE } from './tones'

/** A city ledger invoice in the invoice style: one line per stay, service and PB1 as billed, the agent commission, the net due. */
export default function CityLedgerInvoicePage() {
  const { id = '' } = useParams()
  const { cityLedger } = useServices()
  const resource = useResource(`cityLedger.invoice:${id}`, () => cityLedger.invoice(id), { keepPrevious: false })
  return (
    <Gate resource={resource} what="invoice" back={{ to: '/city-ledger', label: 'Back to the city ledger' }}>
      {({ invoice: inv, account: a, payments }) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <Link to={`/city-ledger/${a.id}`} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
              <ArrowLeft aria-hidden className="size-4" /> {a.name}
            </Link>
            <Button variant="soft" onClick={() => window.print()}>
              <Printer aria-hidden className="size-4" /> Print or save as PDF
            </Button>
          </div>
          <article className="mx-auto max-w-3xl rounded-card border border-line bg-card p-6 shadow-card print:border-0 print:shadow-none md:p-10">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <BrandMark className="size-8 text-fg" />
                <div>
                  <p className="text-base font-bold tracking-tight">Bali Villas</p>
                  <p className="text-xs text-muted">City ledger</p>
                </div>
              </div>
              <div className="text-right">
                <h1 className="text-2xl font-bold tracking-tight">
                  Invoice<span className="text-accent">.</span>
                </h1>
                <p className="font-mono text-xs text-muted">{inv.number}</p>
                <p className="text-xs text-muted">Issued {fullDay(inv.issuedOn)}</p>
                <p className="text-xs text-muted">Due {fullDay(inv.dueOn)}</p>
              </div>
            </header>
            <dl className="mt-8 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted">Bill to</dt>
                <dd className="font-medium">{a.name}</dd>
                <dd className="text-muted">Attn. {a.contact}</dd>
                <dd className="text-muted">{a.address}</dd>
                {a.npwp && <dd className="text-muted">NPWP {a.npwp}</dd>}
              </div>
              <div className="sm:text-right">
                <dt className="text-xs text-muted">Account</dt>
                <dd className="font-mono">{a.code}</dd>
                <dd className="text-muted">{a.termsDays} days from the invoice date</dd>
                <dd className="print:hidden">
                  <StatusPill tone={INVOICE_TONE[inv.state]}>{inv.stateLabel}</StatusPill>
                </dd>
              </div>
            </dl>
            <table className="mt-8 w-full text-sm">
              <thead>
                <tr className="border-b border-line-strong text-left text-xs tracking-wide text-muted uppercase">
                  <th scope="col" className="py-2 font-medium">Stay</th>
                  <th scope="col" className="py-2 text-right font-medium">Charges</th>
                  <th scope="col" className="py-2 text-right font-medium">Service</th>
                  <th scope="col" className="py-2 text-right font-medium">PB1</th>
                  <th scope="col" className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {inv.lines.map((l) => (
                  <tr key={l.bookingId}>
                    <td className="py-3">
                      <p className="font-medium">
                        <span className="font-mono">{l.code}</span> {l.guest}
                      </p>
                      <p className="text-xs text-muted">
                        {l.villa}, {shortDay(l.checkIn)} to {shortDay(l.checkOut)} · {BILLING_INSTRUCTION_LABEL[l.covers as BillingInstruction] ?? l.covers}
                      </p>
                    </td>
                    <td className="py-3 text-right whitespace-nowrap tabular">{money(l.gross - l.service - l.pb1)}</td>
                    <td className="py-3 text-right whitespace-nowrap tabular">{money(l.service)}</td>
                    <td className="py-3 text-right whitespace-nowrap tabular">{money(l.pb1)}</td>
                    <td className="py-3 text-right whitespace-nowrap tabular">{money(l.gross)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr className="border-t border-line-strong">
                  <td colSpan={4} className="pt-3 text-muted">Charges</td>
                  <td className="pt-3 text-right whitespace-nowrap tabular text-muted">{money(inv.gross - inv.service - inv.pb1)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="pt-1 text-muted">Service charge</td>
                  <td className="pt-1 text-right whitespace-nowrap tabular text-muted">{money(inv.service)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="pt-1 text-muted">PB1</td>
                  <td className="pt-1 text-right whitespace-nowrap tabular text-muted">{money(inv.pb1)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="pt-3 font-semibold">Gross</td>
                  <td className="pt-3 text-right whitespace-nowrap font-semibold tabular">{money(inv.gross)}</td>
                </tr>
                {inv.commission > 0 && (
                  <tr>
                    <td colSpan={4} className="pt-1 text-muted">Less commission, {inv.commissionPct}% of the charges</td>
                    <td className="pt-1 text-right whitespace-nowrap tabular text-muted">-{money(inv.commission)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={4} className="pt-1 text-base font-bold">Net due by {shortDay(inv.dueOn)}</td>
                  <td className="pt-1 text-right whitespace-nowrap text-base font-bold tabular">{money(inv.net)}</td>
                </tr>
                {inv.paid + inv.writtenOff > 0 && (
                  <>
                    <tr>
                      <td colSpan={4} className="pt-1 text-muted">Paid{inv.writtenOff > 0 ? ' and written off' : ''}</td>
                      <td className="pt-1 text-right whitespace-nowrap tabular text-muted">-{money(inv.paid + inv.writtenOff)}</td>
                    </tr>
                    <tr>
                      <td colSpan={4} className="pt-1 font-semibold">Still open</td>
                      <td className="pt-1 text-right whitespace-nowrap font-semibold tabular">{money(inv.open)}</td>
                    </tr>
                  </>
                )}
              </tfoot>
            </table>
            {payments.length > 0 && (
              <section aria-labelledby="cli-pay" className="mt-8">
                <h2 id="cli-pay" className="mb-2 text-sm font-semibold">Payments</h2>
                <ul className="divide-y divide-line text-sm">
                  {payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>
                        <span className="font-mono text-xs">{p.number}</span> · {shortDay(p.date)} · {p.reference} · {p.statusLabel}
                      </span>
                      <span className="tabular">{money(p.allocations.filter((x) => x.invoiceId === inv.id).reduce((s, x) => s + x.amount, 0))}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="mt-8 text-xs text-muted">Service charge and PB1 show as the guest folio billed them. Pay by bank transfer to BCA 123 456 7890, Bali Villas, quoting {inv.number}.</p>
          </article>
        </div>
      )}
    </Gate>
  )
}

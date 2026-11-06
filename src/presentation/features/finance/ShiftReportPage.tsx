import { Link, useParams } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { NOTES, noteLabel, SHIFT_STATUS_LABEL, type DrawerCount } from '@/domain/cashier'
import { KIND_LABEL } from '@/domain/finance'
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { fullDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { AccessProvider } from '../../layouts/AccessProvider'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Gate } from '../../ui/Gate'
import { ShiftFigures } from './DrawerCount'
import { differenceText } from './shiftText'

const time = (iso: string | null) => (iso ? iso.slice(11, 16) : '')

/** Pieces per note of one count, for the paper copy. */
function CountTable({ title, count }: { title: string; count: DrawerCount | null }) {
  if (!count) return null
  return (
    <table className="w-full text-sm">
      <caption className="mb-1 text-left text-sm font-semibold">{title}</caption>
      <tbody className="divide-y divide-line">
        {NOTES.filter((n) => count.notes[n]).map((n) => (
          <tr key={n}>
            <td className="py-1">Rp {noteLabel(n)} × {count.notes[n]}</td>
            <td className="py-1 text-right tabular">{money(n * (count.notes[n] ?? 0))}</td>
          </tr>
        ))}
        {count.coins > 0 && (
          <tr>
            <td className="py-1">Coins</td>
            <td className="py-1 text-right tabular">{money(count.coins)}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function Report() {
  const { id = '' } = useParams()
  const { cashier } = useServices()
  const resource = useResource(`cashier.shift:${id}`, () => cashier.shift(id), { keepPrevious: false })
  return (
    <Gate resource={resource} what="shift" back={{ to: '/finance/shifts', label: 'Back to shifts' }}>
      {(d) => {
        const s = d.shift
        return (
          <article className="mx-auto max-w-3xl rounded-card border border-line bg-card p-6 shadow-card print:border-0 print:shadow-none md:p-10">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <BrandMark className="size-8 text-fg" />
                <div>
                  <p className="text-base font-bold tracking-tight">Bali Villas</p>
                  <p className="text-xs text-muted">{s.accountName}, {s.locationName}</p>
                </div>
              </div>
              <div className="text-right">
                <h1 className="text-2xl font-bold tracking-tight">
                  Shift report<span className="text-accent">.</span>
                </h1>
                <p className="font-mono text-xs text-muted">{s.number}</p>
                <p className="text-xs text-muted">Business date {fullDay(s.businessDate)}</p>
              </div>
            </header>
            <dl className="mt-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Cashier</dt>
                <dd className="font-medium">{s.cashierName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Opened</dt>
                <dd>{time(s.openedAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Counted</dt>
                <dd>{time(s.closedAt) || 'Still open'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Status</dt>
                <dd>{SHIFT_STATUS_LABEL[s.status]}</dd>
              </div>
            </dl>

            <section aria-labelledby="rep-entries" className="mt-8">
              <h2 id="rep-entries" className="mb-2 text-sm font-semibold">Transactions</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line-strong text-left text-xs tracking-wide text-muted uppercase">
                    <th scope="col" className="py-2 font-medium">Entry</th>
                    <th scope="col" className="py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.entries.map((t) => (
                    <tr key={t.id}>
                      <td className="py-2">
                        <p className="font-medium">{t.description}</p>
                        <p className="text-xs text-muted">{t.number} · {KIND_LABEL[t.kind]} · {t.categoryName}</p>
                      </td>
                      <td className="py-2 text-right whitespace-nowrap tabular">{t.kind === 'cash_out' ? '-' : ''}{money(t.amount)}</td>
                    </tr>
                  ))}
                  {d.payments.filter((p) => p.method !== 'cash').map((p) => (
                    <tr key={p.id}>
                      <td className="py-2">
                        <p className="font-medium">{PAYMENT_KIND_LABEL[p.kind]} {p.bookingCode}</p>
                        <p className="text-xs text-muted">{p.number} · {PAYMENT_METHOD_LABEL[p.method]}, not in the drawer</p>
                      </td>
                      <td className="py-2 text-right whitespace-nowrap tabular">{p.kind === 'refund' ? '-' : ''}{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2">
              <section aria-labelledby="rep-totals">
                <h2 id="rep-totals" className="mb-2 text-sm font-semibold">Totals</h2>
                <ShiftFigures float={s.float} totals={s.totals} />
                {d.categories.length > 0 && (
                  <dl className="mt-3 space-y-1 text-sm">
                    <p className="text-xs font-medium text-muted">By category</p>
                    {d.categories.map((c) => (
                      <div key={`${c.kind}-${c.categoryId}`} className="flex justify-between gap-2">
                        <dt>{c.name}</dt>
                        <dd className="tabular">{c.kind === 'cash_out' ? '-' : ''}{money(c.amount)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
              <section aria-labelledby="rep-count" className="space-y-4">
                <h2 id="rep-count" className="text-sm font-semibold">Drawer</h2>
                <CountTable title={`Opening float ${money(s.float)}`} count={s.openingCount} />
                <CountTable title={`Closing count ${money(s.counted ?? 0)}`} count={s.closingCount} />
                <p className="flex justify-between border-t border-line-strong pt-2 text-base font-bold">
                  <span>Difference</span>
                  <span>{differenceText(s.difference)}</span>
                </p>
                {s.reason && <p className="text-sm text-muted">Reason: {s.reason}</p>}
                {s.signOff && <p className="text-sm text-muted">Signed off by {s.signOff.by} at {time(s.signOff.at)}{s.signOff.note && `: ${s.signOff.note}`}</p>}
                {d.drop && <p className="text-sm text-muted">Dropped {money(s.dropped)} to {d.drop.to} ({d.drop.transaction.number}).</p>}
                {d.handOverOut && <p className="text-sm text-muted">Handed {money(d.handOverOut.amount)} over to {d.handOverOut.to}.</p>}
              </section>
            </div>

            <section aria-label="Signatures" className="mt-12 grid grid-cols-1 gap-8 text-sm sm:grid-cols-3">
              {[`Cashier, ${s.cashierName}`, d.handOverOut ? `Next cashier, ${d.handOverOut.to}` : 'Received by', s.signOff ? `Manager, ${s.signOff.by}` : 'Manager'].map((who) => (
                <div key={who}>
                  <div className="h-14 border-b border-line-strong" />
                  <p className="mt-1 text-xs text-muted">{who}</p>
                </div>
              ))}
            </section>
          </article>
        )
      }}
    </Gate>
  )
}

/** A printable shift report in the invoice style; the toolbar hides on paper. */
export default function ShiftReportPage() {
  const { id = '' } = useParams()
  return (
    <AccessProvider>
      <div className="min-h-dvh bg-canvas px-4 py-6 print:bg-white print:p-0">
        <div className="mx-auto mb-4 flex max-w-3xl justify-between gap-2 print:hidden">
          <Link to={`/finance/shifts/${id}`} className={buttonStyles({ variant: 'card' })}>
            <ArrowLeft aria-hidden className="size-4" /> Shift
          </Link>
          <Button variant="accent" onClick={() => window.print()}>
            <Printer aria-hidden className="size-4" /> Print
          </Button>
        </div>
        <Report />
      </div>
    </AccessProvider>
  )
}

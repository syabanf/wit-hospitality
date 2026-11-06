import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { CITY_AGING_BUCKETS, CITY_AGING_LABEL, LEDGER_ITEM_LABEL } from '@/domain/cityLedger'
import { fullDay, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Input } from '../../ui/Field'
import { Gate } from '../../ui/Gate'

/** The statement of account for a period, printable: opening balance, every item, closing balance, aging and open invoices. */
export default function CityLedgerStatementPage() {
  const { id = '' } = useParams()
  const { cityLedger } = useServices()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  const resource = useResource(`cityLedger.statement:${id}:${from ?? ''}:${to ?? ''}`, () => cityLedger.statement(id, { from, to }))
  const set = (key: 'from' | 'to', value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  return (
    <Gate resource={resource} what="account" back={{ to: '/city-ledger', label: 'Back to the city ledger' }}>
      {(st) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <Link to={`/city-ledger/${st.account.id}`} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
              <ArrowLeft aria-hidden className="size-4" /> {st.account.name}
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" aria-label="From" className="h-10 w-40" value={st.from} onChange={(e) => set('from', e.target.value)} />
              <Input type="date" aria-label="To" className="h-10 w-40" value={st.to} onChange={(e) => set('to', e.target.value)} />
              <Button variant="soft" onClick={() => window.print()}>
                <Printer aria-hidden className="size-4" /> Print or save as PDF
              </Button>
            </div>
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
                  Statement of account<span className="text-accent">.</span>
                </h1>
                <p className="text-xs text-muted">
                  {fullDay(st.from)} to {fullDay(st.to)}
                </p>
              </div>
            </header>
            <dl className="mt-8 text-sm">
              <dt className="text-xs text-muted">Account</dt>
              <dd className="font-medium">
                {st.account.code} {st.account.name}
              </dd>
              <dd className="text-muted">Attn. {st.account.contact}, {st.account.address}</dd>
            </dl>
            <table className="mt-8 w-full text-sm">
              <thead>
                <tr className="border-b border-line-strong text-left text-xs tracking-wide text-muted uppercase">
                  <th scope="col" className="py-2 font-medium">Date</th>
                  <th scope="col" className="py-2 font-medium">Item</th>
                  <th scope="col" className="py-2 text-right font-medium">Charged</th>
                  <th scope="col" className="py-2 text-right font-medium">Paid or off</th>
                  <th scope="col" className="py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="py-2">{shortDay(st.from)}</td>
                  <td className="py-2 text-muted">Opening balance</td>
                  <td />
                  <td />
                  <td className="py-2 text-right tabular">{money(st.opening)}</td>
                </tr>
                {st.lines.map((l) => (
                  <tr key={`${l.kind}-${l.ref}-${l.date}`}>
                    <td className="py-2 whitespace-nowrap">{shortDay(l.date)}</td>
                    <td className="py-2">
                      {LEDGER_ITEM_LABEL[l.kind]} <span className="font-mono text-xs">{l.ref}</span>
                      <span className="block text-xs text-muted">{l.description}</span>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap tabular">{l.debit ? money(l.debit) : ''}</td>
                    <td className="py-2 text-right whitespace-nowrap tabular">{l.credit ? money(l.credit) : ''}</td>
                    <td className="py-2 text-right whitespace-nowrap tabular">{money(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong">
                  <td colSpan={4} className="pt-3 text-base font-bold">Closing balance</td>
                  <td className="pt-3 text-right text-base font-bold tabular">{money(st.closing)}</td>
                </tr>
              </tfoot>
            </table>
            <section aria-labelledby="sa-aging" className="mt-8">
              <h2 id="sa-aging" className="mb-2 text-sm font-semibold">Aging today</h2>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                {CITY_AGING_BUCKETS.map((k) => (
                  <div key={k}>
                    <dt className="text-xs text-muted">{CITY_AGING_LABEL[k]}</dt>
                    <dd className="tabular">{money(st.account.aging[k])}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {st.openInvoices.length > 0 && (
              <section aria-labelledby="sa-open" className="mt-8">
                <h2 id="sa-open" className="mb-2 text-sm font-semibold">Open invoices</h2>
                <ul className="divide-y divide-line text-sm">
                  {st.openInvoices.map((i) => (
                    <li key={i.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>
                        <span className="font-mono">{i.number}</span> · due {shortDay(i.dueOn)}
                        {i.daysOverdue > 0 && <span className="text-danger"> · {i.daysOverdue} days overdue</span>}
                      </span>
                      <span className="tabular">{money(i.open)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </article>
        </div>
      )}
    </Gate>
  )
}

import { FOLIO_KIND_LABEL, type GuestFolio } from '@/domain/folio'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'

type Lines = GuestFolio['lines']

const amountOf = (l: Lines[number]) => (l.debit > 0 ? money(l.debit) : l.credit > 0 ? `−${money(l.credit)}` : '')
const memoOf = (l: Lines[number]) => (l.memo > 0 ? `${money(l.memo)} held` : l.memo < 0 ? `${money(-l.memo)} handed back` : '')

/** Folio lines oldest first with the running balance. `compact` is the phone list; otherwise a table that also prints. */
export function FolioLines({ lines, compact = false }: { lines: Lines; compact?: boolean }) {
  if (lines.length === 0) return <p className="rounded-panel bg-raised px-4 py-5 text-center text-sm text-muted">Nothing on the folio for this filter.</p>
  if (compact)
    return (
      <ul className="divide-y divide-line text-sm">
        {lines.map((l) => (
          <li key={l.id} className="flex items-start justify-between gap-3 py-2.5">
            <span className="min-w-0">
              <span className="block truncate font-medium">{FOLIO_KIND_LABEL[l.kind]}</span>
              <span className="block truncate text-xs text-muted">
                {shortDay(l.date)} · {l.description}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-semibold whitespace-nowrap tabular">{amountOf(l) || memoOf(l)}</span>
              <span className="block text-xs whitespace-nowrap text-muted tabular">{money(l.balance)}</span>
            </span>
          </li>
        ))}
      </ul>
    )
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs tracking-wide text-muted uppercase">
            <th scope="col" className="px-1 py-2 font-medium">Date</th>
            <th scope="col" className="px-1 py-2 font-medium">Line</th>
            <th scope="col" className="px-1 py-2 text-right font-medium">Debit</th>
            <th scope="col" className="px-1 py-2 text-right font-medium">Credit</th>
            <th scope="col" className="px-1 py-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lines.map((l) => (
            <tr key={l.id}>
              <td className="px-1 py-2.5 align-top whitespace-nowrap text-muted">{shortDay(l.date)}</td>
              <td className="px-1 py-2.5">
                <p className="font-medium">
                  {FOLIO_KIND_LABEL[l.kind]} <span className="font-mono text-xs font-normal text-muted">{l.ref.label}</span>
                </p>
                <p className="text-xs text-muted">
                  {l.description}
                  {l.memo !== 0 && ` · ${memoOf(l)}, outside the balance`} · {l.postedBy}
                </p>
              </td>
              <td className="px-1 py-2.5 text-right align-top whitespace-nowrap tabular">{l.debit > 0 ? money(l.debit) : ''}</td>
              <td className="px-1 py-2.5 text-right align-top whitespace-nowrap tabular">{l.credit > 0 ? money(l.credit) : ''}</td>
              <td className="px-1 py-2.5 text-right align-top font-medium whitespace-nowrap tabular">{money(l.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

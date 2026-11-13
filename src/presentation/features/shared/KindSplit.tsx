import { money, percent } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Card, CardHeader } from '../../ui/Card'

export interface KindRow {
  /** "Rooms", "Villas" or "Total". */
  label: string
  revenue: number
  occupancy: number
  adr: number
  revpar?: number
}

/** Room figures split into hotel rooms and villas, then the total; shown only where a scope holds both kinds. */
export function KindSplit({ id, rows, className }: { id: string; rows: readonly KindRow[]; className?: string }) {
  if (rows.length === 0) return null
  const revpar = rows.some((r) => r.revpar !== undefined)
  return (
    <Card aria-labelledby={id} className={className}>
      <CardHeader id={id} title="Rooms and villas" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-sm">
          <thead>
            <tr className="text-left text-xs tracking-wide text-muted uppercase">
              <th className="py-2 font-medium">Kind</th>
              <th className="py-2 text-right font-medium">Revenue</th>
              <th className="py-2 text-right font-medium">Occupancy</th>
              <th className="py-2 text-right font-medium">ADR</th>
              {revpar && <th className="py-2 text-right font-medium">RevPAR</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.label} className={cn(r.label === 'Total' && 'font-semibold')}>
                <th scope="row" className="py-2 text-left font-medium">{r.label}</th>
                <td className="py-2 text-right tabular">{money(r.revenue)}</td>
                <td className="py-2 text-right tabular">{percent(r.occupancy, { digits: 0 })}</td>
                <td className="py-2 text-right tabular">{money(Math.round(r.adr))}</td>
                {revpar && <td className="py-2 text-right tabular">{money(Math.round(r.revpar ?? 0))}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

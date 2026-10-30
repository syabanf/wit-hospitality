import type { ReportColumn, ReportRow } from '@/application/views'

/** Which chart a report's columns and rows support, and the columns it uses. */
export interface ChartShape {
  kind: 'columns' | 'line' | 'none'
  /** The text or date column that labels each mark. */
  labelKey: ReportColumn | null
  /** The money or number column that sizes each mark. */
  valueKey: ReportColumn | null
  /** A share column drawn as a donut beside the bars; margins are ratios per row, so they skip the donut. */
  shareKey: ReportColumn | null
}

const MAX_COLUMNS = 24

export function chartShape(columns: readonly ReportColumn[], rows: readonly ReportRow[]): ChartShape {
  const first = columns[0]
  const value = columns.find((c) => c.kind === 'money' && c.total) ?? columns.find((c) => c.kind === 'money') ?? columns.find((c) => c.kind === 'number') ?? null
  const share = columns.find((c) => c.kind === 'percent' && c.key === 'share') ?? null
  if (!first || !value || rows.length === 0) return { kind: 'none', labelKey: null, valueKey: null, shareKey: null }
  if (first.kind === 'text' && rows.length <= MAX_COLUMNS) return { kind: 'columns', labelKey: first, valueKey: value, shareKey: share }
  if (first.kind === 'date') return { kind: 'line', labelKey: first, valueKey: value, shareKey: null }
  return { kind: 'none', labelKey: null, valueKey: null, shareKey: null }
}

/** Sums `valueKey` per day for the line chart, oldest day first. */
export function perDay(rows: readonly ReportRow[], dateKey: string, valueKey: string): Array<{ date: string; value: number }> {
  const map = new Map<string, number>()
  for (const r of rows) {
    const d = String(r[dateKey] ?? '')
    if (!d) continue
    map.set(d, (map.get(d) ?? 0) + (Number(r[valueKey]) || 0))
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }))
}

/** Rows whose text columns contain the query. */
export function searchRows(rows: readonly ReportRow[], columns: readonly ReportColumn[], query: string): ReportRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  const keys = columns.filter((c) => c.kind === 'text' || c.kind === 'date').map((c) => c.key)
  return rows.filter((r) => keys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)))
}

/** The `top` rows by the value column, biggest first; `0` keeps every row in its order. */
export function topRows(rows: readonly ReportRow[], valueKey: string | null, top: number): ReportRow[] {
  if (!top || !valueKey || rows.length <= top) return [...rows]
  return [...rows].sort((a, b) => Math.abs(Number(b[valueKey]) || 0) - Math.abs(Number(a[valueKey]) || 0)).slice(0, top)
}

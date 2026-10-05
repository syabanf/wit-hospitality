import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface DataColumn<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  align?: 'left' | 'right'
}

interface DataTableProps<T> {
  rows: readonly T[]
  columns: readonly DataColumn<T>[]
  rowKey: (row: T) => string
  label: string
  /** A bold closing row, for totals. */
  footer?: ReactNode[]
  className?: string
}

/** Plain figures in rows: chart data as a table. Rows do not link anywhere; use ListTable for records. */
export function DataTable<T>({ rows, columns, rowKey, label, footer, className }: DataTableProps<T>) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm" aria-label={label}>
        <thead>
          <tr className="text-left text-xs tracking-wide text-muted uppercase">
            {columns.map((c, i) => (
              <th key={c.key} scope="col" className={cn('py-2 font-medium', i > 0 && 'pl-3', c.align === 'right' && 'text-right')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c, i) => (
                <td key={c.key} className={cn('py-2.5', i > 0 && 'pl-3', c.align === 'right' && 'text-right tabular')}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="border-t border-line-strong font-semibold">
              {footer.map((cell, i) => (
                <td key={i} className={cn('py-2.5', i > 0 && 'pl-3', columns[i]?.align === 'right' && 'text-right tabular')}>
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

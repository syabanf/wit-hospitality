import { useMemo, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { cn } from '@/lib/cn'
import { csvFileName, toCsv } from '@/lib/csv'
import { Button } from './Button'
import { Select } from './Field'

export interface Column<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  /** Plain value behind the cell: drives sorting and the CSV export. Columns without it do not sort. */
  value?: (row: T) => string | number | null | undefined
  align?: 'left' | 'right'
  /** Hide the column below this breakpoint. */
  hide?: 'lg' | 'xl'
  className?: string
  /** Renders the sum of `value` over every filtered row in a totals row. */
  total?: (sum: number) => ReactNode
}

interface ListTableProps<T> {
  rows: readonly T[]
  columns: readonly Column<T>[]
  rowKey: (row: T) => string
  /** Where a row leads. The first column's text carries a real link for keyboard and middle-click. */
  href: (row: T) => string
  /** Compact card for phones. */
  card: (row: T) => ReactNode
  empty: ReactNode
  label: string
  /** Column key and direction before the user picks one. */
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  /** Base name of the CSV download; leave out to hide the export button. */
  exportName?: string
  /** Stamp in the CSV file name, normally today. */
  exportDate?: string
}

const HIDE = { lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' }
const PAGE_SIZES = ['10', '25', '50'] as const

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * A table from `md` up and a list of link cards below it; every row opens its record.
 * Sort, page and page size live in the URL (`sort`, `dir`, `page`, `size`), so Back keeps them.
 */
export function ListTable<T>({ rows, columns, rowKey, href, card, empty, label, defaultSort, exportName, exportDate = '' }: ListTableProps<T>) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const sortKey = params.get('sort') ?? defaultSort?.key ?? null
  const dir = (params.get('dir') === 'desc' ? 'desc' : params.get('dir') === 'asc' ? 'asc' : defaultSort?.dir) ?? 'asc'
  const size = Number(PAGE_SIZES.find((s) => s === params.get('size')) ?? PAGE_SIZES[0])
  const sortColumn = columns.find((c) => c.key === sortKey && c.value)

  const sorted = useMemo(() => {
    if (!sortColumn?.value) return [...rows]
    const value = sortColumn.value
    const sign = dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = value(a) ?? ''
      const y = value(b) ?? ''
      const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
      return diff * sign
    })
  }, [rows, sortColumn, dir])

  const pages = Math.max(1, Math.ceil(sorted.length / size))
  const page = Math.min(pages, Math.max(1, Number(params.get('page')) || 1))
  const visible = sorted.slice((page - 1) * size, page * size)

  function update(next: Record<string, string | null>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) if (v === null) search.delete(k)
    else search.set(k, v)
    setParams(search, { replace: true })
  }

  function sortBy(column: Column<T>) {
    if (!column.value) return
    const nextDir = sortKey === column.key && dir === 'asc' ? 'desc' : 'asc'
    update({ sort: column.key, dir: nextDir, page: null })
  }

  function exportCsv() {
    const cols = columns.filter((c) => c.value)
    download(csvFileName(exportName ?? label, exportDate), toCsv(cols.map((c) => c.header), sorted.map((r) => cols.map((c) => c.value?.(r)))))
  }

  if (rows.length === 0) return <div className="p-4">{empty}</div>
  const from = (page - 1) * size + 1
  const to = Math.min(sorted.length, page * size)
  const hasTotals = columns.some((c) => c.total)
  const sumOf = (c: Column<T>) => sorted.reduce((s, r) => s + (Number(c.value?.(r)) || 0), 0)

  return (
    <>
      <table className="hidden w-full text-sm md:table" aria-label={label}>
        <thead>
          <tr className="text-left text-xs tracking-wide text-muted uppercase">
            {columns.map((c, i) => {
              const active = sortColumn?.key === c.key
              const Icon = dir === 'asc' ? ArrowUp : ArrowDown
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn('py-2 font-medium', i === 0 ? 'pl-5 pr-3' : 'px-3', i === columns.length - 1 && 'pr-5', c.align === 'right' && 'text-right', c.hide && HIDE[c.hide], c.className)}
                >
                  {c.value ? (
                    <button
                      type="button"
                      onClick={() => sortBy(c)}
                      className={cn('inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2 -mx-2 uppercase transition-colors hover:bg-raised hover:text-fg', active && 'text-fg')}
                    >
                      {c.header}
                      <Icon aria-hidden className={cn('size-3', !active && 'opacity-0')} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {visible.map((row) => (
            <tr key={rowKey(row)} onClick={() => navigate(href(row))} className="cursor-pointer transition-colors hover:bg-raised">
              {columns.map((c, i) => (
                <td key={c.key} className={cn('py-3.5', i === 0 ? 'pl-5 pr-3' : 'px-3', i === columns.length - 1 && 'pr-5', c.align === 'right' && 'text-right', c.hide && HIDE[c.hide], c.className)}>
                  {i === 0 ? (
                    <Link to={href(row)} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                      {c.cell(row)}
                    </Link>
                  ) : (
                    c.cell(row)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-t border-line-strong bg-raised/60 text-sm font-semibold">
              {columns.map((c, i) => (
                <td key={c.key} className={cn('py-3', i === 0 ? 'pl-5 pr-3' : 'px-3', i === columns.length - 1 && 'pr-5', c.align === 'right' && 'text-right tabular', c.hide && HIDE[c.hide])}>
                  {i === 0 && !c.total ? `Total of ${sorted.length}` : c.total ? c.total(sumOf(c)) : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {hasTotals && (
        <p className="border-t border-line px-4 py-3 text-sm font-semibold md:hidden">
          {columns.filter((c) => c.total).map((c) => (
            <span key={c.key} className="mr-4">
              {c.header}: {c.total?.(sumOf(c))}
            </span>
          ))}
        </p>
      )}
      <ul className="divide-y divide-line md:hidden" aria-label={label}>
        {visible.map((row) => (
          <li key={rowKey(row)}>
            <Link to={href(row)} className="block px-4 py-3.5 active:bg-raised">
              {card(row)}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 text-xs text-muted">
        <p className="tabular">
          {from} to {to} of {sorted.length}
        </p>
        {exportName && (
          <Button size="sm" variant="ghost" onClick={exportCsv}>
            <Download aria-hidden className="size-3.5" /> Export CSV
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select compact aria-label="Rows per page" value={String(size)} options={PAGE_SIZES.map((s) => ({ value: s, label: `${s} rows` }))} onChange={(e) => update({ size: e.target.value, page: null })} />
          <Button size="icon-sm" variant="soft" aria-label="Previous page" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
            <ChevronLeft aria-hidden className="size-4" />
          </Button>
          <span className="tabular">
            {page} / {pages}
          </span>
          <Button size="icon-sm" variant="soft" aria-label="Next page" disabled={page >= pages} onClick={() => update({ page: page + 1 >= pages ? String(pages) : String(page + 1) })}>
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    </>
  )
}

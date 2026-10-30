import type { ReactNode } from 'react'
import type { WorkOrderView } from '@/application/views'
import { MAINTENANCE_CATEGORY_LABEL, PRIORITY_LABEL, WORK_ORDER_STATUS_LABEL } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { StatusPill, Tag } from '../../ui/Badge'
import { ListTable } from '../../ui/ListTable'
import { EmptyState } from '../../ui/States'
import { PRIORITY_TONE, WORK_ORDER_TONE } from './tones'

interface WorkOrderTableProps {
  rows: readonly WorkOrderView[]
  label: string
  empty?: ReactNode
  exportName?: string
  exportDate?: string
}

const who = (w: WorkOrderView) => w.vendorName || w.assigneeName || 'Unassigned'
const place = (w: WorkOrderView) => (w.unitCode ? `${w.unitCode} · ${w.villaName}` : w.villaName)

/** The one work order table; rows open the job. */
export function WorkOrderTable({ rows, label, empty, exportName, exportDate }: WorkOrderTableProps) {
  return (
    <ListTable
      label={label}
      rows={rows}
      rowKey={(w) => w.id}
      href={(w) => `/maintenance/work-orders/${w.id}`}
      exportName={exportName}
      exportDate={exportDate}
      empty={empty ?? <EmptyState title="No work orders" />}
      columns={[
        { key: 'title', header: 'Job', cell: (w) => <span className="line-clamp-1">{w.title}</span>, value: (w) => w.title },
        { key: 'no', header: 'Number', cell: (w) => <span className="font-mono text-xs text-muted">{w.number}</span>, value: (w) => w.number, hide: 'xl' },
        { key: 'place', header: 'Unit', cell: place, value: place },
        { key: 'cat', header: 'Category', cell: (w) => MAINTENANCE_CATEGORY_LABEL[w.category], value: (w) => MAINTENANCE_CATEGORY_LABEL[w.category], hide: 'xl' },
        { key: 'prio', header: 'Priority', cell: (w) => <Tag tone={PRIORITY_TONE[w.priority]}>{PRIORITY_LABEL[w.priority]}</Tag>, value: (w) => ['urgent', 'high', 'normal', 'low'].indexOf(w.priority) },
        { key: 'who', header: 'Who', cell: who, value: who, hide: 'lg' },
        { key: 'date', header: 'Reported', cell: (w) => shortDay(w.createdOn), value: (w) => w.createdOn, hide: 'lg' },
        { key: 'status', header: 'Status', cell: (w) => <StatusPill tone={WORK_ORDER_TONE[w.status]}>{WORK_ORDER_STATUS_LABEL[w.status]}</StatusPill>, value: (w) => WORK_ORDER_STATUS_LABEL[w.status] },
        { key: 'total', header: 'Cost', align: 'right', cell: (w) => <span className="tabular">{money(w.total)}</span>, value: (w) => w.total, total: (sum) => money(sum) },
      ]}
      card={(w) => (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{w.title}</p>
            <p className="truncate text-xs text-muted">
              {place(w)} · {shortDay(w.createdOn)} · {who(w)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <StatusPill tone={WORK_ORDER_TONE[w.status]}>{WORK_ORDER_STATUS_LABEL[w.status]}</StatusPill>
            <Tag tone={PRIORITY_TONE[w.priority]}>{PRIORITY_LABEL[w.priority]}</Tag>
          </div>
        </div>
      )}
    />
  )
}

import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { BookOpen, Check, ChefHat, Plus, QrCode, Truck } from 'lucide-react'
import type { ServiceOrderView } from '@/application/views'
import { clockLabel } from '@/domain/roomService'
import { MENU_CATEGORIES, MENU_CATEGORY_LABEL, nextOrderStep, ORDER_ACTION_LABEL, ORDER_STATUS_LABEL, ORDER_STATUSES, orderSummary, type MenuCategory, type OrderAction, type OrderStatus } from '@/domain/serviceOrder'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { StatTile } from '../../ui/StatTile'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { ViewToggle } from '../../ui/ViewToggle'
import { OrderPill, PayPill } from './orderParts'

type StatusFilter = OrderStatus | 'all' | 'open'
const FILTERS: StatusFilter[] = ['open', 'all', ...ORDER_STATUSES]
const COLUMNS: ReadonlyArray<{ status: OrderStatus; hint: string }> = [
  { status: 'new', hint: 'Accept or decline' },
  { status: 'confirmed', hint: 'Accepted, not started' },
  { status: 'preparing', hint: 'Kitchen or partner on it' },
  { status: 'delivered', hint: 'Today' },
]
const STEP_ICON: Record<OrderAction, typeof Check> = { confirmed: Check, preparing: ChefHat, delivered: Truck, cancelled: Check }

const when = (o: ServiceOrderView, today: string) => (o.requestedOn === today ? clockLabel(o.requestedAt) : `${shortDay(o.requestedOn)} ${clockLabel(o.requestedAt)}`)

/** Room service orders from the desk and from guests' phones: accept, prepare, deliver, then bill. */
export default function OrdersPage() {
  const { orders } = useServices()
  const toast = useToast()
  const data = useResource('orders.board', () => orders.board())
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useLayout()
  const status = (FILTERS.find((f) => f === params.get('status')) ?? 'open') as StatusFilter
  const category = (MENU_CATEGORIES.find((c) => c === params.get('category')) ?? '') as MenuCategory | ''
  const query = params.get('q') ?? ''
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  const [busy, setBusy] = useState<string | null>(null)

  function update(next: Partial<{ status: StatusFilter; category: string; q: string; from: string; to: string }>) {
    const search = new URLSearchParams(params)
    const merged = { status, category, q: query, from: from ?? '', to: to ?? '', ...next }
    if (merged.status === 'open') search.delete('status')
    else search.set('status', merged.status)
    for (const key of ['category', 'q', 'from', 'to'] as const) {
      if (merged[key]) search.set(key, merged[key])
      else search.delete(key)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  async function move(o: ServiceOrderView, step: OrderAction) {
    setBusy(o.id)
    try {
      await orders.transition(o.id, step)
      toast({ title: `${ORDER_STATUS_LABEL[step]} ${o.number}`, description: `${o.unitCode} · ${orderSummary(o)}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${o.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const rows = orders.filter(d.list, { status, category, query, from, to })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Food, laundry, transfers, spa and tours ordered for a stay. Delivered orders go on the guest’s bill; paying them books the income for Finance to approve.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} cardsLabel="Board" />
          <Link to="/services/catalog" className={buttonStyles({ variant: 'card' })}>
            <BookOpen aria-hidden className="size-4" /> Menu
          </Link>
          <Link to="/services/qr" className={buttonStyles({ variant: 'card' })}>
            <QrCode aria-hidden className="size-4" /> Room QR cards
          </Link>
          <Link to="/services/orders/new" className={buttonStyles({ variant: 'accent' })}>
            <Plus aria-hidden className="size-4" /> New order
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile label="To accept" value={d.waiting} hint="New from guests and the desk" active={status === 'new'} onClick={() => update({ status: status === 'new' ? 'open' : 'new' })} />
        <StatTile label="Running late" value={d.late} hint="Over 30 min past the time" />
        <StatTile label="Open" value={d.open} hint="Not delivered yet" active={status === 'open'} onClick={() => update({ status: 'open' })} />
        <StatTile label="Sold today" value={money(d.salesToday)} hint={`${d.deliveredToday} delivered`} />
        <StatTile label="On guests’ bills" value={money(d.unpaid)} hint={`${d.unpaidCount} orders to pay`} className="col-span-2 sm:col-span-1" active={status === 'delivered'} onClick={() => update({ status: status === 'delivered' ? 'open' : 'delivered' })} />
      </div>

      <Card className="p-0">
        <TableToolbar
          chips={FILTERS.map((f) => ({ value: f, label: f === 'all' ? 'All' : f === 'open' ? 'Open' : ORDER_STATUS_LABEL[f], count: orders.filter(d.list, { status: f }).length }))}
          chip={status}
          onChip={(f) => update({ status: f })}
          summary={`${rows.length} of ${d.list.length} orders`}
          search={<Input className="h-10" placeholder="Order, unit, guest or item" aria-label="Search orders" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={<Select aria-label="Category" value={category} options={[{ value: '', label: 'All categories' }, ...MENU_CATEGORIES.map((c) => ({ value: c, label: MENU_CATEGORY_LABEL[c] }))]} onChange={(e) => update({ category: e.target.value })} />}
          date={<DateRangeFilter today={d.today} label="Requested" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={status !== 'open' || !!category || !!query || !!from || !!to}
          onClear={() => update({ status: 'open', category: '', q: '', from: '', to: '' })}
        />
        {layout === 'cards' ? (
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map((col) => {
              const cards = (status === 'open' || status === 'all' || status === col.status ? orders.filter(d.list, { category, query, from, to }) : []).filter((o) => o.status === col.status && (col.status !== 'delivered' || o.deliveredOn === d.today))
              return (
                <section key={col.status} aria-label={ORDER_STATUS_LABEL[col.status]} className="flex min-h-40 flex-col rounded-panel bg-raised p-3">
                  <header className="mb-3 flex items-center justify-between px-1">
                    <p className="text-sm font-semibold">
                      {ORDER_STATUS_LABEL[col.status]} <span className="ml-1 text-muted tabular">{cards.length}</span>
                    </p>
                    <p className="text-xs text-muted">{col.hint}</p>
                  </header>
                  {cards.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-xs text-muted">Nothing here</p>
                  ) : (
                    <ul className="space-y-2">
                      {cards.map((o) => {
                        const step = nextOrderStep(o)
                        const Icon = step ? STEP_ICON[step] : Check
                        return (
                          <li key={o.id} className="rounded-xl border border-line bg-card p-3 shadow-card">
                            <Link to={`/services/orders/${o.id}`} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold hover:underline pointer-coarse:min-h-10">
                              <span className="font-mono">{o.unitCode}</span>
                              <span className="font-mono text-xs text-muted">{o.number}</span>
                              {o.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                              {o.late && <Tag tone="danger">Late</Tag>}
                              {o.placedBy === 'guest' && <Tag tone="info">Guest</Tag>}
                            </Link>
                            <p className="mt-0.5 text-xs text-muted">
                              {when(o, d.today)} · {o.guestName}
                              {o.assignee && ` · ${o.assignee}`}
                            </p>
                            <p className="mt-1 line-clamp-2 text-sm text-body">{orderSummary(o)}</p>
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold tabular">{money(o.totals.charge)}</span>
                              {step ? (
                                <Button size="sm" variant={step === 'delivered' ? 'solid' : 'soft'} loading={busy === o.id} onClick={() => void move(o, step)}>
                                  {busy !== o.id && <Icon aria-hidden className="size-3.5" />}
                                  {ORDER_ACTION_LABEL[step]}
                                </Button>
                              ) : (
                                <PayPill state={o.payState} />
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        ) : (
          <ListTable
            label="Orders"
            rows={rows}
            rowKey={(o) => o.id}
            href={(o) => `/services/orders/${o.id}`}
            exportName="room-service-orders"
            exportDate={d.today}
            empty={<EmptyState title="No order matches" action={<Button variant="solid" size="sm" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>} />}
            columns={[
              { key: 'no', header: 'Order', cell: (o) => <span className="font-mono text-xs">{o.number}</span>, value: (o) => o.number },
              { key: 'when', header: 'For', cell: (o) => when(o, d.today), value: (o) => `${o.requestedOn} ${clockLabel(o.requestedAt)}` },
              { key: 'unit', header: 'Unit', cell: (o) => <span className="font-mono">{o.unitCode}</span>, value: (o) => o.unitCode },
              { key: 'guest', header: 'Guest', cell: (o) => o.guestName, value: (o) => o.guestName, hide: 'lg' },
              { key: 'items', header: 'Items', cell: (o) => <span className="line-clamp-1">{orderSummary(o)}</span>, value: (o) => orderSummary(o), hide: 'xl' },
              { key: 'status', header: 'Status', cell: (o) => <span className="flex items-center gap-1.5"><OrderPill status={o.status} />{o.late && <Tag tone="danger">Late</Tag>}</span>, value: (o) => ORDER_STATUS_LABEL[o.status] },
              { key: 'pay', header: 'Bill', cell: (o) => <PayPill state={o.payState} />, value: (o) => o.payState, hide: 'lg' },
              { key: 'charge', header: 'Charge', align: 'right', cell: (o) => <span className="font-semibold tabular">{money(o.totals.charge)}</span>, value: (o) => o.totals.charge, total: (sum) => money(sum) },
            ]}
            card={(o) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    <span className="font-mono">{o.unitCode}</span> · {orderSummary(o)}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {when(o, d.today)} · {o.guestName} · {money(o.totals.charge)}
                  </p>
                </div>
                <OrderPill status={o.status} />
              </div>
            )}
          />
        )}
      </Card>
    </div>
  )
}

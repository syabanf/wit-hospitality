import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Check, ChefHat, Play, Plus, Truck } from 'lucide-react'
import type { ServiceOrderView, ServiceRequestView } from '@/application/views'
import { clockLabel, nextServiceStep, SERVICE_KIND_LABEL, SERVICE_STATUS_LABEL } from '@/domain/roomService'
import { isOpenOrder, nextOrderStep, ORDER_ACTION_LABEL, ORDER_STATUS_LABEL, orderSummary } from '@/domain/serviceOrder'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { POP } from '../../ui/pop'
import { Skeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { SERVICE_TONE } from '../shared/tones'
import { RequestForm } from '../services/RequestForm'
import { Screen } from './Screen'

type Tab = 'orders' | 'todo' | 'done'
const TAB_LABEL: Record<Tab, string> = { orders: 'Orders', todo: 'Requests', done: 'Closed' }

export function ServicesScreen() {
  const { service, orders } = useServices()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const data = useResource('service.list', () => service.list())
  const board = useResource('orders.board', () => orders.board())
  const options = useResource('service.formOptions', () => service.formOptions())
  const creating = params.get('new') === '1'
  const [tab, setTab] = useState<Tab>('orders')
  const [busy, setBusy] = useState<string | null>(null)

  function setCreating(on: boolean) {
    const search = new URLSearchParams(params)
    if (on) search.set('new', '1')
    else {
      search.delete('new')
      search.delete('booking')
      search.delete('unit')
    }
    setParams(search, { replace: true })
  }

  async function advance(r: ServiceRequestView) {
    const step = nextServiceStep(r)
    if (!step) return
    setBusy(r.id)
    try {
      await service.transition(r.id, step)
      toast({ title: step === 'done' ? `Closed ${r.number}` : `Started ${r.number}`, description: `${r.unitCode} · ${SERVICE_KIND_LABEL[r.kind]}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${r.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  /** Accept, start and deliver room service from the phone; delivering puts it on the guest's bill. */
  async function advanceOrder(o: ServiceOrderView) {
    const step = nextOrderStep(o)
    if (!step) return
    setBusy(o.id)
    try {
      await orders.transition(o.id, step)
      toast({ title: `${ORDER_STATUS_LABEL[step]} ${o.number}`, description: step === 'delivered' ? `${money(o.totals.charge)} on ${o.guestName}’s bill` : `${o.unitCode} · ${orderSummary(o)}` })
      board.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${o.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  const d = data.data
  const live = (board.data?.list ?? []).filter(isOpenOrder)
  const rows = d ? d.list.filter((r) => (tab === 'todo' ? r.status === 'open' || r.status === 'in_progress' : r.status === 'done' || r.status === 'cancelled')) : []

  return (
    <Screen
      title="Room services"
      band="ink"
      actions={
        <Button variant="onPop" size="icon" className="size-9" aria-label="New request" aria-pressed={creating} onClick={() => setCreating(!creating)}>
          <Plus aria-hidden className="size-4" />
        </Button>
      }
    >
      {creating && options.data && (
        <section aria-label="New request" className="rounded-[26px] bg-card p-4 shadow-card">
          <RequestForm
            catalog={options.data.catalog}
            inHouse={options.data.inHouse}
            initialBookingId={params.get('booking') ?? undefined}
            initialUnitId={params.get('unit') ?? undefined}
            save={(input) => service.create(input)}
            onDone={() => {
              toast({ title: 'Request created' })
              setCreating(false)
              data.reload()
            }}
            onCancel={() => setCreating(false)}
          />
        </section>
      )}
      {!d ? (
        <Skeleton className="h-72 rounded-[26px]" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className={cn('rounded-[22px] p-3', POP.red)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Orders</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{live.length}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.blue)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Requests</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.open + d.inProgress}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.mist)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Done</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.doneToday}</p>
            </div>
          </div>
          <div role="tablist" aria-label="Requests" className="inline-flex gap-0.5 rounded-full border border-line-strong bg-raised p-1">
            {(['orders', 'todo', 'done'] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('h-10 cursor-pointer rounded-full px-3.5 text-sm', tab === t ? 'bg-invert font-medium text-on-invert' : 'text-muted')}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === 'orders' ? (
            live.length === 0 ? (
              <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">No room service waiting.</p>
            ) : (
              <ul className="space-y-2">
                {live.map((o) => {
                  const step = nextOrderStep(o)
                  const Icon = step === 'delivered' ? Truck : step === 'preparing' ? ChefHat : Check
                  return (
                    <li key={o.id} className="rounded-[22px] bg-card p-3 shadow-card">
                      <div className="flex items-start gap-3">
                        <Link to={`/services/orders/${o.id}`} className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                            <span className="font-mono">{o.unitCode}</span> {ORDER_STATUS_LABEL[o.status]}
                            {o.late && <Tag tone="danger">Late</Tag>}
                            {o.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">
                            {o.requestedOn === board.data?.today ? clockLabel(o.requestedAt) : `${shortDay(o.requestedOn)} ${clockLabel(o.requestedAt)}`} · {o.guestName} · {money(o.totals.charge)}
                          </span>
                          <span className="mt-1 block text-sm text-body">{orderSummary(o)}</span>
                          {o.note && <span className="mt-0.5 block text-xs text-muted">{o.note}</span>}
                        </Link>
                        {step && (
                          <Button size="sm" variant={step === 'delivered' ? 'solid' : 'soft'} loading={busy === o.id} onClick={() => void advanceOrder(o)}>
                            {busy !== o.id && <Icon aria-hidden className="size-3.5" />}
                            {step === 'delivered' ? 'Delivered' : ORDER_ACTION_LABEL[step]}
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          ) : rows.length === 0 ? (
            <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nothing here.</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => {
                const step = nextServiceStep(r)
                return (
                  <li key={r.id} className="rounded-[22px] bg-card p-3 shadow-card">
                    <div className="flex items-start gap-3">
                      <Link to={`/services/${r.id}`} className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <span className="font-mono">{r.unitCode}</span> {SERVICE_KIND_LABEL[r.kind]}
                          {r.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {r.requestedOn === d.today ? clockLabel(r.requestedAt) : shortDay(r.requestedOn)} · {r.guestName ?? 'Housekeeping'}
                          {r.assignee && ` · ${r.assignee}`}
                          {r.charge > 0 && ` · ${money(r.charge)}`}
                        </span>
                        {r.note && <span className="mt-1 block text-sm text-body">{r.note}</span>}
                      </Link>
                      {step ? (
                        <Button size="sm" variant={step === 'done' ? 'solid' : 'soft'} loading={busy === r.id} onClick={() => void advance(r)}>
                          {busy !== r.id && (step === 'done' ? <Check aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />)}
                          {step === 'done' ? 'Done' : 'Start'}
                        </Button>
                      ) : (
                        <StatusPill tone={SERVICE_TONE[r.status]}>{SERVICE_STATUS_LABEL[r.status]}</StatusPill>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </Screen>
  )
}

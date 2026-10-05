import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Check, Play, Plus } from 'lucide-react'
import type { ServiceRequestView } from '@/application/views'
import { clockLabel, nextServiceStep, SERVICE_KIND_LABEL, SERVICE_STATUS_LABEL } from '@/domain/roomService'
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

type Tab = 'todo' | 'done'

export function ServicesScreen() {
  const { service } = useServices()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const data = useResource('service.list', () => service.list())
  const options = useResource('service.formOptions', () => service.formOptions())
  const creating = params.get('new') === '1'
  const [tab, setTab] = useState<Tab>('todo')
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

  const d = data.data
  const rows = d ? d.list.filter((r) => (tab === 'todo' ? r.status === 'open' || r.status === 'in_progress' : r.status === 'done' || r.status === 'cancelled')) : []

  return (
    <Screen
      title="Room services"
      band="ink"
      actions={
        <Button variant="onPop" size="icon-lg" className="size-11" aria-label="New request" aria-pressed={creating} onClick={() => setCreating(!creating)}>
          <Plus aria-hidden className="size-5" />
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
              <p className="text-[11px] font-medium uppercase opacity-80">Open</p>
              <p className="mt-2 text-[34px] leading-none font-semibold tabular">{d.open}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.blue)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Doing</p>
              <p className="mt-2 text-[34px] leading-none font-semibold tabular">{d.inProgress}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.mist)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Done</p>
              <p className="mt-2 text-[34px] leading-none font-semibold tabular">{d.doneToday}</p>
            </div>
          </div>
          <div role="tablist" aria-label="Requests" className="inline-flex gap-0.5 rounded-full border border-line-strong bg-raised p-1">
            {(['todo', 'done'] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('h-8 cursor-pointer rounded-full px-3.5 text-sm', tab === t ? 'bg-invert font-medium text-on-invert' : 'text-muted')}>
                {t === 'todo' ? 'To do' : 'Closed'}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
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

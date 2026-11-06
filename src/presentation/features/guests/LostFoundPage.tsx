import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Plus } from 'lucide-react'
import type { LostItemView } from '@/application/guests'
import { isClosedLost, LOST_STATUS_LABEL, LOST_STATUSES, LOST_TRANSITIONS, RETURN_METHOD_LABEL, type LostStatus, type ReturnMethod } from '@/domain/lostFound'
import { shortDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag, type Tone } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { AttachmentList } from '../shared/Attachments'
import { LostItemForm } from './LostItemForm'

const TONE: Record<LostStatus, Tone> = { found: 'accent', stored: 'neutral', contacted: 'info', returned: 'success', disposed: 'neutral', donated: 'neutral' }

/** The next step on one item: a note, and for a return how and to whom. */
function MoveForm({ item, onDone }: { item: LostItemView; onDone: () => void }) {
  const { lostFound } = useServices()
  const toast = useToast()
  const moves = LOST_TRANSITIONS[item.status].filter((s) => (s !== 'disposed' && s !== 'donated') || item.holdOver)
  const [to, setTo] = useState<LostStatus | ''>(moves[0] ?? '')
  const [method, setMethod] = useState<ReturnMethod>('pickup')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  if (!moves.length) return null

  async function submit(f: FormData) {
    if (!to) return
    setSaving(true)
    setError('')
    try {
      await lostFound.move(item.id, {
        to,
        note: String(f.get('note') ?? ''),
        ...(to === 'returned' ? { returned: { method, to: String(f.get('to') ?? ''), courier: String(f.get('courier') ?? ''), tracking: String(f.get('tracking') ?? '') } } : {}),
      })
      toast({ title: `${item.number} ${LOST_STATUS_LABEL[to].toLowerCase()}` })
      onDone()
    } catch (e) {
      setError(fieldErrors(e).form ?? 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 rounded-panel bg-raised p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit(new FormData(e.currentTarget))
      }}
    >
      <Select aria-label="Next step" value={to} onChange={(e) => setTo(e.target.value as LostStatus)} options={moves.map((s) => ({ value: s, label: LOST_STATUS_LABEL[s] }))} />
      {to === 'returned' && (
        <>
          <Select aria-label="How" value={method} onChange={(e) => setMethod(e.target.value as ReturnMethod)} options={(['pickup', 'courier'] as const).map((m) => ({ value: m, label: RETURN_METHOD_LABEL[m] }))} />
          <Input name="to" aria-label="Given to" placeholder="Given to" defaultValue={item.guestName ?? ''} className="h-10 w-40" />
          {method === 'courier' && (
            <>
              <Input name="courier" aria-label="Courier" placeholder="Courier" className="h-10 w-32" />
              <Input name="tracking" aria-label="Tracking number" placeholder="Tracking number" className="h-10 w-44 font-mono" />
            </>
          )}
        </>
      )}
      <Input name="note" aria-label="Note" placeholder="Note" className="h-10 min-w-40 flex-1" />
      <Button type="submit" variant="solid" size="sm" loading={saving}>
        Save
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </form>
  )
}

/** Lost and found across the villas: what was found, where it sits, and how it went back or left. */
export default function LostFoundPage() {
  const { lostFound } = useServices()
  const { can } = useAccess()
  const data = useResource('lostFound.list', () => lostFound.list())
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const chip = (params.get('status') ?? 'open') as LostStatus | 'open' | 'all'
  const query = params.get('q') ?? ''
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { items, settings, catalog, stays, today } = data.data
  const q = query.trim().toLowerCase()
  const rows = items.filter((i) => (chip === 'all' || (chip === 'open' ? !isClosedLost(i.status) : i.status === chip)) && (!q || [i.number, i.description, i.where, i.villaName, i.guestName ?? ''].some((v) => v.toLowerCase().includes(q))))
  const chips = [
    { value: 'open' as const, label: 'Open', count: items.filter((i) => !isClosedLost(i.status)).length },
    ...LOST_STATUSES.map((s) => ({ value: s, label: LOST_STATUS_LABEL[s], count: items.filter((i) => i.status === s).length })),
    { value: 'all' as const, label: 'All', count: items.length },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Items found in the villas. Unclaimed items are held {settings.holdDays} days before they may be disposed of or donated; change it in Settings.</p>
        {can('guest', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Log a find
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Log a find">
          <LostItemForm
            catalog={catalog}
            stays={stays}
            today={today}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false)
              data.reload()
            }}
          />
        </Card>
      )}
      <Card className="p-0">
        <TableToolbar
          chips={chips}
          chip={chip}
          onChip={(v) => update('status', v === 'open' ? '' : v)}
          summary={`${rows.length} of ${items.length} items`}
          search={<Input className="h-10" placeholder="Item, place, villa or guest" aria-label="Search lost and found" value={query} onChange={(e) => update('q', e.target.value)} />}
          active={!!query || chip !== 'open'}
          onClear={() => setParams(new URLSearchParams(), { replace: true })}
        />
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Nothing here">No item matches these filters.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((i) => (
              <li key={i.id} className="px-4 py-4 text-sm">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <span className="mr-2 font-mono text-xs text-muted">{i.number}</span>
                      {i.description}
                    </p>
                    <p className="text-xs text-muted">
                      {shortDay(i.foundOn)} · {i.villaName}
                      {i.unitCode && `, ${i.unitCode}`} · {i.where} · found by {i.foundBy}
                      {i.storage && ` · stored at ${i.storage}`}
                    </p>
                    {i.guestName && (
                      <p className="text-xs text-muted">
                        Likely{' '}
                        <Link to={`/guests/${i.guestId}`} className="text-accent-text hover:underline">
                          {i.guestName}
                        </Link>
                        {i.bookingCode && (
                          <>
                            ,{' '}
                            <Link to={`/bookings/${i.bookingId}`} className="hover:underline">
                              {i.bookingCode}
                            </Link>
                          </>
                        )}
                      </p>
                    )}
                    {i.returned && (
                      <p className="text-xs text-muted">
                        {RETURN_METHOD_LABEL[i.returned.method]} by {i.returned.to}
                        {i.returned.method === 'courier' && ` · ${i.returned.courier} ${i.returned.tracking}`}
                      </p>
                    )}
                    {!isClosedLost(i.status) && <p className={i.holdOver ? 'text-xs font-medium text-warning' : 'text-xs text-muted'}>{i.holdOver ? 'Holding period over: dispose of or donate it' : `Held until ${shortDay(i.holdUntil)}`}</p>}
                  </div>
                  <Tag tone={TONE[i.status]}>{LOST_STATUS_LABEL[i.status]}</Tag>
                </div>
                {i.photos.length > 0 && (
                  <div className="mt-2">
                    <AttachmentList files={i.photos} />
                  </div>
                )}
                {can('guest', 'edit') && <MoveForm item={i} onDone={data.reload} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

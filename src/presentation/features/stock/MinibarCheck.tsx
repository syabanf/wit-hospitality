import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { ServiceOrder } from '@/domain/serviceOrder'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'

/** What the guest took from the in-room minibar; it bills as a delivered room service order on the stay. */
export function MinibarCheckForm({ bookingId, onDone }: { bookingId: string; onDone: (order: ServiceOrder) => void }) {
  const { stock } = useServices()
  const toast = useToast()
  const sheet = useResource(`stock.minibarSheet:${bookingId}`, () => stock.minibarSheet(bookingId), { keepPrevious: false })
  const [taken, setTaken] = useState<Record<string, number>>({})
  const [restock, setRestock] = useState(true)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const d = sheet.data
  if (!d) return null
  if (!d.open) return <p className="text-sm text-muted">The minibar is checked while the guest is in house.</p>
  const total = d.lines.reduce((s, l) => s + (taken[l.menuItem.id] ?? 0) * l.menuItem.price, 0)
  const bump = (id: string, by: number) => setTaken({ ...taken, [id]: Math.max(0, (taken[id] ?? 0) + by) })

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const order = await stock.minibarCheck({ bookingId, restock, note, lines: Object.entries(taken).map(([menuItemId, quantity]) => ({ menuItemId, quantity })) })
      toast({ title: `Billed ${order.number} to the stay`, description: restock ? `${d?.unitCode} minibar restocked to par` : undefined })
      setTaken({})
      setNote('')
      onDone(order)
    } catch (e) {
      const message = Object.values(fieldErrors(e))[0] ?? 'Could not save the check.'
      setError(message)
      toast({ tone: 'danger', title: 'Could not save the minibar check', description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line">
        {d.lines.map((l) => (
          <li key={l.menuItem.id} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{l.menuItem.name}</span>
              <span className="block text-xs text-muted">
                {money(l.menuItem.price)}
                {l.par > 0 && ` · par ${l.par}`}
                {l.inStore !== null && ` · ${l.inStore} in the store`}
              </span>
            </span>
            <Button size="icon-sm" variant="soft" aria-label={`One less ${l.menuItem.name}`} onClick={() => bump(l.menuItem.id, -1)}>
              <Minus aria-hidden className="size-3.5" />
            </Button>
            <span className="w-6 text-center text-sm font-semibold tabular" aria-label={`${l.menuItem.name} taken`}>
              {taken[l.menuItem.id] ?? 0}
            </span>
            <Button size="icon-sm" variant="soft" aria-label={`One more ${l.menuItem.name}`} onClick={() => bump(l.menuItem.id, 1)}>
              <Plus aria-hidden className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <Input aria-label="Note" value={note} placeholder="Note for the bill, optional" onChange={(e) => setNote(e.target.value)} />
      <div className="flex items-center gap-3">
        <Switch label="Restock to par" checked={restock} onChange={setRestock} />
        <span className="text-sm text-muted">{restock ? 'Issue the same items from the villa store' : 'Restock later'}</span>
      </div>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      <Button variant="accent" className="w-full sm:w-auto" loading={saving} disabled={total === 0} onClick={() => void submit()}>
        Bill {money(total)} to the stay
      </Button>
    </div>
  )
}

/** The minibar check on a stay's record page, for staff who may take orders. */
export function MinibarCheckCard({ bookingId, status, onDone }: { bookingId: string; status: string; onDone: () => void }) {
  const { can } = useAccess()
  const [open, setOpen] = useState(false)
  if (status !== 'checked_in' || !can('services', 'create')) return null
  return (
    <Card aria-labelledby="stay-minibar">
      <CardHeader
        id="stay-minibar"
        title="Minibar check"
        action={
          <Button size="sm" variant={open ? 'soft' : 'solid'} onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Check the minibar'}
          </Button>
        }
      />
      {open ? (
        <MinibarCheckForm
          bookingId={bookingId}
          onDone={() => {
            setOpen(false)
            onDone()
          }}
        />
      ) : (
        <p className="text-sm text-muted">Enter what the guest took; it goes on the room service bill and settles at check-out.</p>
      )}
    </Card>
  )
}

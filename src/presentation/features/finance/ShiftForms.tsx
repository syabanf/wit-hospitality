import { useState, type FormEvent } from 'react'
import type { CashierServices, ShiftView } from '@/application/cashier'
import { countTotal, emptyCount, handOverAmount, needsSignOff, type ShiftPolicy } from '@/domain/cashier'
import { money } from '@/lib/format'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { DrawerCounter, ShiftFigures } from './DrawerCount'
import { differenceText } from './shiftText'

type Desk = Awaited<ReturnType<CashierServices['desk']>>

/** Opens a shift on a free cashbox: take over the last drawer, or count a fresh float. */
export function OpenShiftForm({ desk, onOpened }: { desk: Desk; onOpened: () => void }) {
  const { cashier } = useServices()
  const toast = useToast()
  const free = desk.cashboxes.filter((c) => !c.open)
  const [accountId, setAccountId] = useState(free[0]?.account.id ?? '')
  const [takeOver, setTakeOver] = useState(true)
  const [count, setCount] = useState(emptyCount)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const box = free.find((c) => c.account.id === accountId) ?? free[0]
  const handOver = takeOver ? (box?.handOver ?? null) : null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!box) return
    setSaving(true)
    setError(undefined)
    try {
      const shift = await cashier.open({ accountId: box.account.id, count, handOverFrom: handOver?.id ?? null })
      toast({ title: `Opened ${shift.number}`, description: `${box.account.name} with a float of ${money(shift.float)}.` })
      setCount(emptyCount())
      onOpened()
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0])
    } finally {
      setSaving(false)
    }
  }

  if (!box) return <p className="text-sm text-muted">Every cashbox you work has a shift open.</p>
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      {!desk.rostered && (
        <p role="note" className="rounded-2xl bg-warning-soft p-3 text-sm text-warning">
          {desk.manager ? 'You are not on today’s roster; as a manager you may still open the shift.' : 'You are not on today’s roster. Ask a manager to open the shift.'}
        </p>
      )}
      <Field label="Cashbox" htmlFor="open-box">
        <Select id="open-box" className="w-full" value={box.account.id} options={free.map((c) => ({ value: c.account.id, label: `${c.account.name}, ${c.location.name}` }))} onChange={(e) => setAccountId(e.target.value)} />
      </Field>
      {box.handOver && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={takeOver} onChange={(e) => setTakeOver(e.target.checked)} />
          <span>
            Take over {box.handOver.number} from {box.handOver.cashierName}: accept its count of {money(handOverAmount(box.handOver))} as the float.
          </span>
        </label>
      )}
      {!handOver && <DrawerCounter id="open-count" value={count} onChange={setCount} />}
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="accent" className="w-full sm:w-auto" loading={saving}>
        Open shift with {money(handOver ? handOverAmount(handOver) : countTotal(count))}
      </Button>
    </form>
  )
}

/** Counts the drawer against what it should hold; a difference past the tolerance asks for the reason. */
export function CloseShiftForm({ shift, policy, onClosed }: { shift: ShiftView; policy: ShiftPolicy; onClosed: () => void }) {
  const { cashier } = useServices()
  const toast = useToast()
  const [count, setCount] = useState(emptyCount)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const difference = countTotal(count) - shift.totals.expected
  const beyond = needsSignOff(difference, policy)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(undefined)
    try {
      const closed = await cashier.close(shift.id, { count, reason })
      toast({ title: `Closed ${closed.number}`, description: closed.status === 'awaiting_signoff' ? `${differenceText(closed.difference)}; a manager signs it off.` : differenceText(closed.difference) })
      onClosed()
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0])
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <ShiftFigures float={shift.float} totals={shift.totals} />
      <DrawerCounter id={`close-${shift.id}`} value={count} onChange={setCount} />
      <p className={beyond ? 'text-sm font-semibold text-danger' : 'text-sm text-muted'}>
        {differenceText(difference)}
        {beyond && `, past the ${money(policy.tolerance)} tolerance: give the reason; a manager signs it off.`}
      </p>
      {(beyond || difference !== 0) && (
        <Field label="Reason for the difference" htmlFor={`reason-${shift.id}`}>
          <Textarea id={`reason-${shift.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Change given twice, slip missing…" />
        </Field>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="accent" className="w-full sm:w-auto" loading={saving}>
        Close shift on {money(countTotal(count))}
      </Button>
    </form>
  )
}

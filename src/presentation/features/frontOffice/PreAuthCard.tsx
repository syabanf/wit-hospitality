import { useState, type FormEvent } from 'react'
import { CreditCard, TriangleAlert } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { cardLabel, PRE_AUTH_STATUS_LABEL, type PreAuthStatus } from '@/domain/preAuth'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag, type Tone } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { useToast } from '../../ui/useToast'
import { CardFields } from './DepositSection'
import { readCard } from './depositForm'

const STATUS_TONE: Record<PreAuthStatus, Tone> = { active: 'info', captured: 'success', released: 'neutral' }

const useHolds = (b: BookingView) => {
  const { frontOffice } = useServices()
  return useResource(`frontOffice.preAuths:${b.id}:${b.status}:${b.paidAmount}`, () => frontOffice.preAuths.forStay(b.id), { keepPrevious: false })
}

/** At check-out: an active card hold still waits to be captured or released. */
export function PreAuthNotice({ booking: b }: { booking: BookingView }) {
  const data = useHolds(b)
  const active = data.data?.holds.find((h) => h.status === 'active')
  if (!active) return null
  return (
    <p role="status" className="mb-4 flex gap-2 rounded-panel bg-warning-soft p-3.5 text-sm text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        {active.number} holds {money(active.amount)} on {cardLabel(active)}{active.expired ? `, lapsed on ${shortDay(active.expiresOn)}` : ''}. Capture it against the room balance or release it on the Card hold card before the guest leaves.
      </span>
    </p>
  )
}

/** The stay's card holds: take one as the security deposit, capture it against the room balance or let it go. */
export function PreAuthCard({ booking: b, onChanged }: { booking: BookingView; onChanged: () => void }) {
  const { frontOffice } = useServices()
  const toast = useToast()
  const data = useHolds(b)
  const [taking, setTaking] = useState(false)
  const [capturing, setCapturing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const d = data.data
  const open = b.status === 'confirmed' || b.status === 'checked_in'
  if (!d || (d.holds.length === 0 && (!open || !d.canTake))) return null
  const active = d.holds.find((h) => h.status === 'active')

  async function act(label: string, action: () => Promise<unknown>, description?: string) {
    setBusy(true)
    setErrors({})
    try {
      await action()
      toast({ title: label, description })
      setTaking(false)
      setCapturing(null)
      data.reload()
      onChanged()
    } catch (error) {
      const fields = fieldErrors(error)
      setErrors(fields)
      if (fields.form) toast({ tone: 'danger', title: 'The gateway refused', description: fields.form })
    } finally {
      setBusy(false)
    }
  }

  function take(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const amount = Number(f.get('deposit'))
    void act('Took a card hold', () => frontOffice.preAuths.take({ bookingId: b.id, amount, ...readCard(f) }), `${money(amount)} on ${b.code}`)
  }

  function capture(e: FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault()
    const amount = Number(new FormData(e.currentTarget).get('amount'))
    void act('Captured the card hold', () => frontOffice.preAuths.capture(id, amount), `${money(amount)} paid on the folio by card`)
  }

  return (
    <Card aria-labelledby="preauth-title">
      <CardHeader
        id="preauth-title"
        title="Card hold"
        icon={<CreditCard aria-hidden className="size-5 text-muted" />}
        action={
          open && d.canTake && !active && !taking && (
            <Button size="sm" variant="soft" onClick={() => setTaking(true)}>
              Take a hold
            </Button>
          )
        }
      />
      {d.holds.length === 0 && !taking && <p className="text-sm text-muted">No card hold on this stay. A hold secures the deposit on the guest's card without taking the money.</p>}
      <ul className="space-y-3">
        {d.holds.map((h) => (
          <li key={h.id} className="rounded-panel bg-raised p-3.5 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{h.number}</span>
              <Tag tone={h.expired ? 'warning' : STATUS_TONE[h.status]}>{h.expired ? 'Lapsed' : PRE_AUTH_STATUS_LABEL[h.status]}</Tag>
              <span className="ml-auto font-medium text-fg tabular">{money(h.amount)}</span>
            </p>
            <p className="mt-1 text-xs text-muted">
              {cardLabel(h)} · approval {h.approvalCode} · until {shortDay(h.expiresOn)} · {h.takenBy}
            </p>
            {h.status === 'captured' && <p className="mt-1 text-xs text-muted">Captured {money(h.captured)} by {h.closedBy}; the rest was let go.</p>}
            {h.status === 'released' && <p className="mt-1 text-xs text-muted">Released by {h.closedBy}.</p>}
            {h.expired && <p className="mt-1 text-xs font-medium text-warning">The hold lapsed on {shortDay(h.expiresOn)}; take another card or another deposit.</p>}
            {h.status === 'active' && d.canTake && capturing !== h.id && (
              <div className="mt-2 flex flex-wrap gap-2">
                {!h.expired && d.roomDue > 0 && (
                  <Button size="sm" variant="solid" onClick={() => setCapturing(h.id)}>
                    Capture
                  </Button>
                )}
                <Button size="sm" variant="ghost" loading={busy && capturing === null} onClick={() => void act('Released the card hold', () => frontOffice.preAuths.release(h.id), `${h.number} on ${b.code}`)}>
                  Release
                </Button>
              </div>
            )}
            {capturing === h.id && (
              <form onSubmit={(e) => capture(e, h.id)} className="mt-3 flex flex-wrap items-end gap-2" aria-label={`Capture ${h.number}`}>
                <Field label={`Capture, room balance ${money(d.roomDue)}`} htmlFor="pa-amount" error={errors.amount} className="min-w-40 flex-1">
                  <Input id="pa-amount" name="amount" type="number" inputMode="numeric" min={1} defaultValue={Math.min(h.amount, d.roomDue)} className="tabular" autoFocus />
                </Field>
                <Button type="submit" size="sm" variant="accent" loading={busy}>
                  Capture
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCapturing(null)}>
                  Cancel
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {taking && (
        <form onSubmit={take} className="mt-3 space-y-3" aria-label="Take a card hold">
          <Field label="Hold, Rp" htmlFor="pa-deposit" error={errors.deposit ?? errors.amount}>
            <Input id="pa-deposit" name="deposit" type="number" inputMode="numeric" min={0} step={100_000} defaultValue={1_000_000} className="tabular" />
          </Field>
          <CardFields errors={errors} until={b.checkOut} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="accent" loading={busy}>
              Hold on the card
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTaking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

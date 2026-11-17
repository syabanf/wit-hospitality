import { useState, type ReactNode } from 'react'
import { AlarmClock, ClipboardSignature } from 'lucide-react'
import type { GuestWakeUp } from '@/domain/stay'
import { shortDay } from '@/lib/dates'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { SignaturePad } from '../shared/SignaturePad'

const SECTION = 'rounded-card border border-line bg-card p-5 shadow-card space-y-3'

function Section({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={SECTION}>
      <h2 id={id} className="flex items-center gap-2 font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

/** The guest signs the registration card on their own phone: the house rules, then the pad. */
export function GuestCardSection({ guestName, villaName, rules, busy, error, onSign }: { guestName: string; villaName: string; rules: readonly string[]; busy: boolean; error?: string; onSign: (png: Blob) => Promise<unknown> }) {
  return (
    <Section id="gd-card" title="Registration card" icon={<ClipboardSignature aria-hidden className="size-4 text-muted" />}>
      <p className="text-sm text-muted">
        Sign here to confirm your stay details and agree to the house rules of {villaName}. The front desk keeps it with your booking, so check-in goes faster.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="text-xs text-muted">Signed by {guestName}</p>
      <SignaturePad saving={busy} error={error} label="Sign the card" onSign={onSign} />
    </Section>
  )
}

const STATUS_LABEL = { pending: 'Booked', done: 'Done', cancelled: 'Cancelled' } as const
const STATUS_TONE = { pending: 'info', done: 'success', cancelled: 'neutral' } as const

/** The guest books a wake-up call from the stay page; the front desk rings at that time. */
export function WakeUpCard({ calls, today, checkIn, checkOut, busy, errors, onBook }: { calls: readonly GuestWakeUp[]; today: string; checkIn: string; checkOut: string; busy: boolean; errors: Record<string, string>; onBook: (input: { date: string; time: string; note: string; repeatDaily: boolean }) => Promise<boolean> }) {
  const first = today < checkIn ? checkIn : today
  const [date, setDate] = useState(first < checkOut ? first : checkOut)
  const [time, setTime] = useState('07:00')
  const [note, setNote] = useState('')
  const [daily, setDaily] = useState(false)
  return (
    <Section id="gd-wake" title="Wake-up call" icon={<AlarmClock aria-hidden className="size-4 text-muted" />}>
      {calls.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {calls.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <span className="font-medium tabular">{c.time}</span>
              <span className="min-w-0 flex-1 text-xs text-muted">
                {c.date === today ? 'Today' : shortDay(c.date)}
                {c.repeatDaily && ', every morning'}
              </span>
              <StatusPill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</StatusPill>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Day" htmlFor="gd-wake-date" error={errors.date}>
          <Input id="gd-wake-date" tone="card" type="date" min={first} max={checkOut} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Time" htmlFor="gd-wake-time" error={errors.time}>
          <Input id="gd-wake-time" tone="card" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="tabular" />
        </Field>
      </div>
      <Field label="Note for the desk" htmlFor="gd-wake-note" error={errors.note}>
        <Input id="gd-wake-note" tone="card" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Coffee with the call, please" />
      </Field>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} className="size-4 accent-accent" /> Every morning until check-out
      </label>
      <Button
        variant="soft"
        className="w-full"
        loading={busy}
        onClick={() =>
          void onBook({ date, time, note, repeatDaily: daily }).then((ok) => {
            if (ok) setNote('')
          })
        }
      >
        Book the wake-up call
      </Button>
    </Section>
  )
}

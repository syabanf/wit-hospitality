import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { AlarmClock, ClipboardSignature, KeyRound, Sunrise } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { KEY_KIND_LABEL, KEY_KINDS, KEY_REASON_LABEL, KEY_STATUS_LABEL, keysOut, WAKE_UP_OUTCOME_LABEL, type KeyKind, type WakeUpOutcome } from '@/domain/frontDesk'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

/** The action running: early, key, wake, or a key or call id with its outcome. */
type Busy = string | null
const text = (f: FormData, key: string) => String(f.get(key) ?? '').trim()
const KIND_OPTIONS = KEY_KINDS.map((k) => ({ value: k, label: KEY_KIND_LABEL[k] }))
const STATUS_TONE = { out: 'warning', returned: 'success', lost: 'danger', not_returned: 'danger' } as const

/** The desk's standard steps on one stay: the registration card, early check-in, keys and wake-up calls. */
export function FrontDeskCard({ booking: b, today, onChanged }: { booking: BookingView; today: string; onChanged: () => void }) {
  const { frontDesk } = useServices()
  const toast = useToast()
  const early = useResource(`frontDesk.earlyTerms:${b.id}:${b.status}`, () => frontDesk.earlyTerms(b.id))
  const [busy, setBusy] = useState<Busy>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState(false)
  const inHouse = b.status === 'checked_in'
  const live = b.status === 'confirmed' || inHouse
  const keys = b.keys ?? []
  const out = keysOut(b)
  const calls = (b.wakeUpCalls ?? []).slice().sort((x, y) => x.date.localeCompare(y.date) || x.time.localeCompare(y.time))

  async function run(key: NonNullable<Busy>, title: string, action: () => Promise<unknown>, form?: HTMLFormElement) {
    setBusy(key)
    setErrors({})
    try {
      const said = await action()
      toast({ title, description: typeof said === 'string' ? said : undefined })
      form?.reset()
      setReplacing(false)
      onChanged()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not ${title.charAt(0).toLowerCase()}${title.slice(1)}`, description: Object.values(e)[0] })
    } finally {
      setBusy(null)
    }
  }
  const submit = (handler: (f: FormData, form: HTMLFormElement) => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    handler(new FormData(e.currentTarget), e.currentTarget)
  }

  const issueKey = (f: FormData, form: HTMLFormElement) => {
    const fee = text(f, 'fee')
    const input = { number: text(f, 'number'), kind: text(f, 'kind') as KeyKind, reason: replacing ? ('replacement' as const) : ('extra' as const), replacesKeyId: replacing ? text(f, 'replaces') : null, ...(replacing && fee ? { fee: Number(fee) } : {}) }
    void run('key', replacing ? `Gave a replacement key ${input.number}` : `Gave an extra key ${input.number}`, () => frontDesk.issueKey(b.id, input), form)
  }
  const bookWakeUp = (f: FormData, form: HTMLFormElement) => {
    const input = { date: text(f, 'date'), time: text(f, 'time'), note: text(f, 'note'), repeatDaily: f.get('repeatDaily') === 'on' }
    void run('wake', `Booked a wake-up call at ${input.time}`, () => frontDesk.bookWakeUp(b.id, input), form)
  }
  const outcome = (callId: string, o: WakeUpOutcome) => void run(`${callId}:${o}`, `Marked the wake-up call ${WAKE_UP_OUTCOME_LABEL[o].toLowerCase()}`, () => frontDesk.wakeUpOutcome(b.id, callId, o))
  const earlyCheckin = (f: FormData) => {
    const from = text(f, 'from')
    void run('early', `Gave early check-in from ${from}`, async () => {
      const r = await frontDesk.earlyCheckin(b.id, from)
      return r.charge ? `${money(r.charge)} went on the folio.` : 'Free of charge.'
    })
  }

  const e = early.data
  const earlyFree = e && (e.fee === 0 || (e.kind === 'villa' && (!e.departure || b.place.villa.operation === 'mixed')))
  const earlyNote = e ? `${e.departure && !e.departure.checkedOut ? `${e.departure.code} leaves by ${e.departure.leavesBy}. ` : ''}${earlyFree ? 'No charge.' : `${money(e.fee)} on the folio.`}` : ''

  return (
    <Card aria-labelledby="front-desk-title">
      <CardHeader id="front-desk-title" title="Front desk" />

      <section aria-label="Registration card" className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-raised p-3.5">
        <div className="min-w-0 text-sm">
          <p className="font-medium">Registration card</p>
          <p className="text-xs text-muted">
            {b.registrationCard
              ? `Signed ${b.registrationCard.method === 'screen' ? 'on screen' : `on paper, card ${b.registrationCard.cardNumber}`} by ${b.guestName}`
              : b.place.villa.requireRegistrationCard
                ? 'Not signed yet; check-in waits for it.'
                : 'Not signed yet.'}
          </p>
        </div>
        <Link to={`/bookings/${b.id}/registration-card`} className={buttonStyles({ variant: b.registrationCard || !live ? 'soft' : 'solid', size: 'sm' })}>
          <ClipboardSignature aria-hidden className="size-3.5" /> {b.registrationCard || !live ? 'Open card' : 'Sign card'}
        </Link>
      </section>

      {(b.status === 'confirmed' || b.earlyCheckin) && (
        <section aria-label="Early check-in" className="mt-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Sunrise aria-hidden className="size-4 text-muted" /> Early check-in
          </p>
          {b.earlyCheckin ? (
            <p className="mt-1 text-sm text-body">
              From {b.earlyCheckin.from}, {b.earlyCheckin.charge ? money(b.earlyCheckin.charge) : 'free'}
              {b.earlyCheckin.by && <span className="text-muted"> · given by {b.earlyCheckin.by}</span>}
            </p>
          ) : (
            <form onSubmit={submit((f) => earlyCheckin(f))} className="mt-2 flex flex-wrap items-end gap-3">
              <Field label="Arrives at" htmlFor="early-from" error={errors.from} hint={e ? `Check-in is from ${e.checkInTime}. ${earlyNote}` : undefined} className="min-w-0 flex-1">
                <Input id="early-from" name="from" type="time" defaultValue="11:00" className="tabular" />
              </Field>
              <Button type="submit" variant="soft" loading={busy === 'early'}>
                Give early check-in
              </Button>
            </form>
          )}
        </section>
      )}

      <section aria-label="Keys" className="mt-5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <KeyRound aria-hidden className="size-4 text-muted" /> Keys {out.length > 0 && <Tag tone="warning">{out.length} out</Tag>}
        </p>
        {keys.length === 0 ? (
          <p className="mt-1 text-sm text-muted">{b.arrival?.keysHanded ? 'Keys were handed over at check-in; this stay has no key record.' : 'No key handed out yet; check-in records the first one.'}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-mono font-medium">{k.number}</span>
                <span className="text-xs text-muted">
                  {KEY_KIND_LABEL[k.kind]} · {KEY_REASON_LABEL[k.reason]} · {shortDay(k.issuedAt.slice(0, 10))}
                  {k.charge > 0 && ` · ${money(k.charge)} charged`}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <StatusPill tone={STATUS_TONE[k.status]}>{KEY_STATUS_LABEL[k.status]}</StatusPill>
                  {inHouse && k.status === 'out' && (
                    <Button size="sm" variant="soft" loading={busy === `${k.id}:back`} onClick={() => void run(`${k.id}:back`, `Took back key ${k.number}`, () => frontDesk.returnKey(b.id, k.id, true))}>
                      Returned
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {inHouse && (
          <form onSubmit={submit(issueKey)} className="mt-3 grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-3">
            <Field label="Key number or code" htmlFor="key-number" error={errors.number}>
              <Input id="key-number" name="number" placeholder="C-0412" className="font-mono" />
            </Field>
            <Field label="Kind" htmlFor="key-kind" error={errors.kind}>
              <Select id="key-kind" name="kind" className="w-full" defaultValue={b.place.group?.kind === 'room' ? 'card' : 'key'} options={KIND_OPTIONS} />
            </Field>
            {out.length > 0 && (
              <label className="flex min-h-12 items-center gap-3 self-end rounded-full border border-line-strong bg-raised px-4 py-2 text-sm">
                <input type="checkbox" checked={replacing} onChange={(ev) => setReplacing(ev.target.checked)} className="size-4 accent-accent" />
                Replaces a lost key
              </label>
            )}
            {replacing && (
              <>
                <Field label="Lost key" htmlFor="key-replaces" error={errors.replacesKeyId}>
                  <Select id="key-replaces" name="replaces" className="w-full" options={out.map((k) => ({ value: k.id, label: `${k.number}, ${KEY_KIND_LABEL[k.kind]}` }))} />
                </Field>
                <Field label="Lost key fee, Rp" htmlFor="key-fee" error={errors.fee} hint="Optional; goes on the folio">
                  <Input id="key-fee" name="fee" type="number" inputMode="numeric" min={0} step={50_000} placeholder="0" className="tabular" />
                </Field>
              </>
            )}
            <div className="sm:col-span-3">
              <Button type="submit" variant="soft" loading={busy === 'key'}>
                <KeyRound aria-hidden className="size-3.5" /> {replacing ? 'Give replacement key' : 'Give extra key'}
              </Button>
            </div>
          </form>
        )}
      </section>

      <section aria-label="Wake-up calls" className="mt-5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <AlarmClock aria-hidden className="size-4 text-muted" /> Wake-up calls
        </p>
        {calls.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No wake-up call booked.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {calls.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-medium tabular">{c.time}</span>
                <span className="text-xs text-muted">
                  {c.date === today ? 'Today' : shortDay(c.date)}
                  {c.repeatDaily && ', daily'}
                  {c.note && ` · ${c.note}`}
                  {c.by === 'Guest' && ' · asked by the guest'}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {c.status === 'pending' && inHouse ? (
                    (['done', 'no_answer', 'cancelled'] as const).map((o) => (
                      <Button key={o} size="sm" variant={o === 'done' ? 'solid' : 'soft'} loading={busy === `${c.id}:${o}`} onClick={() => outcome(c.id, o)}>
                        {o === 'cancelled' ? 'Cancel' : WAKE_UP_OUTCOME_LABEL[o]}
                      </Button>
                    ))
                  ) : (
                    <StatusPill tone={c.status === 'done' ? 'success' : c.status === 'pending' ? 'info' : 'neutral'}>{c.status === 'pending' ? 'Booked' : c.status === 'done' ? 'Done' : 'Cancelled'}</StatusPill>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {live && (
          <form onSubmit={submit(bookWakeUp)} className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
            <Field label="Day" htmlFor="wake-date" error={errors.date}>
              <Input id="wake-date" name="date" type="date" min={b.checkIn > today ? b.checkIn : today} max={b.checkOut} defaultValue={b.checkIn > today ? b.checkIn : today < b.checkOut ? today : b.checkOut} />
            </Field>
            <Field label="Time" htmlFor="wake-time" error={errors.time}>
              <Input id="wake-time" name="time" type="time" defaultValue="06:30" className="tabular" />
            </Field>
            <Field label="Note" htmlFor="wake-note" error={errors.note} className="col-span-2">
              <Input id="wake-note" name="note" placeholder="Airport transfer at 07:30" />
            </Field>
            <label className="col-span-2 flex min-h-12 items-center gap-3 rounded-full border border-line-strong bg-raised px-4 py-2 text-sm">
              <input type="checkbox" name="repeatDaily" className="size-4 accent-accent" /> Every morning until check-out
            </label>
            <div className="col-span-2 flex items-end">
              <Button type="submit" variant="soft" loading={busy === 'wake'}>
                <AlarmClock aria-hidden className="size-3.5" /> Book wake-up call
              </Button>
            </div>
          </form>
        )}
      </section>
    </Card>
  )
}

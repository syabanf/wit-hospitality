import { useState, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { BedDouble, CircleAlert, CircleCheck, Clock, ConciergeBell, Moon, Receipt, Send, Sparkles, SunMedium } from 'lucide-react'
import { SETUP_LABEL, SETUPS, type GuestPreferences, type ServiceWindow, type Setup } from '@/domain/hospitality'
import { clockLabel, SERVICE_KIND_LABEL, SERVICE_STATUS_LABEL } from '@/domain/roomService'
import { COMPLAINT_CATEGORIES, COMPLAINT_CATEGORY_LABEL, type StayComplaintInput } from '@/domain/relations'
import { lineAmount, ORDER_STATUS_LABEL } from '@/domain/serviceOrder'
import { GUEST_REQUEST_KINDS, GUEST_REQUEST_LABEL, lateCheckoutTimes, type GuestRequestInput, type GuestStayView, type LateCheckoutQuote } from '@/domain/stay'
import { addDays, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState } from '../../ui/States'
import { MenuList } from '../services/orderParts'
import { nextSlot, toClock, toMinutes } from '../services/clock'
import { ORDER_TONE, SERVICE_TONE } from '../shared/tones'
import { GuestCardSection, WakeUpCard } from './GuestDeskCards'

const SECTION = 'rounded-card border border-line bg-card p-5 shadow-card'
const SETUP_OPTIONS = SETUPS.map((id) => ({ id, label: SETUP_LABEL[id] }))
const when = (on: string, at: number, today: string) => `${on === today ? 'Today' : shortDay(on)} ${clockLabel(at)}`

function Section({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`${SECTION} space-y-3`}>
      <h2 id={id} className="flex items-center gap-2 font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * The guest's page during the stay, opened from the link the welcome message carries or the QR
 * card in the room. No sign-in: the stay's token is the key. It opens from check-in, turns read only
 * at check-out and closes a day later.
 */
export default function StayPage() {
  const { token = '' } = useParams()
  const { stay, frontDesk } = useServices()
  const data = useResource(`stay.view:${token}`, () => stay.view(token), { keepPrevious: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const v = data.data
  const open = v?.state === 'open'

  /** Runs one guest action; the answer is the page as it reads afterwards. */
  async function act(key: string, run: () => Promise<GuestStayView>, done: string) {
    setBusy(key)
    setNotice(null)
    setErrors({})
    try {
      data.setData(await run())
      setNotice({ tone: 'ok', text: done })
      return true
    } catch (e) {
      const found = fieldErrors(e)
      setErrors(found)
      setNotice({ tone: 'error', text: Object.values(found)[0] ?? 'That did not go through. Try again.' })
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-dvh bg-canvas px-[max(env(safe-area-inset-left),1rem)] pt-[max(env(safe-area-inset-top),1.5rem)] pb-[max(env(safe-area-inset-bottom),2rem)]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BrandMark className="size-7 text-fg" />
            <span className="text-sm font-bold tracking-tight">{v?.villaName ?? 'WIT Hospitality'}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <BedDouble aria-hidden className="size-4" /> Your stay
          </span>
        </header>
        {!v && data.status === 'error' && <EmptyState title="This stay page is closed">The link works from check-in until a day after check-out. Ask the front desk or your host for help.</EmptyState>}
        {!v && data.status !== 'error' && <CardSkeleton lines={6} />}
        {v && (
          <main className="animate-rise space-y-4">
            <section className={SECTION}>
              <h1 className="text-2xl font-semibold tracking-tight">
                Hello {v.guestName}
                <span className="text-accent">.</span>
              </h1>
              <p className="mt-1 text-sm text-muted">
                {v.unitName} · {v.villaName}, {v.locationName}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-panel bg-raised p-3">
                  <dt className="text-xs text-muted">Check-in</dt>
                  <dd className="font-medium">
                    {shortDay(v.checkIn)}, {v.checkInTime}
                  </dd>
                </div>
                <div className="rounded-panel bg-raised p-3">
                  <dt className="text-xs text-muted">Check-out</dt>
                  <dd className="font-medium">
                    {shortDay(v.checkOut)}, {v.lateCheckout?.until ?? v.checkOutTime}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-sm">
                {plural(v.nights, 'night')}
                {v.hostName && (
                  <>
                    {' '}
                    · your host is <span className="font-medium">{v.hostName}</span>
                  </>
                )}
              </p>
              {!open && <p className="mt-3 rounded-panel bg-info-soft p-3 text-sm text-info-text">Your stay has ended, so this page is read only now. Thank you for staying with us.</p>}
            </section>

            {notice && (
              <p role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'rounded-panel bg-danger-soft p-3 text-sm font-medium text-danger' : 'flex items-center gap-2 rounded-panel bg-success-soft p-3 text-sm font-medium text-success'}>
                {notice.tone === 'ok' && <CircleCheck aria-hidden className="size-4 shrink-0" />}
                {notice.text}
              </p>
            )}

            {open && (
              <>
                <CleanCard v={v} busy={busy === 'clean'} errors={errors} onAsk={(note) => act('clean', () => stay.askClean(token, note), 'Cleaning asked for today. The team will come by.')} />
                <WindowCard v={v} busy={busy === 'window'} errors={errors} onSave={(w, done) => act('window', () => stay.setServiceWindow(token, w), done)} />
                <OrderCard v={v} busy={busy === 'order'} onOrder={(input) => act('order', () => stay.placeOrder(token, input), 'Order sent. It goes on your bill.')} />
                <RequestCard v={v} busy={busy === 'request'} errors={errors} onSend={(input) => act('request', () => stay.request(token, input), v.hostName ? `Sent to ${v.hostName}.` : 'Sent to the front desk.')} />
                <ProblemCard busy={busy === 'complaint'} errors={errors} onSend={(input) => act('complaint', () => stay.complain(token, input), 'Thank you for telling us. The front desk will get back to you.')} />
                {v.wakeUpCalls && <WakeUpCard calls={v.wakeUpCalls} today={v.today} checkIn={v.checkIn} checkOut={v.checkOut} busy={busy === 'wake'} errors={errors} onBook={(input) => act('wake', () => frontDesk.guestBookWakeUp(token, input), `Wake-up call booked for ${input.time}.`)} />}
                {v.cardSigned === false && <GuestCardSection guestName={v.guestName} villaName={v.villaName} rules={v.houseRules} busy={busy === 'card'} error={errors.signature} onSign={(png) => act('card', () => frontDesk.guestSignOnStay(token, png), 'Registration card signed. Thank you.')} />}
              </>
            )}

            {(v.orders.length > 0 || v.requests.length > 0) && (
              <Section id="st-asked" title="What you asked for" icon={<ConciergeBell aria-hidden className="size-4 text-muted" />}>
                <ul className="divide-y divide-line text-sm">
                  {v.orders.map((o) => (
                    <li key={o.number} className="flex items-start gap-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2">{o.lines.map((l) => `${l.quantity} × ${l.name}`).join(', ')}</span>
                        <span className="block text-xs text-muted">{when(o.requestedOn, o.requestedAt, v.today)}</span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        <StatusPill tone={ORDER_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</StatusPill>
                        <span className="text-xs tabular">{money(o.charge)}</span>
                      </span>
                    </li>
                  ))}
                  {v.requests.map((r) => (
                    <li key={r.number} className="flex items-start gap-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        {SERVICE_KIND_LABEL[r.kind]}
                        <span className="block text-xs text-muted">{when(r.requestedOn, r.requestedAt, v.today)}</span>
                      </span>
                      <StatusPill tone={SERVICE_TONE[r.status]}>{SERVICE_STATUS_LABEL[r.status]}</StatusPill>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {v.folio && <FolioCard v={v} />}
            {open && <LateCheckoutCard v={v} busy={busy === 'late'} quote={(until) => stay.quoteLateCheckout(token, until)} onConfirm={(until) => act('late', () => stay.lateCheckout(token, until), `Late check-out confirmed until ${until}.`)} />}
            {open && <PreferencesCard v={v} busy={busy === 'preferences'} errors={errors} onSave={(p) => act('preferences', () => stay.setPreferences(token, p), 'Preferences saved.')} />}

            <Section id="st-rules" title="House rules" icon={<Moon aria-hidden className="size-4 text-muted" />}>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {v.houseRules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                <li>Check-out is by {v.lateCheckout?.until ?? v.checkOutTime} on {shortDay(v.checkOut)}.</li>
              </ul>
            </Section>
          </main>
        )}
      </div>
    </div>
  )
}

function CleanCard({ v, busy, errors, onAsk }: { v: GuestStayView; busy: boolean; errors: Record<string, string>; onAsk: (note: string) => Promise<boolean> }) {
  const [note, setNote] = useState('')
  return (
    <Section id="st-clean" title="Cleaning today" icon={<Sparkles aria-hidden className="size-4 text-muted" />}>
      {v.cleanAskedAt ? (
        <p className="text-sm">You asked for cleaning at {v.cleanAskedAt.slice(11, 16)}. The team will come by{v.serviceWindow.mode === 'window' ? ` between ${v.serviceWindow.from} and ${v.serviceWindow.to}` : ''}.</p>
      ) : (
        <>
          <Field label="A note for the team" htmlFor="st-clean-note" error={errors.note} hint="Optional">
            <Input id="st-clean-note" tone="card" value={note} placeholder="Fresh towels, skip the bed" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button variant="accent" className="w-full" loading={busy} onClick={() => void onAsk(note).then((ok) => ok && setNote(''))}>
            <Sparkles aria-hidden className="size-4" /> Ask for cleaning today
          </Button>
        </>
      )}
    </Section>
  )
}

function WindowCard({ v, busy, errors, onSave }: { v: GuestStayView; busy: boolean; errors: Record<string, string>; onSave: (w: ServiceWindow, done: string) => Promise<boolean> }) {
  const villa = v.unitKind === 'villa'
  const [from, setFrom] = useState(v.serviceWindow.from || '10:00')
  const [to, setTo] = useState(v.serviceWindow.to || '12:00')
  const dnd = v.serviceWindow.mode === 'dnd'
  const service: ServiceWindow = villa ? { mode: 'window', from, to } : { mode: 'scheduled', from: '', to: '' }
  return (
    <Section id="st-window" title="When we may come in" icon={<Clock aria-hidden className="size-4 text-muted" />}>
      <p className="text-sm text-muted">{dnd ? 'Do not disturb is on. Nobody comes in until you lift it.' : villa ? `Housekeeping comes between ${v.serviceWindow.from} and ${v.serviceWindow.to}.` : 'Housekeeping follows its daily round.'}</p>
      {villa && !dnd && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="st-from" error={errors.from}>
            <Input id="st-from" tone="card" type="time" step={900} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="st-to" error={errors.to}>
            <Input id="st-to" tone="card" type="time" step={900} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {dnd ? (
          <Button variant="solid" loading={busy} onClick={() => void onSave(service, 'Do not disturb is off.')}>
            <SunMedium aria-hidden className="size-4" /> Lift do not disturb
          </Button>
        ) : (
          <>
            {villa && (
              <Button variant="solid" loading={busy} onClick={() => void onSave(service, `Housekeeping comes between ${from} and ${to}.`)}>
                Save the time
              </Button>
            )}
            <Button variant="soft" loading={busy} onClick={() => void onSave({ mode: 'dnd', from: '', to: '' }, 'Do not disturb is on.')}>
              <Moon aria-hidden className="size-4" /> Do not disturb
            </Button>
          </>
        )}
      </div>
    </Section>
  )
}

function OrderCard({ v, busy, onOrder }: { v: GuestStayView; busy: boolean; onOrder: (input: { lines: { itemId: string; quantity: number }[]; note: string; requestedOn: string; requestedAt: number }) => Promise<boolean> }) {
  const [cart, setCart] = useState<Record<string, number>>({})
  const [day, setDay] = useState(v.today)
  const [time, setTime] = useState(nextSlot)
  const [note, setNote] = useState('')
  if (!v.menu || v.menu.length === 0) return null
  const picked = v.menu.filter((i) => (cart[i.id] ?? 0) > 0)
  const total = picked.reduce((s, i) => s + lineAmount({ price: i.price, quantity: cart[i.id] ?? 0 }), 0)
  const days = [0, 1, 2].map((n) => addDays(v.today, n)).filter((d) => d <= v.checkOut)
  async function send() {
    if (await onOrder({ lines: picked.map((i) => ({ itemId: i.id, quantity: cart[i.id] ?? 0 })), note, requestedOn: day, requestedAt: time })) {
      setCart({})
      setNote('')
    }
  }
  return (
    <Section id="st-order" title="Order to your room" icon={<ConciergeBell aria-hidden className="size-4 text-muted" />}>
      <MenuList items={v.menu} cart={cart} onChange={(id, q) => setCart((c) => ({ ...c, [id]: q }))} compact />
      {picked.length > 0 && (
        <div className="space-y-3 border-t border-line pt-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day" htmlFor="st-day">
              <Select id="st-day" tone="card" value={day} options={days.map((d, n) => ({ value: d, label: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : shortDay(d) }))} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label="Time" htmlFor="st-time">
              <Input id="st-time" tone="card" type="time" step={900} value={toClock(time)} onChange={(e) => setTime(toMinutes(e.target.value))} />
            </Field>
          </div>
          <Field label="Anything we should know" htmlFor="st-order-note">
            <Textarea id="st-order-note" rows={2} value={note} placeholder="Allergies, where to serve" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button variant="accent" className="w-full" loading={busy} onClick={() => void send()}>
            <Send aria-hidden className="size-4" /> Order for {money(total)}, on your bill
          </Button>
        </div>
      )}
    </Section>
  )
}

function RequestCard({ v, busy, errors, onSend }: { v: GuestStayView; busy: boolean; errors: Record<string, string>; onSend: (input: GuestRequestInput) => Promise<boolean> }) {
  const [input, setInput] = useState<GuestRequestInput>({ kind: 'towels', note: '' })
  return (
    <Section id="st-request" title="Ask for something" icon={<Send aria-hidden className="size-4 text-muted" />}>
      <Field label="What you need" htmlFor="st-kind" error={errors.kind}>
        <Select id="st-kind" tone="card" value={input.kind} options={GUEST_REQUEST_KINDS.map((k) => ({ value: k, label: GUEST_REQUEST_LABEL[k] }))} onChange={(e) => setInput({ ...input, kind: e.target.value as GuestRequestInput['kind'] })} />
      </Field>
      <Field label="Details" htmlFor="st-request-note" error={errors.note} hint={input.kind === 'other' ? undefined : 'Optional'}>
        <Textarea id="st-request-note" rows={2} value={input.note} placeholder="Two more bath towels" onChange={(e) => setInput({ ...input, note: e.target.value })} />
      </Field>
      <Button variant="solid" className="w-full" loading={busy} onClick={() => void onSend(input).then((ok) => ok && setInput({ ...input, note: '' }))}>
        Send to {v.hostName ?? 'the front desk'}
      </Button>
    </Section>
  )
}

function FolioCard({ v }: { v: GuestStayView }) {
  const f = v.folio
  if (!f) return null
  return (
    <Section id="st-folio" title="Your bill so far" icon={<Receipt aria-hidden className="size-4 text-muted" />}>
      {f.lines.length === 0 ? (
        <p className="text-sm text-muted">Nothing posted yet.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {f.lines.map((l, i) => (
            <li key={i} className="flex items-start gap-3 py-2">
              <span className="w-14 shrink-0 text-xs text-muted">{shortDay(l.date)}</span>
              <span className="min-w-0 flex-1">{l.label}</span>
              <span className={l.amount < 0 ? 'text-success tabular' : 'tabular'}>{money(l.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="space-y-1 border-t border-line pt-2 text-sm">
        {(f.service > 0 || f.pb1 > 0) && (
          <div className="flex justify-between text-muted">
            <dt>Of which service and tax</dt>
            <dd className="tabular">{money(f.service + f.pb1)}</dd>
          </div>
        )}
        {f.toCome > 0 && (
          <div className="flex justify-between text-muted">
            <dt>Nights still to post</dt>
            <dd className="tabular">{money(f.toCome)}</dd>
          </div>
        )}
        {f.depositHeld > 0 && (
          <div className="flex justify-between text-muted">
            <dt>Security deposit held</dt>
            <dd className="tabular">{money(f.depositHeld)}</dd>
          </div>
        )}
        <div className="flex justify-between font-semibold">
          <dt>{f.balance > 0 ? 'Balance to pay' : 'Balance'}</dt>
          <dd className="tabular">{money(f.balance)}</dd>
        </div>
      </dl>
    </Section>
  )
}

function LateCheckoutCard({ v, busy, quote, onConfirm }: { v: GuestStayView; busy: boolean; quote: (until: string) => Promise<LateCheckoutQuote>; onConfirm: (until: string) => Promise<boolean> }) {
  const times = lateCheckoutTimes(v.checkOutTime)
  const [until, setUntil] = useState(times[0] ?? '')
  const [price, setPrice] = useState<LateCheckoutQuote | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  if (v.lateCheckout) {
    return (
      <Section id="st-late" title="Late check-out" icon={<Clock aria-hidden className="size-4 text-muted" />}>
        <p className="text-sm">
          You leave by {v.lateCheckout.until} on {shortDay(v.checkOut)}
          {v.lateCheckout.charge > 0 ? `, ${money(v.lateCheckout.charge)} on your bill.` : ', free of charge.'}
        </p>
      </Section>
    )
  }
  if (times.length === 0) return null
  async function check() {
    setChecking(true)
    setProblem(null)
    try {
      setPrice(await quote(until))
    } catch (e) {
      setProblem(Object.values(fieldErrors(e))[0] ?? 'We could not check that time.')
    } finally {
      setChecking(false)
    }
  }
  return (
    <Section id="st-late" title="Late check-out" icon={<Clock aria-hidden className="size-4 text-muted" />}>
      <p className="text-sm text-muted">Check-out is by {v.checkOutTime}. Stay a little longer if the next guest allows it.</p>
      <Field label="Leave by" htmlFor="st-until">
        <Select
          id="st-until"
          tone="card"
          value={until}
          options={times.map((t) => ({ value: t, label: t }))}
          onChange={(e) => {
            setUntil(e.target.value)
            setPrice(null)
          }}
        />
      </Field>
      {problem && <p className="text-sm text-danger">{problem}</p>}
      {price ? (
        <div className="space-y-2">
          <p className="text-sm">{price.charge > 0 ? `${money(price.charge)} goes on your bill.` : 'Free of charge.'}</p>
          <Button variant="accent" className="w-full" loading={busy} onClick={() => void onConfirm(price.until)}>
            Confirm late check-out until {price.until}
          </Button>
        </div>
      ) : (
        <Button variant="soft" className="w-full" loading={checking} onClick={() => void check()}>
          See the price
        </Button>
      )}
    </Section>
  )
}

function PreferencesCard({ v, busy, errors, onSave }: { v: GuestStayView; busy: boolean; errors: Record<string, string>; onSave: (p: GuestPreferences) => Promise<boolean> }) {
  const [p, setP] = useState<GuestPreferences>(v.preferences)
  const set = (change: Partial<GuestPreferences>) => setP({ ...p, ...change })
  const villa = v.unitKind === 'villa'
  return (
    <Section id="st-prefs" title={villa ? 'Make the villa yours' : 'Anything we should know'} icon={<SunMedium aria-hidden className="size-4 text-muted" />}>
      <div className="grid grid-cols-2 gap-3">
        {villa && (
          <>
            <Field label="Breakfast at" htmlFor="st-breakfast" error={errors.breakfastTime}>
              <Input id="st-breakfast" tone="card" type="time" value={p.breakfastTime} onChange={(e) => set({ breakfastTime: e.target.value })} />
            </Field>
            <Field label="Diet and allergies" htmlFor="st-diet" error={errors.dietary}>
              <Input id="st-diet" tone="card" value={p.dietary} placeholder="Vegetarian, no nuts" onChange={(e) => set({ dietary: e.target.value })} />
            </Field>
            <Field label="Set up for you" error={errors.setups} hint="Your host confirms the price before anything is charged" className="col-span-2">
              <CheckboxGrid name="st-setups" options={SETUP_OPTIONS} selected={p.setups} onChange={(next) => set({ setups: next as Setup[] })} />
            </Field>
          </>
        )}
        <Field label="Notes for us" htmlFor="st-notes" error={errors.notes} className="col-span-2">
          <Textarea id="st-notes" rows={2} value={p.notes} placeholder={villa ? 'A birthday, a quiet morning' : 'Extra pillows, a quiet room'} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      <Button variant="solid" className="w-full" loading={busy} onClick={() => void onSave(p)}>
        Save preferences
      </Button>
    </Section>
  )
}

function ProblemCard({ busy, errors, onSend }: { busy: boolean; errors: Record<string, string>; onSend: (input: StayComplaintInput) => Promise<boolean> }) {
  const [input, setInput] = useState<StayComplaintInput>({ category: 'room', description: '' })
  return (
    <Section id="st-problem" title="Tell us something went wrong" icon={<CircleAlert aria-hidden className="size-4 text-muted" />}>
      <Field label="What it is about" htmlFor="st-problem-kind" error={errors.category}>
        <Select id="st-problem-kind" tone="card" value={input.category} options={COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: COMPLAINT_CATEGORY_LABEL[c] }))} onChange={(e) => setInput({ ...input, category: e.target.value as StayComplaintInput['category'] })} />
      </Field>
      <Field label="What happened" htmlFor="st-problem-text" error={errors.description}>
        <Textarea id="st-problem-text" rows={3} value={input.description} placeholder="The air conditioning is not cooling" onChange={(e) => setInput({ ...input, description: e.target.value })} />
      </Field>
      <Button variant="solid" className="w-full" loading={busy} onClick={() => void onSend(input).then((ok) => ok && setInput({ ...input, description: '' }))}>
        Tell the front desk
      </Button>
    </Section>
  )
}

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { CircleCheck, ConciergeBell, Send, Wallet } from 'lucide-react'
import { clockLabel } from '@/domain/roomService'
import { lineAmount, ORDER_STATUS_LABEL, orderSummary, PAY_STATE_LABEL } from '@/domain/serviceOrder'
import { addDays, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState } from '../../ui/States'
import { ORDER_TONE } from '../shared/tones'
import { MenuList } from './orderParts'
import { nextSlot, toClock, toMinutes } from './clock'


/**
 * The guest's menu, opened from the QR card in the room. No sign-in: the card's token is the key,
 * and orders go on the stay's bill, paid by QRIS here or at the desk.
 */
export default function GuestOrderPage() {
  const { token = '' } = useParams()
  const { orders } = useServices()
  const navigate = useNavigate()
  const data = useResource(`orders.guestMenu:${token}`, () => orders.guestMenu(token), { keepPrevious: false })
  const [cart, setCart] = useState<Record<string, number>>({})
  const [day, setDay] = useState('')
  const [time, setTime] = useState(nextSlot)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'order' | 'pay' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState(false)

  const m = data.data
  const items = m?.items ?? []
  const picked = items.filter((i) => (cart[i.id] ?? 0) > 0)
  const total = picked.reduce((s, i) => s + lineAmount({ price: i.price, quantity: cart[i.id] ?? 0 }), 0)

  async function order() {
    if (!m) return
    setBusy('order')
    setError(null)
    try {
      data.setData(await orders.guestPlace(token, { lines: picked.map((i) => ({ itemId: i.id, quantity: cart[i.id] ?? 0 })), note, requestedOn: day || m.today, requestedAt: time }))
      setCart({})
      setNote('')
      setPlaced(true)
    } catch (e) {
      setError(Object.values(fieldErrors(e))[0] ?? 'The order did not go through.')
    } finally {
      setBusy(null)
    }
  }

  async function pay() {
    setBusy('pay')
    setError(null)
    try {
      const link = await orders.guestPay(token)
      navigate(`/pay/${link.token}`)
    } catch (e) {
      setError(Object.values(fieldErrors(e))[0] ?? 'The payment could not start.')
      setBusy(null)
    }
  }

  return (
    <div className="min-h-dvh bg-canvas px-[max(env(safe-area-inset-left),1rem)] pt-[max(env(safe-area-inset-top),1.5rem)] pb-[calc(max(env(safe-area-inset-bottom),1rem)+5rem)]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BrandMark className="size-7 text-fg" />
            <span className="text-sm font-bold tracking-tight">{m?.villaName ?? 'Bali Villas'}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <ConciergeBell aria-hidden className="size-4" /> Room service
          </span>
        </header>
        {!m && data.status === 'error' && <EmptyState title="This menu link does not work">Ask the front desk for the room’s QR card.</EmptyState>}
        {!m && data.status !== 'error' && <CardSkeleton lines={6} />}
        {m && (
          <main className="animate-rise space-y-4">
            <section className="rounded-card border border-line bg-card p-5 shadow-card">
              <h1 className="text-2xl font-semibold tracking-tight">
                {m.stay ? `Hello ${m.stay.guestName}` : m.unitCode}
                <span className="text-accent">.</span>
              </h1>
              <p className="mt-1 text-sm text-muted">
                {m.unitCode} {m.unitName} · {m.villaName}, {m.locationName}
                {m.stay && ` · until ${shortDay(m.stay.checkOut)}`}
              </p>
              {!m.stay && <p className="mt-3 text-sm">Nobody is staying in this room right now, so ordering is closed. The menu below is for a look only.</p>}
            </section>

            {placed && (
              <section aria-live="polite" className="animate-pop-in flex items-center gap-3 rounded-card border border-line bg-card p-4 shadow-card">
                <CircleCheck aria-hidden className="size-8 shrink-0 text-success" />
                <p className="text-sm">
                  Order sent. The team accepts it shortly; you pay with your bill or right here once it is delivered.
                </p>
              </section>
            )}

            {m.orders.length > 0 && (
              <section aria-label="Your orders" className="rounded-card border border-line bg-card p-5 shadow-card">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-semibold">Your orders</h2>
                  {m.outstanding > 0 && <span className="text-sm tabular">To pay {money(m.outstanding)}</span>}
                </div>
                <ul className="mt-3 divide-y divide-line">
                  {m.orders.map((o) => (
                    <li key={o.number} className="flex items-start gap-3 py-2.5 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2">{orderSummary(o)}</span>
                        <span className="block text-xs text-muted">
                          {o.requestedOn === m.today ? `Today ${clockLabel(o.requestedAt)}` : `${shortDay(o.requestedOn)} ${clockLabel(o.requestedAt)}`} · {PAY_STATE_LABEL[o.payState]}
                        </span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        <StatusPill tone={ORDER_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</StatusPill>
                        <span className="text-xs tabular">{money(o.charge)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {m.outstanding > 0 && (
                  <Button variant="solid" className="mt-3 w-full" loading={busy === 'pay'} onClick={() => void pay()}>
                    <Wallet aria-hidden className="size-4" /> {m.payToken ? 'Continue to payment' : `Pay ${money(m.outstanding)} by QRIS`}
                  </Button>
                )}
              </section>
            )}

            <MenuList items={items} cart={cart} onChange={(id, q) => setCart((c) => ({ ...c, [id]: q }))} compact={false} />

            {m.stay && picked.length > 0 && (
              <section aria-label="When" className="space-y-3 rounded-card border border-line bg-card p-5 shadow-card">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Day" htmlFor="go-day">
                    <Select id="go-day" value={day || m.today} options={[0, 1, 2].map((n) => addDays(m.today, n)).filter((d) => d <= (m.stay?.checkOut ?? m.today)).map((d, n) => ({ value: d, label: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : shortDay(d) }))} onChange={(e) => setDay(e.target.value)} />
                  </Field>
                  <Field label="Time" htmlFor="go-time">
                    <Input id="go-time" type="time" step={900} value={toClock(time)} onChange={(e) => setTime(toMinutes(e.target.value))} />
                  </Field>
                </div>
                <Field label="Anything we should know" htmlFor="go-note">
                  <Textarea id="go-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Allergies, where to serve, pickup point" />
                </Field>
              </section>
            )}
            {error && (
              <p role="alert" className="rounded-panel bg-danger-soft p-3 text-sm font-medium text-danger">
                {error}
              </p>
            )}
          </main>
        )}
      </div>
      {m?.stay && picked.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-card/95 px-[max(env(safe-area-inset-left),1rem)] pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur">
          <div className="mx-auto flex w-full max-w-md items-center gap-3">
            <p className="min-w-0 flex-1 text-sm">
              <span className="block font-semibold tabular">{money(total)}</span>
              <span className="block truncate text-xs text-muted">{picked.length === 1 ? picked[0]?.name : `${picked.length} items`}, on your bill</span>
            </p>
            <Button variant="accent" loading={busy === 'order'} onClick={() => void order()}>
              <Send aria-hidden className="size-4" /> Order
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

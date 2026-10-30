import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { CircleCheck, CircleX, Clock3, CreditCard, Landmark, QrCode as QrIcon, ShieldCheck } from 'lucide-react'
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/domain/payment'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useNow } from '../../hooks/useNow'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState } from '../../ui/States'
import { Tabs } from '../../ui/Tabs'
import { QrCode } from './QrCode'

const ICON: Partial<Record<PaymentMethod, typeof QrIcon>> = { qris: QrIcon, virtual_account: Landmark, card: CreditCard }

function Countdown({ until }: { until: string }) {
  const now = useNow(1000)
  const left = Math.max(0, new Date(until).getTime() - now.getTime())
  const h = Math.floor(left / 3_600_000)
  const m = Math.floor((left % 3_600_000) / 60_000)
  const s = Math.floor((left % 60_000) / 1000)
  return (
    <span className="tabular">
      {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  )
}

/**
 * The guest's checkout on the payment gateway. No sign-in: the token is the key.
 * The two simulate buttons stand in for the gateway's callback in the demo.
 */
export default function PayPage() {
  const { token = '' } = useParams()
  const { payments } = useServices()
  const data = useResource(`payments.checkout:${token}`, () => payments.checkout(token), { keepPrevious: false })
  const [tab, setTab] = useState<'pay' | 'details'>('pay')
  const [busy, setBusy] = useState<'paid' | 'failed' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function settle(outcome: 'paid' | 'failed') {
    setBusy(outcome)
    setError(null)
    try {
      data.setData(await payments.settle(token, outcome))
    } catch (e) {
      setError(Object.values(fieldErrors(e))[0] ?? 'The gateway did not answer.')
    } finally {
      setBusy(null)
    }
  }

  const c = data.data
  const Icon = c ? (ICON[c.link.method] ?? CreditCard) : CreditCard
  return (
    <div className="min-h-dvh bg-canvas px-4 py-6">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BrandMark className="size-7 text-fg" />
            <span className="text-sm font-bold tracking-tight">Bali Villas</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck aria-hidden className="size-4" /> Secure checkout
          </span>
        </header>
        {!c && data.status === 'error' && <EmptyState title="This payment link does not exist">Ask your host for a new link.</EmptyState>}
        {!c && data.status !== 'error' && <CardSkeleton lines={5} />}
        {c && (
          <main className="animate-rise space-y-4">
            <section className="rounded-card border border-line bg-card p-5 shadow-card">
              <p className="text-xs text-muted">
                {PAYMENT_KIND_LABEL[c.kind]} for {c.bookingCode}
              </p>
              <h1 className="mt-1 text-[32px] leading-none font-semibold tracking-tight tabular">{money(c.link.amount)}</h1>
              <p className="mt-3 text-sm">
                {c.villaName}, {c.locationName} · {c.unitCode} {c.unitName}
              </p>
              <p className="text-sm text-muted">
                {shortDay(c.checkIn)} to {shortDay(c.checkOut)} · {plural(c.nights, 'night')} · {c.guestName}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-panel bg-raised p-2.5">
                  <dt className="text-muted">Stay total</dt>
                  <dd className="mt-0.5 font-medium tabular">{money(c.total)}</dd>
                </div>
                <div className="rounded-panel bg-raised p-2.5">
                  <dt className="text-muted">Paid before</dt>
                  <dd className="mt-0.5 font-medium tabular">{money(c.paidBefore)}</dd>
                </div>
              </dl>
            </section>

            {c.link.status === 'paid' && (
              <section aria-label="Receipt" className="animate-pop-in rounded-card border border-line bg-card p-5 text-center shadow-card">
                <CircleCheck aria-hidden className="mx-auto size-12 text-success" />
                <p className="mt-3 text-lg font-semibold">Payment received</p>
                <p className="text-sm text-muted">
                  {money(c.link.amount)} by {PAYMENT_METHOD_LABEL[c.link.method]} on {c.paidOn ? shortDay(c.paidOn) : 'today'}
                </p>
                <p className="mt-2 font-mono text-xs text-muted">
                  {c.paymentNumber} · {c.reference}
                </p>
                <p className="mt-4 text-xs text-muted">Your host has the receipt too. You can close this page.</p>
              </section>
            )}

            {(c.link.status === 'failed' || c.link.status === 'expired' || c.link.status === 'cancelled') && (
              <section aria-label="Link closed" className="animate-pop-in rounded-card border border-line bg-card p-5 text-center shadow-card">
                <CircleX aria-hidden className="mx-auto size-12 text-danger" />
                <p className="mt-3 text-lg font-semibold">
                  {c.link.status === 'failed' ? 'Payment failed' : c.link.status === 'expired' ? 'This link has expired' : 'This link was cancelled'}
                </p>
                <p className="text-sm text-muted">Ask your host for a new payment link. No money was taken.</p>
              </section>
            )}

            {c.link.status === 'pending' && (
              <section aria-label="Pay" className="rounded-card border border-line bg-card p-5 shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="flex items-center gap-2 font-semibold">
                    <Icon aria-hidden className="size-5" /> {PAYMENT_METHOD_LABEL[c.link.method]}
                  </p>
                  <Tabs label="View" options={[{ value: 'pay', label: 'Pay' }, { value: 'details', label: 'Details' }]} value={tab} onChange={setTab} />
                </div>
                {tab === 'pay' && c.link.method === 'qris' && (
                  <div className="mt-4 text-center">
                    <QrCode payload={c.link.qrPayload} className="mx-auto size-56" />
                    <p className="mt-3 text-sm text-muted">Scan with any banking or e-wallet app that reads QRIS.</p>
                  </div>
                )}
                {tab === 'pay' && c.link.method === 'virtual_account' && (
                  <div className="mt-4 rounded-panel bg-raised p-4 text-center">
                    <p className="text-xs text-muted">{c.link.vaBank} virtual account</p>
                    <p className="mt-1 font-mono text-2xl font-semibold tracking-wider break-all">{c.link.vaNumber}</p>
                    <p className="mt-2 text-sm text-muted">Transfer exactly {money(c.link.amount)} from any bank.</p>
                  </div>
                )}
                {tab === 'pay' && c.link.method === 'card' && (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <Field label="Card number" htmlFor="card-no" className="col-span-2" hint="Test card for the demo">
                      <Input id="card-no" defaultValue="4111 1111 1111 1111" inputMode="numeric" className="font-mono" />
                    </Field>
                    <Field label="Expiry" htmlFor="card-exp">
                      <Input id="card-exp" defaultValue="12/29" className="font-mono" />
                    </Field>
                    <Field label="CVC" htmlFor="card-cvc">
                      <Input id="card-cvc" defaultValue="123" className="font-mono" />
                    </Field>
                  </div>
                )}
                {tab === 'details' && (
                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Payment</dt>
                      <dd className="font-mono">{c.paymentNumber}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Booking</dt>
                      <dd className="font-mono">{c.bookingCode}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Gateway fee, paid by the host</dt>
                      <dd className="tabular">{money(c.link.gatewayFee)}</dd>
                    </div>
                  </dl>
                )}
                <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
                  <Clock3 aria-hidden className="size-3.5" /> Expires in <Countdown until={c.link.expiresAt} />
                </p>
                <div className="mt-4 rounded-panel border border-dashed border-line-strong p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">Demo gateway</p>
                  <div className="grid grid-cols-1 gap-2">
                    <Button variant="accent" loading={busy === 'paid'} disabled={busy !== null} onClick={() => void settle('paid')}>
                      <CircleCheck aria-hidden className="size-4" /> Simulate successful payment
                    </Button>
                    <Button variant="soft" loading={busy === 'failed'} disabled={busy !== null} onClick={() => void settle('failed')}>
                      <CircleX aria-hidden className="size-4" /> Simulate failed payment
                    </Button>
                  </div>
                  {error && (
                    <p role="alert" className="mt-2 text-xs font-medium text-danger">
                      {error}
                    </p>
                  )}
                </div>
              </section>
            )}
            <p className="text-center text-xs text-muted">
              Host staff? <Link to={`/bookings/${c.link.bookingId}`} className="text-accent-text hover:underline">Open the booking</Link>
            </p>
          </main>
        )}
      </div>
    </div>
  )
}

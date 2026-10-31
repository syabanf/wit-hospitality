import { Link } from 'react-router'
import { Plus, QrCode } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { orderableStay, orderSummary, orderTokenFor } from '@/domain/serviceOrder'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { OrderPill, PayPill } from './orderParts'
import { PayOrders } from './PayOrders'

/** Room service on a stay: what was ordered, what is on the bill, and taking the money for it. */
export function StayServiceCard({ booking, today, onPaid }: { booking: BookingView; today: string; onPaid?: () => void }) {
  const { orders } = useServices()
  const data = useResource(`orders.forStay:${booking.id}`, () => orders.forStay(booking.id))
  const d = data.data
  const open = orderableStay(booking, today)
  if (!d || (d.orders.length === 0 && !open)) return null
  const unpaid = d.orders.filter((o) => o.payState === 'unpaid')

  return (
    <Card aria-labelledby="stay-rs">
      <CardHeader
        id="stay-rs"
        title="Room service"
        action={
          open && (
            <span className="flex gap-2">
              {booking.unitAssigned && (
                <Link to={`/order/${orderTokenFor(booking.unitCode)}`} className={buttonStyles({ variant: 'soft', size: 'sm' })} title="The menu the guest sees from the room's QR card">
                  <QrCode aria-hidden className="size-3.5" /> Guest menu
                </Link>
              )}
              <Link to={`/services/orders/new?booking=${booking.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                <Plus aria-hidden className="size-3.5" /> Order
              </Link>
            </span>
          )
        }
      />
      {d.orders.length === 0 ? (
        <p className="text-sm text-muted">Nothing ordered yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-line text-sm">
            {d.orders.map((o) => (
              <li key={o.id} className="flex items-center gap-3 py-2.5">
                <Link to={`/services/orders/${o.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="font-mono text-xs">{o.number}</span>
                  <span className="block truncate">{orderSummary(o)}</span>
                </Link>
                <span className="hidden sm:inline-flex">
                  <OrderPill status={o.status} />
                </span>
                <PayPill state={o.payState} />
                <span className="w-24 text-right tabular">{money(o.totals.charge)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            {[
              ['Billed', d.charged],
              ['Paid', d.paid],
              ['To pay', d.outstanding],
            ].map(([label, value]) => (
              <div key={label} className="rounded-panel bg-raised p-2.5">
                <dt className="text-muted">{label}</dt>
                <dd className="mt-0.5 font-medium tabular">{money(Number(value))}</dd>
              </div>
            ))}
          </dl>
          {d.links.map((l) => (
            <p key={l.token} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-panel bg-raised p-3 text-sm">
              <span>
                {PAYMENT_METHOD_LABEL[l.method]} link for <span className="font-semibold tabular">{money(l.amount)}</span> waits for the guest.
              </span>
              <Link to={`/pay/${l.token}`} className="text-accent-text hover:underline">
                Open checkout
              </Link>
            </p>
          ))}
          {unpaid.length > 0 && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="mb-3 text-sm">
                {unpaid.length} delivered {unpaid.length === 1 ? 'order' : 'orders'} to pay before check-out.
              </p>
              <PayOrders
                id="stay-pay"
                bookingId={booking.id}
                orderIds={unpaid.map((o) => o.id)}
                amount={unpaid.reduce((s, o) => s + o.totals.charge, 0)}
                onDone={() => {
                  data.reload()
                  onPaid?.()
                }}
              />
            </div>
          )}
        </>
      )}
    </Card>
  )
}

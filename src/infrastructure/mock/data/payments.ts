import { bookingTotal, type Booking } from '@/domain/booking'
import { balanceDueOn, depositAmount, gatewayFee, qrPayloadFor, vaNumberFor, type Payment, type PaymentLink, type PaymentMethod, type PaymentPolicy } from '@/domain/payment'
import { addDays, type IsoDate } from '@/lib/dates'

const BEFORE = 'Recorded before the console'

/** Links the demo opens directly; the QA run uses `demo-qris`. */
export const DEMO_LINKS: ReadonlyArray<{ token: string; method: PaymentMethod; outcome: 'pending' | 'expired' | 'failed' }> = [
  { token: 'demo-qris', method: 'qris', outcome: 'pending' },
  { token: 'demo-va', method: 'virtual_account', outcome: 'pending' },
  { token: 'demo-card', method: 'card', outcome: 'pending' },
  { token: 'demo-expired', method: 'qris', outcome: 'expired' },
  { token: 'demo-failed', method: 'card', outcome: 'failed' },
]

/**
 * Payments the seed bookings imply, with no finance entries (the seeded room revenue
 * already sits in the ledger): stays in house or gone are paid in full, confirmed direct
 * stays carry a deposit, Airbnb stays are paid out the day after arrival.
 */
export function seedPayments(bookings: readonly Booking[], today: IsoDate, policy: PaymentPolicy) {
  const payments: Payment[] = []
  const links: PaymentLink[] = []
  let n = 1
  const add = (b: Booking, fields: Partial<Payment> & Pick<Payment, 'kind' | 'method' | 'amount' | 'status'>) => {
    const p: Payment = {
      id: `pay-${n}`,
      number: `PAY-${String(5000 + n).padStart(4, '0')}`,
      bookingId: b.id,
      dueOn: null,
      paidOn: null,
      reference: '',
      payer: '',
      note: BEFORE,
      transactionId: null,
      feeTransactionId: null,
      gatewayFee: 0,
      refundOf: null,
      createdBy: 'Kadek Ariani',
      createdOn: b.createdOn,
      history: [],
      ...fields,
    }
    n++
    payments.push(p)
    return p
  }
  const stamp = (on: IsoDate, kind: Payment['history'][number]['kind'], by = 'Kadek Ariani') => [{ kind, by, at: `${on}T10:00:00`, note: '' }]

  for (const b of bookings) {
    if (b.status === 'draft' || b.status === 'cancelled' || b.status === 'no_show') continue
    const total = bookingTotal(b)
    if (b.source === 'airbnb') {
      if (b.paymentStatus !== 'paid') continue
      const on = addDays(b.checkIn, 1) > today ? today : addDays(b.checkIn, 1)
      add(b, { kind: 'payout', method: 'airbnb_payout', amount: total - b.airbnbFee, status: 'paid', paidOn: on, reference: b.airbnbCode ?? '', payer: 'Airbnb', createdBy: 'Ida Bagus Rai', createdOn: on, history: stamp(on, 'paid', 'Ida Bagus Rai') })
      continue
    }
    if (b.paymentStatus === 'paid') {
      const method: PaymentMethod = n % 3 === 0 ? 'bank_transfer' : 'cash'
      add(b, { kind: 'full', method, amount: total, status: 'paid', paidOn: b.checkIn, createdOn: b.checkIn, reference: method === 'bank_transfer' ? `TRF-${b.code}` : '', history: stamp(b.checkIn, 'paid') })
      continue
    }
    if (b.paymentStatus === 'partial') {
      const on = b.createdOn > today ? today : b.createdOn
      add(b, { kind: 'deposit', method: 'bank_transfer', amount: b.paidAmount, status: 'paid', paidOn: on, createdOn: on, reference: `TRF-${b.code}`, history: stamp(on, 'paid') })
    }
  }

  // Balance links on the next confirmed direct stays, for the gateway demo.
  const upcoming = bookings.filter((b) => b.source === 'direct' && b.status === 'confirmed' && b.paymentStatus === 'partial' && b.checkIn > today).sort((a, b) => a.checkIn.localeCompare(b.checkIn))
  DEMO_LINKS.forEach((demo, i) => {
    const b = upcoming[i]
    if (!b) return
    const amount = bookingTotal(b) - b.paidAmount
    const createdOn = demo.outcome === 'expired' ? addDays(today, -3) : today
    const status = demo.outcome === 'pending' ? 'pending' : demo.outcome
    const p = add(b, { kind: 'balance', method: demo.method, amount, status, dueOn: balanceDueOn(b.checkIn, policy), note: '', reference: demo.method === 'virtual_account' ? vaNumberFor(demo.token) : '', payer: '', createdOn, history: [{ kind: 'link_sent', by: 'Kadek Ariani', at: `${createdOn}T09:00:00`, note: '' }, ...(status === 'pending' ? [] : [{ kind: status, by: 'Payment gateway', at: `${createdOn}T21:00:00`, note: status === 'failed' ? 'Card declined by the issuer' : 'Link expired unpaid' }] as Payment['history'])] })
    links.push({
      token: demo.token,
      bookingId: b.id,
      paymentId: p.id,
      method: demo.method,
      amount,
      createdAt: `${createdOn}T09:00:00`,
      expiresAt: `${addDays(createdOn, 1)}T09:00:00`,
      status,
      vaBank: demo.method === 'virtual_account' ? 'BCA' : '',
      vaNumber: demo.method === 'virtual_account' ? vaNumberFor(demo.token) : '',
      qrPayload: demo.method === 'qris' ? qrPayloadFor(demo.token, amount) : '',
      gatewayFee: gatewayFee(demo.method, amount, policy),
    })
  })
  return { payments, links, next: n }
}

/** The deposit a confirmed direct seed stay has paid. */
export const seedDeposit = (total: number, policy: PaymentPolicy) => depositAmount(total, policy)

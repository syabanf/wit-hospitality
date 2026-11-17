import { beforeEach, describe, expect, it } from 'vitest'
import type { CheckInDetails } from '@/domain/booking'
import { createMockPorts } from '@/infrastructure/mock'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-11'
let s: Services
let ports: Ports
const clock = { today: () => TODAY }
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const arrival: CheckInDetails = { idVerified: true, deposit: 2_000_000, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const card = { brand: 'visa' as const, last4: '4242', approvalCode: '', expiresOn: '2026-11-20' }

beforeEach(async () => {
  ports = createMockPorts(clock, 0, null)
  s = createServices(ports)
  await signIn('kadek')
})

describe('room discrepancies', () => {
  it('seeds an open sleep in SK-04 today and lists it on the page, the audit checklist and the dashboard', async () => {
    const page = await s.frontOffice.roomReport.page('vil-saka', TODAY)
    expect(page.open.map((c) => `${c.unitCode}:${c.discrepancy}`)).toEqual(['SK-04:sleep'])
    expect(page.resolved.map((c) => `${c.unitCode}:${c.discrepancy}`).sort()).toEqual(['KR-03:persons', 'SK-01:skip'])
    expect((await s.nightAudit.overview()).checks.find((c) => c.key === 'discrepancies')?.items).toHaveLength(1)
    expect((await s.dashboard.attention()).discrepancies).toHaveLength(1)
  })

  it('records a skip, refuses a wrong action, resolves it and keeps the resolved check', async () => {
    await signIn('wayan')
    const check = await s.frontOffice.roomReport.record({ unitId: 'unit-sk-05', date: TODAY, found: 'occupied', persons: 2, note: 'Two guests asleep' })
    expect(check).toMatchObject({ id: `rc-${TODAY}-unit-sk-05`, frontOffice: 'vacant', discrepancy: 'skip' })
    await expect(s.frontOffice.roomReport.resolve(check.id, { action: 'guest_out', note: 'Spoke to them' })).rejects.toMatchObject({ errors: { action: 'Guest out for the night does not settle a skip discrepancy.' } })
    const done = await s.frontOffice.roomReport.resolve(check.id, { action: 'checked_in', note: 'Walk-in registered on BK-new' })
    expect(done.resolution).toMatchObject({ action: 'checked_in', by: 'Wayan Sudiarta' })
    await expect(s.frontOffice.roomReport.record({ unitId: 'unit-sk-05', date: TODAY, found: 'vacant', persons: null, note: '' })).rejects.toMatchObject({ code: 'ROOM_CHECK_RESOLVED' })
  })

  it('keeps the night audit closed until the sleep is resolved or a manager gives a reason', async () => {
    await expect(s.nightAudit.run()).rejects.toMatchObject({ code: 'AUDIT_DISCREPANCIES', message: '1 room discrepancy is still open; resolve it before closing the day.' })
    await signIn('dian')
    await expect(s.nightAudit.run({ reason: 'Guest confirmed by phone' })).rejects.toMatchObject({ message: 'Only a villa manager or someone who approves bookings may close the day over open discrepancies.' })
    await signIn('kadek')
    const audit = await s.nightAudit.run({ reason: 'Guest confirmed by phone' })
    expect(audit.override).toEqual({ by: 'Kadek Ariani', reason: 'Guest confirmed by phone' })
  })

  it('closes the day without an override once the sleep is resolved', async () => {
    const [open] = (await s.frontOffice.roomReport.page('vil-saka', TODAY)).open
    await s.frontOffice.roomReport.resolve(open!.id, { action: 'guest_out', note: 'Guest stayed in Ubud, back tomorrow' })
    expect((await s.nightAudit.run()).override).toBeNull()
  })
})

describe('card holds', () => {
  it('shows the seeded holds: one captured at check-out, one active', async () => {
    const holds = await ports.preAuths.preAuths()
    expect(holds.map((h) => `${h.number}:${h.status}`)).toEqual(['PA-1001:captured', 'PA-1002:active'])
    const pay = (await ports.payment.payments()).find((p) => p.id === holds[0]!.paymentId)
    expect(pay).toMatchObject({ method: 'card', note: 'Captured from PA-1001' })
  })

  it('takes a hold at check-in as the deposit, books no cash, and captures it against the room balance', async () => {
    const b = (await ports.booking.bookings()).find((x) => x.status === 'confirmed' && x.checkIn === TODAY && x.unitAssigned && x.source === 'direct')!
    const before = (await ports.finance.transactions()).length
    await expect(s.booking.checkIn(b.id, arrival, { method: 'preauth', card: { ...card, last4: '12' } })).rejects.toMatchObject({ errors: { last4: 'Enter the last four digits of the card.' } })
    await expect(s.booking.checkIn(b.id, arrival, { method: 'preauth', card: { ...card, last4: '0000' } })).rejects.toMatchObject({ code: 'PREAUTH_DECLINED' })
    const stay = await s.booking.checkIn(b.id, arrival, { method: 'preauth', card })
    expect(stay.arrival?.deposit).toBe(0)
    expect((await ports.finance.transactions()).length).toBe(before)
    const { holds, roomDue } = await s.frontOffice.preAuths.forStay(b.id)
    expect(holds[0]).toMatchObject({ amount: 2_000_000, status: 'active', approvalCode: 'A23757' })
    await expect(s.frontOffice.preAuths.take({ bookingId: b.id, amount: 1, ...card })).rejects.toMatchObject({ code: 'PREAUTH_ACTIVE' })
    if (roomDue > 0) {
      const amount = Math.min(roomDue, 2_000_000)
      const { preAuth, payment } = await s.frontOffice.preAuths.capture(holds[0]!.id, amount)
      expect(preAuth).toMatchObject({ status: 'captured', captured: amount })
      expect(payment).toMatchObject({ kind: 'balance', method: 'card', status: 'paid', note: `Captured from ${preAuth.number}` })
      expect(payment.transactionId).not.toBeNull()
      await expect(s.frontOffice.preAuths.release(preAuth.id)).rejects.toMatchObject({ code: 'PREAUTH_CLOSED' })
    }
  })

  it('books a transfer deposit on the bank account', async () => {
    const b = (await ports.booking.bookings()).find((x) => x.status === 'confirmed' && x.checkIn === TODAY && x.unitAssigned && x.source === 'direct')!
    await s.booking.checkIn(b.id, arrival, { method: 'bank_transfer' })
    const t = (await ports.finance.transactions()).find((x) => x.bookingId === b.id && x.categoryId === 'cat-deposit')
    expect(t?.description).toMatch(/^Security deposit by transfer/)
    expect((await ports.finance.accounts()).find((a) => a.id === t?.accountId)?.kind).toBe('bank')
  })

  it('caps a capture at the hold and releases the seeded active hold', async () => {
    const active = (await ports.preAuths.preAuths()).find((h) => h.status === 'active')!
    await expect(s.frontOffice.preAuths.capture(active.id, active.amount + 1)).rejects.toMatchObject({ errors: { amount: `Only ${active.amount.toLocaleString('id-ID')} is held.` } })
    expect((await s.frontOffice.preAuths.release(active.id)).status).toBe('released')
  })
})

describe('log book', () => {
  it('lists the seeded follow-ups on top and on the dashboard', async () => {
    const page = await s.frontOffice.logBook.page()
    expect(page.followUps).toHaveLength(2)
    expect((await s.dashboard.attention()).followUps).toHaveLength(2)
    expect(Object.keys(page.shifts)).toHaveLength(1)
  })

  it('writes a follow-up; the next shift acknowledges it and anyone marks it done', async () => {
    const e = await s.frontOffice.logBook.write({ category: 'maintenance', text: 'Lamp out in SK-02', villaId: 'vil-saka', link: { kind: 'unit', id: 'unit-sk-02' }, followUp: true })
    expect(e.link).toEqual({ kind: 'unit', id: 'unit-sk-02', label: 'SK-02' })
    await expect(s.frontOffice.logBook.acknowledge(e.id)).rejects.toMatchObject({ code: 'LOG_OWN_ENTRY' })
    await signIn('wayan')
    expect((await s.frontOffice.logBook.acknowledge(e.id)).acknowledgedBy).toBe('Wayan Sudiarta')
    expect((await s.frontOffice.logBook.done(e.id, 'Replaced')).doneNote).toBe('Replaced')
    await expect(s.frontOffice.logBook.done(e.id, '')).rejects.toMatchObject({ code: 'LOG_DONE' })
    await expect(s.frontOffice.logBook.write({ category: 'guest', text: 'x', villaId: null, link: null, followUp: false })).rejects.toMatchObject({ errors: { text: 'Write what the next shift needs to know.' } })
  })

  it('writes the cashier handover to the log book when a shift closes', async () => {
    const open = (await ports.cashier.shifts()).find((x) => x.status === 'open')!
    await signIn(open.cashierId.replace('usr-', ''))
    const expected = (await s.cashier.shift(open.id)).shift.totals.expected
    const count = { notes: { '100000': Math.floor(expected / 100_000) }, coins: expected % 100_000 }
    const closed = await ports.cashier.close(open.id, { count, reason: 'Counted', handover: 'Drawer matched; nothing pending' })
    const entry = (await ports.logBook.entries()).find((e) => e.id === closed.logEntryId)
    expect(entry).toMatchObject({ category: 'handover', shiftId: open.id, text: 'Drawer matched; nothing pending' })
  })
})

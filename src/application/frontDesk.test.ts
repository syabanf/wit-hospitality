import { beforeEach, describe, expect, it } from 'vitest'
import type { Booking } from '@/domain/booking'
import { RuleError } from '@/domain/errors'
import { departureOf } from '@/domain/frontDesk'
import { addDays } from '@/lib/dates'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { STAY_TOKENS } from '@/infrastructure/mock/data/hospitality'
import type { Ports } from './ports'
import { createServices, ValidationError, type Services } from './services'

const TODAY = '2026-11-11'
const TOMORROW = addDays(TODAY, 1)
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RuleError ? e.code : e instanceof ValidationError ? 'VALIDATION' : String(e)))
const arrival = { idVerified: true, deposit: 0, keysHanded: false, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const png = { id: 'file-sig', name: 'signature.png', type: 'image/png', size: 900, url: 'data:image/png;base64,', uploadedBy: 'Guest', uploadedAt: `${TODAY}T10:00:00` }
const all = () => ports.booking.bookings()
const saka = (b: Booking) => b.unitId.startsWith('unit-sk')
const stayOf = async (token: string) => (await all()).find((b) => b.stayToken === token) as Booking

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await signIn('wayan')
})

describe('registration card and keys at check-in', () => {
  it('holds a hotel check-in for the card, takes it on paper once, and records the key card', async () => {
    const b = (await all()).find((x) => saka(x) && x.status === 'confirmed' && x.checkIn === TODAY && x.unitAssigned) as Booking
    expect(await code(s.booking.checkIn(b.id, arrival))).toBe('VALIDATION')
    const keys = [{ number: 'C-0901', kind: 'card' as const }]
    expect(await code(s.booking.checkIn(b.id, { ...arrival, keys }))).toBe('REGISTRATION_CARD_UNSIGNED')
    const signed = await s.frontDesk.signOnPaper(b.id, 'RC-7001')
    expect(signed.registrationCard).toMatchObject({ method: 'paper', cardNumber: 'RC-7001', by: 'Wayan Sudiarta', where: 'desk' })
    expect(await code(s.frontDesk.signOnPaper(b.id, 'RC-7002'))).toBe('CARD_ALREADY_SIGNED')
    const inHouse = await s.booking.checkIn(b.id, { ...arrival, keys })
    expect(inHouse.arrival?.keysHanded).toBe(true)
    expect(inHouse.keys).toMatchObject([{ id: 'key-1', number: 'C-0901', kind: 'card', reason: 'check_in', status: 'out' }])
  })

  it('replaces a lost key with a fee on the folio, takes keys back and closes the rest at check-out', async () => {
    const b = (await all()).find((x) => saka(x) && x.status === 'checked_in' && x.keys?.some((k) => k.status === 'out')) as Booking
    const out = b.keys!.find((k) => k.status === 'out')!
    await s.frontDesk.issueKey(b.id, { number: 'C-7777', kind: 'card', reason: 'extra' })
    const replaced = await s.frontDesk.issueKey(b.id, { number: 'C-7778', kind: 'card', reason: 'replacement', replacesKeyId: out.id, fee: 100_000 })
    expect(replaced.keys?.find((k) => k.id === out.id)).toMatchObject({ status: 'lost', charge: 100_000 })
    const postings = await ports.folio.postings(b.id)
    expect(postings.at(-1)).toMatchObject({ code: 'DMG', description: `Lost key ${out.number}` })
    const extra = replaced.keys!.find((k) => k.number === 'C-7777')!
    expect((await s.frontDesk.returnKey(b.id, extra.id, true)).keys?.find((k) => k.id === extra.id)?.status).toBe('returned')
    expect(await code(s.frontDesk.returnKey(b.id, extra.id, true))).toBe('KEY_NOT_OUT')
    const closed = await ports.booking.transition(b.id, 'checked_out')
    expect(closed.keys?.filter((k) => k.status === 'out')).toEqual([])
    expect(closed.keys?.find((k) => k.number === 'C-7778')?.status).toBe('not_returned')
    expect(await code(s.frontDesk.issueKey(b.id, { number: 'C-1', kind: 'card', reason: 'extra' }))).toBe('BOOKING_INVALID_STATE')
  })

  it('lists the keys out per property and refuses a role without booking edit', async () => {
    const log = await s.frontDesk.keyLog('vil-saka')
    expect(log.out.length).toBeGreaterThan(0)
    expect(log.out.every((r) => r.key.status === 'out')).toBe(true)
    expect(log.history.some((r) => r.key.status === 'lost')).toBe(true)
    await signIn('nia')
    expect(await code(s.frontDesk.issueKey(log.out[0]!.bookingId, { number: 'C-1', kind: 'card', reason: 'extra' }))).toBe('FORBIDDEN')
  })
})

describe('early check-in', () => {
  it('charges a room the fee once the departing guest leaves, and refuses a time they still hold the room', async () => {
    const list = await all()
    // BK-2008 leaves SK-02 tomorrow by noon; a guest booked in after it asks to come early.
    const leaving = list.find((x) => x.code === 'BK-2008') as Booking
    const b = await s.booking.create({ guestId: 'g-01', newGuest: null, groupId: null, unitId: leaving.unitId, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: TOMORROW, checkOut: addDays(TOMORROW, 1), channelRate: null, price: null, notes: '', confirm: true })
    expect(departureOf(b, await all(), '12:00')?.code).toBe(leaving.code)
    expect(await code(s.frontDesk.earlyCheckin(b.id, '10:00'))).toBe('EARLY_CHECKIN_TAKEN')
    const r = await s.frontDesk.earlyCheckin(b.id, '12:30')
    expect(r.charge).toBe(500_000)
    expect(r.booking.earlyCheckin).toMatchObject({ from: '12:30', charge: 500_000, by: 'Wayan Sudiarta' })
    expect((await ports.folio.postings(b.id)).at(-1)).toMatchObject({ code: 'EARLY', description: 'Early check-in from 12:30' })
    expect(await code(s.frontDesk.earlyCheckin(b.id, '12:45'))).toBe('BOOKING_INVALID_STATE')
  })

  it('keeps the seeded villa arrival early and free', async () => {
    await signIn('kadek')
    const early = (await all()).find((x) => x.earlyCheckin)
    expect(early?.earlyCheckin).toMatchObject({ from: '11:00', charge: 0 })
  })
})

describe('wake-up calls', () => {
  it('books a daily call, rolls it on when done, retries no answer and cancels the rest at check-out', async () => {
    const b = (await all()).find((x) => saka(x) && x.status === 'checked_in' && x.checkOut > TOMORROW) as Booking
    expect(await code(s.frontDesk.bookWakeUp(b.id, { date: addDays(TODAY, -1), time: '06:00', note: '', repeatDaily: false }))).toBe('VALIDATION')
    const booked = await s.frontDesk.bookWakeUp(b.id, { date: TODAY, time: '07:15', note: 'Tea please', repeatDaily: true })
    const call = booked.wakeUpCalls!.at(-1)!
    expect((await s.frontDesk.wakeUpCalls()).rows.some((r) => r.call.id === call.id && r.bookingId === b.id)).toBe(true)
    await s.frontDesk.wakeUpOutcome(b.id, call.id, 'no_answer')
    expect((await s.frontDesk.wakeUpCalls()).rows.find((r) => r.call.id === call.id && r.bookingId === b.id)?.lastTry).toMatch(/^No answer at/)
    const rolled = (await s.frontDesk.wakeUpOutcome(b.id, call.id, 'done')).wakeUpCalls!.find((c) => c.id === call.id)!
    expect([rolled.date, rolled.status]).toEqual([TOMORROW, 'pending'])
    expect((await s.frontDesk.wakeUpCalls(TOMORROW)).rows.some((r) => r.call.id === call.id && r.bookingId === b.id)).toBe(true)
    const out = await ports.booking.transition(b.id, 'checked_out')
    expect(out.wakeUpCalls?.every((c) => c.status !== 'pending')).toBe(true)
    expect(await code(s.frontDesk.wakeUpOutcome(b.id, call.id, 'done'))).toBe('BOOKING_INVALID_STATE')
  })

  it('lists tomorrow’s seeded calls by time', async () => {
    const rows = (await s.frontDesk.wakeUpCalls(TOMORROW)).rows
    expect(rows.map((r) => r.call.time)).toEqual(['05:30', '06:45'])
  })
})

describe('guest pages', () => {
  it('lets the guest sign on the stay page and book a wake-up call, each a guest action', async () => {
    const signed = await ports.stay.signCard(STAY_TOKENS.villa, png)
    expect(signed.cardSigned).toBe(true)
    expect(await code(ports.stay.signCard(STAY_TOKENS.villa, png))).toBe('CARD_ALREADY_SIGNED')
    const view = await ports.stay.bookWakeUp(STAY_TOKENS.villa, { date: TOMORROW, time: '07:00', note: '', repeatDaily: false })
    expect(view.wakeUpCalls?.at(-1)).toMatchObject({ date: TOMORROW, time: '07:00', status: 'pending' })
    const b = await stayOf(STAY_TOKENS.villa)
    expect(b.registrationCard).toMatchObject({ by: 'Guest', where: 'stay' })
    expect(b.guestActions?.slice(-2).map((a) => a.kind)).toEqual(['card', 'wake_up'])
  })
})

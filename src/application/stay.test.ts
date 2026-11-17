import { beforeEach, describe, expect, it } from 'vitest'
import type { Booking } from '@/domain/booking'
import { EMPTY_PREFERENCES } from '@/domain/hospitality'
import { GUEST_ACTION_LIMIT, isStayToken } from '@/domain/stay'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { STAY_TOKENS } from '@/infrastructure/mock/data/hospitality'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-11'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const stayOf = async (token: string) => (await ports.booking.bookings()).find((b) => b.stayToken === token) as Booking

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await signIn('kadek')
})

describe('stay page', () => {
  it('shows a villa stay with its host’s first name and a room stay without one', async () => {
    const villa = await s.stay.view(STAY_TOKENS.villa)
    expect(villa).toMatchObject({ state: 'open', unitKind: 'villa', today: TODAY })
    expect(villa.hostName).toMatch(/^\S+$/)
    expect(villa.menu?.every((i) => !('costPrice' in i) && !('partnerId' in i))).toBe(true)
    expect(villa.folio?.lines.length).toBeGreaterThan(0)
    const room = await s.stay.view(STAY_TOKENS.room)
    expect(room).toMatchObject({ unitKind: 'room', hostName: null })
    expect(JSON.stringify(room)).not.toContain('postedBy')
  })

  it('refuses an unknown token and a token of the wrong shape', async () => {
    await expect(s.stay.view(`st${'0'.repeat(32)}`)).rejects.toThrow(/No stay page/)
    await expect(s.stay.view('BK-2001')).rejects.toThrow(/No stay page/)
  })

  it('asks for cleaning once a day and records it as the guest', async () => {
    const view = await s.stay.askClean(STAY_TOKENS.room, 'Fresh towels please')
    expect(view.cleanAskedAt).toMatch(/^2026-11-11T/)
    expect(view.requests.filter((r) => r.kind === 'cleaning' && r.requestedOn === TODAY)).toHaveLength(1)
    await expect(s.stay.askClean(STAY_TOKENS.room, '')).rejects.toMatchObject({ code: 'CLEAN_ALREADY_ASKED' })
    const b = await stayOf(STAY_TOKENS.room)
    expect(b.guestActions?.at(-1)).toMatchObject({ kind: 'clean', summary: 'Asked for cleaning today' })
    const audit = await ports.access.audit()
    expect(audit.some((l) => l.userName === 'Guest' && l.summary.includes('Asked for cleaning today'))).toBe(true)
  })

  it('keeps the service window to the unit kind and lifts do not disturb', async () => {
    await expect(s.stay.setServiceWindow(STAY_TOKENS.room, { mode: 'window', from: '10:00', to: '12:00' })).rejects.toThrow()
    expect((await s.stay.setServiceWindow(STAY_TOKENS.room, { mode: 'dnd', from: '', to: '' })).serviceWindow.mode).toBe('dnd')
    expect((await s.stay.setServiceWindow(STAY_TOKENS.room, { mode: 'scheduled', from: '', to: '' })).serviceWindow.mode).toBe('scheduled')
    await expect(s.stay.setServiceWindow(STAY_TOKENS.villa, { mode: 'scheduled', from: '', to: '' })).rejects.toThrow()
    expect((await s.stay.setServiceWindow(STAY_TOKENS.villa, { mode: 'window', from: '13:00', to: '15:00' })).serviceWindow).toMatchObject({ from: '13:00', to: '15:00' })
  })

  it('orders at menu prices and sends a request to the villa host', async () => {
    const before = await s.stay.view(STAY_TOKENS.villa)
    const item = before.menu!.find((i) => i.villaOnRequest || (i.availableFrom === 0 && i.availableTo === 0)) ?? before.menu![0]!
    const ordered = await s.stay.placeOrder(STAY_TOKENS.villa, { lines: [{ itemId: item.id, quantity: 1 }], note: '', requestedOn: TODAY, requestedAt: 20 * 60 })
    expect(ordered.orders).toHaveLength(before.orders.length + 1)
    expect(ordered.orders[0]!.charge).toBe(item.price)
    const asked = await s.stay.request(STAY_TOKENS.villa, { kind: 'towels', note: 'Two more' })
    expect(asked.requests[0]).toMatchObject({ kind: 'towels', status: 'open' })
    const request = (await ports.service.requests()).find((r) => r.number === asked.requests[0]!.number)!
    expect(request.assignee).not.toBe('')
    await expect(s.stay.request(STAY_TOKENS.villa, { kind: 'other', note: '' })).rejects.toThrow()
  })

  it('quotes a late check-out and confirms it in the guest’s name', async () => {
    const quote = await s.stay.quoteLateCheckout(STAY_TOKENS.room, '14:00')
    const view = await s.stay.lateCheckout(STAY_TOKENS.room, '14:00')
    expect(view.lateCheckout).toEqual({ until: '14:00', charge: quote.charge })
    expect((await stayOf(STAY_TOKENS.room)).lateCheckout).toMatchObject({ by: 'Guest' })
    await expect(s.stay.lateCheckout(STAY_TOKENS.room, '15:00')).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
  })

  it('edits the preferences the unit kind allows and keeps the arrival time', async () => {
    const view = await s.stay.setPreferences(STAY_TOKENS.villa, { ...EMPTY_PREFERENCES, breakfastTime: '07:30', dietary: 'No shellfish', arrivalTime: '23:00' })
    expect(view.preferences).toMatchObject({ breakfastTime: '07:30', dietary: 'No shellfish', arrivalTime: '' })
    const room = await s.stay.setPreferences(STAY_TOKENS.room, { ...EMPTY_PREFERENCES, dietary: 'Vegan', notes: 'Extra pillows' })
    expect(room.preferences).toMatchObject({ dietary: '', notes: 'Extra pillows' })
  })

  it('turns read only once the guest checks out', async () => {
    const b = await stayOf(STAY_TOKENS.room)
    await ports.booking.transition(b.id, 'checked_out')
    expect((await s.stay.view(STAY_TOKENS.room)).state).toBe('read_only')
    await expect(s.stay.askClean(STAY_TOKENS.room, '')).rejects.toMatchObject({ code: 'STAY_READ_ONLY' })
  })

  it('limits each token’s writes', async () => {
    for (let i = 0; i < GUEST_ACTION_LIMIT; i++) await s.stay.setServiceWindow(STAY_TOKENS.room, { mode: i % 2 ? 'dnd' : 'scheduled', from: '', to: '' })
    await expect(s.stay.setServiceWindow(STAY_TOKENS.room, { mode: 'dnd', from: '', to: '' })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect((await s.stay.setServiceWindow(STAY_TOKENS.villa, { mode: 'dnd', from: '', to: '' })).serviceWindow.mode).toBe('dnd')
  })

  it('makes the link at check-in, and on request for a stay in house without one', async () => {
    const inHouse = (await ports.booking.bookings()).find((b) => b.status === 'checked_in' && !b.stayToken)!
    expect(isStayToken((await s.stay.issueLink(inHouse.id)).stayToken ?? '')).toBe(true)
    const confirmed = (await ports.booking.bookings()).find((b) => b.status === 'confirmed' && b.unitAssigned)!
    await expect(s.stay.issueLink(confirmed.id)).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
  })
})

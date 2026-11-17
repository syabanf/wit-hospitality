import { describe, expect, it } from 'vitest'
import type { FolioLine } from './folio'
import {
  cleanAskedAt,
  guestFolioView,
  guestLineLabel,
  guestWindowProblem,
  isStayToken,
  lateCheckoutTimes,
  rateLimiter,
  stayLinkState,
  stayTokenFrom,
  validateGuestRequest,
  withGuestAction,
  GUEST_ACTIONS_KEPT,
} from './stay'

const line = (over: Partial<FolioLine>) => ({ id: 'l', date: '2026-11-10', kind: 'charge', description: '', debit: 0, credit: 0, memo: 0, ref: { type: 'booking', id: 'b', label: '' }, postedBy: 'Kadek', postedAt: '', part: 'room', orderId: null, code: 'ROOM', of: null, forecast: false, balance: 0, ...over }) as FolioLine & { balance: number }

describe('stay link', () => {
  it('makes a 128-bit token and knows its shape', () => {
    const token = stayTokenFrom(new Uint8Array(16).fill(171))
    expect(token).toBe(`st${'ab'.repeat(16)}`)
    expect(isStayToken(token)).toBe(true)
    expect(isStayToken('st123')).toBe(false)
    expect(isStayToken(`ci${'ab'.repeat(16)}`)).toBe(false)
  })

  it('opens in house, turns read only at check-out and closes a day later', () => {
    expect(stayLinkState({ status: 'checked_in', checkOut: '2026-11-12' }, '2026-11-11')).toBe('open')
    expect(stayLinkState({ status: 'checked_out', checkOut: '2026-11-12' }, '2026-11-13')).toBe('read_only')
    expect(stayLinkState({ status: 'checked_out', checkOut: '2026-11-12' }, '2026-11-14')).toBe('expired')
    expect(stayLinkState({ status: 'cancelled', checkOut: '2026-11-12' }, '2026-11-11')).toBe('expired')
  })
})

describe('guest actions', () => {
  it('keeps the latest actions and finds today’s clean', () => {
    let actions = withGuestAction([], { kind: 'clean', at: '2026-11-10T09:00:00', summary: 'Asked for cleaning today' })
    expect(cleanAskedAt(actions, '2026-11-11')).toBeNull()
    actions = withGuestAction(actions, { kind: 'clean', at: '2026-11-11T14:02:00', summary: 'Asked for cleaning today' })
    expect(cleanAskedAt(actions, '2026-11-11')).toBe('2026-11-11T14:02:00')
    for (let i = 0; i < GUEST_ACTIONS_KEPT + 5; i++) actions = withGuestAction(actions, { kind: 'order', at: '2026-11-11T15:00:00', summary: 'Ordered' })
    expect(actions).toHaveLength(GUEST_ACTIONS_KEPT)
  })

  it('lets a villa pick a window or DND and a room the schedule or DND', () => {
    expect(guestWindowProblem('villa', { mode: 'scheduled' })).toBeDefined()
    expect(guestWindowProblem('villa', { mode: 'window' })).toBeUndefined()
    expect(guestWindowProblem('room', { mode: 'window' })).toBeDefined()
    expect(guestWindowProblem('room', { mode: 'dnd' })).toBeUndefined()
  })

  it('checks a request: a known kind, a note for something else', () => {
    expect(validateGuestRequest({ kind: 'towels', note: '' })).toEqual({})
    expect(validateGuestRequest({ kind: 'cleaning', note: '' }).kind).toBeDefined()
    expect(validateGuestRequest({ kind: 'other', note: 'x' }).note).toBe('Tell us what you need.')
    expect(validateGuestRequest({ kind: 'towels', note: 'x'.repeat(501) }).note).toBeDefined()
  })

  it('offers each full hour after check-out until 18:00', () => {
    expect(lateCheckoutTimes('12:00')).toEqual(['13:00', '14:00', '15:00', '16:00', '17:00', '18:00'])
    expect(lateCheckoutTimes('18:00')).toEqual([])
  })

  it('counts each key in its own window', () => {
    const limit = rateLimiter(1000)
    expect([1, 2, 3].map(() => limit.take('a', 2, 0))).toEqual([true, true, false])
    expect(limit.take('b', 2, 0)).toBe(true)
    expect(limit.take('a', 2, 1000)).toBe(true)
  })
})

describe('guest folio', () => {
  it('drops the team’s notes, references and forecasts and keeps taxes as billed', () => {
    const view = guestFolioView({
      lines: [
        line({ kind: 'room', description: 'Night of 10 Nov, rate 1.500.000 (direct)', debit: 1_500_000 }),
        line({ kind: 'tax', code: 'SVC', debit: 150_000 }),
        line({ kind: 'tax', code: 'PB1', debit: 165_000 }),
        line({ kind: 'payment', description: 'Payment PAY-1 ref 99812', credit: 1_000_000, code: 'PAY' }),
        line({ kind: 'room', description: 'Night of 12 Nov', debit: 1_500_000, forecast: true }),
        line({ kind: 'deposit', memo: 500_000 }),
      ],
      balance: 815_000,
      forecast: 1_500_000,
      depositHeld: 500_000,
    })
    expect(view.lines.map((l) => l.label)).toEqual(['Night of 10 Nov', 'Service charge', 'PB1, regional hotel tax', 'Payment'])
    expect(view).toMatchObject({ subtotal: 1_500_000, service: 150_000, pb1: 165_000, balance: 815_000, toCome: 1_500_000, depositHeld: 500_000 })
    expect(guestLineLabel(line({ kind: 'room_service', description: 'SO-701: 2 × Nasi goreng' }))).toBe('2 × Nasi goreng')
  })
})

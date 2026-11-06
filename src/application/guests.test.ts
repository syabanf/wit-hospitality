import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { CheckInDetails } from '@/domain/booking'
import type { CompanionInput, GuestInput } from '@/domain/guest'
import type { LostItemInput } from '@/domain/lostFound'
import { addDays } from '@/lib/dates'
import type { NewBooking } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const arrival: CheckInDetails = { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const visitor: GuestInput = { name: 'Chris Hall', email: 'chris.hall@example.com', phone: '+61 400 111 222', nationality: 'AU', idType: 'passport', idNumber: 'PB1112223', notes: '' }
const booking = (fields: Partial<NewBooking> = {}): NewBooking => ({ guestId: null, newGuest: visitor, unitId: 'unit-sk-06', groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: TODAY, checkOut: addDays(TODAY, 2), channelRate: null, price: null, notes: '', confirm: true, ...fields })
const registered = { idExpiry: '2031-01-01', birthDate: '1990-01-01', sex: 'male', birthPlace: 'Sydney', entryDate: TODAY, entryPort: 'Ngurah Rai (DPS)', visaType: 'voa', addressInIndonesia: '' } as const
const companion: CompanionInput = { name: 'Alex Hall', adult: true, nationality: 'AU', idType: 'passport', idNumber: 'PB1112224', ...registered, sex: 'female' }
const find: LostItemInput = { foundOn: TODAY, villaId: 'vil-saka', unitId: 'unit-sk-06', where: 'Under the bed', description: 'Phone charger', photos: [], guestId: null, bookingId: null, storage: '' }

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0, null))
})

describe('foreign guest registration', () => {
  it('seeds two foreign guests in house past the 24 hours and not reported', async () => {
    const overdue = (await s.dashboard.attention()).unreported
    expect(new Set(overdue.map((r) => r.booking.id)).size).toBe(2)
    const report = await s.reports.run('foreign-guests', { from: addDays(TODAY, -30), to: TODAY })
    expect(report.rows.length).toBeGreaterThan(5)
    expect(report.rows.filter((r) => r.status !== 'Reported').length).toBeGreaterThanOrEqual(2)
  })

  it('lists the day, marks guests reported once, and clears the bell', async () => {
    const [first] = (await s.dashboard.attention()).unreported
    if (!first) throw new Error('no unreported guest')
    const day = await s.guest.foreign({ date: TODAY, villaId: first.booking.place.villa.id })
    expect(day.rows.some((r) => r.key === first.key)).toBe(true)
    expect(day.apoa[0]).toHaveLength(15)
    await s.guest.markReported(first.booking.id, [first.personId], 'APOA-TEST-1')
    await expect(s.guest.markReported(first.booking.id, [first.personId], '')).rejects.toMatchObject({ code: 'ALREADY_REPORTED' })
    expect((await s.dashboard.attention()).unreported.some((r) => r.key === first.key)).toBe(false)
    expect((await s.access.audit()).entries.some((e) => e.entity === 'foreign-report' && e.entityId === first.booking.code)).toBe(true)
  })

  it('refuses check-in until every foreign adult is registered with a valid document', async () => {
    const b = await s.booking.create(booking())
    await expect(s.booking.checkIn(b.id, arrival)).rejects.toMatchObject({ code: 'FOREIGN_DATA_MISSING' })
    await s.guest.update(b.guestId, { ...visitor, ...registered })
    const extra = await s.guest.addCompanion(b.id, { ...companion, visaType: null })
    await expect(s.booking.checkIn(b.id, arrival)).rejects.toMatchObject({ code: 'FOREIGN_DATA_MISSING', message: expect.stringContaining('Alex Hall: visa type') })
    await s.guest.updateCompanion(extra.id, { ...companion, idExpiry: addDays(TODAY, -1) })
    await expect(s.booking.checkIn(b.id, arrival)).rejects.toMatchObject({ code: 'DOCUMENT_EXPIRED' })
    await s.guest.updateCompanion(extra.id, companion)
    expect((await s.booking.checkIn(b.id, arrival)).status).toBe('checked_in')
    const reg = await s.guest.registration(b.id)
    expect(reg.people.every((p) => p.missing.length === 0)).toBe(true)
    expect((await s.guest.foreign({ date: TODAY })).rows.filter((r) => r.booking.id === b.id)).toHaveLength(2)
  })

  it('lets Indonesian guests check in on a KTP alone', async () => {
    const b = await s.booking.create(booking({ newGuest: { ...visitor, name: 'Made Wira', nationality: 'ID', idType: 'ktp', idNumber: '5171010101900001' } }))
    expect((await s.booking.checkIn(b.id, arrival)).status).toBe('checked_in')
  })
})

describe('guest profile', () => {
  it('refuses a blacklisted guest unless a manager overrides with a reason', async () => {
    await expect(s.booking.create(booking({ guestId: 'g-25', newGuest: null }))).rejects.toMatchObject({ code: 'GUEST_BLACKLISTED' })
    await signIn('wayan')
    await expect(s.booking.create(booking({ guestId: 'g-25', newGuest: null, blacklistOverride: 'Paid the damage' }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    const b = await s.booking.create(booking({ guestId: 'g-25', newGuest: null, blacklistOverride: 'Paid the damage in full' }))
    expect(b.guestId).toBe('g-25')
    expect((await s.access.audit()).entries.find((e) => e.entity === 'guest' && e.entityId === 'g-25')?.action).toBe('approve')
  })

  it('sets the blacklist only with the approve action', async () => {
    await signIn('wayan')
    await expect(s.guest.setBlacklist('g-02', 'Smoked indoors twice')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    expect((await s.guest.setBlacklist('g-02', 'Smoked indoors twice')).blacklist?.setBy).toBe('Kadek Ariani')
    expect((await s.guest.setBlacklist('g-02', null)).blacklist).toBeNull()
  })

  it('finds the seeded duplicate and merges it, moving the stays', async () => {
    const pair = (await s.guest.duplicates()).find((p) => [p.a.id, p.b.id].includes('g-26'))
    expect(pair?.match).toBe('phone')
    const stays = (await s.booking.list()).list.length
    const b = await s.booking.create(booking({ guestId: 'g-26', newGuest: null, unitId: 'unit-kr-01' }))
    const kept = await s.guest.merge('g-16', 'g-26')
    expect(kept.tags).toContain('Press')
    expect((await s.guest.list()).guests.some((g) => g.id === 'g-26')).toBe(false)
    expect((await s.booking.detail(b.id)).booking.guestId).toBe('g-16')
    expect((await s.booking.list()).list.length).toBe(stays + 1)
  })
})

describe('lost and found', () => {
  it('logs a find, returns it by courier and holds unclaimed items for the period', async () => {
    await signIn('wayan')
    const item = await s.lostFound.create(find)
    expect(item.foundBy).toBe('Wayan Sudiarta')
    await expect(s.lostFound.move(item.id, { to: 'returned', note: '', returned: { method: 'courier', to: 'Chris Hall', courier: 'JNE', tracking: '' } })).rejects.toMatchObject({ code: 'LOST_ITEM_INVALID_STATE' })
    await s.lostFound.move(item.id, { to: 'stored', note: 'Front office drawer' })
    await expect(s.lostFound.move(item.id, { to: 'donated', note: '' })).rejects.toMatchObject({ code: 'LOST_ITEM_INVALID_STATE' })
    const back = await s.lostFound.move(item.id, { to: 'returned', note: '', returned: { method: 'courier', to: 'Chris Hall', courier: 'JNE', tracking: 'JNE123' } })
    expect(back.history.map((h) => h.status)).toEqual(['found', 'stored', 'returned'])
    const list = await s.lostFound.list()
    expect(list.items.find((i) => i.description === 'Straw beach hat')?.holdOver).toBe(true)
    await expect(s.lostFound.saveSettings({ holdDays: 30 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

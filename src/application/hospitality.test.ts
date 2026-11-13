import { beforeEach, describe, expect, it } from 'vitest'
import type { Booking } from '@/domain/booking'
import { EMPTY_PREFERENCES } from '@/domain/hospitality'
import { checkinTokenFor } from '@/domain/messaging'
import type { PreCheckInInput } from '@/domain/precheckin'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-10-30'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const unitOf = async (b: Booking) => (await ports.property.units()).find((u) => u.id === b.unitId)!
const stays = async (test: (b: Booking) => boolean) => (await ports.booking.bookings()).filter(test)
const isVilla = (b: Booking) => !b.unitId.startsWith('unit-sk-')

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await signIn('kadek')
})

describe('villa host', () => {
  it('gives villa stays the unit host and leaves room stays without one', async () => {
    const all = await stays((b) => b.status === 'confirmed' || b.status === 'checked_in')
    for (const b of all) expect(b.hostId, b.code).toBe(isVilla(b) ? ((await unitOf(b)).hostId ?? null) : null)
    expect(all.some((b) => b.hostId === 'emp-006')).toBe(true)
  })

  it('lets a manager change the host to someone allocated to the villa only', async () => {
    const [b] = await stays((x) => x.status === 'confirmed' && x.unitId.startsWith('unit-tr-'))
    await expect(s.booking.setHost(b!.id, 'emp-011')).rejects.toMatchObject({ code: 'HOST_NOT_ALLOCATED' })
    expect((await s.booking.setHost(b!.id, 'emp-008')).hostId).toBe('emp-008')
    const [room] = await stays((x) => x.status === 'confirmed' && x.unitId.startsWith('unit-sk-'))
    await expect(s.booking.setHost(room!.id, 'emp-001')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await signIn('wayan')
    await expect(s.booking.setHost(b!.id, 'emp-006')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('keeps a unit host to employees of its villa', async () => {
    const unit = (await ports.property.units()).find((u) => u.code === 'TR-01')!
    await expect(s.property.updateUnit(unit.id, { ...unit, hostId: 'emp-011' })).rejects.toMatchObject({ code: 'HOST_NOT_ALLOCATED' })
    expect((await s.property.updateUnit(unit.id, { ...unit, hostId: 'emp-007' })).unit.hostId).toBe('emp-007')
    expect((await s.property.hosts('vil-tirta')).map((e) => e.id)).toContain('emp-006')
  })

  it('lists the host’s stays with preferences and window in their own area', async () => {
    await signIn('dewi')
    const home = await s.people.home()
    expect(home.hosting.length).toBeGreaterThan(0)
    const mine = await stays((b) => b.hostId === 'emp-006')
    expect(home.hosting.every((h) => mine.some((b) => b.id === h.id))).toBe(true)
    expect(home.hosting[0]?.window.mode).toBeDefined()
  })
})

describe('guest preferences', () => {
  it('saves a villa guest’s choices from online check-in and sends the paid setup to the host', async () => {
    const [b] = await stays((x) => x.status === 'confirmed' && x.source === 'direct' && x.unitId.startsWith('unit-tr-') && x.checkIn > TODAY)
    const token = checkinTokenFor(b!.id)
    await s.access.logout()
    const page = await s.precheckin.guest(token)
    expect(page.unitKind).toBe('villa')
    const form: PreCheckInInput = {
      ...page.form,
      phone: '+61 412 555 019',
      adults: 1,
      children: 0,
      travellers: [{ name: 'Ana Silva', nationality: 'Portugal', documentType: 'passport', documentNumber: 'CB123456', documentExpiry: '2030-01-01', dateOfBirth: '1990-04-02', sex: 'female', entryDate: b!.checkIn, portOfEntry: 'DPS', visaType: 'voa' }],
      idPhotos: [{ id: 'file-x', name: 'passport.jpg', type: 'image/jpeg', size: 1000, url: '', uploadedBy: 'Guest', uploadedAt: `${TODAY}T08:00:00` }],
      rulesName: 'Ana Silva',
      rulesAccepted: true,
      arrivalTime: '17:15',
      preferences: { ...EMPTY_PREFERENCES, breakfastTime: '08:30', setups: ['private_chef', 'baby_cot'] },
    }
    await s.precheckin.submit(token, form)
    await signIn('kadek')
    const d = await s.booking.detail(b!.id)
    expect(d.hospitality.preferences).toMatchObject({ breakfastTime: '08:30', arrivalTime: '17:15', setups: ['private_chef', 'baby_cot'] })
    const asked = d.requests.filter((r) => r.note.startsWith('Private chef'))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.assignee).toBe(d.hospitality.host?.name)
    expect(asked[0]?.charge).toBe(0)
  })

  it('keeps only arrival time and notes on a room stay', async () => {
    const [room] = await stays((x) => x.status === 'confirmed' && x.unitId.startsWith('unit-sk-'))
    const saved = await s.booking.setPreferences(room!.id, { breakfastTime: '07:00', dietary: 'Vegan', setups: ['bbq'], arrivalTime: '18:00', notes: 'Late flight' })
    expect(saved.preferences).toEqual({ ...EMPTY_PREFERENCES, arrivalTime: '18:00', notes: 'Late flight' })
    await expect(s.booking.setPreferences(room!.id, { ...EMPTY_PREFERENCES, arrivalTime: '6pm' })).rejects.toMatchObject({ errors: { arrivalTime: expect.any(String) } })
  })
})

describe('service window', () => {
  it('defaults rooms to the schedule and villas to 10:00 to 12:00, and shows it on the board', async () => {
    const [room] = await stays((x) => x.status === 'confirmed' && x.unitId.startsWith('unit-sk-'))
    expect(room!.serviceWindow).toEqual({ mode: 'scheduled', from: '', to: '' })
    const day = await s.housekeeping.day()
    const served = day.tasks.filter((t) => t.bookingId && t.type === 'stayover')
    expect(served.every((t) => t.serviceWindow !== null)).toBe(true)
  })

  it('refuses to start a task on a do-not-disturb stay unless a supervisor overrides with a reason', async () => {
    const [dnd] = await stays((x) => x.status === 'checked_in' && x.serviceWindow?.mode === 'dnd')
    expect(dnd).toBeDefined()
    const task = await s.housekeeping.addTask({ unitId: dnd!.unitId, date: TODAY, type: 'turndown', attendantId: null, note: '' })
    await s.housekeeping.assign([task.id], 'emp-003')
    await signIn('sari')
    await expect(s.housekeeping.work(task.id, 'start')).rejects.toMatchObject({ code: 'TASK_DND', message: 'The guest asked not to be disturbed.' })
    await expect(s.housekeeping.work(task.id, 'start', { overrideReason: 'Water leak below' })).rejects.toMatchObject({ code: 'TASK_DND' })
    await signIn('kadek')
    await expect(s.housekeeping.work(task.id, 'start')).rejects.toMatchObject({ code: 'TASK_DND' })
    const started = await s.housekeeping.work(task.id, 'start', { overrideReason: 'Water leak below' })
    expect(started.status).toBe('in_progress')
    expect(started.note).toContain('Water leak below')
  })

  it('lets a villa guest ask for a clean: a request and one stayover task for today', async () => {
    const [b] = await stays((x) => x.status === 'checked_in' && isVilla(x) && x.serviceWindow?.mode !== 'dnd')
    const request = await s.booking.requestClean(b!.id)
    expect(request.kind).toBe('cleaning')
    await s.booking.requestClean(b!.id)
    const tasks = (await ports.housekeeping.tasks()).filter((t) => t.date === TODAY && t.unitId === b!.unitId && t.type === 'stayover' && t.status !== 'cancelled')
    expect(tasks).toHaveLength(1)
  })

  it('saves a window and refuses one that ends before it starts', async () => {
    const [b] = await stays((x) => x.status === 'confirmed' && isVilla(x))
    expect((await s.booking.setServiceWindow(b!.id, { mode: 'window', from: '13:00', to: '15:00' })).serviceWindow).toEqual({ mode: 'window', from: '13:00', to: '15:00' })
    await expect(s.booking.setServiceWindow(b!.id, { mode: 'window', from: '15:00', to: '13:00' })).rejects.toMatchObject({ errors: { to: expect.any(String) } })
  })
})

describe('late check-out', () => {
  const nextArrival = (all: Booking[], b: Booking) => all.some((x) => x.id !== b.id && x.unitId === b.unitId && (x.status === 'confirmed' || x.status === 'checked_in') && x.checkIn === b.checkOut)

  it('is free for a villa with nobody arriving and charged to a room’s folio', async () => {
    const all = await ports.booking.bookings()
    const villa = all.find((b) => b.status === 'checked_in' && isVilla(b) && !nextArrival(all, b))!
    expect((await s.booking.lateCheckout(villa.id, '16:00')).charge).toBe(0)
    await expect(s.booking.lateCheckout(villa.id, '17:00')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    const room = all.find((b) => b.status === 'checked_in' && !isVilla(b) && !nextArrival(all, b))!
    const r = await s.booking.lateCheckout(room.id, '15:00')
    expect(r.charge).toBe(500_000)
    expect(r.booking.lateCheckout).toEqual({ until: '15:00', charge: 500_000 })
    expect((await ports.folio.postings(room.id)).some((p) => p.code === 'LATE' && p.description === 'Late check-out to 15:00')).toBe(true)
  })

  it('refuses when the next guest arrives before the guest would leave', async () => {
    const all = await ports.booking.bookings()
    const b = all.find((x) => x.status === 'checked_in' && nextArrival(all, x))
    expect(b).toBeDefined()
    await expect(s.booking.lateCheckout(b!.id, '23:00')).rejects.toMatchObject({ code: 'LATE_CHECKOUT_TAKEN' })
  })
})

describe('menu on request', () => {
  it('lets a villa stay order breakfast in the afternoon and keeps a room stay to its hours', async () => {
    const options = await s.orders.formOptions()
    const tomorrow = addDays(TODAY, 1)
    const stayIn = (villaId: string) => options.stays.find((b) => b.status === 'checked_in' && b.place.villa.id === villaId && b.checkOut > tomorrow)!
    const breakfast = (villaId: string) => options.menu.find((i) => i.villaId === villaId && i.name === 'Balinese breakfast')!
    const place = (villaId: string) => s.orders.place({ bookingId: stayIn(villaId).id, lines: [{ itemId: breakfast(villaId).id, quantity: 1 }], note: '', requestedOn: tomorrow, requestedAt: 15 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' })
    expect((await place('vil-tirta')).status).toBe('new')
    await expect(place('vil-saka')).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
  })
})

describe('host workload report', () => {
  it('counts stays per host per week and the requests they answered', async () => {
    const r = await s.reports.run('host-workload', { from: addDays(TODAY, -13), to: TODAY })
    expect(r.rows.length).toBeGreaterThan(0)
    const komang = r.rows.filter((row) => row.host === 'Komang Dewi')
    expect(komang.reduce((sum, row) => sum + Number(row.stays), 0)).toBeGreaterThan(0)
    expect(komang.reduce((sum, row) => sum + Number(row.answered), 0)).toBeGreaterThanOrEqual(1)
  })
})

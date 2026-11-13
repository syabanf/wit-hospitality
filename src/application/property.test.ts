import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { Ports } from './ports'
import { createServices, ValidationError, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const image = (name: string, type = 'image/png') => s.files.upload({ name, type, size: 4, data: new Blob([new Uint8Array([137, 80, 78, 71])], { type }) })

beforeEach(() => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
})

describe('villa profile and photos', () => {
  it('saves the profile, refuses a bad email or a late check-out, and keeps the bank off the website', async () => {
    const { villa } = await s.property.villa('vil-saka')
    const { id: _id, ...input } = villa
    expect(villa).toMatchObject({ checkInTime: '14:00', checkOutTime: '12:00', cancellationPolicy: 'moderate' })
    await expect(s.property.updateVilla(villa.id, { ...input, email: 'saka@' })).rejects.toMatchObject({ errors: { email: expect.any(String) } })
    await expect(s.property.updateVilla(villa.id, { ...input, checkOutTime: '15:00' })).rejects.toMatchObject({ errors: { checkOutTime: 'Check-out must be earlier than check-in.' } })
    const saved = await s.property.updateVilla(villa.id, { ...input, checkInTime: '15:00', houseRules: 'No parties.\nQuiet after 22:00.', cancellationPolicy: 'strict' })
    expect(saved).toMatchObject({ checkInTime: '15:00', cancellationPolicy: 'strict' })
    const site = await s.site.villa('vil-saka')
    expect(site.villa).toMatchObject({ checkInTime: '15:00', houseRules: ['No parties.', 'Quiet after 22:00.'], cancellation: { label: 'Strict' } })
    expect(JSON.stringify(await ports.site.inventory())).not.toContain(villa.bankAccountNo)
  })

  it('orders photos with the cover first, opens them on the console and the website, and refuses a PDF or an unknown file', async () => {
    const [a, b] = [await image('pool.png'), await image('garden.png')]
    await s.property.setVillaPhotos('vil-saka', [{ fileId: b.id, caption: 'Garden' }, { fileId: a.id, caption: ' Pool ' }])
    const { photos } = await s.property.villa('vil-saka')
    expect(photos.map((p) => [p.fileId, p.caption])).toEqual([[b.id, 'Garden'], [a.id, 'Pool']])
    expect(photos[0]?.url).toMatch(/^data:image\/png/)
    expect((await s.site.villa('vil-saka')).villa.photos[0]?.caption).toBe('Garden')
    const pdf = await image('menu.pdf', 'application/pdf')
    await expect(s.property.setVillaPhotos('vil-saka', [{ fileId: pdf.id, caption: '' }])).rejects.toMatchObject({ code: 'PHOTO_NOT_IMAGE' })
    await expect(s.property.setUnitPhotos('unit-sk-01', [{ fileId: 'file-none', caption: '' }])).rejects.toMatchObject({ code: 'PHOTO_UNKNOWN' })
    await expect(s.property.setUnitPhotos('unit-sk-01', Array.from({ length: 21 }, () => ({ fileId: a.id, caption: '' })))).rejects.toMatchObject({ code: 'PHOTO_LIMIT' })
    await s.property.setUnitPhotos('unit-sk-01', [{ fileId: a.id, caption: 'Bedroom' }])
    expect((await s.property.unit('unit-sk-01')).photos[0]).toMatchObject({ caption: 'Bedroom', url: expect.stringMatching(/^data:/) })
  })
})

describe('unit capacity', () => {
  it('refuses a party past the room or the room type, at booking and at check-in', async () => {
    const stay = { guestId: 'g-01', newGuest: null, source: 'direct' as const, airbnbAccountId: null, airbnbCode: null, checkIn: '2026-11-10', checkOut: '2026-11-12', channelRate: null, price: null, notes: '', confirm: true }
    await expect(s.booking.create({ ...stay, unitId: 'unit-kr-01', groupId: null, partySize: { adults: 7, children: 0 } })).rejects.toMatchObject({ code: 'UNIT_CAPACITY', message: 'Karang cliff villa 1 sleeps 4 adults and 2 children, plus 2 extra beds.' })
    // Saka sells by room type: the smallest room decides.
    await expect(s.booking.create({ ...stay, unitId: null, groupId: 'grp-saka-standard', partySize: { adults: 2, children: 3 } })).rejects.toMatchObject({ code: 'UNIT_CAPACITY' })
    await expect(s.booking.create({ ...stay, unitId: null, groupId: 'grp-saka-standard', partySize: { adults: 0, children: 0 } })).rejects.toBeInstanceOf(ValidationError)
    const booked = await s.booking.create({ ...stay, unitId: null, groupId: 'grp-saka-standard', partySize: { adults: 2, children: 1 } })
    expect(booked.partySize).toEqual({ adults: 2, children: 1 })

    const arriving = (await s.booking.list()).list.find((b) => b.status === 'confirmed' && b.checkIn === TODAY && b.unitAssigned)
    if (!arriving) throw new Error('nobody arrives today')
    const details = { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '15:00', adults: 12, children: 0, notes: '' }
    await expect(s.booking.checkIn(arriving.id, details)).rejects.toMatchObject({ code: 'UNIT_CAPACITY' })
    // The mock adapter holds the same rule when called past the use case.
    await expect(ports.booking.checkIn(arriving.id, details)).rejects.toMatchObject({ code: 'UNIT_CAPACITY' })
  })
})

describe('unit status', () => {
  it('needs a reason to take a unit out of service, records who did it, and shows overdue units on the board', async () => {
    await signIn('wayan')
    await expect(s.property.setUnitStatus('unit-sk-02', { status: 'maintenance', statusReason: 'Leak', statusUntil: null })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    await expect(s.property.setUnitStatus('unit-sk-02', { status: 'maintenance', statusReason: '', statusUntil: null })).rejects.toMatchObject({ errors: { statusReason: 'Say why the unit is out of service.' } })
    await expect(s.property.setUnitStatus('unit-sk-02', { status: 'maintenance', statusReason: 'Leak', statusUntil: '2026-10-01' })).rejects.toMatchObject({ errors: { statusUntil: expect.stringMatching(/past/) } })
    const unit = await s.property.setUnitStatus('unit-sk-02', { status: 'maintenance', statusReason: ' Bathroom leak ', statusUntil: '2026-10-08' })
    expect(unit).toMatchObject({ status: 'maintenance', statusReason: 'Bathroom leak', statusUntil: '2026-10-08' })
    const detail = await s.property.unit('unit-sk-02')
    expect(detail.history[0]).toMatchObject({ from: 'active', to: 'maintenance', reason: 'Bathroom leak', until: '2026-10-08', by: 'Kadek Ariani' })
    expect(detail.overdue).toBe(false)
    expect(await s.property.setUnitStatus('unit-sk-02', { status: 'active', statusReason: 'ignored', statusUntil: null })).toMatchObject({ status: 'active', statusReason: '', statusUntil: null })

    const board = await s.property.statusBoard()
    const tiles = board.villas.flatMap((v) => v.units)
    expect(tiles.find((t) => t.place.unit.code === 'KR-01')).toMatchObject({ overdue: true, place: { unit: { status: 'maintenance' } } })
    expect(tiles.filter((t) => t.overdue).map((t) => t.place.unit.code)).toEqual(['KR-01'])
    expect((await ports.property.statusHistory({ villaId: 'vil-saka' })).every((h) => h.unitId.startsWith('unit-sk-'))).toBe(true)
  })

  it('adds history rows as Housekeeping when the board cleans a unit and as Maintenance when a job runs', async () => {
    await signIn('kadek')
    await s.maintenance.setHousekeeping('unit-lb-02', 'dirty')
    await s.maintenance.setHousekeeping('unit-lb-02', 'cleaning')
    expect((await s.property.unit('unit-lb-02')).place.unit.status).toBe('cleaning')
    await s.maintenance.setHousekeeping('unit-lb-02', 'inspected')
    await s.maintenance.setHousekeeping('unit-lb-02', 'ready')
    const { history, place } = await s.property.unit('unit-lb-02')
    expect(place.unit.status).toBe('active')
    expect(history.slice(0, 2).map((h) => [h.to, h.by])).toEqual([
      ['active', 'Housekeeping'],
      ['cleaning', 'Housekeeping'],
    ])

    const job = await ports.maintenance.createWorkOrder({ villaId: 'vil-lumbung', unitId: 'unit-lb-03', assetId: null, planId: null, source: 'manual', category: 'plumbing', priority: 'high', title: 'Shower drain blocked', description: '', assigneeId: null, vendorId: null, scheduledOn: null, parts: [], labourCost: 0, vendorCost: 0, beforePhotos: [], afterPhotos: [] })
    await ports.maintenance.transitionWorkOrder(job.id, 'in_progress', '')
    expect((await s.property.unit('unit-lb-03')).place.unit).toMatchObject({ status: 'maintenance', statusReason: `${job.number} Shower drain blocked` })
    await ports.maintenance.transitionWorkOrder(job.id, 'done', '')
    const after = await s.property.unit('unit-lb-03')
    expect(after.place.unit.status).toBe('active')
    expect(after.history.slice(0, 2).map((h) => [h.to, h.by])).toEqual([
      ['active', 'Maintenance'],
      ['maintenance', 'Maintenance'],
    ])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { VILLA_PROFILE_DEFAULTS } from '@/domain/property'
import { fixedClock } from '@/infrastructure/clock'
import { createHttpPorts } from './index'

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>

describe('http adapter, property operation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the wizard in the contract shape and books a whole villa', async () => {
    const fetch = vi.fn(async () => ok({ id: 'x' }))
    vi.stubGlobal('fetch', fetch)
    const ports = createHttpPorts('http://api/api/v1', fixedClock('2026-10-30'))
    const villa = { ...VILLA_PROFILE_DEFAULTS, locationId: 'loc-1', code: 'HT', name: 'Hotel', description: '', facilities: [], operation: 'hotel' as const, stayoverEvery: 1, depositOnCheckIn: false }
    await ports.property.createProperty({ villa, groups: [{ name: 'Deluxe', kind: 'room', interchangeable: true, operatorAssigns: true, minStay: 1 }], rooms: [{ code: 'HT-201', name: 'Room 201', floor: '2', bedrooms: 1, nightlyRate: 900_000, groupIndex: 0, amenities: [] }] })
    const body = bodyOf(fetch.mock.calls[0] as unknown[])
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/properties$/)
    expect(body.villa).toMatchObject({ operation: 'hotel', stayoverEvery: 1, depositOnCheckIn: false, wholeRental: false, wholeNightlyRate: 0 })
    expect(body.groups).toEqual([{ name: 'Deluxe', kind: 'room', interchangeable: true, operatorAssigns: true, minStay: 1, plan: { weekdayRate: 900_000, weekendRate: 1_080_000, seasons: [] } }])
    expect(Object.keys((body.rooms as object[])[0] ?? {}).sort()).toEqual(['amenities', 'bedrooms', 'beds', 'code', 'extraBedRate', 'extraBeds', 'floor', 'groupIndex', 'maxAdults', 'maxChildren', 'name', 'nightlyRate'])

    await ports.groups.bookWholeVilla({ villaId: 'vil-1', guestId: 'g-1', newGuest: null, checkIn: '2026-12-01', checkOut: '2026-12-03', adults: 4, children: 0, source: 'direct' })
    expect(String((fetch.mock.calls[1] as unknown[])[0])).toMatch(/\/whole-villa-bookings$/)
  })

  it('puts a GROUP_KIND refusal on the kind field', async () => {
    const problem = { error: { code: 'GROUP_KIND', message: 'A Hotel only has rooms.', fields: { kind: 'A Hotel only has rooms.' } } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(problem), { status: 409, headers: { 'content-type': 'application/json' } })))
    const ports = createHttpPorts('http://api/api/v1', fixedClock('2026-10-30'))
    await expect(ports.property.createGroup({ villaId: 'v', name: 'Villas', interchangeable: false, operatorAssigns: false, kind: 'villa' })).rejects.toMatchObject({ code: 'GROUP_KIND', errors: { kind: 'A Hotel only has rooms.' } })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { VILLA_PROFILE_DEFAULTS } from '@/domain/property'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { createPerformance } from './performance'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-10-30'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

beforeEach(() => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
})

describe('room and villa foundations', () => {
  it('splits revenue into Rooms and Villas where a scope holds both, and not where it holds one', async () => {
    const all = await s.revenue.dashboard({ from: '2026-10-01', to: TODAY, compare: 'previous' })
    expect(all.kinds.map((k) => k.label)).toEqual(['Rooms', 'Villas'])
    expect(all.kinds.reduce((t, k) => t + k.stats.revenue, 0)).toBe(all.current.revenue)
    expect((await s.revenue.dashboard({ from: '2026-10-01', to: TODAY, compare: 'previous', villaId: 'vil-saka' })).kinds).toEqual([])

    const exec = await s.dashboard.executive({ period: '30d' })
    expect(exec.byKind.map((k) => k.label)).toEqual(['Rooms', 'Villas', 'Total'])
    expect(exec.byKind[0]!.revenue + exec.byKind[1]!.revenue).toBe(exec.byKind[2]!.revenue)
    expect((await s.dashboard.executive({ period: '30d', locationId: 'loc-ubud' })).byKind).toEqual([])

    const owner = await createPerformance(s).overview({ from: '2026-10-01', to: TODAY, compareFrom: '2026-09-01', compareTo: '2026-09-30' })
    expect(owner.byKind.map((k) => k.label)).toEqual(['Rooms', 'Villas', 'Total'])
  })

  it('creates a mixed property from the wizard with each kind’s minimum stay as a stay restriction', async () => {
    await signIn('admin')
    const villa = await s.property.createProperty({
      villa: { ...VILLA_PROFILE_DEFAULTS, locationId: 'loc-ubud', code: 'MX', name: 'Mixed Ubud', description: '', facilities: [], operation: 'mixed', stayoverEvery: 1 },
      groups: [
        { name: 'Deluxe', kind: 'room', interchangeable: true, operatorAssigns: true, minStay: 1 },
        { name: 'Rice villa', kind: 'villa', interchangeable: false, operatorAssigns: false, minStay: 2 },
      ],
      rooms: [
        { code: 'MX-201', name: 'Room 201', floor: '2', bedrooms: 1, nightlyRate: 900_000, groupIndex: 0, amenities: [] },
        { code: 'MX-202', name: 'Room 202', floor: '2', bedrooms: 1, nightlyRate: 900_000, groupIndex: 0, amenities: [] },
        { code: 'MX-01', name: 'Rice villa', bedrooms: 2, nightlyRate: 3_000_000, groupIndex: 1, amenities: ['private-pool'] },
      ],
    })
    const groups = (await ports.property.groups()).filter((g) => g.villaId === villa.id)
    expect(groups.map((g) => [g.name, g.kind, g.operatorAssigns])).toEqual([['Deluxe', 'room', true], ['Rice villa', 'villa', false]])
    const rules = (await ports.stayRules.restrictions()).filter((r) => groups.some((g) => g.id === r.groupId))
    expect(rules).toEqual([expect.objectContaining({ id: `rst-min-${groups[1]!.id}`, groupId: groups[1]!.id, rule: 'min_stay', nights: 2, yearly: true })])
    expect((await s.property.unit('unit-mx-201')).place.unit.floor).toBe('2')
  })
})

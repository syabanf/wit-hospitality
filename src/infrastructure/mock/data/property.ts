import type { Location, Unit, UnitGroup, UnitStatus, Villa } from '@/domain/property'

export const LOCATIONS: readonly Location[] = [
  { id: 'loc-canggu', name: 'Canggu', area: 'Badung, Bali' },
  { id: 'loc-ubud', name: 'Ubud', area: 'Gianyar, Bali' },
  { id: 'loc-seminyak', name: 'Seminyak', area: 'Badung, Bali' },
  { id: 'loc-uluwatu', name: 'Uluwatu', area: 'Badung, Bali' },
]

export const VILLAS: readonly Villa[] = [
  { id: 'vil-saka', locationId: 'loc-canggu', code: 'SK', name: 'Villa Saka', description: 'Eight identical one-bedroom pool units around a shared garden, five minutes from Batu Bolong.', facilities: ['pool', 'wifi', 'parking', 'breakfast', 'security', 'garden'] },
  { id: 'vil-tirta', locationId: 'loc-ubud', code: 'TR', name: 'Villa Tirta', description: 'Two pool suites and two garden rooms above the Ayung valley.', facilities: ['wifi', 'breakfast', 'spa', 'shuttle', 'garden', 'laundry'] },
  { id: 'vil-lumbung', locationId: 'loc-seminyak', code: 'LB', name: 'Villa Lumbung', description: 'Four rice-barn lofts with a shared lap pool off Jalan Petitenget.', facilities: ['pool', 'wifi', 'parking', 'restaurant', 'security'] },
  { id: 'vil-karang', locationId: 'loc-uluwatu', code: 'KR', name: 'Villa Karang', description: 'Three cliff-edge two-bedroom villas with private pools.', facilities: ['wifi', 'parking', 'breakfast', 'shuttle', 'security', 'gym'] },
  { id: 'vil-pandawa', locationId: 'loc-uluwatu', code: 'PD', name: 'Villa Pandawa', description: 'One four-bedroom estate, closed for renovation until December.', facilities: ['wifi', 'parking', 'security'] },
]

export const GROUPS: readonly UnitGroup[] = [
  { id: 'grp-saka-standard', villaId: 'vil-saka', name: 'Saka standard', interchangeable: true },
  { id: 'grp-tirta-pool', villaId: 'vil-tirta', name: 'Tirta pool suites', interchangeable: true },
  { id: 'grp-tirta-garden', villaId: 'vil-tirta', name: 'Tirta garden rooms', interchangeable: false },
  { id: 'grp-lumbung-loft', villaId: 'vil-lumbung', name: 'Lumbung lofts', interchangeable: true },
  { id: 'grp-karang-cliff', villaId: 'vil-karang', name: 'Karang cliff villas', interchangeable: false },
]

const AMENITIES: Record<string, readonly string[]> = {
  SK: ['ac', 'private-pool', 'kitchen', 'tv', 'safe', 'outdoor-shower'],
  TR: ['ac', 'balcony', 'tv', 'safe', 'minibar', 'bathtub'],
  LB: ['ac', 'kitchen', 'balcony', 'tv', 'workspace', 'safe'],
  KR: ['ac', 'private-pool', 'kitchen', 'bathtub', 'tv', 'safe', 'minibar'],
  PD: ['ac', 'private-pool', 'kitchen', 'bathtub', 'tv', 'safe', 'workspace'],
}

const unit = (villaId: string, groupId: string | null, code: string, name: string, bedrooms: number, nightlyRate: number, status: UnitStatus = 'active'): Unit => ({
  id: `unit-${code.toLowerCase()}`,
  villaId,
  groupId,
  code,
  name,
  bedrooms,
  nightlyRate,
  status,
  amenities: AMENITIES[code.slice(0, 2)] ?? [],
})

/** Twenty units across four locations; PD-01 is closed for renovation. */
export const UNITS: readonly Unit[] = [
  ...Array.from({ length: 8 }, (_, i) => unit('vil-saka', 'grp-saka-standard', `SK-0${i + 1}`, `Saka ${i + 1}`, 1, 1_850_000)),
  unit('vil-tirta', 'grp-tirta-pool', 'TR-01', 'Tirta pool suite 1', 1, 2_400_000),
  unit('vil-tirta', 'grp-tirta-pool', 'TR-02', 'Tirta pool suite 2', 1, 2_400_000),
  unit('vil-tirta', 'grp-tirta-garden', 'TR-03', 'Tirta garden room 1', 1, 1_650_000),
  unit('vil-tirta', 'grp-tirta-garden', 'TR-04', 'Tirta garden room 2', 1, 1_650_000),
  ...Array.from({ length: 4 }, (_, i) => unit('vil-lumbung', 'grp-lumbung-loft', `LB-0${i + 1}`, `Lumbung loft ${i + 1}`, 1, 2_100_000)),
  ...Array.from({ length: 3 }, (_, i) => unit('vil-karang', 'grp-karang-cliff', `KR-0${i + 1}`, `Karang cliff villa ${i + 1}`, 2, 3_200_000)),
  unit('vil-pandawa', null, 'PD-01', 'Pandawa estate', 4, 4_500_000, 'inactive'),
]

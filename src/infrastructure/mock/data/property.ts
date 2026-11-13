import { VILLA_PROFILE_DEFAULTS, type Bed, type Location, type Unit, type UnitGroup, type UnitStatus, type UnitView, type Villa, type VillaOperation, type VillaProfile } from '@/domain/property'

export const LOCATIONS: readonly Location[] = [
  { id: 'loc-canggu', name: 'Canggu', area: 'Badung, Bali' },
  { id: 'loc-ubud', name: 'Ubud', area: 'Gianyar, Bali' },
  { id: 'loc-seminyak', name: 'Seminyak', area: 'Badung, Bali' },
  { id: 'loc-uluwatu', name: 'Uluwatu', area: 'Badung, Bali' },
]

const RULES = 'Quiet hours from 22:00 to 07:00.\nNo parties or events without written approval.\nNo smoking indoors; use the garden.\nNo glass by the pool, and children swim with an adult.\nRegistered guests only overnight.'

const profile = (p: Partial<VillaProfile & VillaOperation>): VillaProfile & VillaOperation => ({ ...VILLA_PROFILE_DEFAULTS, houseRules: RULES, ...p })

export const VILLAS: readonly Villa[] = [
  {
    id: 'vil-saka', locationId: 'loc-canggu', code: 'SK', name: 'Villa Saka', description: 'A small hotel of eight identical one-bedroom pool rooms on two floors around a shared garden, five minutes from Batu Bolong.', facilities: ['pool', 'wifi', 'parking', 'breakfast', 'security', 'garden'],
    ...profile({ address: 'Jl. Pantai Batu Bolong No. 88, Canggu, Kuta Utara, Badung, Bali 80351', lat: -8.6559, lng: 115.1306, phone: '+62 811 3801 2201', email: 'saka@balivillas.id', licenseNo: 'NIB 9120001234567', bankName: 'BCA', bankAccountNo: '7710452281', bankAccountName: 'PT Bali Villa Kelola', cancellationPolicy: 'moderate', depositKind: 'percent', depositValue: 30, operation: 'hotel', stayoverEvery: 1, depositOnCheckIn: false }),
  },
  {
    id: 'vil-tirta', locationId: 'loc-ubud', code: 'TR', name: 'Villa Tirta', description: 'Two pool suites and two garden rooms above the Ayung valley.', facilities: ['wifi', 'breakfast', 'spa', 'shuttle', 'garden', 'laundry'],
    ...profile({ address: 'Jl. Raya Sayan No. 21, Sayan, Ubud, Gianyar, Bali 80571', lat: -8.5021, lng: 115.2446, phone: '+62 811 3801 2202', email: 'tirta@balivillas.id', checkInTime: '15:00', checkOutTime: '11:00', licenseNo: 'Pondok Wisata 503/118/DPMPTSP/2024', bankName: 'Mandiri', bankAccountNo: '1450011223344', bankAccountName: 'PT Bali Villa Kelola', cancellationPolicy: 'flexible', stayoverEvery: 2 }),
  },
  {
    id: 'vil-lumbung', locationId: 'loc-seminyak', code: 'LB', name: 'Villa Lumbung', description: 'Four rice-barn lofts with a shared lap pool off Jalan Petitenget.', facilities: ['pool', 'wifi', 'parking', 'restaurant', 'security'],
    ...profile({ address: 'Jl. Petitenget No. 12A, Kerobokan Kelod, Kuta Utara, Badung, Bali 80361', lat: -8.6789, lng: 115.1554, phone: '+62 811 3801 2203', email: 'lumbung@balivillas.id', licenseNo: 'NIB 9120007654321', bankName: 'BCA', bankAccountNo: '7710452299', bankAccountName: 'PT Bali Villa Kelola', cancellationPolicy: 'strict', depositKind: 'fixed', depositValue: 1_000_000 }),
  },
  {
    id: 'vil-karang', locationId: 'loc-uluwatu', code: 'KR', name: 'Villa Karang', description: 'Three cliff-edge two-bedroom villas with private pools.', facilities: ['wifi', 'parking', 'breakfast', 'shuttle', 'security', 'gym'],
    ...profile({ address: 'Jl. Labuansait No. 7, Pecatu, Kuta Selatan, Badung, Bali 80361', lat: -8.8149, lng: 115.0884, phone: '+62 811 3801 2204', email: 'karang@balivillas.id', licenseNo: 'NIB 9120005550123', bankName: 'BNI', bankAccountNo: '0612345789', bankAccountName: 'PT Bali Villa Kelola', cancellationPolicy: 'strict', depositKind: 'percent', depositValue: 50, stayoverEvery: 1, wholeRental: true, wholeNightlyRate: 9_000_000 }),
  },
  {
    id: 'vil-pandawa', locationId: 'loc-uluwatu', code: 'PD', name: 'Villa Pandawa', description: 'One four-bedroom estate, closed for renovation until December.', facilities: ['wifi', 'parking', 'security'],
    ...profile({ address: 'Jl. Pantai Pandawa, Kutuh, Kuta Selatan, Badung, Bali 80361', lat: -8.8448, lng: 115.1867, phone: '+62 811 3801 2205', cancellationPolicy: 'non_refundable' }),
  },
]

export const GROUPS: readonly UnitGroup[] = [
  { id: 'grp-saka-standard', villaId: 'vil-saka', name: 'Saka standard', interchangeable: true, operatorAssigns: true, kind: 'room' },
  { id: 'grp-tirta-pool', villaId: 'vil-tirta', name: 'Tirta pool suites', interchangeable: true, operatorAssigns: false, kind: 'villa' },
  { id: 'grp-tirta-garden', villaId: 'vil-tirta', name: 'Tirta garden rooms', interchangeable: false, operatorAssigns: false, kind: 'villa' },
  { id: 'grp-lumbung-loft', villaId: 'vil-lumbung', name: 'Lumbung lofts', interchangeable: true, operatorAssigns: true, kind: 'villa' },
  { id: 'grp-karang-cliff', villaId: 'vil-karang', name: 'Karang cliff villas', interchangeable: false, operatorAssigns: false, kind: 'villa' },
  { id: 'grp-pandawa-estate', villaId: 'vil-pandawa', name: 'Pandawa estate', interchangeable: false, operatorAssigns: false, kind: 'villa' },
]

const AMENITIES: Record<string, readonly string[]> = {
  SK: ['ac', 'private-pool', 'kitchen', 'tv', 'safe', 'outdoor-shower'],
  TR: ['ac', 'balcony', 'tv', 'safe', 'minibar', 'bathtub'],
  LB: ['ac', 'kitchen', 'balcony', 'tv', 'workspace', 'safe'],
  KR: ['ac', 'private-pool', 'kitchen', 'bathtub', 'tv', 'safe', 'minibar'],
  PD: ['ac', 'private-pool', 'kitchen', 'bathtub', 'tv', 'safe', 'workspace'],
}

/** Beds, size and view per villa; capacity follows the beds. */
const SETUP: Record<string, { beds: Bed[]; maxAdults: number; maxChildren: number; sizeSqm: number; view: UnitView; extraBeds: number; extraBedRate: number }> = {
  SK: { beds: [{ type: 'king', count: 1 }], maxAdults: 2, maxChildren: 1, sizeSqm: 55, view: 'pool', extraBeds: 1, extraBedRate: 350_000 },
  TR: { beds: [{ type: 'king', count: 1 }, { type: 'sofa_bed', count: 1 }], maxAdults: 2, maxChildren: 2, sizeSqm: 60, view: 'jungle', extraBeds: 2, extraBedRate: 400_000 },
  LB: { beds: [{ type: 'queen', count: 1 }, { type: 'single', count: 1 }], maxAdults: 3, maxChildren: 1, sizeSqm: 48, view: 'rice_field', extraBeds: 1, extraBedRate: 300_000 },
  KR: { beds: [{ type: 'king', count: 1 }, { type: 'twin', count: 1 }], maxAdults: 4, maxChildren: 2, sizeSqm: 140, view: 'ocean', extraBeds: 2, extraBedRate: 450_000 },
  PD: { beds: [{ type: 'king', count: 2 }, { type: 'queen', count: 1 }, { type: 'bunk', count: 1 }], maxAdults: 8, maxChildren: 4, sizeSqm: 420, view: 'ocean', extraBeds: 2, extraBedRate: 500_000 },
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
  ...(SETUP[code.slice(0, 2)] ?? SETUP.SK!),
  // The garden rooms look onto the garden, not the valley.
  ...(code === 'TR-03' || code === 'TR-04' ? { view: 'garden' as const, sizeSqm: 38 } : {}),
  photos: [],
  // Saka's hotel rooms: four on the ground floor, four upstairs.
  floor: code.startsWith('SK-') ? (Number(code.slice(3)) <= 4 ? 'G' : '1') : '',
  statusReason: status === 'inactive' ? 'Closed for renovation' : '',
  statusUntil: null,
})

/** Twenty units across four locations: Saka is a hotel of eight rooms, the rest are villas; PD-01 is closed for renovation. */
export const UNITS: readonly Unit[] = [
  ...Array.from({ length: 8 }, (_, i) => unit('vil-saka', 'grp-saka-standard', `SK-0${i + 1}`, `Saka ${i + 1}`, 1, 1_850_000)),
  unit('vil-tirta', 'grp-tirta-pool', 'TR-01', 'Tirta pool suite 1', 1, 2_400_000),
  unit('vil-tirta', 'grp-tirta-pool', 'TR-02', 'Tirta pool suite 2', 1, 2_400_000),
  unit('vil-tirta', 'grp-tirta-garden', 'TR-03', 'Tirta garden room 1', 1, 1_650_000),
  unit('vil-tirta', 'grp-tirta-garden', 'TR-04', 'Tirta garden room 2', 1, 1_650_000),
  ...Array.from({ length: 4 }, (_, i) => unit('vil-lumbung', 'grp-lumbung-loft', `LB-0${i + 1}`, `Lumbung loft ${i + 1}`, 1, 2_100_000)),
  ...Array.from({ length: 3 }, (_, i) => unit('vil-karang', 'grp-karang-cliff', `KR-0${i + 1}`, `Karang cliff villa ${i + 1}`, 2, 3_200_000)),
  unit('vil-pandawa', 'grp-pandawa-estate', 'PD-01', 'Pandawa estate', 4, 4_500_000, 'inactive'),
]

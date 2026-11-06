import { namedFile } from '@/domain/attachment'
import type { Booking } from '@/domain/booking'
import { HOME_COUNTRY, NO_PREFERENCES, type CompanionInput, type ForeignReport, type Guest, type GuestPreferences, type IdType, type Sex, type StayCompanion, type VipLevel, type VisaType } from '@/domain/guest'
import type { LostEvent, LostItem, LostReturn, LostStatus } from '@/domain/lostFound'
import { addDays, type IsoDate } from '@/lib/dates'

export interface GuestSeed {
  id: string
  name: string
  email: string
  phone: string
  /** ISO country code. */
  nationality: string
  idType: IdType
  idNumber: string
  idExpiry: string
  birthDate: string
  sex: Sex
  birthPlace: string
  /** Foreign guests only; the state dates the entry the day before their stay. */
  visaType: VisaType | null
  entryPort: string
  notes: string
  preferences: GuestPreferences
  vipLevel: VipLevel
  vipReason: string
  tags: readonly string[]
  blacklist: { reason: string; setBy: string; daysAgo: number } | null
  createdDaysAgo: number
}

const DPS = 'Ngurah Rai (DPS)'
type Doc = [sex: Sex, birthDate: string, birthPlace: string, idExpiry: string, visa: VisaType | null]

const guest = (n: number, name: string, nationality: string, phone: string, idType: IdType, idNumber: string, createdDaysAgo: number, doc: Doc, more: Partial<GuestSeed> = {}): GuestSeed => ({
  id: `g-${String(n).padStart(2, '0')}`,
  name,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`,
  phone,
  nationality,
  idType,
  idNumber,
  sex: doc[0],
  birthDate: doc[1],
  birthPlace: doc[2],
  idExpiry: doc[3],
  visaType: doc[4],
  entryPort: doc[4] ? DPS : '',
  notes: '',
  preferences: NO_PREFERENCES,
  vipLevel: 0,
  vipReason: '',
  tags: [],
  blacklist: null,
  createdDaysAgo,
  ...more,
})

const prefs = (p: Partial<GuestPreferences>): GuestPreferences => ({ ...NO_PREFERENCES, ...p })

export const GUESTS: readonly GuestSeed[] = [
  guest(1, 'Hannah Weiss', 'DE', '+49 170 2231 884', 'passport', 'C7K2L9X41', 140, ['female', '1988-03-14', 'Munich', '2031-05-20', 'evoa'], { notes: 'Prefers a quiet unit away from the pool pump.', preferences: prefs({ roomLocation: 'Away from the pool pump', pillow: 'Firm' }), tags: ['Returning', 'Quiet'] }),
  guest(2, "Liam O'Connor", 'IE', '+353 86 221 0934', 'passport', 'PX8821043', 131, ['male', '1991-07-02', 'Cork', '2029-11-08', 'voa']),
  guest(3, 'Putri Anjani', 'ID', '+62 812 3344 5566', 'ktp', '5171024503920002', 126, ['female', '1992-03-05', 'Denpasar', '2099-12-31', null], { notes: 'Returning guest, books for family weekends.', tags: ['Returning', 'Family'] }),
  guest(4, 'Sato Yuki', 'JP', '+81 90 1122 3344', 'passport', 'TK4471182', 122, ['female', '1985-11-21', 'Osaka', '2030-02-14', 'free'], { preferences: prefs({ dietary: 'No raw fish at breakfast', bedSetup: 'Twin beds' }) }),
  guest(5, 'Mateo Álvarez', 'ES', '+34 612 445 778', 'passport', 'XDA442110', 118, ['male', '1979-06-30', 'Sevilla', '2028-09-01', 'voa']),
  guest(6, 'Chloe Martin', 'FR', '+33 6 12 34 56 78', 'passport', '19FV55213', 115, ['female', '1994-01-17', 'Lyon', '2029-04-03', 'evoa'], { preferences: prefs({ celebrations: 'Anniversary on 12 May' }) }),
  guest(7, 'Ravi Menon', 'IN', '+91 98450 12345', 'passport', 'N8812345', 110, ['male', '1983-09-09', 'Kochi', '2032-01-25', 'evoa'], { preferences: prefs({ dietary: 'Vegetarian' }) }),
  guest(8, 'Emma Lindqvist', 'SE', '+46 70 123 45 67', 'passport', '88123456', 104, ['female', '1990-12-12', 'Uppsala', '2030-08-19', 'voa']),
  guest(9, 'Daniel Park', 'KR', '+82 10 2345 6789', 'passport', 'M12345678', 101, ['male', '1987-04-26', 'Busan', '2031-03-30', 'voa']),
  guest(10, 'Olivia Brown', 'AU', '+61 412 345 678', 'passport', 'PA1234567', 98, ['female', '1993-08-08', 'Perth', '2033-06-11', 'voa'], { notes: 'Surf trips, asks for early board storage.', preferences: prefs({ allergies: 'Peanuts, carries an EpiPen', roomLocation: 'Ground floor' }), tags: ['Surfer'] }),
  guest(11, 'Budi Santoso', 'ID', '+62 813 9988 7766', 'ktp', '3171012209880001', 95, ['male', '1988-09-22', 'Jakarta', '2099-12-31', null], { vipLevel: 1, vipReason: 'Corporate client, books staff retreats', tags: ['Corporate'] }),
  guest(12, 'Nadia Rahman', 'MY', '+60 12 345 6789', 'passport', 'A12345678', 90, ['female', '1996-02-29', 'Kuala Lumpur', '2028-12-05', 'free'], { preferences: prefs({ dietary: 'Halal' }) }),
  guest(13, 'Lucas Ferreira', 'BR', '+55 11 91234 5678', 'passport', 'FP123456', 86, ['male', '1989-10-10', 'São Paulo', '2029-07-07', 'voa']),
  guest(14, 'Mia Tan', 'SG', '+65 9123 4567', 'passport', 'E1234567K', 80, ['female', '1991-05-15', 'Singapore', '2030-10-21', 'free']),
  guest(15, 'Jonas Becker', 'DE', '+49 151 2345 6789', 'kitas', '2C11JE1234-AB', 77, ['male', '1982-02-02', 'Hamburg', '2027-08-31', 'kitas'], { notes: 'Lives in Canggu on a KITAS; books for visiting family.', tags: ['Resident'] }),
  guest(16, 'Sarah Cohen', 'US', '+1 415 555 0134', 'passport', '541234567', 74, ['female', '1984-12-03', 'San Francisco', '2031-09-14', 'evoa'], { vipLevel: 2, vipReason: 'Travel writer, reviewed us in 2025', preferences: prefs({ pillow: 'Feather', celebrations: 'Birthday on 3 December' }), tags: ['Press'] }),
  guest(17, 'Wei Zhang', 'CN', '+86 138 0013 8000', 'passport', 'E12345678', 69, ['male', '1986-06-18', 'Shanghai', '2029-03-22', 'voa']),
  guest(18, 'Isabella Rossi', 'IT', '+39 320 123 4567', 'passport', 'YA1234567', 63, ['female', '1997-07-27', 'Florence', '2032-04-16', 'evoa'], { preferences: prefs({ allergies: 'Shellfish', dietary: 'Pescatarian' }) }),
  guest(19, 'Noah Williams', 'GB', '+44 7700 900123', 'passport', '123456789', 58, ['male', '1980-01-30', 'Bristol', '2030-12-01', 'voa'], { vipLevel: 3, vipReason: 'Owner’s family friend', preferences: prefs({ bedSetup: 'King, extra cot', roomLocation: 'Ocean view' }), tags: ['Owner guest'] }),
  guest(20, 'Ayu Lestari', 'ID', '+62 811 2233 4455', 'ktp', '5103014107950003', 52, ['female', '1995-07-01', 'Gianyar', '2099-12-31', null]),
  guest(21, 'Felix Andersen', 'DK', '+45 20 12 34 56', 'passport', '200123456', 47, ['male', '1992-11-11', 'Aarhus', '2031-02-28', 'voa']),
  guest(22, 'Amara Okafor', 'NG', '+234 803 123 4567', 'passport', 'A01234567', 40, ['female', '1990-04-04', 'Lagos', '2029-05-17', 'b211'], { notes: 'On a B211 business visa for a two-month project.' }),
  guest(23, 'Thomas Dubois', 'FR', '+33 7 98 76 54 32', 'passport', '21AB11223', 33, ['male', '1987-08-19', 'Bordeaux', '2030-01-09', 'voa']),
  guest(24, 'Grace Kim', 'US', '+1 212 555 0199', 'passport', '598765432', 21, ['female', '1998-09-23', 'New York', '2033-03-03', 'evoa'], { preferences: prefs({ celebrations: 'Honeymoon' }), tags: ['Honeymoon'] }),
]

/** Profiles without seeded stays: a blacklisted guest and a duplicate of Sarah Cohen to merge. Kept apart so the stay rotation over GUESTS does not move. */
export const EXTRA_GUESTS: readonly GuestSeed[] = [
  guest(25, 'Marco Bianchi', 'IT', '+39 333 555 0101', 'passport', 'YB7654321', 160, ['male', '1975-05-05', 'Milan', '2030-06-30', 'voa'], { notes: 'Held a party for 40 people in a two-bedroom villa; neighbours called the banjar.', blacklist: { reason: 'Unauthorised party and damage to the pool deck, July', setBy: 'Kadek Ariani', daysAgo: 110 }, tags: ['Damage'] }),
  { ...guest(26, 'Sarah Cohen', 'US', '+1 (415) 555-0134', 'passport', '', 9, ['female', '1984-12-03', '', '2031-09-14', 'evoa']), email: 's.cohen@example.com', notes: 'Created from an enquiry form; likely the same Sarah Cohen.' },
]

/** Who else stays with a seeded guest: on their stay in house, else their next or latest stay. */
export const COMPANION_SEEDS: ReadonlyArray<{ guestId: string; companions: ReadonlyArray<Omit<CompanionInput, 'entryDate'>> }> = [
  { guestId: 'g-01', companions: [{ name: 'Lukas Weiss', adult: true, nationality: 'DE', idType: 'passport', idNumber: 'C8L3M1Y52', idExpiry: '2030-10-02', birthDate: '1986-06-02', sex: 'male', birthPlace: 'Munich', entryPort: DPS, visaType: 'evoa', addressInIndonesia: '' }] },
  {
    guestId: 'g-10',
    companions: [
      { name: 'Jack Brown', adult: true, nationality: 'AU', idType: 'passport', idNumber: 'PA7654321', idExpiry: '2032-02-17', birthDate: '1992-01-19', sex: 'male', birthPlace: 'Perth', entryPort: DPS, visaType: 'voa', addressInIndonesia: '' },
      { name: 'Ruby Brown', adult: false, nationality: 'AU', idType: 'passport', idNumber: 'PA7654322', idExpiry: '2029-02-17', birthDate: '2019-03-03', sex: 'female', birthPlace: 'Perth', entryPort: DPS, visaType: 'voa', addressInIndonesia: '' },
    ],
  },
  { guestId: 'g-04', companions: [{ name: 'Kenji Sato', adult: true, nationality: 'JP', idType: 'passport', idNumber: 'TK5582293', idExpiry: '2031-07-07', birthDate: '1983-02-11', sex: 'male', birthPlace: 'Osaka', entryPort: DPS, visaType: 'free', addressInIndonesia: '' }] },
]

interface LostSeed {
  foundDaysAgo: number
  villaId: string
  unitCode: string | null
  where: string
  description: string
  foundBy: string
  /** Links the item to this guest's latest stay that started. */
  stayOf: string | null
  storage: string
  status: LostStatus
  photo: string | null
  returned?: LostReturn
  note?: string
}

export const LOST_ITEM_SEEDS: readonly LostSeed[] = [
  { foundDaysAgo: 1, villaId: 'vil-saka', unitCode: 'SK-02', where: 'Bedside drawer', description: 'Silver bracelet with a turtle charm', foundBy: 'Wayan Sudiarta', stayOf: 'g-06', storage: '', status: 'found', photo: 'bracelet-sk02.jpg' },
  { foundDaysAgo: 4, villaId: 'vil-tirta', unitCode: 'TR-01', where: 'Bathroom shelf', description: 'Black Kindle e-reader in a grey case', foundBy: 'Wayan Sudiarta', stayOf: 'g-08', storage: 'Tirta office safe, shelf B', status: 'contacted', photo: 'kindle-tr01.jpg', note: 'Emailed the guest; she asks for a courier to Stockholm.' },
  { foundDaysAgo: 9, villaId: 'vil-karang', unitCode: 'KR-01', where: 'Under the sun lounger by the pool', description: 'Tortoiseshell sunglasses', foundBy: 'Wayan Sudiarta', stayOf: 'g-19', storage: '', status: 'returned', photo: null, returned: { method: 'courier', to: 'Noah Williams', courier: 'DHL Express', tracking: 'JD014600003318' } },
  { foundDaysAgo: 22, villaId: 'vil-lumbung', unitCode: null, where: 'Lap pool changing area', description: 'Blue kids’ swim shorts and goggles', foundBy: 'Wayan Sudiarta', stayOf: null, storage: 'Lumbung linen room, lost property box', status: 'stored', photo: null },
  { foundDaysAgo: 96, villaId: 'vil-saka', unitCode: 'SK-06', where: 'Wardrobe', description: 'Straw beach hat', foundBy: 'Wayan Sudiarta', stayOf: null, storage: 'Saka store room, lost property box', status: 'stored', photo: null },
  { foundDaysAgo: 130, villaId: 'vil-tirta', unitCode: 'TR-03', where: 'Garden terrace', description: 'Three paperback novels', foundBy: 'Wayan Sudiarta', stayOf: null, storage: '', status: 'donated', photo: null, note: 'Given to the Ubud community library after the holding period.' },
]

const REPORTER = 'Dian Permata'

/**
 * Guest profiles, stay companions, Immigration reports and lost and found items for one `today`.
 * Foreign guests entered Indonesia the day before their current, next or latest stay. Every foreign stay
 * that checked in was reported the same evening, except two in house since before yesterday, left for the desk.
 */
export function seedGuests(today: IsoDate, bookings: readonly Booking[], unitIdOf: (code: string) => string) {
  const day = (offset: number) => addDays(today, offset)
  const started = (b: Booking) => b.status === 'checked_in' || b.status === 'checked_out'
  const tripOf = (guestId: string) => {
    const mine = bookings.filter((b) => b.guestId === guestId)
    return mine.find((b) => b.status === 'checked_in') ?? mine.filter((b) => b.status === 'confirmed').sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] ?? mine.filter(started).sort((a, b) => b.checkIn.localeCompare(a.checkIn))[0] ?? null
  }
  const guests: Guest[] = [...GUESTS, ...EXTRA_GUESTS].map(({ createdDaysAgo, blacklist, ...g }) => {
    const trip = tripOf(g.id)
    return {
      ...g,
      tags: [...g.tags],
      entryDate: g.nationality === HOME_COUNTRY ? null : trip ? addDays(trip.checkIn, -1) : day(-createdDaysAgo),
      addressInIndonesia: g.idType === 'kitas' ? 'Jl. Pantai Berawa 12, Canggu' : '',
      blacklist: blacklist ? { reason: blacklist.reason, setBy: blacklist.setBy, setOn: day(-blacklist.daysAgo) } : null,
      createdOn: day(-createdDaysAgo),
    }
  })
  const foreign = new Set(guests.filter((g) => g.nationality !== HOME_COUNTRY).map((g) => g.id))

  let companionSeq = 1
  const companions: StayCompanion[] = COMPANION_SEEDS.flatMap(({ guestId, companions: list }) => {
    const stay = tripOf(guestId)
    return stay ? list.map((c) => ({ ...c, id: `cmp-${companionSeq++}`, bookingId: stay.id, entryDate: addDays(stay.checkIn, -1) })) : []
  })

  const reported = bookings.filter((b) => started(b) && b.checkedInOn && foreign.has(b.guestId)).sort((a, b) => a.code.localeCompare(b.code))
  const left = new Set(reported.filter((b) => b.status === 'checked_in' && (b.checkedInOn ?? today) < day(-1)).slice(0, 2).map((b) => b.id))
  let reportSeq = 1
  const foreignReports: ForeignReport[] = reported
    .filter((b) => !left.has(b.id))
    .flatMap((b) =>
      [b.guestId, ...companions.filter((c) => c.bookingId === b.id && c.adult && c.nationality !== HOME_COUNTRY).map((c) => c.id)].map((personId) => ({
        id: `fr-${reportSeq++}`,
        bookingId: b.id,
        personId,
        reportedAt: `${b.checkedInOn}T19:30:00`,
        reportedBy: REPORTER,
        reference: `APOA-${(b.checkedInOn ?? '').replace(/-/g, '')}-${b.code.slice(3)}`,
      })),
    )

  const latestStay = (guestId: string) => bookings.filter((b) => b.guestId === guestId && started(b)).sort((a, b) => b.checkIn.localeCompare(a.checkIn))[0] ?? null
  const lostItems: LostItem[] = LOST_ITEM_SEEDS.map((x, i) => {
    const foundOn = day(-x.foundDaysAgo)
    const stay = x.stayOf ? latestStay(x.stayOf) : null
    const at = `${foundOn}T11:00:00`
    const history: LostEvent[] = [{ status: 'found', by: x.foundBy, at, note: '' }]
    const movedOn = day(Math.min(0, -x.foundDaysAgo + (x.status === 'donated' ? 92 : 1)))
    if (x.status !== 'found') history.push({ status: x.status, by: x.status === 'stored' ? x.foundBy : REPORTER, at: `${movedOn}T15:00:00`, note: x.note ?? '' })
    return {
      id: `lf-${i + 1}`,
      number: `LF-${String(i + 1).padStart(3, '0')}`,
      foundOn,
      villaId: x.villaId,
      unitId: x.unitCode ? unitIdOf(x.unitCode) : null,
      where: x.where,
      description: x.description,
      photos: x.photo ? [namedFile(x.photo, x.foundBy, at)] : [],
      foundBy: x.foundBy,
      guestId: stay?.guestId ?? null,
      bookingId: stay?.id ?? null,
      storage: x.storage,
      status: x.status,
      returned: x.returned ?? null,
      history,
    }
  })

  return { guests, companions, foreignReports, lostItems, next: { guest: guests.length + 1, companion: companionSeq, foreignReport: reportSeq, lostItem: lostItems.length + 1 } }
}


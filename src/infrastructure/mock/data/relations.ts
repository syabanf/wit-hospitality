import type { Booking } from '@/domain/booking'
import type { Catalog } from '@/domain/property'
import type { BoxRental, Complaint, Incident, SafeBox } from '@/domain/relations'
import { addDays, maxIso, type IsoDate } from '@/lib/dates'

/** A folio posting guest relations asked billing for, before the state turns it into a FolioPosting. */
export interface RelationsPosting {
  booking: Booking
  kind: 'credit' | 'charge'
  amount: number
  description: string
  by: string
  /** `YYYY-MM-DDTHH:MM:SS`. */
  at: string
}

interface Ctx {
  today: IsoDate
  catalog: Catalog
  /** Stays in house today, by booking code. */
  inHouse: readonly Booking[]
  signer: { desk: string; manager: string }
  guestName: (id: string) => string
}

const pad = (n: number) => String(n).padStart(3, '0')

/**
 * Four complaints across the statuses (one credit posted, one filed from the stay page), two incidents
 * (one damage charged, one medical signed off) and safe boxes at Saka and one villa, two in use.
 */
export function seedRelations({ today, catalog, inHouse, signer, guestName }: Ctx) {
  const at = (offset: number, time: string) => `${addDays(today, offset)}T${time}`
  /** A time during the stay: the day clamps to its check-in. */
  const during = (b: Booking, offset: number, time: string) => `${maxIso(addDays(today, offset), b.checkedInOn ?? b.checkIn)}T${time}`
  const villaOf = (b: Booking) => catalog.unit(b.unitId).villaId
  const stay = (code: string) => {
    const b = inHouse.find((x) => x.code === code)
    if (!b) throw new Error(`The relations seed needs ${code} in house`)
    return b
  }
  // The credit goes on a stay whose open charges cover it; the damage on a direct villa stay.
  const [credited, paged, swept, transfer, damaged] = ['BK-1294', 'BK-1298', 'BK-1306', 'BK-1303', 'BK-1297'].map(stay) as [Booking, Booking, Booking, Booking, Booking]
  const postings: RelationsPosting[] = []

  const complaint = (n: number, b: Booking, fields: Partial<Complaint> & Pick<Complaint, 'category' | 'severity' | 'description' | 'receivedAt' | 'status'>): Complaint => ({
    id: `cpl-${n}`,
    number: `CP-${pad(n)}`,
    villaId: villaOf(b),
    unitId: b.unitId,
    bookingId: b.id,
    guestId: b.guestId,
    receivedBy: signer.desk,
    owner: signer.manager,
    source: 'desk',
    resolution: null,
    compensation: null,
    links: [],
    timeline: [{ at: `${fields.receivedAt}:00`, by: signer.desk, kind: 'logged', note: '', ref: null }],
    ...fields,
  })

  const credit = complaint(1, credited, { category: 'room', severity: 'medium', status: 'resolved', description: 'The air conditioning in the master bedroom stopped at night; the room was hot until morning.', receivedAt: during(credited, -1, '08:10') })
  const resolvedAt = during(credited, -1, '15:30:00')
  credit.resolution = { action: 'Technician replaced the capacitor the same morning; manager apologised in person.', by: signer.manager, at: resolvedAt }
  credit.compensation = { kind: 'folio_credit', amount: 150_000, description: 'One night of air conditioning trouble', status: 'posted', decidedBy: signer.manager, decidedAt: resolvedAt }
  credit.timeline.push({ at: resolvedAt, by: signer.manager, kind: 'resolved', note: credit.resolution.action, ref: null }, { at: resolvedAt, by: signer.manager, kind: 'compensation', note: 'Credit of 150000 posted to the folio', ref: null })
  postings.push({ booking: credited, kind: 'credit', amount: 150_000, description: `Compensation for ${credit.number}: ${credit.compensation.description}`, by: signer.manager, at: resolvedAt })

  const fromPage = complaint(2, paged, { category: 'noise', severity: 'high', status: 'open', source: 'stay_page', receivedBy: 'Guest', owner: 'Front desk', description: 'Loud music from the next room until after midnight, two nights running.', receivedAt: at(0, '00:40') })
  fromPage.timeline = [{ at: `${fromPage.receivedAt}:00`, by: 'Guest', kind: 'logged', note: '', ref: null }]

  const working = complaint(3, swept, { category: 'cleanliness', severity: 'low', status: 'in_progress', description: 'Sand left on the pool deck and the outdoor shower drain is slow.', receivedAt: at(0, '09:15') })
  working.timeline.push({ at: at(0, '09:20:00'), by: signer.desk, kind: 'status', note: 'Open to in progress: asked housekeeping to sweep and maintenance to clear the drain', ref: null })

  const closed = complaint(4, transfer, { category: 'service', severity: 'low', status: 'closed', description: 'Airport pickup arrived twenty minutes late.', receivedAt: during(transfer, -3, '19:05') })
  const closedAt = during(transfer, -3, '21:00:00')
  closed.resolution = { action: 'Spoke with the transport partner; the guest accepted the apology.', by: signer.desk, at: during(transfer, -3, '20:00:00') }
  closed.compensation = { kind: 'goodwill', amount: 0, description: 'Fruit platter and a handwritten note', status: 'given', decidedBy: null, decidedAt: null }
  closed.timeline.push(
    { at: closed.resolution.at, by: signer.desk, kind: 'resolved', note: closed.resolution.action, ref: null },
    { at: closed.resolution.at, by: signer.desk, kind: 'compensation', note: 'Goodwill gesture: Fruit platter and a handwritten note', ref: null },
    { at: closedAt, by: signer.manager, kind: 'status', note: 'Resolved to closed', ref: null },
  )

  const damageAt = during(damaged, -1, '18:20')
  const damage: Incident = {
    id: 'inc-1',
    number: 'IN-001',
    kind: 'damage',
    severity: 'medium',
    villaId: villaOf(damaged),
    unitId: damaged.unitId,
    area: 'Living room',
    occurredAt: damageAt,
    bookingId: damaged.id,
    people: [{ kind: 'guest', name: guestName(damaged.guestId), guestId: damaged.guestId, note: 'Reported it to the desk' }],
    description: 'A floor lamp fell and cracked the glass coffee table top.',
    actions: 'Cleared the glass, moved the table out, ordered a new top.',
    policeCalled: false,
    doctorCalled: false,
    policeReport: '',
    attachments: [],
    reportedBy: signer.desk,
    status: 'follow_up',
    timeline: [
      { at: `${damageAt}:00`, by: signer.desk, kind: 'logged', note: '' },
      { at: at(0, '08:30:00'), by: signer.manager, kind: 'charge', note: `Charged 750000 to ${damaged.code}: Cracked glass coffee table top` },
    ],
    charge: { amount: 750_000, reason: 'Cracked glass coffee table top', bookingId: damaged.id, by: signer.manager, at: at(0, '08:30:00') },
    signOff: null,
  }
  postings.push({ booking: damaged, kind: 'charge', amount: 750_000, description: 'Damage, IN-001: Cracked glass coffee table top', by: signer.manager, at: at(0, '08:30:00') })

  const medicalAt = at(-4, '16:45')
  const medical: Incident = {
    id: 'inc-2',
    number: 'IN-002',
    kind: 'medical',
    severity: 'high',
    villaId: 'vil-saka',
    unitId: null,
    area: 'Pool deck',
    occurredAt: medicalAt,
    bookingId: null,
    people: [
      { kind: 'guest', name: 'Guest of SK-03', guestId: null, note: 'Slipped on the wet steps, cut on the knee' },
      { kind: 'staff', name: signer.desk, guestId: null, note: 'First aid' },
    ],
    description: 'A guest slipped on the pool steps and cut a knee.',
    actions: 'First aid at the pool, the on-call doctor dressed the cut, wet-floor signs placed on the steps.',
    policeCalled: false,
    doctorCalled: true,
    policeReport: '',
    attachments: [],
    reportedBy: signer.desk,
    status: 'closed',
    timeline: [
      { at: `${medicalAt}:00`, by: signer.desk, kind: 'logged', note: '' },
      { at: at(-3, '10:00:00'), by: signer.desk, kind: 'follow_up', note: 'Guest is fine; anti-slip strips ordered for the steps.' },
      { at: at(-2, '11:00:00'), by: signer.manager, kind: 'closed', note: 'Strips fitted on all pool steps.' },
    ],
    charge: null,
    signOff: { by: signer.manager, at: at(-2, '11:00:00'), note: 'Strips fitted on all pool steps.' },
  }

  const safeBoxes: SafeBox[] = [
    ...['1', '2', '3', '4'].map((number, i): SafeBox => ({ id: `box-${i + 1}`, villaId: 'vil-saka', number, size: i < 3 ? 'small' : 'large', status: i === 3 ? 'out_of_order' : 'free', note: i === 3 ? 'Lock jammed, locksmith booked' : '' })),
    ...['1', '2'].map((number, i): SafeBox => ({ id: `box-${i + 5}`, villaId: 'vil-lumbung', number, size: 'medium', status: 'free', note: '' })),
  ]
  const boxRentals: BoxRental[] = []
  const rent = (box: SafeBox, b: Booking, items: string, keyNumber: string) => {
    const n = boxRentals.length + 1
    const openedAt = `${b.checkedInOn ?? b.checkIn}T15:10:00`
    box.status = 'in_use'
    boxRentals.push({ id: `bxr-${n}`, number: `SB-${pad(n)}`, boxId: box.id, villaId: box.villaId, bookingId: b.id, guestId: b.guestId, items, keyNumber, status: 'open', openedAt, openedBy: signer.desk, closedAt: null, closedBy: null, keyReturned: null, keyFee: 0, log: [{ kind: 'open', at: openedAt, by: signer.desk, signature: 'paper', signatureData: '', note: '' }] })
  }
  const [sakaBox, villaBox] = [safeBoxes[0]!, safeBoxes[4]!]
  rent(sakaBox, stay('BK-1301'), 'Passports, a watch in its box', 'K-01')
  rent(villaBox, stay('BK-1304'), 'Envelope of cash, two passports', 'V-01')

  return { complaints: [credit, fromPage, working, closed], incidents: [damage, medical], safeBoxes, boxRentals, postings, next: { complaint: 5, incident: 3, safeBox: safeBoxes.length + 1, boxRental: boxRentals.length + 1 } }
}

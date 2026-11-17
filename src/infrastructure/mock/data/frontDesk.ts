import type { Booking } from '@/domain/booking'
import { departureOf, newKey, type KeyHanded, type RegistrationCard, type StayKey } from '@/domain/frontDesk'
import { unitKindOf, type Catalog } from '@/domain/property'
import { addDays } from '@/lib/dates'

const DESK = 'Wayan Sudiarta'

/** A signature drawn on the desk's tablet: a small SVG scribble, so the card shows ink without an upload. */
const SIGNATURE_URL = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><path d="M10 60 C 30 10, 50 10, 60 50 S 90 70, 110 30 S 150 20, 160 55 S 200 60, 230 25" fill="none" stroke="#101112" stroke-width="3" stroke-linecap="round"/></svg>')}`

const at = (date: string, time: string) => `${date}T${time}:00`

function cardFor(b: Booking, i: number): RegistrationCard {
  const signedAt = at(b.checkIn, '14:02')
  return i % 3 === 2
    ? { method: 'paper', signature: null, cardNumber: `RC-${4100 + i}`, signedAt, by: DESK, where: 'desk' }
    : { method: 'screen', signature: { id: `sig-${b.id}`, name: 'signature.png', type: 'image/svg+xml', size: 420, url: SIGNATURE_URL, uploadedBy: i % 3 === 1 ? 'Guest' : DESK, uploadedAt: signedAt }, cardNumber: '', signedAt, by: i % 3 === 1 ? 'Guest' : DESK, where: i % 3 === 1 ? 'precheckin' : 'desk' }
}

/**
 * Signed cards on the stays in house where the property asks for them, the keys handed out and back, one early
 * check-in on tomorrow's villa arrival, and wake-up calls for tomorrow morning.
 */
export function seedFrontDesk(bookings: Booking[], catalog: Catalog, today: string) {
  const villaOf = (b: Booking) => catalog.place(b.unitId).villa
  const tomorrow = addDays(today, 1)
  const byArrival = (x: Booking, y: Booking) => x.checkIn.localeCompare(y.checkIn) || x.code.localeCompare(y.code)
  const inHouse = bookings.filter((b) => b.status === 'checked_in' && b.unitAssigned).sort(byArrival)

  inHouse
    .filter((b) => villaOf(b).requireRegistrationCard)
    .forEach((b, i) => {
      b.registrationCard = cardFor(b, i)
    })

  // Keys: a card per room, a key and the gate code per villa; the first room lost its card and has a new one.
  const handed = (b: Booking): KeyHanded[] => {
    const unit = catalog.unit(b.unitId)
    const digits = unit.code.replace(/\D/g, '').padStart(2, '0')
    return unitKindOf(catalog, b.unitId) === 'room'
      ? [{ number: `C-${digits}01`, kind: 'card' }]
      : [
          { number: `${unit.code}-K1`, kind: 'key' },
          { number: `Gate ${digits}${digits}`, kind: 'code' },
        ]
  }
  const issue = (b: Booking, closed: StayKey['status'] | null) => {
    const keys: StayKey[] = []
    for (const k of handed(b)) keys.push(newKey(keys, k, 'check_in', null, DESK, at(b.checkIn, '14:05')))
    b.keys = closed ? keys.map((k) => ({ ...k, status: closed, closedAt: at(b.checkOut, '11:40'), closedBy: DESK })) : keys
    if (b.arrival) b.arrival = { ...b.arrival, keys: handed(b) }
  }
  for (const b of inHouse) issue(b, null)
  for (const b of bookings.filter((x) => x.status === 'checked_out' && x.checkOut >= addDays(today, -3))) issue(b, 'returned')

  const lostRoom = inHouse.find((b) => unitKindOf(catalog, b.unitId) === 'room')
  const lost = lostRoom?.keys?.[0]
  if (lostRoom && lost) {
    const reported = at(addDays(today, -1), '21:15')
    lostRoom.keys = [{ ...lost, status: 'lost', closedAt: reported, closedBy: DESK }, newKey(lostRoom.keys ?? [], { number: lost.number.replace(/01$/, '02'), kind: 'card' }, 'replacement', lost.id, DESK, reported)]
  }
  const extraRoom = inHouse.filter((b) => unitKindOf(catalog, b.unitId) === 'room')[1]
  if (extraRoom?.keys) extraRoom.keys = [...extraRoom.keys, newKey(extraRoom.keys, { number: (extraRoom.keys[0]?.number ?? 'C-0001').replace(/01$/, '03'), kind: 'card' }, 'extra', null, DESK, at(addDays(today, -1), '16:30'))]

  // Tomorrow's first villa arrival with nobody leaving that morning comes in at 11:00, free.
  const early = bookings
    .filter((b) => b.status === 'confirmed' && b.unitAssigned && b.checkIn === tomorrow && unitKindOf(catalog, b.unitId) === 'villa' && !b.bookingGroupId)
    .sort(byArrival)
    .find((b) => departureOf(b, bookings, villaOf(b).checkOutTime) === null)
  if (early) early.earlyCheckin = { from: '11:00', charge: 0, by: 'Dian Permata', at: at(addDays(today, -2), '10:20') }

  // Wake-up calls for tomorrow on the first two rooms in house that stay past it.
  inHouse
    .filter((b) => unitKindOf(catalog, b.unitId) === 'room' && b.checkOut >= tomorrow)
    .slice(0, 2)
    .forEach((b, i) => {
      b.wakeUpCalls = [
        { id: 'wk-1', date: tomorrow, time: i === 0 ? '05:30' : '06:45', note: i === 0 ? 'Airport transfer at 06:30' : '', repeatDaily: i === 1, status: 'pending', by: DESK, at: at(addDays(today, -1), '20:10'), log: [] },
      ]
    })
}

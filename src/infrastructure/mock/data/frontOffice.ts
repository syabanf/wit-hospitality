import type { User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import type { CashierShift } from '@/domain/cashier'
import { shiftOf, type LogCategory, type LogEntry, type LogLink } from '@/domain/logBook'
import type { Payment } from '@/domain/payment'
import type { CardBrand, PreAuth } from '@/domain/preAuth'
import type { Catalog } from '@/domain/property'
import { discrepancyOf, frontOfficeStay, roomCheckId, stayPersons, type DiscrepancyAction, type FoundStatus, type RoomCheck } from '@/domain/roomCheck'
import { addDays, type IsoDate } from '@/lib/dates'

interface Sources {
  today: IsoDate
  catalog: Catalog
  bookings: readonly Booking[]
  payments: Payment[]
  shifts: CashierShift[]
  users: readonly User[]
}

/** One room on the round: the day offset, the room, what housekeeping found and how the desk settled it. */
const ROUNDS: ReadonlyArray<{ offset: number; unit: string; found: FoundStatus; persons?: number; note?: string; resolved?: { action: DiscrepancyAction; note: string } }> = [
  { offset: -1, unit: 'SK-01', found: 'occupied', persons: 1, note: 'Luggage and an open suitcase on the bed.', resolved: { action: 'housekeeping_error', note: 'The departing guest of BK-1292 came back for the bags; the room was empty by noon.' } },
  { offset: -1, unit: 'SK-03', found: 'occupied', persons: 2 },
  { offset: -1, unit: 'SK-07', found: 'occupied', persons: 2 },
  { offset: -1, unit: 'KR-03', found: 'occupied', persons: 1, resolved: { action: 'guest_out', note: 'The second guest stayed in Ubud for the night and is back today.' } },
  { offset: 0, unit: 'SK-01', found: 'vacant' },
  { offset: 0, unit: 'SK-02', found: 'occupied', persons: 2 },
  { offset: 0, unit: 'SK-03', found: 'occupied', persons: 2 },
  { offset: 0, unit: 'SK-04', found: 'vacant', note: 'Bed not slept in, no luggage, wardrobe empty.' },
  { offset: 0, unit: 'SK-05', found: 'vacant' },
  { offset: 0, unit: 'SK-06', found: 'occupied', persons: 2 },
  { offset: 0, unit: 'SK-07', found: 'occupied', persons: 2 },
  { offset: 0, unit: 'SK-08', found: 'occupied', persons: 2 },
  { offset: 0, unit: 'TR-02', found: 'occupied', persons: 2 },
  { offset: 0, unit: 'TR-03', found: 'occupied', persons: 2 },
]

interface LogSeed {
  offset: number
  time: string
  by: string
  category: LogCategory
  text: string
  link?: { kind: LogLink['kind']; code: string }
  villa?: string
  followUp?: { acknowledged?: { by: string; time: string }; done?: { by: string; time: string; note: string } }
  /** The latest closed cashier shift's handover. */
  shift?: true
}

/** A week at the desk; times are local, a night note before 07:00 belongs to the day before. */
const LOG: readonly LogSeed[] = [
  { offset: -6, time: '07:20', by: 'usr-kadek', category: 'handover', text: 'Morning desk open. Two arrivals for Saka, both checked in online. Float counted at 1.500.000.' },
  { offset: -6, time: '16:40', by: 'usr-wayan', category: 'maintenance', villa: 'vil-saka', link: { kind: 'unit', code: 'SK-05' }, text: 'Guest reported a dripping shower head in SK-05. Work order raised; the plumber comes tomorrow morning.' },
  { offset: -5, time: '01:10', by: 'usr-agus', category: 'security', villa: 'vil-saka', text: 'Night round done at 01:00. The side gate to the Saka car park was unlocked; locked it again.' },
  { offset: -5, time: '09:15', by: 'usr-sari', category: 'guest', villa: 'vil-karang', link: { kind: 'booking', code: 'KR-03' }, text: 'The guests in KR-03 asked for a birthday cake on the 12th. The kitchen has the order.' },
  { offset: -5, time: '17:30', by: 'usr-kadek', category: 'cash', text: 'The card terminal dropped two payments this afternoon. Both went through on the second try; the settlement slip is in the drawer.' },
  { offset: -4, time: '07:05', by: 'usr-wayan', category: 'handover', text: 'Took over from the night shift. Three departures today, all settled except the late check-out in Tirta.' },
  { offset: -3, time: '04:45', by: 'usr-agus', category: 'guest', villa: 'vil-saka', link: { kind: 'booking', code: 'SK-03' }, text: 'Taxi booked at 05:30 for the early flight from SK-03. Breakfast box handed over.' },
  { offset: -3, time: '10:20', by: 'usr-dian', category: 'guest', villa: 'vil-tirta', link: { kind: 'booking', code: 'TR-02' }, text: 'The guests in TR-02 asked for extra towels and a baby cot before 14:00.', followUp: { acknowledged: { by: 'Ni Luh Putu Sari', time: '11:00' }, done: { by: 'Ni Luh Putu Sari', time: '13:40', note: 'Cot set up and towels delivered at 13:30.' } } },
  { offset: -3, time: '19:10', by: 'usr-wayan', category: 'other', text: 'Printer at the desk is out of toner. A new cartridge is ordered; print registration cards from the back office meanwhile.' },
  { offset: -2, time: '08:30', by: 'usr-sari', category: 'maintenance', villa: 'vil-karang', link: { kind: 'unit', code: 'KR-01' }, text: 'The pool pump for KR-01 still waits on the part. The supplier says two more days.' },
  { offset: -2, time: '18:05', by: 'usr-wayan', category: 'cash', text: 'Dropped 3.000.000 to the safe after the afternoon check-ins.' },
  { offset: -1, time: '09:40', by: 'usr-wayan', category: 'guest', villa: 'vil-saka', link: { kind: 'booking', code: 'SK-04' }, text: 'The guest in SK-04 asked for an airport transfer tomorrow at 10:00. Confirm the driver with the transport desk.', followUp: { acknowledged: { by: 'Kadek Ariani', time: '15:10' } } },
  { offset: -1, time: '16:25', by: 'usr-agus', category: 'maintenance', villa: 'vil-saka', link: { kind: 'unit', code: 'SK-06' }, text: 'The air conditioning in SK-06 is noisy. Engineering checks it before the next arrival.' },
  { offset: -1, time: '21:50', by: 'usr-kadek', category: 'handover', shift: true, text: 'Drawer counted and matched. One deposit by transfer still to confirm with finance in the morning.' },
  { offset: 0, time: '02:30', by: 'usr-agus', category: 'security', villa: 'vil-saka', text: 'The light by the Saka car park gate is out. Ask engineering to replace it today.', followUp: {} },
  { offset: 0, time: '07:15', by: 'usr-sari', category: 'handover', text: 'Took over from the night shift. Four departures in Saka today; housekeeping has the round sheet.' },
]

/**
 * The front office controls' demo data: two days of housekeeping rounds with a resolved skip, a
 * resolved person count and today's open sleep; a card hold captured at check-out and one active;
 * a week of log book notes with two open follow-ups and the last shift's handover.
 */
export function seedFrontOffice({ today, catalog, bookings, payments, shifts, users }: Sources) {
  const day = (offset: number) => addDays(today, offset)
  const name = (id: string) => users.find((u) => u.id === id)?.name ?? id
  const unitId = (code: string) => catalog.unitByCode(code).id
  /** A unit by its code, or the stay in house there for a booking link. */
  const linkTo = (l: LogSeed['link']): LogLink | null => {
    if (!l) return null
    if (l.kind === 'unit') return { kind: 'unit', id: unitId(l.code), label: l.code }
    const b = bookings.find((x) => x.unitId === unitId(l.code) && x.status === 'checked_in')
    return b ? { kind: 'booking', id: b.id, label: b.code } : null
  }

  const roomChecks: RoomCheck[] = ROUNDS.map((r) => {
    const date = day(r.offset)
    const unit = catalog.unitByCode(r.unit)
    const stay = frontOfficeStay(bookings, unit.id, date)
    const persons = r.found === 'occupied' ? (r.persons ?? null) : null
    const frontPersons = stay ? stayPersons(stay) : null
    const discrepancy = discrepancyOf(r.found, persons, Boolean(stay), frontPersons)
    return {
      id: roomCheckId(date, unit.id),
      unitId: unit.id,
      villaId: unit.villaId,
      date,
      found: r.found,
      persons,
      note: r.note ?? '',
      checkedBy: 'Komang Dewi',
      checkedAt: `${date}T10:${r.offset === 0 ? '05' : '20'}:00`,
      frontOffice: stay ? 'occupied' : 'vacant',
      bookingId: stay?.id ?? null,
      bookingCode: stay?.code ?? null,
      frontPersons,
      discrepancy,
      resolution: discrepancy && r.resolved ? { ...r.resolved, by: 'Kadek Ariani', at: `${date}T15:40:00` } : null,
    }
  })

  const preAuths: PreAuth[] = []
  const hold = (b: Booking | undefined, fields: { amount: number; brand: CardBrand; last4: string; approvalCode: string; expiresOn: IsoDate }, closing?: Pick<PreAuth, 'captured' | 'paymentId' | 'closedAt'>) => {
    if (!b) return
    const n = preAuths.length + 1
    preAuths.push({ id: `pa-${n}`, number: `PA-${1000 + n}`, bookingId: b.id, ...fields, status: closing ? 'captured' : 'active', takenBy: 'Kadek Ariani', takenAt: `${b.checkIn}T14:20:00`, captured: closing?.captured ?? 0, paymentId: closing?.paymentId ?? null, closedBy: closing ? 'Kadek Ariani' : null, closedAt: closing?.closedAt ?? null })
  }
  // The last direct villa stay that left paid by transfer: its payment becomes the card capture.
  const left = [...bookings].reverse().find((b) => b.status === 'checked_out' && b.source === 'direct' && catalog.unit(b.unitId).villaId !== 'vil-saka' && payments.some((p) => p.bookingId === b.id && p.kind === 'full' && p.method === 'bank_transfer'))
  const paid = left && payments.find((p) => p.bookingId === left.id && p.kind === 'full' && p.method === 'bank_transfer')
  if (left && paid) {
    Object.assign(paid, { kind: 'balance', method: 'card', reference: 'A08113', note: 'Captured from PA-1001', paidOn: left.checkOut })
    hold(left, { amount: Math.ceil(paid.amount / 1_000_000) * 1_000_000, brand: 'visa', last4: '4242', approvalCode: 'A08113', expiresOn: addDays(left.checkOut, 2) }, { captured: paid.amount, paymentId: paid.id, closedAt: `${left.checkOut}T10:45:00` })
  }
  const inHouse = bookings.find((b) => b.status === 'checked_in' && b.source === 'direct' && catalog.unit(b.unitId).villaId !== 'vil-saka' && b.checkOut > today)
  if (inHouse) hold(inHouse, { amount: 5_000_000, brand: 'mastercard', last4: '4417', approvalCode: 'M52710', expiresOn: addDays(inHouse.checkOut, 2) })

  const lastClosed = [...shifts].reverse().find((sh) => sh.status === 'closed')
  const logEntries: LogEntry[] = LOG.map((e, i) => {
    const at = `${day(e.offset)}T${e.time}:00`
    const stamp = (t: { time: string }) => `${at.slice(0, 10)}T${t.time}:00`
    return {
      id: `log-${i + 1}`,
      at,
      ...shiftOf(at),
      author: name(e.by),
      authorId: e.by,
      category: e.category,
      text: e.text,
      villaId: e.villa ?? null,
      link: linkTo(e.link),
      followUp: Boolean(e.followUp),
      acknowledgedBy: e.followUp?.acknowledged?.by ?? null,
      acknowledgedAt: e.followUp?.acknowledged ? stamp(e.followUp.acknowledged) : null,
      doneBy: e.followUp?.done?.by ?? null,
      doneAt: e.followUp?.done ? stamp(e.followUp.done) : null,
      doneNote: e.followUp?.done?.note ?? '',
      shiftId: e.shift && lastClosed ? lastClosed.id : null,
    }
  })
  const handover = logEntries.find((e) => e.shiftId)
  if (lastClosed && handover) lastClosed.logEntryId = handover.id

  return { roomChecks, preAuths, logEntries, next: { preAuth: preAuths.length + 1, logEntry: logEntries.length + 1 } }
}

import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { RuleError } from '@/domain/errors'
import { effectiveHousekeeping, type HousekeepingState } from '@/domain/maintenance'
import { unitKindOf, type Catalog, type Unit } from '@/domain/property'
import { assignChoices, hotelRooms, OCCUPANCIES, roomOccupancy, type Occupancy } from '@/domain/rack'
import { floorLabel, floorRank, sectionFrom, type SectionInput } from '@/domain/section'
import type { IsoDate } from '@/lib/dates'
import type { Ports } from './ports'

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
}

export interface RackTile {
  unit: Unit
  roomType: string
  floor: string
  occupancy: Occupancy
  /** Today only: the board's state, out of service for an inactive or maintenance room. */
  housekeeping: HousekeepingState | null
  stay: { id: string; code: string; guestName: string; checkIn: IsoDate; checkOut: IsoDate } | null
  next: { id: string; code: string; guestName: string } | null
}

const count = <T extends string>(keys: readonly T[], of: (k: T) => number) => Object.fromEntries(keys.map((k) => [k, of(k)])) as Record<T, number>

/** The front desk of a hotel or mixed property: the room rack, rooms to assign, and sections. */
export function createDeskServices({ ports, today, catalog, allow }: Deps) {
  /** Properties the rack shows: those in scope that operate as hotel or mixed. */
  const hotels = (cat: Catalog) => cat.villas.filter((v) => v.operation !== 'villa')

  async function world() {
    const [cat, bookings, guests, board] = await Promise.all([catalog(), ports.booking.bookings(), ports.guest.guests(), ports.maintenance.housekeeping()])
    const guestName = (b: Pick<Booking, 'guestId'>) => guests.find((g) => g.id === b.guestId)?.name ?? ''
    const stateOf = (unitId: string): HousekeepingState => {
      const unit = cat.unit(unitId)
      return effectiveHousekeeping(board.find((h) => h.unitId === unitId), unit.status === 'maintenance', unit.status === 'inactive')
    }
    return { cat, bookings, guestName, stateOf }
  }

  return {
    /** Whether the menu shows the rack: the scope holds a hotel or mixed property. */
    async hasHotel() {
      return hotels(await catalog()).length > 0
    },

    /** The rack of one property on one date: rooms by floor, filter counts, and room-type stays still to assign. */
    async rack(villaId?: string, date: IsoDate = today()) {
      const w = await world()
      const properties = hotels(w.cat)
      const villa = properties.find((v) => v.id === villaId) ?? properties[0]
      if (!villa) throw new RuleError('NOT_FOUND', 'No hotel or mixed property is in your scope.')
      const isToday = date === today()
      const tiles: RackTile[] = hotelRooms(w.cat, villa.id).map((unit) => {
        const occ = roomOccupancy(unit.id, date, today(), w.bookings)
        return {
          unit,
          roomType: w.cat.place(unit.id).group?.name ?? '',
          floor: unit.floor.trim(),
          occupancy: occ.occupancy,
          housekeeping: isToday ? w.stateOf(unit.id) : null,
          stay: occ.stay ? { id: occ.stay.id, code: occ.stay.code, guestName: w.guestName(occ.stay), checkIn: occ.stay.checkIn, checkOut: occ.stay.checkOut } : null,
          next: occ.next ? { id: occ.next.id, code: occ.next.code, guestName: w.guestName(occ.next) } : null,
        }
      })
      const floors = [...new Set(tiles.map((t) => t.floor))].sort((a, b) => floorRank(a).localeCompare(floorRank(b))).map((floor) => ({ floor, label: floorLabel(floor), count: tiles.filter((t) => t.floor === floor).length }))
      const roomTypes = [...new Set(tiles.map((t) => t.roomType))].sort().map((name) => ({ name, count: tiles.filter((t) => t.roomType === name).length }))
      const unassigned = w.bookings
        .filter((b) => !b.unitAssigned && b.status === 'confirmed' && b.checkIn === date && w.cat.unit(b.unitId).villaId === villa.id && unitKindOf(w.cat, b.unitId) === 'room')
        .map((b) => ({ id: b.id, code: b.code, guestName: w.guestName(b), roomType: w.cat.place(b.unitId).group?.name ?? '', checkOut: b.checkOut }))
      return {
        date,
        today: today(),
        villa,
        properties,
        tiles,
        floors,
        roomTypes,
        occupancyCounts: count(OCCUPANCIES, (k) => tiles.filter((t) => t.occupancy === k).length),
        unassigned,
      }
    },

    /** Rooms of the stay's type free for its nights, the ready ones first; a room not released carries a warning. */
    async assignChoices(bookingId: string) {
      const [w, blocks] = await Promise.all([world(), ports.booking.blocks()])
      const b = w.bookings.find((x) => x.id === bookingId)
      if (!b) throw new RuleError('NOT_FOUND', 'That booking was not found.')
      return assignChoices(b, w.cat, w.bookings, blocks, w.stateOf)
    },

    async sections(villaId: string) {
      return (await ports.property.sections()).filter((x) => x.villaId === villaId)
    },
    async saveSection(id: string | null, input: SectionInput) {
      await allow('property', 'edit')
      return ports.property.saveSection(id, sectionFrom(input))
    },
    async removeSection(id: string) {
      await allow('property', 'edit')
      return ports.property.removeSection(id)
    },
  }
}

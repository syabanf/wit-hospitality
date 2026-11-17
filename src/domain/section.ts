import type { IsoDate } from '@/lib/dates'
import { unitKindOf, type Catalog, type Unit, type UnitKind, type Villa } from './property'

/**
 * A section is a named set of rooms of one hotel or mixed property; housekeeping gives a section to
 * one attendant for a day. Contract: api/docs/contracts/hotel-desk-contract.md section 3.
 */

export const MAX_SECTION_NAME = 40

export interface Section {
  id: string
  villaId: string
  name: string
  unitIds: readonly string[]
}
export type SectionInput = Omit<Section, 'id'>

export interface SectionAssignment {
  sectionId: string
  date: IsoDate
  attendantId: string
}

export class SectionHotelOnly extends Error {
  readonly code = 'SECTION_HOTEL_ONLY'
}

/**
 * validateSection. Throws SectionHotelOnly for a villa-only property, else returns field errors.
 * `kindOf` gives a unit's kind; `others` are the property's other sections.
 */
export function validateSection(input: SectionInput, villa: Pick<Villa, 'id' | 'name' | 'operation'>, units: readonly Pick<Unit, 'id' | 'code' | 'villaId'>[], kindOf: (unitId: string) => UnitKind, others: readonly Section[], current: Section | null): Record<string, string> {
  if (villa.operation === 'villa') throw new SectionHotelOnly(`Sections group hotel rooms; ${villa.name} has none.`)
  const errors: Record<string, string> = {}
  if (current && input.villaId !== current.villaId) errors.villaId = 'A section stays with its property.'
  const name = input.name.trim()
  const length = [...name].length
  if (length < 2) errors.name = 'Name the section.'
  else if (length > MAX_SECTION_NAME) errors.name = `A section name is at most ${MAX_SECTION_NAME} characters.`
  else if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) errors.name = `${name} is already a section of ${villa.name}.`
  if (input.unitIds.length === 0) errors.unitIds = 'Pick at least one room.'
  for (const id of input.unitIds) {
    const unit = units.find((u) => u.id === id)
    if (!unit || unit.villaId !== villa.id || kindOf(id) !== 'room') {
      errors.unitIds = 'Pick rooms of this property.'
      break
    }
    const holder = others.find((o) => o.unitIds.includes(id))
    if (holder) {
      errors.unitIds = `${unit.code} is already in ${holder.name}.`
      break
    }
  }
  return errors
}

/** The form as the section keeps it: the name trimmed, each room once. */
export const sectionFrom = (input: SectionInput): SectionInput => ({ villaId: input.villaId, name: input.name.trim(), unitIds: [...new Set(input.unitIds)] })

export const sectionOf = (sections: readonly Section[], unitId: string) => sections.find((s) => s.unitIds.includes(unitId)) ?? null

/** The attendant a new pending task on this room and day starts with, from its section. */
export function sectionAttendant(sections: readonly Section[], assignments: readonly SectionAssignment[], unitId: string, date: IsoDate): string | null {
  const section = sectionOf(sections, unitId)
  return (section && assignments.find((a) => a.sectionId === section.id && a.date === date)?.attendantId) || null
}

/**
 * Which tasks change hands when a section's attendant changes for a day: with an attendant, every
 * pending task of the day on its rooms that someone else or nobody holds; cleared, the pending ones
 * the previous attendant held.
 */
export function sectionHandover<T extends { unitId: string; date: IsoDate; status: string; attendantId: string | null }>(tasks: readonly T[], section: Pick<Section, 'unitIds'>, date: IsoDate, attendantId: string | null, previous: string | null): T[] {
  return tasks.filter((t) => t.date === date && t.status === 'pending' && section.unitIds.includes(t.unitId) && (attendantId ? t.attendantId !== attendantId : previous !== null && t.attendantId === previous))
}

/** Floor label: "Floor 2", "Ground floor" for G or 0, "No floor" when empty. */
export function floorLabel(floor: string): string {
  const f = floor.trim()
  if (!f) return 'No floor'
  if (f.toUpperCase() === 'G' || f === '0') return 'Ground floor'
  return `Floor ${f}`
}

/** Sort key for floors: ground first, numbers in order, others by name, no floor last. */
export function floorRank(floor: string): string {
  const f = floor.trim()
  if (!f) return '~'
  if (f.toUpperCase() === 'G' || f === '0') return '0000'
  const n = Number(f)
  return Number.isFinite(n) ? String(n + 1).padStart(4, '0') : `5${f}`
}

export interface RoomGroup {
  key: string
  label: string
  /** Sorts groups: the property name, then the floor. */
  order: string
}

/** Where housekeeping lists a unit: a hotel room under its property's floor, a villa under its property. */
export function roomGroup(catalog: Catalog, unitId: string): RoomGroup {
  const { unit, villa } = catalog.place(unitId)
  if (unitKindOf(catalog, unitId) !== 'room') return { key: villa.id, label: villa.name, order: `${villa.name}\u0000` }
  return { key: `${villa.id}:${unit.floor.trim()}`, label: `${villa.name}, ${floorLabel(unit.floor)}`, order: `${villa.name}\u0000${floorRank(unit.floor)}` }
}

/** Items grouped by roomGroup, groups in order, items in their given order. */
export function groupByRoom<T>(catalog: Catalog, items: readonly T[], unitOf: (item: T) => string): Array<RoomGroup & { items: T[] }> {
  const groups = new Map<string, RoomGroup & { items: T[] }>()
  for (const item of items) {
    const g = roomGroup(catalog, unitOf(item))
    const found = groups.get(g.key) ?? { ...g, items: [] }
    found.items.push(item)
    groups.set(g.key, found)
  }
  return [...groups.values()].sort((a, b) => a.order.localeCompare(b.order))
}

import type { IsoDate } from '@/lib/dates'
import { BOOKING_STATUS_LABEL, type BookingStatus } from './booking'
import { RuleError } from './errors'
import type { MaintenanceCategory } from './maintenance'

/**
 * What a unit holds, item by item, and the counts housekeeping makes against it before a guest
 * arrives and after they leave. Contract: api/docs/contracts/villa-operations-contract.md sections 1 and 2.
 */

export type InventoryCategory = 'kitchen' | 'linen' | 'electronics' | 'furniture' | 'bathroom' | 'outdoor' | 'pool'
export const INVENTORY_CATEGORIES: readonly InventoryCategory[] = ['kitchen', 'linen', 'electronics', 'furniture', 'bathroom', 'outdoor', 'pool']
export const INVENTORY_CATEGORY_LABEL: Record<InventoryCategory, string> = { kitchen: 'Kitchen', linen: 'Linen', electronics: 'Electronics', furniture: 'Furniture', bathroom: 'Bathroom', outdoor: 'Outdoor', pool: 'Pool' }
/** The trade a damaged or missing item goes to when it raises a work order. */
export const INVENTORY_TRADE: Record<InventoryCategory, MaintenanceCategory> = { kitchen: 'appliance', linen: 'other', electronics: 'electrical', furniture: 'structure', bathroom: 'plumbing', outdoor: 'garden', pool: 'pool' }

export interface UnitItem {
  id: string
  unitId: string
  villaId: string
  name: string
  category: InventoryCategory
  expected: number
  /** Free note on the item's state: "chipped rim", "new in March". */
  condition: string
  /** File name of the photo, as work order photos keep it. */
  photo: string | null
  replacementCost: number
}
export type UnitItemInput = Omit<UnitItem, 'id' | 'villaId'>

export const MAX_ITEM_NAME = 60
const MAX_NOTE = 200
const whole = (n: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(n) && n >= min && n <= max

/** `list` is the unit's current items; `current` the item being edited. */
export function validateUnitItem(input: UnitItemInput, list: readonly UnitItem[], current: UnitItem | null): Record<string, string> {
  const errors: Record<string, string> = {}
  if (current && input.unitId !== current.unitId) errors.unitId = 'An item stays with its unit.'
  const name = input.name.trim()
  const length = [...name].length
  if (length < 2) errors.name = 'Name the item.'
  else if (length > MAX_ITEM_NAME) errors.name = `An item name is at most ${MAX_ITEM_NAME} characters.`
  else if (list.some((i) => i.id !== current?.id && i.name.toLowerCase() === name.toLowerCase())) errors.name = `${name} is already on this list.`
  if (!INVENTORY_CATEGORIES.includes(input.category)) errors.category = 'Pick the category.'
  if (!whole(input.expected, 1, 999)) errors.expected = 'A whole number from 1 to 999.'
  if (!whole(input.replacementCost, 0)) errors.replacementCost = 'Whole rupiah, zero or more.'
  if (input.condition.length > MAX_NOTE) errors.condition = 'Keep the condition note under 200 characters.'
  return errors
}

/** The source's items whose names the target lacks, refused as the API refuses an empty copy. */
export function itemsToCopy(source: readonly UnitItem[], target: readonly UnitItem[], codes: { source: string; target: string }, sameUnit: boolean): UnitItem[] {
  if (sameUnit) throw new RuleError('INVENTORY_COPY_SELF', 'Pick another unit to copy from.')
  if (source.length === 0) throw new RuleError('INVENTORY_COPY_EMPTY', `${codes.source} has no inventory list to copy.`)
  const taken = new Set(target.map((i) => i.name.toLowerCase()))
  const fresh = source.filter((i) => !taken.has(i.name.toLowerCase()))
  if (fresh.length === 0) throw new RuleError('INVENTORY_COPY_NOTHING', `${codes.target} already lists every item of ${codes.source}.`)
  return fresh
}

export type CheckKind = 'pre_arrival' | 'post_departure'
export const CHECK_KINDS: readonly CheckKind[] = ['pre_arrival', 'post_departure']
export const CHECK_KIND_LABEL: Record<CheckKind, string> = { pre_arrival: 'Pre-arrival check', post_departure: 'Post-departure check' }

export type ItemCondition = 'ok' | 'damaged' | 'missing'
export const ITEM_CONDITIONS: readonly ItemCondition[] = ['ok', 'damaged', 'missing']
export const ITEM_CONDITION_LABEL: Record<ItemCondition, string> = { ok: 'OK', damaged: 'Damaged', missing: 'Missing' }

export interface LineCharge {
  sourceRef: string
  quantity: number
  amount: number
  reason: string
  by: string
  on: IsoDate
}

export interface CheckLine {
  itemId: string
  name: string
  category: InventoryCategory
  expected: number
  counted: number
  condition: ItemCondition
  note: string
  replacementCost: number
  charge: LineCharge | null
  workOrder: { id: string; number: string } | null
  adjusted: boolean
}

export interface InventoryCheck {
  id: string
  number: string
  unitId: string
  villaId: string
  bookingId: string
  bookingCode: string
  kind: CheckKind
  on: IsoDate
  by: string
  byId: string
  lines: readonly CheckLine[]
}

export interface CountInput {
  itemId: string
  counted: number
  condition: ItemCondition
  note: string
}

export interface CheckInput {
  unitId: string
  bookingId: string
  kind: CheckKind
  lines: readonly CountInput[]
}

export const checkNumber = (n: number) => `IC-${1000 + n}`

const STAY_OK: Record<CheckKind, readonly BookingStatus[]> = { pre_arrival: ['confirmed', 'checked_in'], post_departure: ['checked_in', 'checked_out'] }
const STAY_WHEN: Record<CheckKind, string> = { pre_arrival: 'a pre-arrival check is for a stay arriving or in house', post_departure: 'a post-departure check follows a stay in house or checked out' }

/**
 * The checks a recorded count must pass, in the API's order: the kind, the list, the stay, a
 * second check of the kind, then the lines. Rule refusals throw; field errors come back.
 */
export function validateCheck(input: CheckInput, list: readonly UnitItem[], unitCode: string, stay: { id: string; unitId: string; code: string; status: BookingStatus }, existing: readonly Pick<InventoryCheck, 'bookingId' | 'kind'>[]): Record<string, string> {
  if (!CHECK_KINDS.includes(input.kind)) return { kind: 'Pick the check.' }
  if (list.length === 0) throw new RuleError('CHECK_NO_LIST', `${unitCode} has no inventory list yet; add its items first.`)
  if (stay.unitId !== input.unitId) return { bookingId: 'Pick a stay of this unit.' }
  if (!STAY_OK[input.kind].includes(stay.status)) throw new RuleError('CHECK_STAY_STATE', `${stay.code} is ${BOOKING_STATUS_LABEL[stay.status].toLowerCase()}; ${STAY_WHEN[input.kind]}.`)
  if (existing.some((c) => c.bookingId === stay.id && c.kind === input.kind)) throw new RuleError('CHECK_TWICE', `${stay.code} already has a ${CHECK_KIND_LABEL[input.kind].toLowerCase()}.`)
  const ids = input.lines.map((l) => l.itemId)
  if (ids.length !== list.length || new Set(ids).size !== ids.length || list.some((i) => !ids.includes(i.id))) return { lines: 'Count every item on the list.' }
  const errors: Record<string, string> = {}
  input.lines.forEach((l, i) => {
    const item = list.find((x) => x.id === l.itemId)!
    if (!whole(l.counted, 0, 9999)) errors[`lines.${i}.counted`] = 'Count in whole numbers.'
    else if (!ITEM_CONDITIONS.includes(l.condition)) errors[`lines.${i}.condition`] = 'Pick ok, damaged or missing.'
    else if (l.condition === 'ok' && l.counted < item.expected) errors[`lines.${i}.condition`] = `${l.counted} of ${item.expected} found; mark it missing or damaged.`
    if (l.note.length > MAX_NOTE) errors[`lines.${i}.note`] = 'Keep the note under 200 characters.'
  })
  return errors
}

/** The lines as recorded: each item's name, count and cost as they stood. */
export const checkLines = (input: CheckInput, list: readonly UnitItem[]): CheckLine[] =>
  input.lines.map((l) => {
    const item = list.find((x) => x.id === l.itemId)!
    return { itemId: item.id, name: item.name, category: item.category, expected: item.expected, counted: l.counted, condition: l.condition, note: l.note.trim(), replacementCost: item.replacementCost, charge: null, workOrder: null, adjusted: false }
  })

export interface LineDiff {
  line: CheckLine
  /** Counted less the list's expected count. */
  vsList: number
  /** Counted less the pre-arrival count of the same stay, on a post-departure check. */
  vsPre: number | null
  conditionChanged: boolean
  flagged: boolean
}

/** Every line against the list and, after departure, against the stay's pre-arrival check. */
export function checkDiffs(check: Pick<InventoryCheck, 'lines' | 'kind'>, pre: Pick<InventoryCheck, 'lines'> | null): LineDiff[] {
  return check.lines.map((line) => {
    const before = check.kind === 'post_departure' ? pre?.lines.find((l) => l.itemId === line.itemId) : undefined
    const vsList = line.counted - line.expected
    const vsPre = before ? line.counted - before.counted : null
    const conditionChanged = Boolean(before && before.condition !== line.condition)
    return { line, vsList, vsPre, conditionChanged, flagged: line.condition !== 'ok' || vsList !== 0 || (vsPre ?? 0) !== 0 || conditionChanged }
  })
}

export const linesOff = (check: Pick<InventoryCheck, 'lines'>) => check.lines.filter((l) => l.condition !== 'ok' || l.counted !== l.expected).length

/** A line action needs a line that was not found in order. */
export function assertLineOff(line: CheckLine) {
  if (line.condition === 'ok') throw new RuleError('CHECK_LINE_OK', `${line.name} was found in order.`)
}

export interface ChargeInput {
  quantity: number
  reason: string
}

/** The charge rules in the API's order; `inHouse` is whether the stay can still take folio charges. */
export function validateCharge(check: Pick<InventoryCheck, 'kind' | 'bookingCode'>, line: CheckLine, input: ChargeInput, inHouse: boolean): Record<string, string> {
  if (check.kind !== 'post_departure') throw new RuleError('CHECK_KIND', 'Charges come from a post-departure check.')
  assertLineOff(line)
  if (line.charge) throw new RuleError('CHECK_CHARGED', `${line.name} is already charged to ${check.bookingCode}.`)
  if (line.replacementCost <= 0) throw new RuleError('CHECK_NO_COST', `${line.name} has no replacement cost; set one on the list first.`)
  const errors: Record<string, string> = {}
  if (!whole(input.quantity, 1, line.expected)) errors.quantity = `From 1 to ${line.expected}.`
  if (input.reason.trim().length < 4) errors.reason = 'Say why the guest pays for it.'
  if (Object.keys(errors).length) return errors
  if (!inHouse) throw new RuleError('CHECK_STAY_CLOSED', `${check.bookingCode} has checked out; charge damage while the guest is in house, before the deposit is returned.`)
  return errors
}

export const chargeDescription = (line: Pick<CheckLine, 'condition' | 'name'>, quantity: number, reason: string) => `${line.condition === 'missing' ? 'Missing' : 'Damaged'} ${line.name} (${quantity}): ${reason.trim()}`

export function assertWorkOrderable(line: CheckLine) {
  assertLineOff(line)
  if (line.workOrder) throw new RuleError('CHECK_WORK_ORDER', `${line.name} already has work order ${line.workOrder.number}.`)
}

export function assertAdjustable(line: CheckLine) {
  assertLineOff(line)
  if (line.adjusted) throw new RuleError('CHECK_ADJUSTED', `${line.name} is already adjusted on the list.`)
}

/** The work order a damaged or missing item raises. */
export function lineWorkOrder(check: Pick<InventoryCheck, 'number' | 'kind'>, line: CheckLine, unitCode: string) {
  return {
    category: INVENTORY_TRADE[line.category],
    title: `${line.condition === 'missing' ? 'Missing' : 'Damaged'} ${line.name} in ${unitCode}`,
    description: `${check.number}, ${CHECK_KIND_LABEL[check.kind]}: ${line.counted} of ${line.expected} found${line.note ? `. ${line.note}` : ''}`,
  }
}

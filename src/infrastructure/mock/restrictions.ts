import type { StayRulesPort } from '@/application/ports'
import { can, ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import { sellsRoomType, type Booking, type BookingSource } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import type { Transaction } from '@/domain/finance'
import { overbookedNights, validateOverbook, validateWalk, WALK_DESTINATION_LABEL, type Walk } from '@/domain/overbooking'
import { evaluateStay, mayOverrideRestrictions, withNights, restrictionLabel, restrictionWhen, validateRestriction, violationSummary, type Restriction, type RestrictionInput, type RestrictionNote, type RestrictionOverrideInput, type StayShape } from '@/domain/restriction'
import { addDays } from '@/lib/dates'
import type { MockState } from './state'

/** The mock adapter's own helpers the stay rules reuse, so a walk moves and pays through the same paths as the desk. */
export interface StayRuleDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  copy: <T>(v: T) => T
  seq: (key: string) => number
  user: () => User
  today: () => string
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
  refuse: (errors: Record<string, string | undefined>) => void
  /** Refuses a unit already held on the nights. */
  assertFree: (unitId: string, checkIn: string, checkOut: string, excludeId?: string) => void
  /** Moves the money of a stay that ends without checking out, as cancelling does. */
  recordStay: (b: Booking) => void
  newTransaction: (fields: Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>, submit: boolean, me: User) => Transaction
}

export function createStayRules(d: StayRuleDeps) {
  const { s } = d
  const catalog = () => s.catalog()

  function mayEdit(what: string) {
    const me = d.user()
    if (!can(s.permissions, me.role, 'property', 'edit')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot edit ${what}.`)
    return me
  }

  function restrictionOf(input: RestrictionInput, id: string, me: User): Restriction {
    d.refuse(validateRestriction(input))
    const group = findById(s.groups, input.groupId, 'room type')
    if (input.unitId && catalog().unit(input.unitId).groupId !== group.id) throw new RuleError('VALIDATION_ERROR', `That unit is not a room of ${group.name}.`)
    const { groupId, unitId, rule, nights, yearly, from, to, weekdays, note } = input
    return { id, groupId, unitId, rule, nights: withNights(rule) ? nights : null, yearly, from, to, weekdays: [...weekdays].sort(), note: note.trim(), createdBy: me.name, createdOn: d.today() }
  }

  const describe = (r: Restriction) => `${restrictionLabel(r)} on ${catalog().group(r.groupId).name}${r.unitId ? ` ${catalog().unit(r.unitId).code}` : ''}, ${restrictionWhen(r)}`

  /**
   * The rules a new stay or new dates break. A direct stay is refused unless a manager overrides with
   * a reason; a channel stay is kept with a warning, since the channel already sold it. `list` narrows
   * the rules, as assigning a room does to the unit's own.
   */
  function checkStay(stay: StayShape, source: BookingSource, override: RestrictionOverrideInput | null | undefined, label: string, list: readonly Restriction[] = s.restrictions): RestrictionNote | null {
    const violations = evaluateStay(list, stay)
    if (violations.length === 0) return null
    const me = d.user()
    const note = { rules: violations.map((v) => v.rule), messages: violations.map((v) => v.message), by: me.name, on: d.today() }
    if (source !== 'direct') return { ...note, kind: 'channel', reason: '' }
    if (!override) throw new RuleError('RESTRICTION_VIOLATED', `${label} breaks the stay restrictions: ${violationSummary(violations)} A villa manager can sell past them with a reason.`)
    if (!mayOverrideRestrictions(s.permissions, me.role)) throw new RuleError('RESTRICTION_OVERRIDE_FORBIDDEN', `${ROLE_LABEL[me.role]} cannot sell past stay restrictions. Ask a villa manager.`)
    if (override.reason.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the stay sells past the restrictions.')
    return { ...note, kind: 'override', reason: override.reason.trim() }
  }

  /** The cost of a walk, paid from the overbooked villa's cashbox or the bank, through approval. */
  function relocationCost(b: Booking, fromUnitId: string, walk: Pick<Walk, 'number' | 'cost' | 'method' | 'destination' | 'property'>, receipts: Transaction['attachments'], me: User) {
    const place = catalog().place(fromUnitId)
    const box = s.cashAccounts.find((a) => a.kind === 'cashbox' && a.locationId === place.location.id)
    const bank = s.cashAccounts.find((a) => a.kind === 'bank')
    const account = walk.method === 'cash' ? (box ?? bank) : (bank ?? box)
    if (!account) throw new RuleError('VALIDATION_ERROR', 'No account to pay from.')
    const to = walk.destination === 'outside' ? walk.property.trim() : WALK_DESTINATION_LABEL[walk.destination].toLowerCase()
    return d.newTransaction(
      { accountId: account.id, kind: 'cash_out', categoryId: 'cat-relocation', amount: walk.cost, date: d.today(), locationId: place.location.id, villaId: place.villa.id, unitId: fromUnitId, bookingId: b.id, description: `Guest relocation ${b.code} to ${to}`, reference: walk.number, transferId: null, attachments: [...receipts], origin: 'front_desk' },
      true,
      me,
    )
  }

  const port: StayRulesPort = {
    restrictions: () => d.later(() => d.copy(s.restrictions)),
    saveRestriction: (id, input) =>
      d.later(() => {
        const me = mayEdit('stay restrictions')
        const before = id ? findById(s.restrictions, id, 'restriction') : null
        const saved = restrictionOf(input, before?.id ?? `rst-${d.seq('restriction')}`, me)
        s.restrictions = before ? s.restrictions.map((r) => (r.id === saved.id ? saved : r)) : [...s.restrictions, saved]
        d.log(before ? 'update' : 'create', 'restriction', saved.id, `${before ? 'Changed' : 'Added'} ${describe(saved)}`, before ? { rule: before.rule, nights: before.nights, from: before.from, to: before.to } : null, { rule: saved.rule, nights: saved.nights, from: saved.from, to: saved.to })
        return d.copy(saved)
      }),
    removeRestriction: (id) =>
      d.later(() => {
        mayEdit('stay restrictions')
        const r = findById(s.restrictions, id, 'restriction')
        s.restrictions = s.restrictions.filter((x) => x.id !== id)
        d.log('delete', 'restriction', id, `Removed ${describe(r)}`, { rule: r.rule, from: r.from, to: r.to }, null)
      }),
    bulkRestrictions: (input) =>
      d.later(() =>
        d.atomically(() => {
          const me = mayEdit('stay restrictions')
          if (input.groupIds.length === 0) throw new RuleError('VALIDATION_ERROR', 'Pick at least one room type.')
          const { groupIds, ...rule } = input
          const saved = [...new Set(groupIds)].map((groupId) => restrictionOf({ ...rule, groupId, unitId: null }, `rst-${d.seq('restriction')}`, me))
          s.restrictions = [...s.restrictions, ...saved]
          d.log('create', 'restriction', saved.map((r) => r.id).join(', '), `Added ${restrictionLabel(rule)} on ${saved.map((r) => catalog().group(r.groupId).name).join(', ')}, ${restrictionWhen(rule)}`)
          return d.copy(saved)
        }),
      ),
    overbooking: () => d.later(() => d.copy(s.overbooking)),
    setOverbooking: (groupId, limit) =>
      d.later(() => {
        mayEdit('the overbooking policy')
        const problem = validateOverbook(limit)
        if (problem) throw new RuleError('VALIDATION_ERROR', problem)
        const group = findById(s.groups, groupId, 'room type')
        if (limit > 0 && !sellsRoomType(group)) throw new RuleError('OVERBOOK_ROOM_BY_ROOM', `${group.name} sells room by room; only a room type that sells by type can overbook.`)
        const before = s.overbooking.find((p) => p.groupId === groupId)?.limit ?? 0
        s.overbooking = [...s.overbooking.filter((p) => p.groupId !== groupId), { groupId, limit }]
        d.log('update', 'overbooking', groupId, `Set ${group.name} to sell ${limit} past its rooms a night`, { limit: before }, { limit })
        return { groupId, limit }
      }),
    walks: () => d.later(() => d.copy(s.walks)),
    walk: (bookingId, input) =>
      d.later(() =>
        d.atomically(() => {
          const me = d.user()
          if (!can(s.permissions, me.role, 'booking', 'edit')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot walk a guest.`)
          d.refuse(validateWalk(input))
          const b = findById(s.bookings, bookingId, 'booking')
          const today = d.today()
          if (b.status !== 'confirmed' || b.checkIn !== today) throw new RuleError('WALK_NOT_ALLOWED', `${b.code} is not a confirmed arrival for today; only a guest due today can be walked.`)
          const from = catalog().unit(b.unitId)
          const group = from.groupId ? catalog().group(from.groupId) : null
          if (!group || overbookedNights(catalog(), group.id, today, addDays(today, 1), s.bookings, s.blocks).length === 0)
            throw new RuleError('WALK_NOT_OVERBOOKED', `${group?.name ?? from.code} is not overbooked tonight. Assign a room instead.`)
          const number = `WLK-${100 + d.seq('walk')}`
          let toUnitId: string | null = null
          if (input.destination === 'group_villa') {
            const target = catalog().unit(input.unitId ?? '')
            if (target.groupId === group.id) throw new RuleError('VALIDATION_ERROR', `${target.code} is a ${group.name} room; pick a unit of another villa or room type.`)
            if (target.status !== 'active') throw new RuleError('UNIT_UNAVAILABLE', `${target.code} is ${target.status}.`)
            d.assertFree(target.id, b.checkIn, b.checkOut, b.id)
            b.movements = [...b.movements, { fromUnitId: b.unitId, toUnitId: target.id, on: today, reason: `Walked ${number}: ${input.reason.trim()}`, by: me.name }]
            b.unitId = target.id
            b.unitAssigned = true
            toUnitId = target.id
          } else {
            b.status = 'cancelled'
            d.recordStay(b)
          }
          const fields = { number, cost: input.cost, method: input.method, destination: input.destination, property: input.property }
          const t = input.cost > 0 ? relocationCost(b, from.id, fields, input.receipts ?? [], me) : null
          const walk: Walk = { id: `walk-${number.slice(4)}`, ...fields, property: input.destination === 'outside' ? input.property.trim() : '', bookingId: b.id, bookingCode: b.code, groupId: group.id, date: today, fromUnitId: from.id, toUnitId, compensation: input.compensation.trim(), reason: input.reason.trim(), transactionId: t?.id ?? null, by: me.name, byId: me.id }
          s.walks.push(walk)
          const where = toUnitId ? `to ${catalog().unit(toUnitId).code}` : `to ${walk.property}, stay cancelled`
          d.log('create', 'walk', number, `Walked ${b.code} off overbooked ${group.name} ${where}${t ? `; cost ${input.cost} as ${t.number}` : ''}`, null, { cost: input.cost, destination: input.destination })
          return { booking: d.copy(b), walk: d.copy(walk) }
        }),
      ),
  }

  return { port, checkStay }
}

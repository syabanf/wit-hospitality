import type { Booking } from '@/domain/booking'
import type { Employee, LeaveRequest, ShiftAssignment } from '@/domain/hr'
import { attendantsOnShift, autoAssign, DEFAULT_HOUSEKEEPING_SETTINGS, planTasks, TASK_CHECKLIST, type LaundryBatch, type LinenCount, type LinenPar, type PlannedTask, type RoomTask } from '@/domain/housekeeping'
import type { HousekeepingRecord } from '@/domain/maintenance'
import { stayoverEveryOf, type Catalog } from '@/domain/property'
import { onHand, type StockItem, type StockLine, type StockMovement, type StockReceipt } from '@/domain/stock'
import { addDays, type IsoDate } from '@/lib/dates'
import { STOCK_ITEMS } from './stock'

const linen = (code: string, name: string, averageCost: number): StockItem => ({ id: `stk-${code.toLowerCase()}`, code, name, kind: 'linen', unit: 'piece', reorderLevel: 8, par: 0, averageCost, active: true })

/** The linen the par asks for beyond the bath towel and sheet set the stock seed already carries. */
export const LINEN_ITEMS: readonly StockItem[] = [linen('LN-DUVET', 'Duvet cover', 180_000), linen('LN-PILLOW', 'Pillow case', 35_000), linen('LN-HAND', 'Hand towel', 40_000), linen('LN-MAT', 'Bath mat', 45_000), linen('LN-POOL', 'Pool towel', 95_000)]

const id = (code: string) => `stk-${code.toLowerCase()}`
const lines = (pairs: ReadonlyArray<[string, number]>): StockLine[] => pairs.map(([code, quantity]) => ({ itemId: id(code), quantity }))
const ONE_BED: ReadonlyArray<[string, number]> = [['LN-SHEET', 1], ['LN-DUVET', 1], ['LN-PILLOW', 4], ['LN-TOWEL', 2], ['LN-HAND', 2], ['LN-MAT', 1], ['LN-POOL', 2]]
const times = (n: number) => ONE_BED.map(([code, q]): [string, number] => [code, q * n])

/** Pieces per room by room type, three sets each: one in the room, one in the store, one at the laundry. */
export const LINEN_PARS: readonly LinenPar[] = [
  { groupId: 'grp-saka-standard', sets: 3, lines: lines(ONE_BED) },
  { groupId: 'grp-tirta-pool', sets: 3, lines: lines(ONE_BED) },
  { groupId: 'grp-tirta-garden', sets: 3, lines: lines(ONE_BED.filter(([code]) => code !== 'LN-POOL')) },
  { groupId: 'grp-lumbung-loft', sets: 3, lines: lines(ONE_BED) },
  { groupId: 'grp-karang-cliff', sets: 3, lines: lines(times(2)) },
  { groupId: 'grp-pandawa-estate', sets: 3, lines: lines(times(4)) },
]

const STORES = ['vil-saka', 'vil-tirta', 'vil-lumbung', 'vil-karang'] as const
/** Lumbung lost pool towels over the season and sits under par, so the flag shows. */
const UNDER_PAR = { villaId: 'vil-lumbung', itemId: id('LN-POOL'), less: 6 }
const MANAGER = 'Kadek Ariani'

/** Small deterministic spread for seeded minutes. */
const spread = (a: number, b: number) => (((a + 3) * 7919 + (b + 11) * 104729) % 41) / 100

interface SeedInput {
  today: IsoDate
  catalog: Catalog
  bookings: readonly Booking[]
  employees: readonly Employee[]
  roster: readonly ShiftAssignment[]
  leaves: readonly LeaveRequest[]
  board: HousekeepingRecord[]
  movements: readonly StockMovement[]
  next: { stockMovement: number; stockReceipt: number }
  /** Books the posted cash-out of the returned laundry batch and returns its id. */
  laundryEntry: (b: Pick<LaundryBatch, 'villaId' | 'vendor' | 'number' | 'cost' | 'method' | 'reference' | 'returnedOn'>) => string
}

/**
 * Housekeeping for the seed: today's tasks for every villa given out to the attendants on shift, a week of finished
 * work with times, linen opening stock up to the par, soiled bags, and two laundry batches (one out, one back two towels short).
 */
export function seedHousekeeping({ today, catalog, bookings, employees, roster, leaves, board, movements, next, laundryEntry }: SeedInput) {
  const day = (offset: number) => addDays(today, offset)
  const settings = structuredClone(DEFAULT_HOUSEKEEPING_SETTINGS)
  const at = (date: IsoDate, minute: number) => `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`
  const stays = bookings.filter((b) => b.unitAssigned && (b.status === 'checked_in' || b.status === 'checked_out' || b.status === 'confirmed'))
  const tasks: RoomTask[] = []
  const name = (employeeId: string | null) => employees.find((e) => e.id === employeeId)?.name ?? MANAGER

  function plan(date: IsoDate, dirty: ReadonlySet<string>) {
    const planned = planTasks({ date, units: catalog.units, stays, dirty, turndown: false, existing: [], stayoverEvery: (unitId) => stayoverEveryOf(catalog, unitId) })
    const made = planned.map((p: PlannedTask) => {
      const n = tasks.length + 1
      const standard = settings.standards[p.type]
      const t: RoomTask = { ...p, id: `hkt-${n}`, number: `HK-${4000 + n}`, date, attendantId: null, status: 'pending', credits: standard.credits, standardMinutes: standard.minutes, startedAt: null, finishedAt: null, runningSince: null, workedMinutes: 0, checklist: [], workOrderIds: [], lostFound: [], note: '', history: [{ kind: 'created', by: MANAGER, at: at(date, 7 * 60), note: '' }] }
      tasks.push(t)
      return t
    })
    const attendants = attendantsOnShift(employees, roster, leaves, date)
    const given = autoAssign(
      made.map((t) => ({ id: t.id, villaId: t.villaId, locationId: catalog.villa(t.villaId).locationId, unitCode: catalog.unit(t.unitId).code, type: t.type, credits: t.credits })),
      attendants.map((a) => ({ id: a.id, villaIds: a.villaIds, locationIds: a.villaIds.map((v) => catalog.villa(v).locationId), credits: 0 })),
      settings.dailyQuota,
    )
    for (const g of given) {
      const t = made.find((x) => x.id === g.taskId)
      if (!t) continue
      t.attendantId = g.attendantId
      t.history = [...t.history, { kind: 'assigned', by: MANAGER, at: at(date, 7 * 60 + 5), note: `Auto-assigned to ${name(g.attendantId)}` }]
    }
    return made
  }

  /** Works a task from `start` for about its standard time, the checklist ticked. */
  function finish(t: RoomTask, start: number, index: number) {
    const minutes = Math.max(5, Math.round(t.standardMinutes * (0.8 + spread(index, start))))
    Object.assign(t, { status: 'done', startedAt: at(t.date, start), finishedAt: at(t.date, start + minutes), workedMinutes: minutes, checklist: TASK_CHECKLIST[t.type].map((item) => ({ item, ok: true })) })
    t.history = [...t.history, { kind: 'start', by: name(t.attendantId), at: at(t.date, start), note: '' }, { kind: 'done', by: name(t.attendantId), at: at(t.date, start + minutes), note: '' }]
    return start + minutes + 5
  }

  // A week of finished work: each attendant works their list from the start of the shift.
  const dndStay = bookings.find((b) => b.status === 'checked_in' && b.unitAssigned && b.checkIn <= day(-3) && b.checkOut > day(1))
  for (let offset = -7; offset <= -1; offset++) {
    const date = day(offset)
    const made = plan(date, new Set())
    const clock = new Map<string, number>()
    made.forEach((t, i) => {
      if (t.bookingId === dndStay?.id && t.type === 'stayover' && offset >= -2) {
        Object.assign(t, { status: 'dnd', finishedAt: at(date, 9 * 60), note: 'Do not disturb sign on the door' })
        return
      }
      if (!t.attendantId) {
        Object.assign(t, { status: 'cancelled', note: 'No attendant on shift for this villa' })
        return
      }
      clock.set(t.attendantId, finish(t, clock.get(t.attendantId) ?? 8 * 60, i + offset * 31))
    })
  }

  // Today: the plan from the stays and the board, given out, with the first rooms under way.
  const dirty = new Set(board.filter((h) => h.state === 'dirty').map((h) => h.unitId))
  const todays = plan(today, dirty)
  const started = new Set<string>()
  todays.forEach((t, i) => {
    if (t.bookingId === dndStay?.id && t.type === 'stayover') {
      Object.assign(t, { status: 'dnd', finishedAt: at(today, 8 * 60 + 40), note: 'Do not disturb, third day running' })
      return
    }
    if (!t.attendantId) return
    if (t.type === 'stayover' && !started.has(`${t.attendantId}|stay`)) {
      started.add(`${t.attendantId}|stay`)
      finish(t, 8 * 60, i)
      return
    }
    const record = board.find((h) => h.unitId === t.unitId)
    if (t.type === 'departure' && record?.state === 'dirty' && !started.has(`${t.attendantId}|dep`)) {
      started.add(`${t.attendantId}|dep`)
      Object.assign(t, { status: 'in_progress', startedAt: at(today, 9 * 60), runningSince: at(today, 9 * 60) })
      t.history = [...t.history, { kind: 'start', by: name(t.attendantId), at: at(today, 9 * 60), note: '' }]
      Object.assign(record, { state: 'cleaning', note: `${t.number} started`, updatedBy: name(t.attendantId) })
    }
  })
  const refused = todays.find((t) => t.type === 'stayover' && t.status === 'pending' && t.attendantId)
  if (refused) Object.assign(refused, { status: 'refused', finishedAt: at(today, 8 * 60 + 50), note: 'Guest asked for fresh towels only, at the door' })
  // A quarterly deep clean on a free room, left for the supervisor to give out.
  const free = catalog.units.find((u) => u.status !== 'inactive' && !todays.some((t) => t.unitId === u.id))
  if (free) {
    const n = tasks.length + 1
    const standard = settings.standards.deep
    tasks.push({ id: `hkt-${n}`, number: `HK-${4000 + n}`, date: today, unitId: free.id, villaId: free.villaId, type: 'deep', bookingId: null, attendantId: null, status: 'pending', credits: standard.credits, standardMinutes: standard.minutes, startedAt: null, finishedAt: null, runningSince: null, workedMinutes: 0, checklist: [], workOrderIds: [], lostFound: [], note: 'Quarterly deep clean', history: [{ kind: 'created', by: MANAGER, at: at(today, 7 * 60), note: 'Quarterly deep clean' }] })
  }

  // Linen: opening stock up to the par in every villa store, the used sets of recent departures in the soiled bags.
  const roomSet = (unitId: string) => LINEN_PARS.find((p) => p.groupId === catalog.unit(unitId).groupId)?.lines ?? []
  const inUse = (villaId: string, itemId: string) => catalog.units.filter((u) => u.villaId === villaId && u.status !== 'inactive').reduce((s, u) => s + (roomSet(u.id).find((l) => l.itemId === itemId)?.quantity ?? 0), 0)
  const added: StockMovement[] = []
  const receipts: StockReceipt[] = []
  const push = (fields: Pick<StockMovement, 'villaId' | 'itemId' | 'kind' | 'quantity' | 'on' | 'unitCost'> & Partial<StockMovement>) => {
    const n = next.stockMovement + added.length
    added.push({ id: `sm-${n}`, number: `SM-${1000 + n}`, by: MANAGER, unitId: null, bookingId: null, orderId: null, receiptId: null, countId: null, transferId: null, otherVillaId: null, reason: '', ...fields })
  }
  const cost = (itemId: string) => [...STOCK_ITEMS, ...LINEN_ITEMS].find((i) => i.id === itemId)?.averageCost ?? 0
  for (const villaId of STORES) {
    const receiptLines = ONE_BED.map(([code]) => id(code)).flatMap((itemId) => {
      const target = inUse(villaId, itemId) * 3 - (villaId === UNDER_PAR.villaId && itemId === UNDER_PAR.itemId ? UNDER_PAR.less : 0)
      // The two missing towels of the returned batch leave the store later; the opening covers them.
      const missing = villaId === 'vil-saka' && itemId === id('LN-TOWEL') ? 2 : 0
      const quantity = target + missing - onHand(movements, villaId, itemId)
      return quantity > 0 ? [{ itemId, quantity, unitCost: cost(itemId) }] : []
    })
    if (receiptLines.length === 0) continue
    const k = next.stockReceipt + receipts.length
    const r: StockReceipt = { id: `srx-${k}`, number: `SR-${300 + k}`, villaId, supplier: 'Linen opening stock', lines: receiptLines, method: 'bank_transfer', reference: 'OPENING-LINEN', attachments: [], receivedOn: day(-30), transactionId: null, createdBy: MANAGER, createdOn: day(-30) }
    receipts.push(r)
    for (const l of r.lines) push({ villaId, itemId: l.itemId, kind: 'receipt', quantity: l.quantity, unitCost: l.unitCost, on: r.receivedOn, receiptId: r.id, reason: 'Linen opening stock' })
  }

  const soiled: LinenCount[] = []
  const bag = (villaId: string, set: readonly StockLine[]) => {
    for (const l of set) {
      const row = soiled.find((c) => c.villaId === villaId && c.itemId === l.itemId)
      if (row) row.quantity += l.quantity
      else soiled.push({ villaId, itemId: l.itemId, quantity: l.quantity })
    }
  }
  for (const t of tasks) if (t.type === 'departure' && t.status === 'done' && t.date >= day(-1)) bag(t.villaId, roomSet(t.unitId))

  // Saka's batch came back yesterday two bath towels short; Karang's left yesterday and is still out.
  const towel = id('LN-TOWEL')
  const back: LaundryBatch = {
    id: 'lnb-1',
    number: 'LDY-201',
    villaId: 'vil-saka',
    vendor: 'Bersih Laundry Canggu',
    status: 'returned',
    sentOn: day(-3),
    returnedOn: day(-1),
    lines: lines([['LN-SHEET', 8], ['LN-DUVET', 8], ['LN-PILLOW', 32], ['LN-TOWEL', 16], ['LN-HAND', 16], ['LN-MAT', 8]]).map((l) => ({ itemId: l.itemId, sent: l.quantity, returned: l.itemId === towel ? l.quantity - 2 : l.quantity, damaged: 0 })),
    cost: 680_000,
    method: 'cash',
    reference: 'BRS/1103/77',
    attachments: [],
    transactionId: null,
    writeOffs: [],
    sentBy: 'Ni Luh Putu Sari',
    returnedBy: 'Ni Luh Putu Sari',
    note: 'Weekly pick-up',
  }
  back.transactionId = laundryEntry(back)
  push({ villaId: 'vil-saka', itemId: towel, kind: 'write_off', quantity: -2, unitCost: cost(towel), on: day(-1), by: 'Ni Luh Putu Sari', reason: `Laundry ${back.number}: missing or damaged at ${back.vendor}` })
  back.writeOffs = [added[added.length - 1]?.number ?? '']
  const out: LaundryBatch = {
    id: 'lnb-2',
    number: 'LDY-202',
    villaId: 'vil-karang',
    vendor: 'Uluwatu Fresh Laundry',
    status: 'out',
    sentOn: day(-1),
    returnedOn: null,
    lines: lines(times(4)).map((l) => ({ itemId: l.itemId, sent: l.quantity, returned: 0, damaged: 0 })),
    cost: 0,
    method: 'bank_transfer',
    reference: '',
    attachments: [],
    transactionId: null,
    writeOffs: [],
    sentBy: 'Kadek Yuliani',
    returnedBy: '',
    note: 'Two cliff villas after the weekend',
  }

  return {
    settings,
    tasks,
    pars: LINEN_PARS.map((p) => ({ ...p, lines: p.lines.map((l) => ({ ...l })) })),
    soiled,
    batches: [back, out],
    items: LINEN_ITEMS.map((i) => ({ ...i })),
    movements: added,
    receipts,
    next: { roomTask: tasks.length + 1, laundryBatch: 3, stockMovement: next.stockMovement + added.length, stockReceipt: next.stockReceipt + receipts.length },
  }
}

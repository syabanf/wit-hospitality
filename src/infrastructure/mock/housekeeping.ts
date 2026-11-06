import type { HousekeepingPort, TaskIssueInput } from '@/application/ports'
import { can, type AuditAction, type User } from '@/domain/access'
import { findById, RuleError } from '@/domain/errors'
import type { Transaction } from '@/domain/finance'
import {
  assertTaskAction,
  attendantsOnShift,
  autoAssign,
  creditsByAttendant,
  isOpenTask,
  minutesBetween,
  missingOf,
  planTasks,
  TASK_ACTION_LABEL,
  TASK_CHECKLIST,
  TASK_TYPE_LABEL,
  validateHousekeepingSettings,
  validateLaundryReturn,
  validateLaundrySend,
  validateLinenPar,
  validateTask,
  type PlannedTask,
  type RoomTask,
  type TaskEvent,
} from '@/domain/housekeeping'
import type { LostItem, LostItemInput } from '@/domain/lostFound'
import type { HousekeepingRecord, WorkOrder } from '@/domain/maintenance'
import type { StockLine, StockMovement } from '@/domain/stock'
import type { MockState } from './state'

type NewTransaction = Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>
type NewWorkOrder = Omit<WorkOrder, 'id' | 'number' | 'status' | 'createdOn' | 'startedOn' | 'finishedOn' | 'verifiedOn' | 'blockId' | 'expenses' | 'history' | 'reportedBy'>

/** The mock API's shared helpers the housekeeping tables need. */
export interface HousekeepingContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  today: () => string
  clockNow: () => string
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  newTransaction: (fields: NewTransaction, submit: boolean, me?: User) => Transaction
  newWorkOrder: (input: NewWorkOrder) => WorkOrder
  housekeepingRecord: (unitId: string) => HousekeepingRecord
  writeOff: (villaId: string, lines: readonly StockLine[], reason: string, actor: User) => StockMovement[]
  /** Logs a find in lost and found, in the attendant's name. */
  logLostItem: (input: LostItemInput, actor: User) => LostItem
}

/**
 * Room attendant tasks, linen and laundry for the mock API. The board keeps its states: starting a departure clean
 * moves a dirty room to cleaning, and the supervisor's inspection still decides when it is ready.
 */
export function createHousekeepingAdapter({ s, later, atomically, today, clockNow, user, seq, refuse, log, newTransaction, newWorkOrder, housekeepingRecord, writeOff, logLostItem }: HousekeepingContext): HousekeepingPort {
  const copy = <T>(v: T): T => structuredClone(v)
  const task = (id: string) => findById(s.roomTasks, id, 'housekeeping task')
  const supervises = (me: User) => can(s.permissions, me.role, 'maintenance', 'approve')
  const event = (kind: TaskEvent['kind'], me: User, note = ''): TaskEvent => ({ kind, by: me.name, at: clockNow(), note })
  const unitCode = (unitId: string) => s.catalog().unit(unitId).code
  const onShift = (date: string) => attendantsOnShift(s.employees, s.assignments, s.leaves, date)

  function assertEditor(me: User) {
    if (!can(s.permissions, me.role, 'maintenance', 'edit')) throw new RuleError('FORBIDDEN', 'Only housekeeping supervisors assign rooms and keep the linen.')
  }

  /** Attendants work their own list; someone who approves maintenance, or a login with no employee record, works any. */
  function assertWorker(t: RoomTask, me: User) {
    if (!can(s.permissions, me.role, 'maintenance', 'edit') && !can(s.permissions, me.role, 'maintenance', 'submit')) throw new RuleError('FORBIDDEN', 'Your role cannot work housekeeping tasks.')
    if (me.employeeId && t.attendantId !== me.employeeId && !supervises(me)) throw new RuleError('TASK_NOT_YOURS', `${t.number} is on another attendant's list.`)
  }

  function newTask(p: PlannedTask, date: string, me: User, note = ''): RoomTask {
    const n = seq('roomTask')
    const standard = s.hkSettings.standards[p.type]
    const t: RoomTask = { ...p, id: `hkt-${n}`, number: `HK-${4000 + n}`, date, attendantId: null, status: 'pending', credits: standard.credits, standardMinutes: standard.minutes, startedAt: null, finishedAt: null, runningSince: null, workedMinutes: 0, checklist: [], workOrderIds: [], lostFound: [], note, history: [event('created', me, note)] }
    s.roomTasks.push(t)
    return t
  }

  /** Pieces one room of the unit's type holds, from the room type's linen par. */
  const roomSet = (unitId: string) => s.linenPars.find((p) => p.groupId === s.catalog().unit(unitId).groupId)?.lines ?? []

  function addSoiled(villaId: string, lines: readonly StockLine[], sign: 1 | -1) {
    for (const l of lines) {
      const row = s.linenSoiled.find((c) => c.villaId === villaId && c.itemId === l.itemId)
      if (row) row.quantity += sign * l.quantity
      else s.linenSoiled.push({ villaId, itemId: l.itemId, quantity: sign * l.quantity })
    }
  }

  function assertSoiled(villaId: string, lines: readonly StockLine[]) {
    for (const l of lines) {
      const held = s.linenSoiled.find((c) => c.villaId === villaId && c.itemId === l.itemId)?.quantity ?? 0
      if (l.quantity > held) {
        const item = findById(s.stockItems, l.itemId, 'stock item')
        throw new RuleError('LINEN_SHORT', `${s.catalog().villa(villaId).name} holds ${held} soiled ${item.name}; ${l.quantity} cannot leave.`)
      }
    }
  }

  /** A departure clean starting takes a dirty room to cleaning on the board; the stay must have left. */
  function startDeparture(t: RoomTask, me: User) {
    const stay = t.bookingId ? s.bookings.find((b) => b.id === t.bookingId) : undefined
    if (stay && stay.status === 'checked_in') throw new RuleError('TASK_INVALID_STATE', `${stay.code} has not checked out of ${unitCode(t.unitId)} yet.`)
    const record = housekeepingRecord(t.unitId)
    if (record.state === 'dirty') {
      Object.assign(record, { state: 'cleaning', updatedOn: today(), updatedBy: me.name, note: `${t.number} started` })
      log('status', 'housekeeping', unitCode(t.unitId), `${unitCode(t.unitId)} dirty to cleaning`, { state: 'dirty' }, { state: 'cleaning' }, me)
    }
  }

  return {
    settings: () => later(() => copy(s.hkSettings)),
    saveSettings: (settings) =>
      later(() => {
        assertEditor(user())
        refuse(validateHousekeepingSettings(settings))
        const before = { dailyQuota: s.hkSettings.dailyQuota, turndown: s.hkSettings.turndown }
        s.hkSettings = copy(settings)
        log('update', 'housekeeping-settings', 'housekeeping', 'Changed the housekeeping quota and standards', before, { dailyQuota: settings.dailyQuota, turndown: settings.turndown })
        return copy(s.hkSettings)
      }),
    tasks: () => later(() => copy(s.roomTasks)),
    planDay: (date) =>
      later(() => {
        const me = user()
        assertEditor(me)
        const dirty = new Set(s.housekeeping.filter((h) => h.state === 'dirty').map((h) => h.unitId))
        const stays = s.bookings.filter((b) => b.unitAssigned && (b.status === 'checked_in' || b.status === 'checked_out' || b.status === 'confirmed'))
        const planned = planTasks({ date, units: s.units, stays, dirty: date === today() ? dirty : new Set(), turndown: s.hkSettings.turndown, existing: s.roomTasks.filter((t) => t.date === date && t.status !== 'cancelled') })
        const created = planned.map((p) => newTask(p, date, me))
        log('create', 'housekeeping-task', date, `Planned ${created.length} housekeeping tasks for ${date}`)
        return copy(created)
      }),
    addTask: (input) =>
      later(() => {
        const me = user()
        assertEditor(me)
        refuse(validateTask(input))
        const unit = s.catalog().unit(input.unitId)
        const stay = s.bookings.find((b) => b.unitId === unit.id && b.status === 'checked_in' && b.checkIn <= input.date && input.date < b.checkOut)
        const t = newTask({ unitId: unit.id, villaId: unit.villaId, type: input.type, bookingId: stay?.id ?? null }, input.date, me, input.note.trim())
        if (input.attendantId) {
          if (!onShift(input.date).some((a) => a.id === input.attendantId)) throw new RuleError('NOT_ON_SHIFT', 'That attendant is not on shift that day.')
          t.attendantId = input.attendantId
        }
        log('create', 'housekeeping-task', t.number, `Added ${TASK_TYPE_LABEL[t.type].toLowerCase()} for ${unit.code} on ${t.date}`)
        return copy(t)
      }),
    assign: (taskIds, attendantId) =>
      later(() => {
        const me = user()
        assertEditor(me)
        const list = taskIds.map(task)
        for (const t of list) {
          if (!isOpenTask(t)) throw new RuleError('TASK_INVALID_STATE', `${t.number} is closed; it keeps its attendant.`)
          if (attendantId && !onShift(t.date).some((a) => a.id === attendantId)) throw new RuleError('NOT_ON_SHIFT', `That attendant is not on shift on ${t.date}.`)
        }
        const name = attendantId ? findById(s.employees, attendantId, 'employee').name : 'unassigned'
        for (const t of list) {
          t.attendantId = attendantId
          t.history = [...t.history, event('assigned', me, name)]
        }
        log('update', 'housekeeping-task', list.map((t) => t.number).join(', '), `Gave ${list.length} tasks to ${name}`)
        return copy(list)
      }),
    autoAssign: (date) =>
      later(() => {
        const me = user()
        assertEditor(me)
        const cat = s.catalog()
        const day = s.roomTasks.filter((t) => t.date === date)
        const credits = creditsByAttendant(day)
        const attendants = onShift(date).map((a) => ({ id: a.id, villaIds: a.villaIds, locationIds: a.villaIds.map((v) => cat.villa(v).locationId), credits: credits.get(a.id) ?? 0 }))
        const open = day.filter((t) => t.attendantId === null && t.status === 'pending').map((t) => ({ id: t.id, villaId: t.villaId, locationId: cat.villa(t.villaId).locationId, unitCode: cat.unit(t.unitId).code, type: t.type, credits: t.credits }))
        const given = autoAssign(open, attendants, s.hkSettings.dailyQuota)
        const changed = given.map(({ taskId, attendantId }) => {
          const t = task(taskId)
          t.attendantId = attendantId
          t.history = [...t.history, event('assigned', me, `Auto-assigned to ${findById(s.employees, attendantId, 'employee').name}`)]
          return t
        })
        log('update', 'housekeeping-task', date, `Auto-assigned ${changed.length} of ${open.length} open tasks for ${date}`)
        return copy(changed)
      }),
    workTask: (id, action, input) =>
      later(() => {
        const me = user()
        const t = task(id)
        assertWorker(t, me)
        const to = assertTaskAction(t, action)
        const now = clockNow()
        if (action === 'done') {
          const items = TASK_CHECKLIST[t.type]
          const ticks = input.checklist ?? []
          if (items.some((item) => !ticks.some((x) => x.item === item && x.ok))) throw new RuleError('VALIDATION_ERROR', 'Tick every line of the checklist, or report what is wrong.')
          t.checklist = items.map((item) => ({ item, ok: true }))
        }
        if (action === 'start' && t.type === 'departure') startDeparture(t, me)
        if ((action === 'dnd' || action === 'refused') && !t.bookingId) throw new RuleError('TASK_INVALID_STATE', `${unitCode(t.unitId)} has no guest in house.`)
        if (t.runningSince && (action === 'pause' || action === 'done' || action === 'cancel')) {
          t.workedMinutes += minutesBetween(t.runningSince, now)
          t.runningSince = null
        }
        if (action === 'start' || action === 'resume') t.runningSince = now
        if (action === 'start') t.startedAt = now
        if (action === 'done' || action === 'dnd' || action === 'refused') t.finishedAt = now
        if (action === 'done' && t.type === 'departure') {
          // The used set goes to the soiled bags; the board waits for the supervisor's inspection.
          addSoiled(t.villaId, roomSet(t.unitId), 1)
          const record = housekeepingRecord(t.unitId)
          if (record.state === 'cleaning') Object.assign(record, { updatedOn: today(), updatedBy: me.name, note: `Cleaned by ${me.name}, waiting for inspection` })
        }
        const before = t.status
        t.status = to
        const note = input.note?.trim() ?? ''
        if (note) t.note = [t.note, note].filter(Boolean).join(' · ')
        t.history = [...t.history, event(action, me, note)]
        log('status', 'housekeeping-task', t.number, `${t.number} ${unitCode(t.unitId)}: ${TASK_ACTION_LABEL[action].toLowerCase()}`, { status: before }, { status: to }, me)
        return copy(t)
      }),
    reportIssue: (id, input: TaskIssueInput) =>
      later(() => {
        const me = user()
        const t = task(id)
        assertWorker(t, me)
        refuse({ title: input.title.trim().length < 4 ? 'Say what needs fixing.' : undefined })
        const w = newWorkOrder({ villaId: t.villaId, unitId: t.unitId, assetId: null, planId: null, source: 'inspection', category: input.category, priority: input.urgent ? 'urgent' : 'normal', title: `${unitCode(t.unitId)}: ${input.title.trim()}`, description: [input.description.trim(), `Found during ${t.number}`].filter(Boolean).join(' · '), assigneeId: null, vendorId: null, scheduledOn: null, parts: [], labourCost: 0, vendorCost: 0, beforePhotos: [], afterPhotos: [] })
        t.workOrderIds = [...t.workOrderIds, w.id]
        t.history = [...t.history, event('issue', me, `${w.number} ${input.title.trim()}`)]
        log('update', 'housekeeping-task', t.number, `${t.number} reported ${w.number}`, null, null, me)
        return copy({ task: t, workOrderId: w.id })
      }),
    noteLostFound: (id, note, ref) =>
      later(() => {
        const me = user()
        const t = task(id)
        assertWorker(t, me)
        refuse({ note: note.trim().length < 3 ? 'Say what was found and where.' : undefined })
        // The find becomes a lost and found record on the unit and the stay, unless the task points at one already.
        const item = ref ?? logLostItem({ foundOn: today(), villaId: t.villaId, unitId: t.unitId, where: `${TASK_TYPE_LABEL[t.type]}, ${t.number}`, description: note, photos: [], guestId: null, bookingId: t.bookingId, storage: '' }, me).id
        t.lostFound = [...t.lostFound, { note: note.trim(), ref: item, by: me.name, at: clockNow() }]
        t.history = [...t.history, event('lost_found', me, note.trim())]
        log('update', 'housekeeping-task', t.number, `${t.number} found: ${note.trim()}`, null, null, me)
        return copy(t)
      }),
    linenPars: () => later(() => copy(s.linenPars)),
    saveLinenPar: (groupId, input) =>
      later(() => {
        assertEditor(user())
        refuse(validateLinenPar(input))
        const group = s.catalog().group(groupId)
        for (const l of input.lines) if (findById(s.stockItems, l.itemId, 'stock item').kind !== 'linen') throw new RuleError('VALIDATION_ERROR', 'Only linen items make a linen par.')
        const par = { groupId, sets: input.sets, lines: input.lines.map((l) => ({ ...l })) }
        s.linenPars = [...s.linenPars.filter((p) => p.groupId !== groupId), par]
        log('update', 'linen-par', groupId, `Set the ${group.name} linen par to ${par.sets} sets of ${par.lines.length} items`)
        return copy(par)
      }),
    linenSoiled: () => later(() => copy(s.linenSoiled)),
    discardLinen: (input) =>
      later(() =>
        atomically(() => {
          const me = user()
          assertEditor(me)
          const lines = input.lines.filter((l) => l.quantity > 0)
          refuse({ lines: lines.length === 0 ? 'Count what is discarded.' : undefined, reason: input.reason.trim().length < 3 ? 'Say why the linen is discarded.' : undefined })
          if (input.from === 'soiled') {
            assertSoiled(input.villaId, lines)
            addSoiled(input.villaId, lines, -1)
          }
          const moved = writeOff(input.villaId, lines, `Linen discarded: ${input.reason.trim()}`, me)
          log('create', 'linen-discard', moved[0]?.number ?? '', `Discarded ${lines.reduce((n, l) => n + l.quantity, 0)} linen pieces in ${s.catalog().villa(input.villaId).name}`)
          return copy(moved)
        }),
      ),
    laundryBatches: () => later(() => copy(s.laundryBatches)),
    sendLaundry: (input) =>
      later(() => {
        const me = user()
        assertEditor(me)
        refuse(validateLaundrySend(input))
        const lines = input.lines.filter((l) => l.quantity > 0)
        assertSoiled(input.villaId, lines)
        addSoiled(input.villaId, lines, -1)
        const n = seq('laundryBatch')
        const batch = { id: `lnb-${n}`, number: `LDY-${200 + n}`, villaId: input.villaId, vendor: input.vendor.trim(), status: 'out' as const, sentOn: input.sentOn, returnedOn: null, lines: lines.map((l) => ({ itemId: l.itemId, sent: l.quantity, returned: 0, damaged: 0 })), cost: 0, method: 'cash' as const, reference: '', attachments: [], transactionId: null, writeOffs: [], sentBy: me.name, returnedBy: '', note: input.note.trim() }
        s.laundryBatches.push(batch)
        log('create', 'laundry-batch', batch.number, `Sent ${lines.reduce((n, l) => n + l.quantity, 0)} pieces from ${s.catalog().villa(input.villaId).name} to ${batch.vendor}`)
        return copy(batch)
      }),
    returnLaundry: (id, input) =>
      later(() =>
        atomically(() => {
          const me = user()
          assertEditor(me)
          const batch = findById(s.laundryBatches, id, 'laundry batch')
          if (batch.status !== 'out') throw new RuleError('LAUNDRY_INVALID_STATE', `${batch.number} came back on ${batch.returnedOn}.`)
          refuse(validateLaundryReturn(batch, input))
          batch.lines = batch.lines.map((l) => {
            const back = input.lines.find((x) => x.itemId === l.itemId)
            return { ...l, returned: back?.returned ?? 0, damaged: back?.damaged ?? 0 }
          })
          const lost = batch.lines.map((l) => ({ itemId: l.itemId, quantity: missingOf(l) + l.damaged })).filter((l) => l.quantity > 0)
          const moved = lost.length ? writeOff(batch.villaId, lost, `Laundry ${batch.number}: missing or damaged at ${batch.vendor}`, me) : []
          const villa = s.catalog().villa(batch.villaId)
          let transactionId: string | null = null
          if (input.cost > 0) {
            const box = s.cashAccounts.find((a) => a.kind === 'cashbox' && a.locationId === villa.locationId)
            const bank = s.cashAccounts.find((a) => a.kind === 'bank')
            const account = input.method === 'cash' ? (box ?? bank) : (bank ?? box)
            if (!account) throw new RuleError('VALIDATION_ERROR', 'No account to pay from.')
            transactionId = newTransaction({ accountId: account.id, kind: 'cash_out', categoryId: 'cat-house', amount: input.cost, date: input.returnedOn, locationId: villa.locationId, villaId: villa.id, unitId: null, bookingId: null, description: `${batch.number} laundry, ${batch.vendor}`, reference: input.reference.trim() || batch.number, origin: 'maintenance', transferId: null, attachments: [...input.attachments] }, true, me).id
          }
          Object.assign(batch, { status: 'returned', returnedOn: input.returnedOn, cost: input.cost, method: input.method, reference: input.reference.trim(), attachments: [...input.attachments], transactionId, writeOffs: moved.map((m) => m.number), returnedBy: me.name })
          log('update', 'laundry-batch', batch.number, `${batch.number} back from ${batch.vendor}${lost.length ? `, ${lost.reduce((n, l) => n + l.quantity, 0)} pieces written off` : ''}`, null, { cost: input.cost })
          return copy(batch)
        }),
      ),
  }
}

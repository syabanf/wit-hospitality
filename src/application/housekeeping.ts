import type { Action, Module, User } from '@/domain/access'
import { RuleError } from '@/domain/errors'
import {
  attendantsOnShift,
  creditsByAttendant,
  DND_ALERT_DAYS,
  dndStreak,
  isClosedTask,
  isOpenTask,
  LAUNDRY_STATUS_LABEL,
  linenLevels,
  missingOf,
  parCoverage,
  taskMinutes,
  validateHousekeepingSettings,
  validateLaundryReturn,
  validateLaundrySend,
  validateLinenPar,
  validateTask,
  type ChecklistTick,
  type HousekeepingSettings,
  type LaundryReturnInput,
  type LaundrySendInput,
  type LinenLevel,
  type LinenPar,
  type RoomTask,
  type TaskAction,
  type TaskInput,
} from '@/domain/housekeeping'
import type { HousekeepingState } from '@/domain/maintenance'
import type { Catalog, Scope } from '@/domain/property'
import { onHand, type StockItem, type StockLine } from '@/domain/stock'
import { addDays, eachDay, type IsoDate } from '@/lib/dates'
import type { Ports, TaskIssueInput } from './ports'
import type { ReportRow } from './views'

export interface TaskView extends RoomTask {
  unitCode: string
  villaName: string
  locationId: string
  attendantName: string
  guestName: string
  bookingCode: string
  /** Minutes worked so far, the running stretch included. */
  minutes: number
  boardState: HousekeepingState | null
  workOrders: ReadonlyArray<{ id: string; number: string }>
}

export interface AttendantView {
  id: string
  name: string
  shiftName: string
  villaNames: string
  credits: number
  over: boolean
  tasks: number
  closed: number
}

export interface DndAlert {
  bookingId: string
  bookingCode: string
  guestName: string
  unitCode: string
  days: number
}

export interface VillaLinen {
  villa: Catalog['villas'][number]
  levels: Array<LinenLevel & { item: StockItem; coverage: number }>
  flagged: number
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
}

/** Now as the API stamps it, so a running task shows its minutes. */
const clockNow = (today: IsoDate) => `${today}T${new Date().toTimeString().slice(0, 8)}`
const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

/** Room attendant assignments, their phone list, linen per villa and laundry batches, as the signed-in user may see them. */
export function createHousekeepingServices({ ports, today, catalog, allow, access, check }: Deps) {
  async function world() {
    const [cat, tasks, settings, employees, roster, leaves, shifts, bookings, guests, board, workOrders] = await Promise.all([
      catalog(),
      ports.housekeeping.tasks(),
      ports.housekeeping.settings(),
      ports.hr.employees(),
      ports.hr.assignments(),
      ports.hr.leaves(),
      ports.hr.shifts(),
      ports.booking.bookings(),
      ports.guest.guests(),
      ports.maintenance.housekeeping(),
      ports.maintenance.workOrders(),
    ])
    const villaIds = new Set(cat.villas.map((v) => v.id))
    const now = clockNow(today())
    const villaName = (id: string) => cat.villas.find((v) => v.id === id)?.name ?? ''
    const describe = (t: RoomTask): TaskView => {
      const booking = t.bookingId ? bookings.find((b) => b.id === t.bookingId) : undefined
      return {
        ...t,
        unitCode: cat.unit(t.unitId).code,
        villaName: villaName(t.villaId),
        locationId: cat.villa(t.villaId).locationId,
        attendantName: employees.find((e) => e.id === t.attendantId)?.name ?? '',
        guestName: booking ? (guests.find((g) => g.id === booking.guestId)?.name ?? '') : '',
        bookingCode: booking?.code ?? '',
        minutes: taskMinutes(t, now),
        boardState: board.find((h) => h.unitId === t.unitId)?.state ?? null,
        workOrders: t.workOrderIds.flatMap((id) => workOrders.filter((w) => w.id === id).map((w) => ({ id: w.id, number: w.number }))),
      }
    }
    const mine = tasks.filter((t) => villaIds.has(t.villaId))
    return { cat, tasks: mine, settings, employees, roster, leaves, shifts, bookings, guests, describe, villaName }
  }

  type World = Awaited<ReturnType<typeof world>>

  function attendantsOf(w: World, date: IsoDate): AttendantView[] {
    const day = w.tasks.filter((t) => t.date === date)
    const credits = creditsByAttendant(day)
    return attendantsOnShift(w.employees, w.roster, w.leaves, date)
      .filter((a) => a.villaIds.some((v) => w.cat.villas.some((x) => x.id === v)))
      .map((a) => {
        const list = day.filter((t) => t.attendantId === a.id && t.status !== 'cancelled')
        const total = credits.get(a.id) ?? 0
        return { id: a.id, name: a.name, shiftName: w.shifts.find((s) => s.id === a.shiftId)?.name ?? '', villaNames: a.villaIds.map(w.villaName).filter(Boolean).join(', '), credits: total, over: total > w.settings.dailyQuota, tasks: list.length, closed: list.filter(isClosedTask).length }
      })
  }

  function dndAlerts(w: World, date: IsoDate): DndAlert[] {
    const stays = new Set(w.tasks.filter((t) => t.date === date && t.type === 'stayover' && t.bookingId).map((t) => t.bookingId as string))
    return [...stays].flatMap((bookingId) => {
      const days = dndStreak(w.tasks, bookingId, date)
      if (days < DND_ALERT_DAYS) return []
      const b = w.bookings.find((x) => x.id === bookingId)
      return b ? [{ bookingId, bookingCode: b.code, guestName: w.guests.find((g) => g.id === b.guestId)?.name ?? '', unitCode: w.cat.unit(b.unitId).code, days }] : []
    })
  }

  async function linenWorld() {
    const [cat, items, movements, pars, soiled, batches, transactions] = await Promise.all([catalog(), ports.stock.items(), ports.stock.movements(), ports.housekeeping.linenPars(), ports.housekeeping.linenSoiled(), ports.housekeeping.laundryBatches(), ports.finance.transactions()])
    const linenItems = items.filter((i) => i.kind === 'linen')
    const parOf = (groupId: string | null) => pars.find((p) => p.groupId === groupId)
    const writtenOff = (villaId: string, itemId: string, from?: IsoDate, to?: IsoDate) => -sum(movements.filter((m) => m.villaId === villaId && m.itemId === itemId && m.kind === 'write_off' && (!from || m.on >= from) && (!to || m.on <= to)).map((m) => m.quantity))
    const levelsOf = (villaId: string) => {
      const units = cat.units.filter((u) => u.villaId === villaId && u.status !== 'inactive')
      const perUnit = (itemId: string, times: (p: LinenPar) => number) => sum(units.map((u) => { const p = parOf(u.groupId); return p ? (p.lines.find((l) => l.itemId === itemId)?.quantity ?? 0) * times(p) : 0 }))
      const carried = linenItems.filter((i) => perUnit(i.id, () => 1) > 0 || movements.some((m) => m.villaId === villaId && m.itemId === i.id))
      const levels = linenLevels({
        itemIds: carried.map((i) => i.id),
        inUse: (itemId) => perUnit(itemId, () => 1),
        par: (itemId) => perUnit(itemId, (p) => p.sets),
        owned: (itemId) => onHand(movements, villaId, itemId),
        soiled: (itemId) => soiled.find((c) => c.villaId === villaId && c.itemId === itemId)?.quantity ?? 0,
        laundry: (itemId) => sum(batches.filter((b) => b.villaId === villaId && b.status === 'out').flatMap((b) => b.lines.filter((l) => l.itemId === itemId).map((l) => l.sent))),
        discarded: (itemId) => writtenOff(villaId, itemId),
      })
      return levels.map((l) => ({ ...l, item: linenItems.find((i) => i.id === l.itemId) as StockItem, coverage: parCoverage(l) }))
    }
    const villas: VillaLinen[] = cat.villas.map((villa) => {
      const levels = levelsOf(villa.id)
      return { villa, levels, flagged: levels.filter((l) => l.short > 0 || l.owned < l.par).length }
    })
    const batchViews = batches
      .filter((b) => cat.villas.some((v) => v.id === b.villaId))
      .sort((a, b) => b.sentOn.localeCompare(a.sentOn) || b.number.localeCompare(a.number))
      .map((b) => {
        const entry = b.transactionId ? (transactions.find((t) => t.id === b.transactionId) ?? null) : null
        return { ...b, villaName: cat.villa(b.villaId).name, sent: sum(b.lines.map((l) => l.sent)), returned: sum(b.lines.map((l) => l.returned)), damaged: sum(b.lines.map((l) => l.damaged)), missing: b.status === 'returned' ? sum(b.lines.map(missingOf)) : 0, entry }
      })
    return { cat, linenItems, pars, soiled, villas, batches: batchViews, writtenOff }
  }

  return {
    /** The supervisor's day: every task with its attendant, the attendants on shift with their credits, and the flags. */
    async day(date: IsoDate = today()) {
      const [w, a] = await Promise.all([world(), access()])
      const tasks = w.tasks.filter((t) => t.date === date).map(w.describe).sort((x, y) => x.villaName.localeCompare(y.villaName) || x.unitCode.localeCompare(y.unitCode))
      const attendants = attendantsOf(w, date)
      return {
        date,
        today: today(),
        catalog: w.cat,
        settings: w.settings,
        tasks,
        attendants,
        unassigned: tasks.filter((t) => !t.attendantId && isOpenTask(t)).length,
        overQuota: attendants.filter((x) => x.over).length,
        dnd: dndAlerts(w, date),
        canSupervise: a.can('maintenance', 'edit'),
      }
    },
    /** The attendant's phone list for today; a supervisor also sees everyone else's open work. */
    async myTasks() {
      const [w, a] = await Promise.all([world(), access()])
      const day = w.tasks.filter((t) => t.date === today()).map(w.describe)
      const employeeId = a.user.employeeId
      const mine = employeeId ? day.filter((t) => t.attendantId === employeeId) : []
      const supervisor = a.can('maintenance', 'approve')
      const order = (t: TaskView) => (t.status === 'in_progress' ? 0 : t.status === 'paused' ? 1 : t.status === 'pending' ? 2 : 3)
      const sorted = (list: TaskView[]) => [...list].sort((x, y) => order(x) - order(y) || x.unitCode.localeCompare(y.unitCode))
      return {
        today: today(),
        mine: sorted(mine),
        others: supervisor ? sorted(day.filter((t) => !mine.includes(t) && isOpenTask(t))) : [],
        credits: sum(mine.filter((t) => t.status !== 'cancelled').map((t) => t.credits)),
        quota: w.settings.dailyQuota,
        dnd: dndAlerts(w, today()),
        canWork: a.can('maintenance', 'edit') || a.can('maintenance', 'submit'),
      }
    },
    async planDay(date: IsoDate) {
      await allow('maintenance', 'edit')
      return ports.housekeeping.planDay(date)
    },
    async autoAssign(date: IsoDate) {
      await allow('maintenance', 'edit')
      return ports.housekeeping.autoAssign(date)
    },
    async assign(taskIds: readonly string[], attendantId: string | null) {
      await allow('maintenance', 'edit')
      if (taskIds.length === 0) throw new RuleError('VALIDATION_ERROR', 'Pick at least one task.')
      return ports.housekeeping.assign(taskIds, attendantId)
    },
    async addTask(input: TaskInput) {
      await allow('maintenance', 'edit')
      check(validateTask(input))
      return ports.housekeeping.addTask(input)
    },
    async saveSettings(settings: HousekeepingSettings) {
      await allow('maintenance', 'edit')
      check(validateHousekeepingSettings(settings))
      return ports.housekeeping.saveSettings(settings)
    },
    /** Start, pause, resume, done with the checklist, or the guest's do not disturb or refusal; the adapter checks it is the attendant's own task. */
    async work(id: string, action: TaskAction, input: { checklist?: readonly ChecklistTick[]; note?: string } = {}) {
      await allow('maintenance', 'submit')
      return ports.housekeeping.workTask(id, action, input)
    },
    /** A fault in the room opens a work order through the maintenance path. */
    async reportIssue(id: string, input: TaskIssueInput) {
      await allow('maintenance', 'create')
      check({ title: input.title.trim().length < 4 ? 'Say what needs fixing.' : undefined })
      return ports.housekeeping.reportIssue(id, input)
    },
    async noteLostFound(id: string, note: string, ref: string | null = null) {
      await allow('maintenance', 'submit')
      check({ note: note.trim().length < 3 ? 'Say what was found and where.' : undefined })
      return ports.housekeeping.noteLostFound(id, note, ref)
    },

    /** Linen per villa by state, the par per room type, soiled bags and laundry batches. */
    async linen() {
      const [l, a] = await Promise.all([linenWorld(), access()])
      return {
        catalog: l.cat,
        items: l.linenItems,
        villas: l.villas,
        pars: l.cat.groups.map((g) => ({ group: g, villaName: l.cat.villa(g.villaId).name, par: l.pars.find((p) => p.groupId === g.id) ?? null })),
        soiled: l.soiled.filter((c) => c.quantity > 0 && l.cat.villas.some((v) => v.id === c.villaId)),
        batches: l.batches,
        canEdit: a.can('maintenance', 'edit'),
        today: today(),
      }
    },
    async saveLinenPar(groupId: string, input: Pick<LinenPar, 'sets' | 'lines'>) {
      await allow('maintenance', 'edit')
      const kept = { ...input, lines: input.lines.filter((l) => l.quantity > 0) }
      check(validateLinenPar(kept))
      return ports.housekeeping.saveLinenPar(groupId, kept)
    },
    async discardLinen(input: { villaId: string; from: 'soiled' | 'clean'; lines: readonly StockLine[]; reason: string }) {
      await allow('maintenance', 'edit')
      check({ lines: input.lines.some((l) => l.quantity > 0) ? undefined : 'Count what is discarded.', reason: input.reason.trim().length < 3 ? 'Say why the linen is discarded.' : undefined })
      return ports.housekeeping.discardLinen(input)
    },
    async sendLaundry(input: LaundrySendInput) {
      await allow('maintenance', 'edit')
      check(validateLaundrySend(input))
      return ports.housekeeping.sendLaundry(input)
    },
    /** Counts what came back; losses are written off and the bill goes for approval as a cash-out. */
    async returnLaundry(id: string, input: LaundryReturnInput) {
      await allow('maintenance', input.cost > 0 ? 'submit' : 'edit')
      const batch = (await ports.housekeeping.laundryBatches()).find((b) => b.id === id)
      if (!batch) throw new RuleError('VALIDATION_ERROR', 'No such laundry batch.')
      check(validateLaundryReturn(batch, input))
      return ports.housekeeping.returnLaundry(id, input)
    },

    /** Rows for the housekeeping reports; `to` is inclusive. */
    async reportRows(slug: string, from: IsoDate, to: IsoDate, scope: Scope): Promise<ReportRow[]> {
      const villaIn = (cat: Catalog, villaId: string) => (!scope.villaId || villaId === scope.villaId) && (!scope.locationId || cat.villa(villaId).locationId === scope.locationId)
      const unitIn = (unitId: string) => !scope.unitId || unitId === scope.unitId
      if (slug === 'hk-productivity' || slug === 'hk-completion') {
        const w = await world()
        const range = w.tasks.filter((t) => t.date >= from && t.date <= to && villaIn(w.cat, t.villaId) && unitIn(t.unitId))
        if (slug === 'hk-productivity') {
          const ids = [...new Set(range.filter((t) => t.attendantId).map((t) => t.attendantId as string))]
          return ids
            .map((id) => {
              const done = range.filter((t) => t.attendantId === id && t.status === 'done')
              const worked = sum(done.map((t) => t.workedMinutes))
              const standard = sum(done.map((t) => t.standardMinutes))
              const days = new Set(range.filter((t) => t.attendantId === id && isClosedTask(t)).map((t) => t.date)).size
              const credits = sum(done.map((t) => t.credits))
              return { attendant: w.employees.find((e) => e.id === id)?.name ?? id, days, tasks: done.length, credits, creditsPerDay: days ? Math.round((credits / days) * 100) / 100 : 0, minutes: worked, standard, perTask: done.length ? Math.round(worked / done.length) : 0, efficiency: worked ? standard / worked : 0 }
            })
            .sort((a, b) => b.credits - a.credits)
        }
        return eachDay(from, addDays(to, 1)).flatMap((date) =>
          w.cat.villas
            .filter((v) => villaIn(w.cat, v.id))
            .flatMap((v) => {
              const list = range.filter((t) => t.date === date && t.villaId === v.id)
              if (list.length === 0) return []
              const done = list.filter((t) => t.status === 'done').length
              const declined = list.filter((t) => t.status === 'dnd' || t.status === 'refused').length
              const planned = list.filter((t) => t.status !== 'cancelled').length
              return [{ date, villa: v.name, planned, done, declined, open: list.filter(isOpenTask).length, cancelled: list.length - planned, completion: planned ? (done + declined) / planned : 0 }]
            }),
        )
      }
      const l = await linenWorld()
      if (slug === 'linen-par') {
        return l.villas
          .filter((v) => villaIn(l.cat, v.villa.id) && v.levels.some((x) => x.par > 0 || x.owned > 0))
          .flatMap((v) => v.levels.map((x) => ({ villa: v.villa.name, item: x.item.name, par: x.par, owned: x.owned, coverage: x.coverage, inUse: x.inUse, clean: x.clean, soiled: x.soiled, laundry: x.laundry, lost: l.writtenOff(v.villa.id, x.itemId, from, to), short: Math.max(0, x.par - x.owned) })))
      }
      if (slug === 'laundry-batches') {
        return l.batches
          .filter((b) => b.sentOn >= from && b.sentOn <= to && villaIn(l.cat, b.villaId))
          .map((b) => ({ number: b.number, villa: b.villaName, vendor: b.vendor, sentOn: b.sentOn, returnedOn: b.returnedOn ?? 'Still out', status: LAUNDRY_STATUS_LABEL[b.status], sent: b.sent, returned: b.returned, damaged: b.damaged, missing: b.missing, cost: b.cost, entry: b.entry ? `${b.entry.number} ${b.entry.status}` : '' }))
      }
      throw new RuleError('VALIDATION_ERROR', `No housekeeping report ${slug}.`)
    },
  }
}

export type HousekeepingServices = ReturnType<typeof createHousekeepingServices>

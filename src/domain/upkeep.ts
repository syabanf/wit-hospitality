import type { IsoDate } from '@/lib/dates'
import { RuleError } from './errors'
import type { ServiceWindow } from './hospitality'
import type { IntervalUnit, MaintenanceCategory, PreventivePlan, WorkOrder, WorkOrderStatus } from './maintenance'
import { WORK_ORDER_STATUS_LABEL } from './maintenance'

/**
 * Pool, garden and fogging upkeep: preventive plan templates for a villa, the tasks they open with
 * their checklists and pool chemistry, kept clear of a guest's do-not-disturb and service window.
 * Contract: api/docs/contracts/villa-operations-contract.md section 4.
 */

export type UpkeepTemplate = 'pool' | 'garden' | 'fogging'
export const UPKEEP_TEMPLATES: readonly UpkeepTemplate[] = ['pool', 'garden', 'fogging']
export const UPKEEP_TEMPLATE_LABEL: Record<UpkeepTemplate, string> = { pool: 'Pool', garden: 'Garden', fogging: 'Fogging' }

export interface UpkeepJob {
  key: string
  title: string
  category: MaintenanceCategory
  every: number
  unit: IntervalUnit
  checklist: readonly string[]
  readings: boolean
  outsideWindow: boolean
  notifyStay: boolean
}

const job = (key: string, title: string, category: MaintenanceCategory, every: number, unit: IntervalUnit, checklist: string[], extra: Partial<Pick<UpkeepJob, 'readings' | 'outsideWindow' | 'notifyStay'>> = {}): UpkeepJob => ({ key, title, category, every, unit, checklist, readings: false, outsideWindow: false, notifyStay: false, ...extra })

export const UPKEEP_JOBS: Record<UpkeepTemplate, readonly UpkeepJob[]> = {
  pool: [
    job('pool_daily', 'Pool skim and chemical check', 'pool', 1, 'days', ['Skim the surface', 'Empty the skimmer baskets', 'Test pH and chlorine', 'Dose chemicals when out of range'], { readings: true }),
    job('pool_weekly', 'Pool vacuum', 'pool', 7, 'days', ['Brush the walls and steps', 'Vacuum the floor', 'Check the pump pressure']),
    job('pool_monthly', 'Pool filter backwash', 'pool', 1, 'months', ['Backwash the filter', 'Rinse the filter', 'Top up the water level', 'Log the pressure after']),
  ],
  garden: [
    job('garden_weekly', 'Garden mowing and trimming', 'garden', 7, 'days', ['Mow the lawn', 'Trim the hedges and edges', 'Clear the cuttings']),
    job('garden_monthly', 'Garden fertilising', 'garden', 1, 'months', ['Fertilise the lawn and beds', 'Water in after feeding']),
  ],
  fogging: [job('fogging_monthly', 'Mosquito fogging', 'pest', 1, 'months', ['Fog the garden and drains', 'Treat standing water', 'Air the terrace afterwards'], { outsideWindow: true, notifyStay: true })],
}

export interface PlanUpkeep {
  template: UpkeepTemplate
  key: string
  readings: boolean
  outsideWindow: boolean
  notifyStay: boolean
}

export interface PoolReadings {
  ph: number
  chlorine: number
  flags: readonly string[]
}

export interface UpkeepNotice {
  bookingId: string
  bookingCode: string
  text: string
  sentOn: IsoDate | null
}

export interface WorkOrderUpkeep {
  key: string
  checklist: readonly { item: string; done: boolean }[]
  readingsRequired: boolean
  readings: PoolReadings | null
  window: { from: string; to: string } | null
  outsideWindow: boolean
  notice: UpkeepNotice | null
}

export interface ApplyTemplateInput {
  villaId: string
  unitId: string | null
  template: UpkeepTemplate
  startOn: IsoDate
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Field errors, then UPKEEP_APPLIED when an active plan of the template is on that villa and unit. */
export function validateApplyTemplate(input: ApplyTemplateInput, villaName: string, unitVilla: (unitId: string) => string | undefined, plans: readonly PreventivePlan[]): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!UPKEEP_TEMPLATES.includes(input.template)) errors.template = 'Pick pool, garden or fogging.'
  if (!DATE.test(input.startOn)) errors.startOn = 'Pick the first day.'
  if (input.unitId && unitVilla(input.unitId) !== input.villaId) errors.unitId = 'Pick a unit of this villa.'
  if (Object.keys(errors).length) return errors
  if (plans.some((p) => p.active && p.upkeep?.template === input.template && p.villaId === input.villaId && p.unitId === input.unitId))
    throw new RuleError('UPKEEP_APPLIED', `${villaName} already has the ${UPKEEP_TEMPLATE_LABEL[input.template]} plans.`)
  return errors
}

/** The plans a template gives a villa, without ids. */
export const templatePlans = (input: ApplyTemplateInput): Omit<PreventivePlan, 'id'>[] =>
  UPKEEP_JOBS[input.template].map((j) => ({
    title: j.title,
    category: j.category,
    villaId: input.villaId,
    unitId: input.unitId,
    assetId: null,
    every: j.every,
    unit: j.unit,
    nextDue: input.startOn,
    lastDoneOn: null,
    checklist: [...j.checklist],
    assigneeId: null,
    vendorId: null,
    estimatedCost: 0,
    active: true,
    upkeep: { template: input.template, key: j.key, readings: j.readings, outsideWindow: j.outsideWindow, notifyStay: j.notifyStay },
  }))

/** The stay in house on the plan's unit, as the generator sees it. */
export interface UpkeepStay {
  bookingId: string
  bookingCode: string
  window: ServiceWindow
}

/**
 * What an upkeep plan's task looks like today: skipped (null) when the guest asked not to be
 * disturbed, else the task's upkeep and the line its description ends with.
 */
export function upkeepTask(plan: Pick<PreventivePlan, 'title' | 'checklist'> & { upkeep: PlanUpkeep }, stay: UpkeepStay | null, villaName: string, date: IsoDate): { upkeep: WorkOrderUpkeep; note: string } | null {
  if (stay?.window.mode === 'dnd') return null
  const window = stay && stay.window.mode === 'window' ? { from: stay.window.from, to: stay.window.to } : null
  const note = window ? `${plan.upkeep.outsideWindow ? 'Outside' : 'Within'} the guest's service window ${window.from} to ${window.to}.` : ''
  const notice: UpkeepNotice | null =
    stay && plan.upkeep.notifyStay
      ? { bookingId: stay.bookingId, bookingCode: stay.bookingCode, text: window ? `${plan.title} at ${villaName} on ${date}, outside your service window (${window.from} to ${window.to}). Please keep doors and windows closed for 30 minutes afterwards.` : `${plan.title} at ${villaName} on ${date}.`, sentOn: null }
      : null
  return { upkeep: { key: plan.upkeep.key, checklist: plan.checklist.map((item) => ({ item, done: false })), readingsRequired: plan.upkeep.readings, readings: null, window, outsideWindow: plan.upkeep.outsideWindow, notice }, note }
}

export const POOL_RANGE = { ph: [7.2, 7.8], chlorine: [1, 3] } as const

/** Out-of-range pool chemistry, as the task shows it. */
export function poolFlags(ph: number, chlorine: number): string[] {
  const flags: string[] = []
  if (ph < POOL_RANGE.ph[0]) flags.push('pH low')
  else if (ph > POOL_RANGE.ph[1]) flags.push('pH high')
  if (chlorine < POOL_RANGE.chlorine[0]) flags.push('Chlorine low')
  else if (chlorine > POOL_RANGE.chlorine[1]) flags.push('Chlorine high')
  return flags
}

export interface UpkeepInput {
  checklist: readonly boolean[]
  readings: { ph: number; chlorine: number } | null
  noticeSent: boolean
}

const CLOSED: readonly WorkOrderStatus[] = ['verified', 'cancelled']

/** The upkeep recording rules in the API's order. */
export function validateUpkeep(w: Pick<WorkOrder, 'number' | 'status' | 'upkeep'>, input: UpkeepInput): Record<string, string> {
  const upkeep = w.upkeep
  if (!upkeep) throw new RuleError('UPKEEP_NONE', `${w.number} is not an upkeep task.`)
  if (CLOSED.includes(w.status)) throw new RuleError('WORK_ORDER_INVALID_STATE', `${w.number} is ${WORK_ORDER_STATUS_LABEL[w.status].toLowerCase()}; its checklist is closed.`)
  const errors: Record<string, string> = {}
  if (input.checklist.length !== upkeep.checklist.length) errors.checklist = 'Tick the checklist as listed.'
  if (input.readings) {
    if (!upkeep.readingsRequired) errors.readings = 'This task records no readings.'
    else {
      const { ph, chlorine } = input.readings
      if (typeof ph !== 'number' || !Number.isFinite(ph) || ph < 0 || ph > 14) errors.ph = 'pH from 0 to 14.'
      if (typeof chlorine !== 'number' || !Number.isFinite(chlorine) || chlorine < 0 || chlorine > 20) errors.chlorine = 'Chlorine in ppm, from 0 to 20.'
    }
  }
  return errors
}

/** The upkeep after a valid recording. */
export function recordUpkeep(upkeep: WorkOrderUpkeep, input: UpkeepInput, today: IsoDate): WorkOrderUpkeep {
  return {
    ...upkeep,
    checklist: upkeep.checklist.map((c, i) => ({ item: c.item, done: Boolean(input.checklist[i]) })),
    readings: input.readings ? { ph: input.readings.ph, chlorine: input.readings.chlorine, flags: poolFlags(input.readings.ph, input.readings.chlorine) } : upkeep.readings,
    notice: upkeep.notice && input.noticeSent && !upkeep.notice.sentOn ? { ...upkeep.notice, sentOn: today } : upkeep.notice,
  }
}

/** A task that records pool chemistry does not close without it. */
export function assertReadingsBeforeDone(w: Pick<WorkOrder, 'number' | 'upkeep'>, to: WorkOrderStatus) {
  if (to === 'done' && w.upkeep?.readingsRequired && !w.upkeep.readings) throw new RuleError('READINGS_REQUIRED', `Record the pH and chlorine on ${w.number} before closing it.`)
}

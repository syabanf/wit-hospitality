import type { IsoDate } from '@/lib/dates'

/** A company notice for the employee area; pinned ones stay on top of the home screen. */
export interface Announcement {
  id: string
  title: string
  body: string
  publishedOn: IsoDate
  by: string
  pinned: boolean
  /** Null reaches everyone; a villa id reaches its team. */
  villaId: string | null
}

export interface AnnouncementInput {
  title: string
  body: string
  pinned: boolean
  villaId: string | null
}

export function validateAnnouncement(input: AnnouncementInput): Partial<Record<keyof AnnouncementInput, string>> {
  const errors: Partial<Record<keyof AnnouncementInput, string>> = {}
  if (input.title.trim().length < 4) errors.title = 'Give the notice a title.'
  if (input.body.trim().length < 10) errors.body = 'Write the notice.'
  return errors
}

export interface KpiItem {
  name: string
  target: number
  actual: number
  /** Weights add up to 100. */
  weight: number
  unit: string
}

export type KpiStatus = 'draft' | 'published'

/** One employee's scorecard for a period, written by the manager and read by the employee. */
export interface KpiReview {
  id: string
  employeeId: string
  /** "YYYY-Qn". */
  period: string
  items: readonly KpiItem[]
  status: KpiStatus
  reviewer: string
  note: string
  reviewedOn: IsoDate
}

export interface KpiInput {
  employeeId: string
  period: string
  items: readonly KpiItem[]
  status: KpiStatus
  note: string
}

/** Weighted achievement, each item capped at 120% of target, as a 0 to 120 score. */
export function kpiScore(items: readonly KpiItem[]): number {
  const total = items.reduce((s, i) => s + i.weight, 0)
  if (!total) return 0
  return Math.round(items.reduce((s, i) => s + (i.target > 0 ? Math.min(1.2, i.actual / i.target) : 0) * i.weight, 0) / total * 100)
}

export type KpiBand = 'exceeds' | 'meets' | 'below'
export const KPI_BAND_LABEL: Record<KpiBand, string> = { exceeds: 'Exceeds target', meets: 'On target', below: 'Below target' }
export const kpiBand = (score: number): KpiBand => (score >= 105 ? 'exceeds' : score >= 90 ? 'meets' : 'below')

export function validateKpi(input: KpiInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!input.employeeId) errors.employeeId = 'Pick the employee.'
  if (!/^\d{4}-Q[1-4]$/.test(input.period)) errors.period = 'The period is a quarter, for example 2026-Q4.'
  if (input.items.length === 0) errors.items = 'Add at least one indicator.'
  const weight = input.items.reduce((s, i) => s + i.weight, 0)
  if (input.items.length && weight !== 100) errors.items = `The weights add up to ${weight}%, not 100%.`
  input.items.forEach((i, n) => {
    if (i.name.trim().length < 2) errors[`items.${n}.name`] = 'Name the indicator.'
    if (!(i.target > 0)) errors[`items.${n}.target`] = 'A target above zero.'
    if (i.actual < 0) errors[`items.${n}.actual`] = 'Zero or more.'
  })
  return errors
}

/** "2026-Q4" for a date. */
export const quarterOf = (iso: IsoDate) => `${iso.slice(0, 4)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`

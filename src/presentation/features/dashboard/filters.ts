import type { DashboardFilter } from '@/application/views'
import { PERIODS } from '@/domain/dashboard'

export type View = 'executive' | 'operational' | 'financial'
export const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: 'executive', label: 'Executive' },
  { value: 'operational', label: 'Operational' },
  { value: 'financial', label: 'Financial' },
]

export interface DashboardState extends DashboardFilter {
  view: View
}

/** Filters live in the URL, so Back and shared links keep them. */
export function parseState(params: URLSearchParams): DashboardState {
  const view = VIEWS.find((v) => v.value === params.get('view'))?.value ?? 'executive'
  const period = PERIODS.find((p) => p === params.get('period')) ?? '30d'
  const pick = (key: string) => params.get(key) || undefined
  return { view, period, locationId: pick('location'), villaId: pick('villa'), unitId: pick('unit'), source: pick('source'), from: pick('from'), to: pick('to') }
}

export function serializeState(state: DashboardState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.view !== 'executive') params.set('view', state.view)
  if (state.period !== '30d') params.set('period', state.period)
  if (state.locationId) params.set('location', state.locationId)
  if (state.villaId) params.set('villa', state.villaId)
  if (state.unitId) params.set('unit', state.unitId)
  if (state.source) params.set('source', state.source)
  if (state.from) params.set('from', state.from)
  if (state.to) params.set('to', state.to)
  return params
}

export const filterKey = (f: DashboardFilter) => [f.period, f.locationId, f.villaId, f.unitId, f.source, f.from, f.to].map((v) => v ?? '').join('|')

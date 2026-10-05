import { addDays, startOfMonth, type IsoDate } from '@/lib/dates'

export interface DateRange {
  from?: string
  to?: string
}

export type Preset = '' | 'today' | '7d' | '30d' | 'month' | 'custom'

export const PRESETS: ReadonlyArray<{ value: Preset; label: string }> = [
  { value: '', label: 'Any date' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom' },
]

export function presetRange(preset: Preset, today: IsoDate): DateRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: addDays(today, -6), to: today }
    case '30d':
      return { from: addDays(today, -29), to: today }
    case 'month':
      return { from: startOfMonth(today), to: today }
    default:
      return {}
  }
}

export function presetOf(range: DateRange, today: IsoDate): Preset {
  if (!range.from && !range.to) return ''
  const found = (['today', '7d', '30d', 'month'] as const).find((p) => {
    const r = presetRange(p, today)
    return r.from === range.from && r.to === range.to
  })
  return found ?? 'custom'
}


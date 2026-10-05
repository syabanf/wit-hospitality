import type { IsoDate } from '@/lib/dates'
import { Input, Select } from './Field'

import { presetOf, PRESETS, presetRange, type DateRange, type Preset } from './dateRange'

interface DateRangeFilterProps {
  value: DateRange
  onChange: (range: DateRange) => void
  today: IsoDate
  /** What the dates filter, for the labels: "Stay", "Date", "Requested". */
  label?: string
  tone?: 'inset' | 'card'
  className?: string
}

/** Preset select plus two date inputs; the page keeps `from` and `to` in the URL. */
export function DateRangeFilter({ value, onChange, today, label = 'Date', tone = 'inset', className }: DateRangeFilterProps) {
  const preset = presetOf(value, today)
  return (
    <div role="group" aria-label={`${label} filter`} className={className ?? 'flex flex-wrap items-center gap-2'}>
      <Select aria-label={`${label} preset`} tone={tone} value={preset} options={PRESETS} onChange={(e) => onChange(e.target.value === 'custom' ? { from: value.from ?? today, to: value.to ?? today } : presetRange(e.target.value as Preset, today))} />
      <Input tone={tone} className="h-10 w-[9.5rem] px-3" type="date" aria-label={`${label} from`} value={value.from ?? ''} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value || undefined })} />
      <span className="text-xs text-muted">to</span>
      <Input tone={tone} className="h-10 w-[9.5rem] px-3" type="date" aria-label={`${label} to`} value={value.to ?? ''} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value || undefined })} />
    </div>
  )
}

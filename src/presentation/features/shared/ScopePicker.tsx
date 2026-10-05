import type { Catalog, Scope } from '@/domain/property'
import { Select } from '../../ui/Field'

interface ScopePickerProps {
  catalog: Catalog
  value: Scope
  onChange: (scope: Scope) => void
  tone?: 'inset' | 'card'
  compact?: boolean
  /** Leave the unit select out (finance mapping to a villa, for example). */
  units?: boolean
  /** Hide the "All" rows, so a value is always picked (forms). */
  required?: boolean
  className?: string
}

/** Location, villa and unit selects that narrow each other; the URL or the form holds the result. */
export function ScopePicker({ catalog, value, onChange, tone = 'inset', compact = false, units = true, required = false, className }: ScopePickerProps) {
  const villas = catalog.villas.filter((v) => !value.locationId || v.locationId === value.locationId)
  const unitList = catalog.units.filter((u) => (value.villaId ? u.villaId === value.villaId : villas.some((v) => v.id === u.villaId)))
  const all = (label: string) => (required ? [] : [{ value: '', label }])
  const common = { tone, compact, className: 'min-w-0 flex-1 basis-0' }
  return (
    <div className={className}>
      <Select
        {...common}
        aria-label="Location"
        value={value.locationId ?? ''}
        options={[...all('All locations'), ...catalog.locations.map((l) => ({ value: l.id, label: l.name }))]}
        onChange={(e) => onChange({ locationId: e.target.value || undefined })}
      />
      <Select
        {...common}
        aria-label="Villa"
        value={value.villaId ?? ''}
        options={[...all('All villas'), ...villas.map((v) => ({ value: v.id, label: v.name }))]}
        onChange={(e) => {
          const villa = catalog.villas.find((v) => v.id === e.target.value)
          onChange({ locationId: villa?.locationId ?? value.locationId, villaId: villa?.id })
        }}
      />
      {units && (
        <Select
          {...common}
          aria-label="Unit"
          value={value.unitId ?? ''}
          options={[...all('All units'), ...unitList.map((u) => ({ value: u.id, label: u.code }))]}
          onChange={(e) => {
            const unit = catalog.units.find((u) => u.id === e.target.value)
            const villa = unit ? catalog.villa(unit.villaId) : undefined
            onChange({ locationId: villa?.locationId ?? value.locationId, villaId: villa?.id ?? value.villaId, unitId: unit?.id })
          }}
        />
      )}
    </div>
  )
}

import { cn } from '@/lib/cn'

interface CheckboxGridProps {
  name: string
  options: ReadonlyArray<{ id: string; label: string }>
  selected: readonly string[]
  /** Controlled: the caller keeps the list. Uncontrolled forms read `FormData.getAll(name)`. */
  onChange?: (selected: string[]) => void
  className?: string
}

/** Pill checkboxes for facilities and amenities; a checked pill is inverted. */
export function CheckboxGrid({ name, options, selected, onChange, className }: CheckboxGridProps) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {options.map((o) => {
        const on = selected.includes(o.id)
        return (
          <label key={o.id} className={cn('flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm transition-colors', on ? 'border-invert bg-invert text-on-invert' : 'border-line-strong bg-raised text-fg hover:bg-control')}>
            <input
              type="checkbox"
              name={name}
              value={o.id}
              checked={onChange ? on : undefined}
              defaultChecked={onChange ? undefined : on}
              onChange={onChange ? (e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id)) : undefined}
              className="sr-only"
            />
            {o.label}
          </label>
        )
      })}
    </div>
  )
}

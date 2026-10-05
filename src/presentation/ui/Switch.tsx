import { cn } from '@/lib/cn'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  className?: string
}

/** On/off control: red track when on. `label` names the setting for screen readers. */
export function Switch({ checked, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent-strong' : 'bg-control ring-1 ring-line-strong',
        className,
      )}
    >
      <span className={cn('size-6 rounded-full bg-white shadow-card transition-transform', checked && 'translate-x-5')} />
    </button>
  )
}

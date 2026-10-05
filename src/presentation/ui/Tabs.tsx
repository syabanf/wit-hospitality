import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'

export interface TabOption<T extends string> {
  value: T
  label: string
}

interface TabsProps<T extends string> {
  options: readonly TabOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  /** `pill`: white active pill in a dark track. `underline`: text tabs with an accent rule. */
  variant?: 'pill' | 'underline'
  className?: string
}

/** Single-select view switch with roving arrow keys. */
export function Tabs<T extends string>({ options, value, onChange, label, variant = 'pill', className }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function onKeyDown(e: KeyboardEvent, index: number) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (index + step + options.length) % options.length
    const option = options[next]
    if (!option) return
    onChange(option.value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center',
        variant === 'pill' ? 'gap-0.5 rounded-full border border-line-strong bg-raised p-1' : 'gap-5',
        className,
      )}
    >
      {options.map((option, i) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'cursor-pointer text-sm whitespace-nowrap transition-colors',
              variant === 'pill' && 'h-8 rounded-full px-3.5',
              variant === 'pill' && (active ? 'bg-invert font-medium text-on-invert' : 'text-muted hover:text-fg'),
              variant === 'underline' && 'border-b-2 pb-1.5',
              variant === 'underline' && (active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'),
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

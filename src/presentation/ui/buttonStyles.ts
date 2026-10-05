import { cn } from '@/lib/cn'

export type ButtonVariant = 'solid' | 'accent' | 'soft' | 'card' | 'ghost' | 'ink' | 'onPop'
export type ButtonSize = 'sm' | 'md' | 'icon-sm' | 'icon' | 'icon-lg'

const VARIANT: Record<ButtonVariant, string> = {
  /** Inverted pill: ink on light, white on dark. */
  solid: 'bg-invert text-on-invert hover:opacity-90',
  /** WIT red, the one primary action per region. */
  accent: 'bg-accent-strong text-white shadow-glow hover:opacity-90',
  /** Inside a card. */
  soft: 'border border-line-strong bg-raised text-fg hover:bg-control',
  /** On the canvas, beside cards. */
  card: 'border border-line bg-card text-fg shadow-card hover:bg-raised',
  ghost: 'text-muted hover:bg-control hover:text-fg',
  /** Dark button on a light pop surface. */
  ink: 'bg-ink text-on-ink hover:opacity-85',
  /** White button on a red or ink pop surface. */
  onPop: 'bg-white text-ink hover:opacity-90',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
  'icon-sm': 'size-8',
  icon: 'size-10',
  'icon-lg': 'size-12',
}

/** Button classes for elements that are not buttons, such as a router `Link`. */
export function buttonStyles({
  variant = 'soft',
  size = 'md',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full font-medium whitespace-nowrap transition-[color,background-color,opacity] select-none active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    className,
  )
}

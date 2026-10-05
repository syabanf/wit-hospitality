import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '../../ui/Button'
import { Skeleton } from '../../ui/States'
import { POP, type Pop } from '../../ui/pop'

/**
 * Condensed uppercase screen title ending in the WIT period.
 * The display face appears on phone titles and nowhere else.
 */
export function ScreenTitle({ children, period = 'text-accent', className }: { children: ReactNode; period?: string; className?: string }) {
  return (
    <h1 className={cn('font-display text-[34px] leading-[0.95] font-bold tracking-[-0.03em] uppercase', className)}>
      {children}
      <span className={period}>.</span>
    </h1>
  )
}

/** The period must stay visible on the band: white on red, ink on light pops. */
const PERIOD: Record<Pop, string> = { red: 'text-white', ink: 'text-accent', blue: 'text-ink', blush: 'text-accent', mist: 'text-accent' }

interface ScreenProps {
  title?: ReactNode
  /** Shows the round back button; tab roots leave it off. */
  back?: boolean
  actions?: ReactNode
  /** Pop band behind the header, for screens that open on a colour. */
  band?: Pop
  children: ReactNode
  className?: string
}

export function Screen({ title, back = true, actions, band, children, className }: ScreenProps) {
  const navigate = useNavigate()
  return (
    <div className="min-h-full pb-32">
      {title && (
        <header className={cn('px-5 pt-[max(env(safe-area-inset-top),1.5rem)] pb-5', band && cn(POP[band], 'rounded-b-[32px] md:mx-3 md:mt-3 md:rounded-[32px] md:pt-6'))}>
          <div className="flex items-center gap-3">
            {back && (
              <Button
                variant={!band ? 'card' : band === 'red' || band === 'ink' ? 'onPop' : 'ink'}
                size="icon-lg"
                aria-label="Back"
                className="size-11"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/m'))}
              >
                <ArrowLeft aria-hidden className="size-5" />
              </Button>
            )}
            <ScreenTitle className="min-w-0 flex-1" period={band ? PERIOD[band] : undefined}>
              {title}
            </ScreenTitle>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        </header>
      )}
      <div className={cn('space-y-4 px-5', className)}>{children}</div>
    </div>
  )
}

/** Loading state for a phone detail screen: a hero block and one card. */
export function ScreenSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <Skeleton className="h-44 rounded-card" />
      <Skeleton className="h-28 rounded-card" />
    </div>
  )
}

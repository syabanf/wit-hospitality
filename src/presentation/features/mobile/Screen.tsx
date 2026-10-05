import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '../../ui/Button'
import { Skeleton } from '../../ui/States'
import { POP, type Pop } from '../../ui/pop'

/** Compact screen title ending in the WIT period. */
export function ScreenTitle({ children, period = 'text-accent', className }: { children: ReactNode; period?: string; className?: string }) {
  return (
    <h1 className={cn('truncate text-xl leading-tight font-bold tracking-tight', className)}>
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
        <header className={cn('px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3', band && cn(POP[band], 'mb-1 rounded-b-2xl md:mx-3 md:mt-3 md:rounded-2xl'))}>
          <div className="flex h-10 items-center gap-3">
            {back && (
              <Button
                variant={!band ? 'card' : band === 'red' || band === 'ink' ? 'onPop' : 'ink'}
                size="icon"
                aria-label="Back"
                className="size-9"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/m'))}
              >
                <ArrowLeft aria-hidden className="size-4" />
              </Button>
            )}
            <ScreenTitle className="min-w-0 flex-1" period={band ? PERIOD[band] : undefined}>
              {title}
            </ScreenTitle>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        </header>
      )}
      <div className={cn('space-y-4 px-4', className)}>{children}</div>
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

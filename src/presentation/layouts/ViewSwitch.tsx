import { useLocation, useNavigate } from 'react-router'
import { Monitor, Smartphone } from 'lucide-react'
import { cn } from '@/lib/cn'
import { counterpart, isMobilePath, saveView, type ViewMode } from './viewMode'

const OPTIONS: ReadonlyArray<{ value: ViewMode; label: string; icon: typeof Monitor }> = [
  { value: 'desktop', label: 'Desktop', icon: Monitor },
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
]

/** Desktop | Mobile pill: opens the same record in the other view and remembers the choice on this device. */
/** `full` stretches it across its container, for the phone menu and the drawer. */
export function ViewSwitch({ full = false, onSwitch }: { full?: boolean; onSwitch?: () => void }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const current: ViewMode = isMobilePath(pathname) ? 'mobile' : 'desktop'

  function pick(mode: ViewMode) {
    saveView(mode)
    if (mode === current) return
    onSwitch?.()
    navigate(counterpart(pathname, mode))
  }

  return (
    <div role="group" aria-label="View" className={cn('shrink-0 items-center gap-0.5 rounded-full border border-line-strong bg-raised p-1', full ? 'flex w-full' : 'inline-flex')}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={current === o.value}
          onClick={() => pick(o.value)}
          className={cn(
            'flex h-8 pointer-coarse:h-10 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap transition-colors',
            full && 'flex-1 justify-center',
            current === o.value ? 'bg-invert font-medium text-on-invert' : 'text-muted hover:text-fg',
          )}
        >
          <o.icon aria-hidden className="size-4" />
          {o.label}
        </button>
      ))}
    </div>
  )
}

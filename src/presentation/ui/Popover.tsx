import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface PopoverProps {
  /** Renders the trigger; spread `props` onto a button. */
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-controls': string }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  className?: string
}

/** Anchored panel that closes on outside click and Escape, handing focus back to its trigger. */
export function Popover({ trigger, children, align = 'right', className }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [shift, setShift] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  // Keep the panel on screen: on a phone a right-aligned menu near the left edge would hang off it.
  useLayoutEffect(() => {
    if (!open || !panel.current) {
      setShift(0)
      return
    }
    const r = panel.current.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    setShift(r.left < 8 ? 8 - r.left : r.right > vw - 8 ? vw - 8 - r.right : 0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-controls': id })}
      {open && (
        <div
          ref={panel}
          id={id}
          style={shift ? { translate: `${shift}px 0` } : undefined}
          className={cn(
            'absolute top-full z-40 mt-2 w-64 max-w-[calc(100vw-1rem)] animate-rise rounded-panel border border-line-strong bg-card p-2 shadow-float',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** A row inside a popover menu. */
export const menuItem =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-body transition-colors hover:bg-raised hover:text-fg'

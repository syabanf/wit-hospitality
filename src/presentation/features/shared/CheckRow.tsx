import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** A checklist line: one checkbox with its label and an optional error under it. */
export function CheckRow({ name, label, hint, defaultChecked = false, error, children }: { name: string; label: string; hint?: ReactNode; defaultChecked?: boolean; error?: string; children?: ReactNode }) {
  return (
    <div>
      <label className={cn('flex items-start gap-3 rounded-panel bg-raised px-4 py-3 text-sm', error && 'ring-1 ring-danger')}>
        <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 size-4 shrink-0 accent-accent" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{label}</span>
          {hint && <span className="block text-xs text-muted">{hint}</span>}
          {children}
        </span>
      </label>
      {error && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

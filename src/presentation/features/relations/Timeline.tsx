import type { ReactNode } from 'react'
import { when } from './shared'

/** A record's history, oldest first. */
export function Timeline({ entries }: { entries: ReadonlyArray<{ at: string; by: string; label: string; note: string; link?: ReactNode }> }) {
  return (
    <ol className="space-y-3">
      {entries.map((e, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-line-strong" />
          <div className="min-w-0">
            <p>
              <span className="font-medium">{e.label}</span>
              {e.note && <span className="text-body"> · {e.note}</span>}
              {e.link && <> · {e.link}</>}
            </p>
            <p className="text-xs text-muted">
              {when(e.at)} · {e.by}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

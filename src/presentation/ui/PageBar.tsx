import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from './Button'

/**
 * Top of a detail page: Back on the left, the page's actions on the right.
 * Back returns to wherever the user came from, or to `fallback` when the page opened directly.
 */
export function PageBar({ fallback, label, actions }: { fallback: string; label: string; actions?: ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <Button variant="card" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate(fallback))}>
        <ArrowLeft aria-hidden className="size-4" />
        {label}
      </Button>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

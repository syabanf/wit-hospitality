import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { NotFoundError } from '@/domain/errors'
import type { Resource } from '../hooks/useResource'
import { buttonStyles } from './buttonStyles'
import { CardSkeleton, EmptyState, ErrorState } from './States'

interface FallbackProps {
  error?: Error
  onRetry: () => void
  /** Where "not found" sends the user, with the link text. */
  back: { to: string; label: string }
  /** Names the record in the not-found message: "invoice", "worker". */
  what?: string
  loading?: ReactNode
}

/** What a record page shows until its data is ready: a skeleton, "not found" with a way back, or Try again. */
export function Fallback({ error, onRetry, back, what = 'record', loading = <CardSkeleton lines={5} /> }: FallbackProps) {
  if (!error) return <>{loading}</>
  if (!(error instanceof NotFoundError)) return <ErrorState error={error} onRetry={onRetry} />
  return (
    <EmptyState
      title={`This ${what} does not exist`}
      action={
        <Link to={back.to} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
          {back.label}
        </Link>
      }
    >
      The link may be old, or the {what} was removed.
    </EmptyState>
  )
}

interface GateProps<T> extends Omit<FallbackProps, 'error' | 'onRetry'> {
  resource: Resource<T> & { reload: () => void }
  children: (data: T) => ReactNode
}

/** Renders `children(data)` once the record is loaded, and the Fallback until then. */
export function Gate<T>({ resource, children, ...fallback }: GateProps<T>) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>
  return <Fallback error={resource.error} onRetry={resource.reload} {...fallback} />
}

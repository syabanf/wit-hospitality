import { Link } from 'react-router'
import { buttonStyles } from '../ui/buttonStyles'
import { EmptyState } from '../ui/States'

export function NotFound() {
  return (
    <EmptyState
      title="This page does not exist"
      action={
        <Link to="/" className={buttonStyles({ variant: 'solid' })}>
          Back to the dashboard
        </Link>
      }
    >
      The link may be old, or the page moved. The dashboard links to every section.
    </EmptyState>
  )
}

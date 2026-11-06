import { useParams } from 'react-router'
import { Printer } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatementSheet } from '../villaOwners/StatementSheet'

/** An approved statement, printable to PDF, with its stays and entries behind every figure. */
export default function PortalStatementPage() {
  const { id = '' } = useParams()
  const { portal } = useServices()
  const data = useResource(`portal.statement:${id}`, () => portal.statement(id), { keepPrevious: false })
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  return (
    <StatementSheet
      view={data.data}
      actions={
        <Button variant="accent" onClick={() => window.print()}>
          <Printer aria-hidden className="size-4" /> Print or save as PDF
        </Button>
      }
    />
  )
}

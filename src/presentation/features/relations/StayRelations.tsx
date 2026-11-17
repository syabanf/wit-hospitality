import { useState } from 'react'
import { Link } from 'react-router'
import { Plus } from 'lucide-react'
import { COMPLAINT_CATEGORY_LABEL, COMPLAINT_STATUS_LABEL, SEVERITY_LABEL } from '@/domain/relations'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { ComplaintForm } from './ComplaintForm'
import { COMPLAINT_TONE, SEVERITY_TONE, when } from './shared'

/** A guest's or a stay's complaints, newest first, with a form to log another. */
export function ComplaintsCard({ guestId, bookingId }: { guestId?: string; bookingId?: string }) {
  const { complaints } = useServices()
  const { can } = useAccess()
  const data = useResource(`complaints.list:${guestId ?? ''}:${bookingId ?? ''}`, () => complaints.list())
  const [adding, setAdding] = useState(false)
  if (!data.data) return null
  const mine = data.data.complaints.filter((c) => (!guestId || c.guestId === guestId) && (!bookingId || c.bookingId === bookingId))
  return (
    <Card aria-labelledby="complaints-title">
      <CardHeader
        id="complaints-title"
        title="Complaints"
        action={
          can('guest', 'create') && (
            <Button size="sm" variant="card" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
              <Plus aria-hidden className="size-4" /> Log one
            </Button>
          )
        }
      />
      {adding && (
        <div className="mb-4">
          <ComplaintForm
            {...data.data}
            bookingId={bookingId}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false)
              data.reload()
            }}
          />
        </div>
      )}
      {mine.length === 0 ? (
        <p className="text-sm text-muted">No complaints on file.</p>
      ) : (
        <ul className="divide-y divide-line">
          {mine.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-2 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <Link to={`/complaints/${c.id}`} className="font-medium hover:underline">
                  <span className="mr-2 font-mono text-xs text-muted">{c.number}</span>
                  {COMPLAINT_CATEGORY_LABEL[c.category]}
                </Link>
                <p className="text-xs text-muted">
                  {when(c.receivedAt)}
                  {c.bookingCode && !bookingId && ` · ${c.bookingCode}`} · {c.description}
                </p>
              </div>
              <Tag tone={SEVERITY_TONE[c.severity]}>{SEVERITY_LABEL[c.severity]}</Tag>
              <Tag tone={COMPLAINT_TONE[c.status]}>{COMPLAINT_STATUS_LABEL[c.status]}</Tag>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** Check-out's reminder of a safe box the stay still holds. */
export function OpenBoxWarnings({ bookingId }: { bookingId: string }) {
  const { safeBoxes } = useServices()
  const data = useResource(`safeBoxes.ofStay:${bookingId}`, () => safeBoxes.ofStay(bookingId))
  if (!data.data?.warnings.length) return null
  return (
    <div role="status" className="rounded-panel bg-warning-soft p-3.5 text-sm text-body">
      {data.data.warnings.map((w) => (
        <p key={w}>
          {w}{' '}
          <Link to="/safe-boxes" className="font-medium text-accent-text hover:underline">
            Safe boxes
          </Link>
        </p>
      ))}
    </div>
  )
}

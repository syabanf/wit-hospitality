import { Megaphone, Pin } from 'lucide-react'
import { shortDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'

export default function MyAnnouncementsPage() {
  const { people } = useServices()
  const data = useResource('people.home:announcements', () => people.home())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  return (
    <>
      <PageBar fallback="/me" label="My area" />
      {d.announcements.length === 0 ? (
        <EmptyState title="No announcements" />
      ) : (
        <ul className="space-y-4">
          {d.announcements.map((a) => (
            <li key={a.id}>
              <Card as="article" aria-label={a.title}>
                <div className="flex items-start gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-raised text-muted">{a.pinned ? <Pin aria-hidden className="size-5" /> : <Megaphone aria-hidden className="size-5" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold tracking-tight">{a.title}</h2>
                      {a.pinned && <Tag tone="accent">Pinned</Tag>}
                      {a.villaId && <Tag tone="info">{d.catalog.villas.find((v) => v.id === a.villaId)?.name ?? 'Villa team'}</Tag>}
                    </div>
                    <p className="mt-1 text-sm text-body">{a.body}</p>
                    <p className="mt-2 text-xs text-muted">
                      {a.by} · {shortDay(a.publishedOn)}
                    </p>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

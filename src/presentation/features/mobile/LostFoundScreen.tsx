import { LOST_STATUS_LABEL } from '@/domain/lostFound'
import { shortDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { LostItemForm } from '../guests/LostItemForm'
import { Screen } from './Screen'

/** Staff log a find with a photo where they found it; the desk takes it from there. */
export function LostFoundScreen() {
  const { lostFound } = useServices()
  const data = useResource('lostFound.list', () => lostFound.list())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  return (
    <Screen title="Lost and found">
      {!data.data ? (
        <CardSkeleton lines={6} />
      ) : (
        <>
          <section className="rounded-[26px] bg-card p-4 shadow-card" aria-label="Log a find">
            <LostItemForm catalog={data.data.catalog} stays={data.data.stays} today={data.data.today} onDone={data.reload} />
          </section>
          <section className="rounded-[26px] bg-card p-4 shadow-card" aria-labelledby="lf-recent">
            <h2 id="lf-recent" className="mb-2 text-sm font-semibold">
              Logged lately
            </h2>
            <ul className="divide-y divide-line text-sm">
              {data.data.items.slice(0, 6).map((i) => (
                <li key={i.id} className="flex items-start gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{i.description}</p>
                    <p className="text-xs text-muted">
                      {shortDay(i.foundOn)} · {i.villaName}
                      {i.unitCode && `, ${i.unitCode}`}
                    </p>
                  </div>
                  <Tag tone="neutral">{LOST_STATUS_LABEL[i.status]}</Tag>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Screen>
  )
}

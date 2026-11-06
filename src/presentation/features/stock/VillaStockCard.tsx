import { Link } from 'react-router'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Card, CardHeader } from '../../ui/Card'

/** A villa's store on its page: value, the items running low, and a way into the stock section. */
export function VillaStockCard({ villaId }: { villaId: string }) {
  const { stock } = useServices()
  const { can } = useAccess()
  const data = useResource(`stock.villaStore:${villaId}`, () => stock.villaStore(villaId), { keepPrevious: false })
  const store = data.data?.store
  if (!can('maintenance', 'view') || !store || store.levels.length === 0) return null

  return (
    <Card aria-labelledby="villa-stock">
      <CardHeader id="villa-stock" title="Stock" action={<span className="text-sm text-muted tabular">{money(store.value)}</span>} />
      {store.low.length === 0 ? (
        <p className="text-sm text-muted">Every item is above its reorder level.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {store.low.map((l) => (
            <li key={l.item.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1 truncate">{l.item.name}</span>
              <span className="text-muted tabular">
                {l.onHand} of {l.item.reorderLevel}
              </span>
              <Tag tone="warning">Low</Tag>
            </li>
          ))}
        </ul>
      )}
      <Link to={`/stock?villa=${villaId}`} className="mt-4 flex items-center justify-between rounded-panel bg-raised px-4 py-3 text-sm transition-colors hover:bg-control">
        Open the {store.villa.name} store
        <span aria-hidden>→</span>
      </Link>
    </Card>
  )
}

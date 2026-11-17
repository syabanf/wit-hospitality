import { Link, useSearchParams } from 'react-router'
import { Printer } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { QrCode } from '../payments/QrCode'

/** One card per room to print and place in the villa: scanning it opens that room's menu. */
export default function QrCardsPage() {
  const { orders } = useServices()
  const data = useResource('orders.qrCards', () => orders.qrCards())
  const [params, setParams] = useSearchParams()
  const villaId = params.get('villa') ?? ''
  const opensStay = params.get('opens') === 'stay'
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const cards = data.data.cards.filter((c) => !villaId || c.villa.id === villaId)
  const origin = window.location.origin

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="max-w-xl text-sm text-muted">Print and leave one card in each room. The code opens the room’s menu for whoever is staying; orders land on their bill. A room with a guest in house can point at that guest’s stay page instead.</p>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Villa" tone="card" value={villaId} options={[{ value: '', label: 'All villas' }, ...data.data.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => setParam('villa', e.target.value)} />
          <Select aria-label="The code opens" tone="card" value={opensStay ? 'stay' : ''} options={[{ value: '', label: 'Room menu' }, { value: 'stay', label: 'Stay page when in house' }]} onChange={(e) => setParam('opens', e.target.value)} />
          <Button variant="accent" onClick={() => window.print()}>
            <Printer aria-hidden className="size-4" /> Print
          </Button>
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2">
        {cards.map((c) => {
          const path = opensStay && c.stayToken ? `/stay/${c.stayToken}` : `/order/${c.token}`
          return (
            <li key={c.unit.id} className="break-inside-avoid rounded-card border border-line bg-card p-5 shadow-card print:shadow-none">
              <div className="flex items-center gap-2">
                <BrandMark className="size-6 text-fg" />
                <span className="text-sm font-bold tracking-tight">{c.villa.name}</span>
                <span className="ml-auto font-mono text-sm font-semibold">{c.unit.code}</span>
              </div>
              <div className="mt-4 flex items-center gap-4">
                <QrCode payload={`${origin}${path}`} className="size-32 shrink-0 border border-line" />
                {opensStay && c.stayToken ? (
                  <div className="min-w-0">
                    <p className="text-lg leading-tight font-semibold">Your stay</p>
                    <p className="mt-1 text-sm text-muted">Ask for cleaning, order to the room, see your bill and ask for a late check-out.</p>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <p className="text-lg leading-tight font-semibold">Room service</p>
                    <p className="mt-1 text-sm text-muted">Breakfast, drinks, laundry, massage, tours and transfers. Scan to order, pay later with your bill.</p>
                  </div>
                )}
              </div>
              <Link to={path} className="mt-1 flex min-h-10 items-center font-mono text-xs text-muted hover:text-accent-text hover:underline">
                <span className="truncate">
                  {origin.replace(/^https?:\/\//, '')}
                  {path}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

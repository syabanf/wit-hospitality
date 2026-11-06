import { useState } from 'react'
import { Pencil } from 'lucide-react'
import type { StockServices } from '@/application/stock'
import type { StockItem } from '@/domain/stock'
import { money } from '@/lib/format'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

type Overview = Awaited<ReturnType<StockServices['overview']>>

/** The amenity kit per room type, edited as a quantity per amenity. */
export function KitsCard({ kits, items, canEdit, onChanged }: { kits: Overview['kits']; items: readonly StockItem[]; canEdit: boolean; onChanged: () => void }) {
  const { stock } = useServices()
  const toast = useToast()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const amenities = items.filter((i) => i.kind === 'amenity' && i.active)
  const name = (id: string) => items.find((i) => i.id === id)?.name ?? id

  async function save(groupId: string) {
    setSaving(true)
    try {
      await stock.saveKit(groupId, Object.entries(draft).map(([itemId, quantity]) => ({ itemId, quantity })))
      toast({ title: 'Saved the amenity kit' })
      setEditing(null)
      onChanged()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save the kit', description: Object.values(fieldErrors(error))[0] })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby="stock-kits">
      <CardHeader id="stock-kits" title="Amenity kits" />
      <p className="-mt-2 mb-4 text-sm text-muted">Releasing a unit after turnover issues its room type’s kit from the villa store. A short store still releases the unit and flags the item.</p>
      <ul className="divide-y divide-line">
        {kits.map((k) => {
          const cost = k.lines.reduce((s, l) => s + l.quantity * (items.find((i) => i.id === l.itemId)?.averageCost ?? 0), 0)
          return (
            <li key={k.group.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{k.group.name}</span>
                  <span className="block text-xs text-muted">
                    {k.villaName} · {k.lines.length ? `${k.lines.map((l) => `${l.quantity} × ${name(l.itemId)}`).join(', ')}` : 'No kit'}
                  </span>
                </span>
                <span className="text-sm tabular">{money(cost)}</span>
                {canEdit && editing !== k.group.id && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit the ${k.group.name} kit`} onClick={() => {
                    setDraft(Object.fromEntries(k.lines.map((l) => [l.itemId, l.quantity])))
                    setEditing(k.group.id)
                  }}>
                    <Pencil aria-hidden className="size-4" />
                  </Button>
                )}
              </div>
              {editing === k.group.id && (
                <div className="mt-3 space-y-3 rounded-panel bg-raised p-4">
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {amenities.map((i) => (
                      <li key={i.id} className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm">{i.name}</span>
                        <Input aria-label={`${i.name} per turnover`} className="h-10 w-20" type="number" inputMode="numeric" min={0} value={draft[i.id] ?? ''} onChange={(e) => setDraft({ ...draft, [i.id]: Number(e.target.value) })} />
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    <Button size="sm" variant="accent" loading={saving} onClick={() => void save(k.group.id)}>
                      Save kit
                    </Button>
                    <Button size="sm" variant="soft" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** Which stock each minibar menu item sells; delivered orders and restocks move that stock. */
export function MinibarLinksCard({ links, items, canEdit, onChanged }: { links: Overview['links']; items: readonly StockItem[]; canEdit: boolean; onChanged: () => void }) {
  const { stock } = useServices()
  const toast = useToast()
  const options = [{ value: '', label: 'Not tracked' }, ...items.filter((i) => i.kind === 'minibar').map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))]

  async function link(menuItemId: string, stockItemId: string) {
    try {
      await stock.linkMinibar(menuItemId, stockItemId || null)
      onChanged()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not link the item', description: error instanceof Error ? error.message : undefined })
    }
  }

  return (
    <Card aria-labelledby="stock-links">
      <CardHeader id="stock-links" title="Minibar menu and stock" />
      <ul className="divide-y divide-line">
        {links.map((l) => (
          <li key={l.menuItem.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{l.menuItem.name}</span>
              <span className="block text-xs text-muted">
                {l.villaName} · {money(l.menuItem.price)}
              </span>
            </span>
            <Select aria-label={`Stock for ${l.menuItem.name} at ${l.villaName}`} compact disabled={!canEdit} value={l.stockItemId ?? ''} options={options} onChange={(e) => void link(l.menuItem.id, e.target.value)} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

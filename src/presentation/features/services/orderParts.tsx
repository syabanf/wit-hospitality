import { Minus, Plus } from 'lucide-react'
import { hoursLabel, leadLabel, lineAmount, MENU_CATEGORIES, MENU_CATEGORY_LABEL, ORDER_STATUS_LABEL, PAY_STATE_LABEL, PRICE_UNIT_LABEL, type MenuItem, type OrderLine, type OrderPayState, type OrderStatus, type OrderTotals } from '@/domain/serviceOrder'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ORDER_TONE, PAY_STATE_TONE } from '../shared/tones'

export const OrderPill = ({ status }: { status: OrderStatus }) => <StatusPill tone={ORDER_TONE[status]}>{ORDER_STATUS_LABEL[status]}</StatusPill>
export const PayPill = ({ state }: { state: OrderPayState }) => <StatusPill tone={PAY_STATE_TONE[state]}>{PAY_STATE_LABEL[state]}</StatusPill>

/** Laundry goes by the half kilo, everything else by one. */
const stepOf = (item: Pick<MenuItem, 'unit'>) => (item.unit === 'kg' ? 0.5 : 1)

export function QuantityStepper({ item, value, onChange }: { item: MenuItem; value: number; onChange: (next: number) => void }) {
  const step = stepOf(item)
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${item.name}`}>
      <Button type="button" variant="soft" size="icon-sm" aria-label={`One less ${item.name}`} disabled={value <= 0} onClick={() => onChange(Math.max(0, Math.round((value - step) * 10) / 10))}>
        <Minus aria-hidden className="size-3.5" />
      </Button>
      <span className={cn('w-9 text-center text-sm tabular', value > 0 ? 'font-semibold' : 'text-muted')}>{value}</span>
      <Button type="button" variant={value > 0 ? 'solid' : 'soft'} size="icon-sm" aria-label={`One more ${item.name}`} onClick={() => onChange(Math.round((value + step) * 10) / 10)}>
        <Plus aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}

/** The menu by category, each item with its price, hours and a quantity stepper. */
export function MenuList({ items, cart, onChange, compact = false }: { items: readonly MenuItem[]; cart: Record<string, number>; onChange: (itemId: string, quantity: number) => void; compact?: boolean }) {
  const groups = MENU_CATEGORIES.map((c) => ({ category: c, items: items.filter((i) => i.category === c) })).filter((g) => g.items.length > 0)
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.category} aria-label={MENU_CATEGORY_LABEL[g.category]}>
          <h3 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{MENU_CATEGORY_LABEL[g.category]}</h3>
          <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-card">
            {g.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-3">
                {i.photo?.url && <img src={i.photo.url} alt="" className="size-12 shrink-0 rounded-xl object-cover" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{i.name}</p>
                  {!compact && i.description && <p className="line-clamp-2 text-xs text-muted">{i.description}</p>}
                  <p className="mt-0.5 text-xs text-muted">
                    <span className="font-semibold text-fg tabular">{money(i.price)}</span> {PRICE_UNIT_LABEL[i.unit]} · {hoursLabel(i)}
                    {i.leadMinutes > 0 && ` · ${leadLabel(i.leadMinutes)}`}
                  </p>
                </div>
                <QuantityStepper item={i} value={cart[i.id] ?? 0} onChange={(q) => onChange(i.id, q)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Order lines with the totals underneath: menu price, free items, discount, charge, and the partner cost when shown. */
export function OrderLines({ lines, totals, discountPct, showCost = false }: { lines: readonly OrderLine[]; totals: OrderTotals; discountPct: number; showCost?: boolean }) {
  return (
    <div className="text-sm">
      <ul className="divide-y divide-line">
        {lines.map((l) => (
          <li key={l.itemId} className="flex items-start gap-3 py-2.5">
            <span className="w-10 shrink-0 text-muted tabular">{l.quantity}×</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{l.name}</span>
              <span className="block text-xs text-muted">
                {money(l.price)} {PRICE_UNIT_LABEL[l.unit]}
                {l.comp && ' · on the house'}
                {showCost && l.costPrice > 0 && ` · partner ${money(l.costPrice)}`}
              </span>
            </span>
            <span className={cn('tabular', l.comp && 'text-muted line-through')}>{money(lineAmount(l))}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2 space-y-1 border-t border-line pt-2">
        {totals.comp > 0 && <Row label="On the house" value={-totals.comp} />}
        {totals.discount > 0 && <Row label={`Discount ${discountPct}%`} value={-totals.discount} />}
        <Row label="Guest pays" value={totals.charge} strong />
        {showCost && totals.cost > 0 && (
          <>
            <Row label="Partner cost" value={-totals.cost} muted />
            <Row label="Margin" value={totals.margin} muted />
          </>
        )}
      </dl>
    </div>
  )
}

function Row({ label, value, strong = false, muted = false }: { label: string; value: number; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-3', strong && 'text-base font-semibold', muted && 'text-xs text-muted')}>
      <dt>{label}</dt>
      <dd className="tabular">{money(value)}</dd>
    </div>
  )
}

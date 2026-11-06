import { countTotal, NOTES, noteLabel, SHIFT_STATUS_LABEL, type DrawerCount, type ShiftStatus, type ShiftTotals } from '@/domain/cashier'
import { PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { StatusPill } from '../../ui/Badge'
import { SHIFT_TONE } from './shiftText'

export function ShiftStatusPill({ status }: { status: ShiftStatus }) {
  return <StatusPill tone={SHIFT_TONE[status]}>{SHIFT_STATUS_LABEL[status]}</StatusPill>
}

/** Pieces per note and the coins, with the running total; one field per note so a phone keypad works. */
export function DrawerCounter({ id, value, onChange, disabled }: { id: string; value: DrawerCount; onChange: (c: DrawerCount) => void; disabled?: boolean }) {
  const field = 'h-10 w-full rounded-full border border-line-strong bg-raised px-3 text-right text-base tabular sm:text-sm'
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="sr-only">Count by denomination</legend>
      <div className="grid grid-cols-[4.5rem_1fr_7rem] items-center gap-x-3 gap-y-2 text-sm">
        <span className="text-xs text-muted">Note</span>
        <span className="text-xs text-muted">Pieces</span>
        <span className="text-right text-xs text-muted">Value</span>
        {NOTES.map((n) => (
          <div key={n} className="contents">
            <label htmlFor={`${id}-${n}`} className="font-medium tabular">
              Rp {noteLabel(n)}
            </label>
            <input
              id={`${id}-${n}`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              className={field}
              value={value.notes[n] ?? ''}
              placeholder="0"
              onChange={(e) => onChange({ ...value, notes: { ...value.notes, [n]: e.target.value === '' ? 0 : Number(e.target.value) } })}
            />
            <span className="text-right text-muted tabular">{money(n * (value.notes[n] ?? 0))}</span>
          </div>
        ))}
        <label htmlFor={`${id}-coins`} className="font-medium">
          Coins
        </label>
        <input id={`${id}-coins`} type="number" inputMode="numeric" min={0} step={100} className={field} value={value.coins || ''} placeholder="Rp 0" onChange={(e) => onChange({ ...value, coins: Number(e.target.value) || 0 })} />
        <span className="text-right text-muted tabular">{money(value.coins)}</span>
      </div>
      <p className="flex justify-between border-t border-line pt-2 text-sm font-semibold">
        <span>Counted</span>
        <span className="tabular">{money(countTotal(value))}</span>
      </p>
    </fieldset>
  )
}

/** Float, cash in and out and what the drawer should hold, then the guest money per method. */
export function ShiftFigures({ float, totals, className }: { float: number; totals: ShiftTotals; className?: string }) {
  const rows: [string, number][] = [
    ['Opening float', float],
    ['Cash in', totals.cashIn],
    ['Cash out', -totals.cashOut],
  ]
  return (
    <div className={cn('space-y-3 text-sm', className)}>
      <dl className="space-y-1">
        {rows.map(([label, amount]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular">{money(amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-2 border-t border-line pt-1 font-semibold">
          <dt>Expected in the drawer</dt>
          <dd className="tabular">{money(totals.expected)}</dd>
        </div>
      </dl>
      {totals.byMethod.length > 0 && (
        <dl className="space-y-1">
          <p className="text-xs font-medium text-muted">Guest payments by method</p>
          {totals.byMethod.map((m) => (
            <div key={m.method} className="flex justify-between gap-2">
              <dt>
                {PAYMENT_METHOD_LABEL[m.method]} <span className="text-muted">· {m.count}</span>
              </dt>
              <dd className="tabular">{money(m.amount)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

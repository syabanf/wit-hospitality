import { DISCOUNT_PER_LABEL, type DiscountPer } from '@/domain/pricing'
import { money } from '@/lib/format'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import type { PriceDraft, PriceQuote } from './priceDraft'

interface PriceFieldsProps {
  value: PriceDraft
  onChange: (next: PriceDraft) => void
  errors: Record<string, string>
  quote: PriceQuote | null
  idPrefix: string
}

/** Staff rate and discount for a direct stay, with the limit spelled out before anyone saves. */
export function PriceFields({ value, onChange, errors, quote, idPrefix }: PriceFieldsProps) {
  const set = (patch: Partial<PriceDraft>) => onChange({ ...value, ...patch })
  const id = (name: string) => `${idPrefix}-${name}`
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Staff rate per night, Rp" htmlFor={id('override')} error={errors.rateOverride} hint="Leave empty to sell at the list price">
          <Input id={id('override')} type="number" inputMode="numeric" min={0} step={10_000} value={value.override} onChange={(e) => set({ override: e.target.value })} className="tabular" placeholder="List price" />
        </Field>
        {value.override.trim() && (
          <Field label="Why this rate" htmlFor={id('reason')} error={errors.reason}>
            <Input id={id('reason')} value={value.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Corporate rate, upgrade, long stay" />
          </Field>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)_140px]">
        <Field label="Discount" htmlFor={id('discount')}>
          <Select
            id={id('discount')}
            className="w-full"
            value={value.discount}
            options={[
              { value: 'none', label: 'None' },
              { value: 'percent', label: 'Percent off' },
              { value: 'amount', label: 'Rupiah off' },
            ]}
            onChange={(e) => set({ discount: e.target.value as PriceDraft['discount'] })}
          />
        </Field>
        {value.discount !== 'none' && (
          <>
            <Field label={value.discount === 'percent' ? 'Percent' : 'Rupiah'} htmlFor={id('value')} error={errors['discount.value']}>
              <Input id={id('value')} type="number" inputMode="numeric" min={0} step={value.discount === 'percent' ? 1 : 10_000} value={value.value} onChange={(e) => set({ value: e.target.value })} className="tabular" />
            </Field>
            {value.discount === 'amount' ? (
              <Field label="Taken" htmlFor={id('per')}>
                <Select id={id('per')} className="w-full" value={value.per} options={(['night', 'stay'] as const).map((p) => ({ value: p, label: DISCOUNT_PER_LABEL[p] }))} onChange={(e) => set({ per: e.target.value as DiscountPer })} />
              </Field>
            ) : (
              <span aria-hidden />
            )}
          </>
        )}
      </div>
      {value.discount !== 'none' && (
        <Field label="Why the guest gets it" htmlFor={id('discount-reason')} error={errors['discount.reason']}>
          <Input id={id('discount-reason')} value={value.discountReason} onChange={(e) => set({ discountReason: e.target.value })} placeholder="Returning guest, long stay, honeymoon" />
        </Field>
      )}
      {quote && quote.price.total < quote.price.list && (
        <p role="status" className={`rounded-panel p-3 text-sm ${quote.beyondLimit && !quote.mayApprove ? 'bg-danger-soft text-danger' : quote.beyondLimit ? 'bg-warning-soft text-warning' : 'bg-raised text-muted'}`}>
          {money(quote.price.list - quote.price.total)} under the list price, {Math.round(quote.price.reduction * 100)}% off.{' '}
          {quote.beyondLimit
            ? quote.mayApprove
              ? `That is past the ${quote.limitPct}% limit; saving records you as the one who allowed it.`
              : `That is past the ${quote.limitPct}% limit. A villa manager has to give it.`
            : `Inside the ${quote.limitPct}% limit.`}
        </p>
      )}
    </div>
  )
}

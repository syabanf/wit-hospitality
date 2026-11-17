import { useState } from 'react'
import type { CashAccount } from '@/domain/finance'
import { CARD_BRAND_LABEL, CARD_BRANDS, DEPOSIT_METHOD_LABEL, type DepositMethod } from '@/domain/preAuth'
import { addDays } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'

const METHODS: readonly DepositMethod[] = ['cash', 'bank_transfer', 'preauth']

export function CardFields({ errors, until }: { errors: Record<string, string>; until: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Field label="Card" htmlFor="card-brand" error={errors.brand}>
        <Select id="card-brand" name="cardBrand" options={CARD_BRANDS.map((b) => ({ value: b, label: CARD_BRAND_LABEL[b] }))} />
      </Field>
      <Field label="Last four digits" htmlFor="card-last4" error={errors.last4}>
        <Input id="card-last4" name="cardLast4" inputMode="numeric" maxLength={4} pattern="[0-9]*" autoComplete="off" placeholder="4242" className="tabular" />
      </Field>
      <Field label="Approval code" htmlFor="card-approval" error={errors.approvalCode} hint="Blank takes the gateway's">
        <Input id="card-approval" name="cardApproval" maxLength={12} autoComplete="off" />
      </Field>
      <Field label="Hold until" htmlFor="card-expires" error={errors.expiresOn}>
        <Input id="card-expires" name="cardExpires" type="date" defaultValue={addDays(until, 2)} />
      </Field>
    </div>
  )
}

/**
 * The deposit step of the check-in form: the amount and how the guest leaves it. Cash goes to the
 * cashbox, a transfer to the bank account, a card hold to the gateway with no money moved.
 */
export function DepositSection({ asked, cashbox, villaName, defaultAmount, until, errors }: { asked: boolean; cashbox: CashAccount | null; villaName: string; defaultAmount: number; until: string; errors: Record<string, string> }) {
  const [method, setMethod] = useState<DepositMethod>('cash')
  const hint =
    method === 'preauth'
      ? 'Held on the card through the gateway; nothing is booked until it is captured'
      : !asked
        ? `${villaName} takes no deposit at check-in; enter one only if the guest leaves it`
        : method === 'bank_transfer'
          ? 'Recorded as cash in on the bank account, submitted for approval'
          : cashbox
            ? `Recorded as cash in on ${cashbox.name}, submitted for approval`
            : 'No cashbox for this location; the deposit is noted on the stay only'
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-xs font-medium text-muted">Security deposit</legend>
      <input type="hidden" name="depositMethod" value={method} />
      <div role="radiogroup" aria-label="How the guest leaves the deposit" className="flex flex-wrap gap-2">
        {METHODS.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={method === m}
            onClick={() => setMethod(m)}
            className={cn('h-9 rounded-full px-4 text-sm font-medium transition-colors', method === m ? 'bg-invert text-on-invert' : 'bg-control text-body hover:bg-hover')}
          >
            {DEPOSIT_METHOD_LABEL[m]}
          </button>
        ))}
      </div>
      <Field label={method === 'preauth' ? 'Hold, Rp' : 'Deposit, Rp'} htmlFor="ci-deposit" error={errors.deposit} hint={hint}>
        <Input id="ci-deposit" name="deposit" type="number" inputMode="numeric" min={0} step={100_000} defaultValue={defaultAmount} className="tabular" />
      </Field>
      {method === 'preauth' && <CardFields errors={errors} until={until} />}
    </fieldset>
  )
}

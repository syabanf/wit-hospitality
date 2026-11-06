import { BILLING_INSTRUCTION_LABEL, BILLING_INSTRUCTIONS, type BillingInstruction, type CityLedgerBillingInput } from '@/domain/cityLedger'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'

interface BillingPickerProps {
  value: CityLedgerBillingInput | null
  onChange: (next: CityLedgerBillingInput | null) => void
  /** The villas the stays sit in; accounts limited to other villas drop out. */
  villaIds: readonly string[]
  /** What the stays come to, for the credit check. */
  amount: number
  error?: string
}

/** The company or travel agent a new direct booking or group bills after the stay, with the credit it has left. */
export function BillingPicker({ value, onChange, villaIds, amount, error }: BillingPickerProps) {
  const { cityLedger } = useServices()
  const options = useResource('cityLedger.bookingOptions', () => cityLedger.bookingOptions())
  const o = options.data
  if (!o || o.accounts.length === 0) return null
  const accounts = o.accounts.filter((a) => a.villaIds.length === 0 || villaIds.every((v) => a.villaIds.includes(v)))
  const picked = value ? o.accounts.find((a) => a.id === value.accountId) : undefined
  const over = picked ? amount - picked.available : 0

  return (
    <Card aria-labelledby="clb-title">
      <CardHeader id="clb-title" title="Bill to" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Company or travel agent" htmlFor="clb-account" error={error} hint={picked ? `${money(Math.max(0, picked.available))} of ${money(picked.creditLimit)} credit left` : 'Leave it on the guest, or bill an account after the stay'}>
          <Select
            id="clb-account"
            className="w-full"
            value={value?.accountId ?? ''}
            options={[{ value: '', label: 'The guest pays' }, ...accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))]}
            onChange={(e) => onChange(e.target.value ? { accountId: e.target.value, instruction: value?.instruction ?? 'all', overrideReason: value?.overrideReason ?? '' } : null)}
          />
        </Field>
        {value && (
          <Field label="The account pays" htmlFor="clb-covers" hint="The rest stays with the guest">
            <Select id="clb-covers" className="w-full" value={value.instruction} options={BILLING_INSTRUCTIONS.map((k) => ({ value: k, label: BILLING_INSTRUCTION_LABEL[k] }))} onChange={(e) => onChange({ ...value, instruction: e.target.value as BillingInstruction })} />
          </Field>
        )}
      </div>
      {value && over > 0 && (
        <div role="alert" className="mt-4 rounded-panel bg-warning-soft p-3.5 text-sm text-body">
          <p>
            This passes the credit limit of {picked?.name} by {money(over)}.
            {o.mayOverride ? ' Give the reason to book it anyway.' : ' Finance or a villa manager may book it with a reason.'}
          </p>
          {o.mayOverride && (
            <Field label="Book past the limit because" htmlFor="clb-override" className="mt-3">
              <Input id="clb-override" value={value.overrideReason ?? ''} onChange={(e) => onChange({ ...value, overrideReason: e.target.value })} placeholder="Payment promised, director approved" />
            </Field>
          )}
        </div>
      )}
    </Card>
  )
}

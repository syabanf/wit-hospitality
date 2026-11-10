import { BILLING_INSTRUCTION_LABEL, BILLING_INSTRUCTIONS, type BillingInstruction, type CityLedgerBillingInput } from '@/domain/cityLedger'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'

interface BillingFieldsProps {
  value: CityLedgerBillingInput | null
  onChange: (next: CityLedgerBillingInput | null) => void
  /** The accounts open to pick, with the credit each has left. */
  accounts: ReadonlyArray<{ id: string; code: string; name: string; villaIds: readonly string[]; creditLimit: number; available: number }>
  mayOverride: boolean
  /** The villas the stays sit in; accounts limited to other villas drop out. */
  villaIds: readonly string[]
  /** What the stays come to, for the credit check. */
  amount: number
  error?: string
  /** Keeps the field ids apart when two pickers share a page. */
  idPrefix?: string
}

/** The account, what it pays and, past the credit limit, the override reason. */
export function BillingFields({ value, onChange, accounts: all, mayOverride, villaIds, amount, error, idPrefix = 'clb' }: BillingFieldsProps) {
  const accounts = all.filter((a) => a.villaIds.length === 0 || villaIds.every((v) => a.villaIds.includes(v)))
  const picked = value ? all.find((a) => a.id === value.accountId) : undefined
  const over = picked ? amount - picked.available : 0

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Company or travel agent" htmlFor={`${idPrefix}-account`} error={error} hint={picked ? `${money(Math.max(0, picked.available))} of ${money(picked.creditLimit)} credit left` : 'Leave it on the guest, or bill an account after the stay'}>
          <Select
            id={`${idPrefix}-account`}
            className="w-full"
            value={value?.accountId ?? ''}
            options={[{ value: '', label: 'The guest pays' }, ...accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))]}
            onChange={(e) => onChange(e.target.value ? { accountId: e.target.value, instruction: value?.instruction ?? 'all', overrideReason: value?.overrideReason ?? '' } : null)}
          />
        </Field>
        {value && (
          <Field label="The account pays" htmlFor={`${idPrefix}-covers`} hint="The rest stays with the guest">
            <Select id={`${idPrefix}-covers`} className="w-full" value={value.instruction} options={BILLING_INSTRUCTIONS.map((k) => ({ value: k, label: BILLING_INSTRUCTION_LABEL[k] }))} onChange={(e) => onChange({ ...value, instruction: e.target.value as BillingInstruction })} />
          </Field>
        )}
      </div>
      {value && over > 0 && (
        <div role="alert" className="mt-4 rounded-panel bg-warning-soft p-3.5 text-sm text-body">
          <p>
            This passes the credit limit of {picked?.name} by {money(over)}.
            {mayOverride ? ' Give the reason to book it anyway.' : ' Finance or a villa manager may book it with a reason.'}
          </p>
          {mayOverride && (
            <Field label="Book past the limit because" htmlFor={`${idPrefix}-override`} className="mt-3">
              <Input id={`${idPrefix}-override`} value={value.overrideReason ?? ''} onChange={(e) => onChange({ ...value, overrideReason: e.target.value })} placeholder="Payment promised, director approved" />
            </Field>
          )}
        </div>
      )}
    </>
  )
}

/** The company or travel agent a new direct booking or group bills after the stay, with the credit it has left. */
export function BillingPicker({ value, onChange, villaIds, amount, error }: Pick<BillingFieldsProps, 'value' | 'onChange' | 'villaIds' | 'amount' | 'error'>) {
  const { cityLedger } = useServices()
  const options = useResource('cityLedger.bookingOptions', () => cityLedger.bookingOptions())
  const o = options.data
  if (!o || o.accounts.length === 0) return null
  return (
    <Card aria-labelledby="clb-title">
      <CardHeader id="clb-title" title="Bill to" />
      <BillingFields value={value} onChange={onChange} accounts={o.accounts} mayOverride={o.mayOverride} villaIds={villaIds} amount={amount} error={error} />
    </Card>
  )
}

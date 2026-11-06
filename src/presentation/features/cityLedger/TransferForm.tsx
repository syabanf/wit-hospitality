import { useState, type FormEvent } from 'react'
import { BILLING_INSTRUCTION_LABEL, BILLING_INSTRUCTIONS, type BillingInstruction } from '@/domain/cityLedger'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

/**
 * Moves a stay's bill, or the part the billing instruction covers, to a city ledger account. The
 * folio card and the check-out form both use it; check-out then settles only what is left.
 */
export function TransferForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const { cityLedger } = useServices()
  const toast = useToast()
  const options = useResource(`cityLedger.transferOptions:${bookingId}`, () => cityLedger.transferOptions(bookingId), { keepPrevious: false })
  const [accountId, setAccountId] = useState('')
  const [instruction, setInstruction] = useState<BillingInstruction | ''>('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const o = options.data
  if (!o) return <p className="text-sm text-muted">Loading the accounts…</p>
  if (!o.allowed) return <p className="text-sm text-muted">Only a direct stay in house moves to the city ledger.</p>
  if (o.accounts.length === 0) return <p className="text-sm text-muted">No city ledger account may book this villa.</p>
  const account = accountId || o.billing?.accountId || o.accounts[0]?.id || ''
  const covers = instruction || o.billing?.instruction || 'all'
  const amount = o.preview[covers]

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      const posted = await cityLedger.transfer(bookingId, { accountId: account, instruction: covers })
      toast({ title: `Moved ${money(posted.reduce((s, p) => s + p.amount, 0))} to the city ledger`, description: 'The guest settles only what is left at check-out.' })
      options.reload()
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <Field label="Bill to" htmlFor={`clt-account-${bookingId}`} error={errors.accountId ?? errors.form} hint={o.billing ? 'Booked to this account' : undefined}>
        <Select id={`clt-account-${bookingId}`} className="w-full" value={account} options={o.accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} onChange={(e) => setAccountId(e.target.value)} />
      </Field>
      <Field label="The account pays" htmlFor={`clt-covers-${bookingId}`} hint="The rest stays with the guest">
        <Select id={`clt-covers-${bookingId}`} className="w-full" value={covers} options={BILLING_INSTRUCTIONS.map((k) => ({ value: k, label: `${BILLING_INSTRUCTION_LABEL[k]}, ${money(o.preview[k])}` }))} onChange={(e) => setInstruction(e.target.value as BillingInstruction)} />
      </Field>
      {o.transferred > 0 && <p className="text-xs text-muted">{money(o.transferred)} already moved to the city ledger.</p>}
      <Button type="submit" variant="accent" size="sm" loading={saving} disabled={amount <= 0}>
        Transfer {money(amount)}
      </Button>
    </form>
  )
}

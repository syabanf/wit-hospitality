import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ArrowDown, ArrowLeftRight } from 'lucide-react'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

/** Money between two accounts: a cash-out on the source and a cash-in on the target, approved as one. */
export default function TransferPage() {
  const { finance } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const options = useResource('finance.formOptions', () => finance.formOptions())
  const [fromAccountId, setFrom] = useState(params.get('from') ?? '')
  const [toAccountId, setTo] = useState(params.get('to') ?? '')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!options.data) return
    setSaving(true)
    setErrors({})
    try {
      const t = await finance.transfer({ fromAccountId, toAccountId, amount: Number(amount), date: date || options.data.today, description, reference })
      toast({ title: `Submitted transfer ${t.number}`, description: `${money(t.amount)} leaves ${t.accountName}` })
      navigate(`/finance/transactions/${t.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the transfer', description: Object.values(e)[0] })
    } finally {
      setSaving(false)
    }
  }

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={6} />
  const o = options.data
  const accountOptions = (exclude: string) => [{ value: '', label: 'Pick the account' }, ...o.accounts.filter((a) => a.id !== exclude).map((a) => ({ value: a.id, label: a.name }))]
  const from = o.accounts.find((a) => a.id === fromAccountId)
  const to = o.accounts.find((a) => a.id === toAccountId)
  const value = Number(amount) || 0

  return (
    <>
      <PageBar fallback="/finance" label="Cashbox" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <Card aria-labelledby="transfer-title">
          <CardHeader id="transfer-title" title="Cash transfer" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="tr-from" error={errors.fromAccountId}>
              <Select id="tr-from" className="w-full" value={fromAccountId} options={accountOptions(toAccountId)} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" htmlFor="tr-to" error={errors.toAccountId}>
              <Select id="tr-to" className="w-full" value={toAccountId} options={accountOptions(fromAccountId)} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Amount, Rp" htmlFor="tr-amount" error={errors.amount}>
              <Input id="tr-amount" type="number" inputMode="numeric" min={0} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" placeholder="0" />
            </Field>
            <Field label="Date" htmlFor="tr-date" error={errors.date}>
              <Input id="tr-date" type="date" value={date || o.today} max={o.today} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Reference" htmlFor="tr-ref" error={errors.reference} hint="Bank reference or slip number, optional">
              <Input id="tr-ref" value={reference} onChange={(e) => setReference(e.target.value)} className="font-mono" placeholder="TRF-…" />
            </Field>
            <Field label="Description" htmlFor="tr-desc" error={errors.description} className="sm:col-span-2">
              <Textarea id="tr-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Why the money moves, for example topping up a cashbox" />
            </Field>
          </div>
        </Card>
        <div className="space-y-4">
          <Card aria-labelledby="tr-sum">
            <CardHeader id="tr-sum" title="Two linked entries" />
            <div className="space-y-2 text-sm">
              <div className="rounded-panel bg-raised p-3">
                <p className="text-xs text-muted">Cash out</p>
                <p className="truncate font-medium">{from?.name ?? 'Source account'}</p>
                <p className="font-semibold tabular text-muted">-{money(value)}</p>
              </div>
              <ArrowDown aria-hidden className="mx-auto size-4 text-muted" />
              <div className="rounded-panel bg-raised p-3">
                <p className="text-xs text-muted">Cash in</p>
                <p className="truncate font-medium">{to?.name ?? 'Target account'}</p>
                <p className="font-semibold tabular">+{money(value)}</p>
              </div>
            </div>
            {errors.form && (
              <p role="alert" className="mt-3 text-xs font-medium text-danger">
                {errors.form}
              </p>
            )}
            <Button type="submit" variant="accent" loading={saving} className="mt-4 w-full">
              {!saving && <ArrowLeftRight aria-hidden className="size-4" />} Submit transfer
            </Button>
            <p className="mt-3 text-xs text-muted">One approval covers both halves; posting moves both balances.</p>
          </Card>
        </div>
      </form>
    </>
  )
}

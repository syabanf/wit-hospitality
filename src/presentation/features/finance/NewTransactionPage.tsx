import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Save, Send } from 'lucide-react'
import { KIND_LABEL, type TransactionInput, type TransactionKind } from '@/domain/finance'
import type { Scope } from '@/domain/property'
import { shortDay } from '@/lib/dates'
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
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { ScopePicker } from '../shared/ScopePicker'

const KIND_TABS = [
  { value: 'cash_in', label: KIND_LABEL.cash_in },
  { value: 'cash_out', label: KIND_LABEL.cash_out },
] as const

/** Cash in or out, mapped to a location, villa and unit, saved as a draft or sent for approval. */
export default function NewTransactionPage() {
  const { finance } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const options = useResource('finance.formOptions', () => finance.formOptions())

  const [kind, setKind] = useState<TransactionKind>(params.get('kind') === 'cash_out' ? 'cash_out' : 'cash_in')
  const [accountId, setAccountId] = useState(params.get('account') ?? '')
  const [categoryId, setCategoryId] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [scope, setScope] = useState<Scope>({})
  const [bookingId, setBookingId] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null)

  async function submit(send: boolean) {
    if (!options.data) return
    const input: TransactionInput = {
      accountId,
      kind,
      categoryId,
      amount: Number(amount),
      date: date || options.data.today,
      locationId: scope.locationId ?? '',
      villaId: scope.villaId ?? null,
      unitId: scope.unitId ?? null,
      bookingId: bookingId || null,
      description,
    }
    setSaving(send ? 'submit' : 'draft')
    setErrors({})
    try {
      const t = await finance.createTransaction(input, send)
      toast({ title: send ? `Submitted ${t.number} for approval` : `Saved ${t.number} as a draft`, description: `${KIND_LABEL[t.kind]} ${money(t.amount)} · ${t.accountName}` })
      navigate(`/finance/transactions/${t.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the entry', description: Object.values(e)[0] })
    } finally {
      setSaving(null)
    }
  }

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={8} />
  const o = options.data
  const categories = o.categories.filter((c) => c.kind === kind)
  const account = o.accounts.find((a) => a.id === accountId)
  const bookings = o.bookings.filter((b) => (scope.unitId ? b.unitId === scope.unitId : scope.villaId ? b.place.villa.id === scope.villaId : scope.locationId ? b.place.location.id === scope.locationId : true))

  function pickAccount(id: string) {
    setAccountId(id)
    const a = o.accounts.find((x) => x.id === id)
    if (a?.locationId && !scope.locationId) setScope({ locationId: a.locationId })
  }

  return (
    <>
      <PageBar fallback="/finance/transactions" label="Transactions" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="money-title">
            <CardHeader id="money-title" title="Money" action={<Tabs label="Kind" options={KIND_TABS} value={kind} onChange={(v) => { setKind(v); setCategoryId('') }} />} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Account" htmlFor="account" error={errors.accountId}>
                <Select id="account" className="w-full" value={accountId} options={[{ value: '', label: 'Pick the account' }, ...o.accounts.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => pickAccount(e.target.value)} />
              </Field>
              <Field label="Category" htmlFor="category" error={errors.categoryId}>
                <Select id="category" className="w-full" value={categoryId} options={[{ value: '', label: 'Pick a category' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} onChange={(e) => setCategoryId(e.target.value)} />
              </Field>
              <Field label="Amount, Rp" htmlFor="amount" error={errors.amount}>
                <Input id="amount" type="number" inputMode="numeric" min={0} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" placeholder="0" />
              </Field>
              <Field label="Date" htmlFor="date" error={errors.date}>
                <Input id="date" type="date" value={date || o.today} max={o.today} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Description" htmlFor="desc" error={errors.description} className="sm:col-span-2">
                <Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the money was for, and who handed it over" rows={2} />
              </Field>
            </div>
          </Card>
          <Card aria-labelledby="map-title">
            <CardHeader id="map-title" title="Mapping" />
            <p className="mb-4 text-sm text-muted">Every entry belongs to a location. Add the villa and unit when the money is theirs, so the reports split by property.</p>
            <Field label="Location, villa, unit" error={errors.locationId}>
              <ScopePicker catalog={o.catalog} value={scope} onChange={setScope} className="grid grid-cols-1 gap-2 sm:grid-cols-3" />
            </Field>
            <Field label="Booking" htmlFor="booking" hint="Optional: deposits and stay payments link to the stay" className="mt-4">
              <Select id="booking" className="w-full" value={bookingId} options={[{ value: '', label: 'No booking' }, ...bookings.map((b) => ({ value: b.id, label: `${b.code} · ${b.guestName} · ${b.unitCode} · ${shortDay(b.checkIn)}` }))]} onChange={(e) => setBookingId(e.target.value)} />
            </Field>
          </Card>
        </div>
        <div className="space-y-4">
          <Card aria-labelledby="sum2-title">
            <CardHeader id="sum2-title" title="Summary" />
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Kind</dt>
                <dd>{KIND_LABEL[kind]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Account</dt>
                <dd className="truncate pl-4">{account?.name ?? '—'}</dd>
              </div>
              <div className="flex justify-between border-t border-line-strong pt-2 font-semibold">
                <dt>Amount</dt>
                <dd className="tabular">{money(Number(amount) || 0)}</dd>
              </div>
            </dl>
            {errors.form && <p role="alert" className="mt-3 text-xs font-medium text-danger">{errors.form}</p>}
            <div className="mt-4 flex flex-col gap-2">
              <Button type="submit" variant="accent" loading={saving === 'submit'}>
                {saving !== 'submit' && <Send aria-hidden className="size-4" />} Submit for approval
              </Button>
              <Button variant="soft" loading={saving === 'draft'} onClick={() => void submit(false)}>
                {saving !== 'draft' && <Save aria-hidden className="size-4" />} Save as draft
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted">A submitted entry waits for a manager; posting it moves the balance.</p>
          </Card>
        </div>
      </form>
    </>
  )
}

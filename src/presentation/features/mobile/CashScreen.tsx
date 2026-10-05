import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { KIND_LABEL, type TransactionKind } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { POP } from '../../ui/pop'
import { Skeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { Screen } from './Screen'

export function CashScreen() {
  const { finance } = useServices()
  const toast = useToast()
  const overview = useResource('finance.overview', () => finance.overview())
  const options = useResource('finance.formOptions', () => finance.formOptions())
  const [accountId, setAccountId] = useState('')
  const [kind, setKind] = useState<TransactionKind>('cash_in')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const accounts = overview.data?.accounts.filter((a) => a.account.kind === 'cashbox') ?? []
  const current = accounts.find((a) => a.account.id === accountId) ?? accounts[0]
  const categories = options.data?.categories.filter((c) => c.kind === kind) ?? []

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!current || !options.data) return
    const form = e.currentTarget
    const f = new FormData(form)
    setSaving(true)
    setErrors({})
    try {
      const t = await finance.createTransaction(
        {
          accountId: current.account.id,
          kind,
          categoryId: String(f.get('category') ?? ''),
          amount: Number(f.get('amount')),
          date: options.data.today,
          locationId: current.account.locationId ?? '',
          villaId: null,
          unitId: null,
          bookingId: null,
          description: String(f.get('description') ?? ''),
        },
        true,
      )
      toast({ title: `Submitted ${t.number}`, description: `${KIND_LABEL[t.kind]} ${money(t.amount)} waits for approval.` })
      form.reset()
      overview.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen
      title="Cashbox"
      band="red"
      actions={
        accounts.length > 0 && (
          <Select compact tone="card" aria-label="Cashbox" value={current?.account.id ?? ''} options={accounts.map((a) => ({ value: a.account.id, label: a.location?.name ?? a.account.name }))} onChange={(e) => setAccountId(e.target.value)} />
        )
      }
    >
      {!current ? (
        <Skeleton className="h-40 rounded-[28px]" />
      ) : (
        <section aria-label={current.account.name} className={cn('rounded-[28px] p-5 shadow-pop', POP.ink)}>
          <p className="text-sm font-semibold">{current.account.name}</p>
          <p className="mt-3 text-[34px] leading-none font-semibold tracking-tight tabular">{money(current.balance)}</p>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-[18px] bg-white/10 p-3">
              <p className="opacity-70">In, 30 days</p>
              <p className="mt-1 text-base font-semibold tabular">{money(current.in30.cashIn)}</p>
            </div>
            <div className="rounded-[18px] bg-white/10 p-3">
              <p className="opacity-70">Out, 30 days</p>
              <p className="mt-1 text-base font-semibold tabular">{money(current.in30.cashOut)}</p>
            </div>
          </div>
          {current.lastMovement && <p className="mt-3 truncate text-xs opacity-70">Last: {current.lastMovement.description}, {shortDay(current.lastMovement.date)}</p>}
        </section>
      )}

      <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-[26px] bg-card p-4 shadow-card">
        <div className="grid grid-cols-2 gap-2">
          {(['cash_in', 'cash_out'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn('flex h-12 cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors', kind === k ? 'bg-invert text-on-invert' : 'border border-line-strong bg-raised text-muted')}
            >
              {k === 'cash_in' ? <ArrowDownLeft aria-hidden className="size-4" /> : <ArrowUpRight aria-hidden className="size-4" />}
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <Field label="Amount, Rp" htmlFor="m-amount" error={errors.amount}>
          <Input id="m-amount" name="amount" type="number" inputMode="numeric" min={0} step={1000} placeholder="0" className="tabular" />
        </Field>
        <Field label="Category" htmlFor="m-cat" error={errors.categoryId}>
          <Select id="m-cat" name="category" className="w-full" options={[{ value: '', label: 'Pick a category' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <Field label="What for" htmlFor="m-desc" error={errors.description ?? errors.form}>
          <Textarea id="m-desc" name="description" rows={2} placeholder="Deposit from SK-02, gas refill…" />
        </Field>
        <Button type="submit" variant="accent" className="w-full" loading={saving}>
          Submit for approval
        </Button>
      </form>

      {overview.data && (
        <section aria-labelledby="m-recent">
          <h2 id="m-recent" className="mb-2 text-base font-semibold">
            Latest
          </h2>
          <ul className="space-y-2">
            {overview.data.recent.slice(0, 5).map((t) => (
              <li key={t.id}>
                <Link to={`/finance/transactions/${t.id}`} className="flex items-center gap-3 rounded-[22px] bg-card p-3 shadow-card">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{t.description}</span>
                    <span className="block truncate text-xs text-muted">
                      {shortDay(t.date)} · {t.accountName}
                    </span>
                  </span>
                  <span className={cn('text-sm font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>
                    {t.kind === 'cash_out' ? '-' : '+'}
                    {money(t.amount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Screen>
  )
}

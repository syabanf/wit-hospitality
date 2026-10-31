import { useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowDownLeft, ArrowLeftRight, Calculator, Pencil, Scale } from 'lucide-react'
import { ACCOUNT_KIND_LABEL, cashSummary, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { addDays, shortDay, withinRange } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { ListTable } from '../../ui/ListTable'
import { PageBar } from '../../ui/PageBar'
import { EmptyState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { TRANSACTION_TONE } from '../shared/tones'
import { AccountForm } from './AccountForm'
import { PettyFacts } from './PettyCash'

type Panel = 'edit' | 'count' | 'adjust'

/** Count the physical cash against the book balance; the difference can become an adjustment entry. */
function CountForm({ accountId, balance, today, onDone, onCancel }: { accountId: string; balance: number; today: string; onDone: () => void; onCancel: () => void }) {
  const { finance } = useServices()
  const [counted, setCounted] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const difference = counted === '' ? null : Number(counted) - balance

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await finance.reconcile({ accountId, date: String(f.get('date') ?? today), counted: Number(counted), note: String(f.get('note') ?? ''), adjust: f.get('adjust') === 'on' })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label="Count cash">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">Count cash</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Count date" htmlFor="rc-date" error={errors.date}>
            <Input id="rc-date" name="date" type="date" defaultValue={today} max={today} />
          </Field>
          <Field label="Counted, Rp" htmlFor="rc-counted" error={errors.counted}>
            <Input id="rc-counted" type="number" inputMode="numeric" min={0} step={1000} value={counted} onChange={(e) => setCounted(e.target.value)} className="tabular" placeholder="0" />
          </Field>
          <Field label="Book balance">
            <p className="flex h-12 items-center rounded-full border border-dashed border-line-strong px-4 text-sm tabular">{money(balance)}</p>
          </Field>
          <Field label="Note" htmlFor="rc-note" className="sm:col-span-2">
            <Textarea id="rc-note" name="note" rows={2} placeholder="Who counted, and what explains a difference" />
          </Field>
          <Field label="Difference">
            <p className={cn('flex h-12 items-center rounded-full border border-dashed border-line-strong px-4 text-sm font-semibold tabular', difference === null ? 'text-muted' : difference === 0 ? 'text-success' : 'text-danger')}>
              {difference === null ? 'Enter the count' : difference === 0 ? 'Matches' : `${difference > 0 ? 'Over by ' : 'Short by '}${money(Math.abs(difference))}`}
            </p>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="adjust" defaultChecked className="size-4 accent-[var(--color-accent)]" />
          Post the difference as an adjustment entry for approval
        </label>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            Save the count
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** A correction with a mandatory reason, submitted through the normal approval chain. */
function AdjustForm({ accountId, today, onDone, onCancel }: { accountId: string; today: string; onDone: () => void; onCancel: () => void }) {
  const { finance } = useServices()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await finance.adjust({ accountId, direction: f.get('direction') === 'increase' ? 'increase' : 'decrease', amount: Number(f.get('amount')), date: String(f.get('date') ?? today), reason: String(f.get('reason') ?? '') })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label="Adjust balance">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">Adjust balance</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Direction" htmlFor="adj-dir">
            <Select id="adj-dir" name="direction" className="w-full" options={[{ value: 'decrease', label: 'Decrease the balance' }, { value: 'increase', label: 'Increase the balance' }]} />
          </Field>
          <Field label="Amount, Rp" htmlFor="adj-amount" error={errors.amount}>
            <Input id="adj-amount" name="amount" type="number" inputMode="numeric" min={0} step={1000} className="tabular" placeholder="0" />
          </Field>
          <Field label="Date" htmlFor="adj-date" error={errors.date}>
            <Input id="adj-date" name="date" type="date" defaultValue={today} max={today} />
          </Field>
          <Field label="Reason" htmlFor="adj-reason" error={errors.reason} className="sm:col-span-3">
            <Textarea id="adj-reason" name="reason" rows={2} placeholder="What the correction fixes; it stays on the entry" />
          </Field>
        </div>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            Submit adjustment
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

export default function CashAccountPage() {
  const { id = '' } = useParams()
  const { finance, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const resource = useResource(`finance.account:${id}`, () => finance.account(id), { keepPrevious: false })
  const [panel, setPanel] = useState<Panel | null>(null)
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  function setRange(r: { from?: string; to?: string }) {
    const search = new URLSearchParams(params)
    if (r.from) search.set('from', r.from)
    else search.delete('from')
    if (r.to) search.set('to', r.to)
    else search.delete('to')
    search.delete('page')
    setParams(search, { replace: true })
  }
  const toggle = (p: Panel) => setPanel((v) => (v === p ? null : p))
  function done(title: string, description?: string) {
    toast({ title, description })
    setPanel(null)
    resource.reload()
  }

  return (
    <Gate resource={resource} what="account" back={{ to: '/finance', label: 'Back to the cashbox' }}>
      {(d) => (
        <>
          <PageBar
            fallback="/finance"
            label="Cashbox"
            actions={
              <>
                {can('master', 'edit') && (
                  <Button variant="card" aria-pressed={panel === 'edit'} onClick={() => toggle('edit')}>
                    <Pencil aria-hidden className="size-4" /> Edit
                  </Button>
                )}
                {can('finance', 'submit') && (
                  <>
                    <Button variant="card" aria-pressed={panel === 'adjust'} onClick={() => toggle('adjust')}>
                      <Scale aria-hidden className="size-4" /> Adjust balance
                    </Button>
                    <Button variant="card" aria-pressed={panel === 'count'} onClick={() => toggle('count')}>
                      <Calculator aria-hidden className="size-4" /> Count cash
                    </Button>
                    <Link to={`/finance/transfer?from=${d.account.id}`} className={buttonStyles({ variant: 'card' })}>
                      <ArrowLeftRight aria-hidden className="size-4" /> Transfer
                    </Link>
                  </>
                )}
                <Link to={`/finance/transactions/new?account=${d.account.id}`} className={buttonStyles({ variant: 'accent' })}>
                  <ArrowDownLeft aria-hidden className="size-4" /> New entry
                </Link>
              </>
            }
          />
          <div className="space-y-4">
            {panel === 'edit' && (
              <AccountForm initial={d.account} locations={d.locations} today={d.today} save={(input) => finance.updateAccount(d.account.id, input)} onDone={() => done(`Saved ${d.account.name}`)} onCancel={() => setPanel(null)} />
            )}
            {panel === 'count' && <CountForm accountId={d.account.id} balance={d.balance} today={d.today} onDone={() => done('Count saved', 'A difference was submitted as an adjustment when you asked for it.')} onCancel={() => setPanel(null)} />}
            {panel === 'adjust' && <AdjustForm accountId={d.account.id} today={d.today} onDone={() => done('Adjustment submitted', 'It waits for approval like any other entry.')} onCancel={() => setPanel(null)} />}
            <Card aria-label={d.account.name}>
              <Headline>{d.account.name}</Headline>
              <p className="mt-1 text-sm text-muted">
                {ACCOUNT_KIND_LABEL[d.account.kind]} · {d.petty?.villa?.name ?? d.location?.name ?? 'All locations'}
              </p>
              {d.petty && (
                <div className="mt-6">
                  <PettyFacts row={d.petty} />
                </div>
              )}
              {!d.petty && <p className="mt-6 min-w-0 text-[44px] leading-none font-medium tracking-tight break-words tabular">{money(d.balance)}</p>}
              <FactGrid
                className="mt-6 grid-cols-2 sm:grid-cols-4"
                facts={[
                  ['Opening balance', money(d.account.openingBalance)],
                  ['Opened on', shortDay(d.account.openedOn)],
                  ['Entries', d.ledger.length],
                  ['Last count', d.reconciliations[0] ? `${shortDay(d.reconciliations[0].date)} · ${d.reconciliations[0].difference === 0 ? 'matched' : money(d.reconciliations[0].difference)}` : 'Never'],
                ]}
              />
            </Card>
            <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 min-[1360px]:grid-cols-4">
              <StatTile label="Balance" value={money(d.balance)} hint={`Opened with ${money(d.account.openingBalance)}`} to={`/finance/transactions?account=${d.account.id}`} />
              <StatTile label="In, 30 days" value={money(cashSummary(d.ledger, addDays(d.today, -29), addDays(d.today, 1)).cashIn)} to={`/finance/transactions?account=${d.account.id}&kind=cash_in`} />
              <StatTile label="Out, 30 days" value={money(cashSummary(d.ledger, addDays(d.today, -29), addDays(d.today, 1)).cashOut)} to={`/finance/transactions?account=${d.account.id}&kind=cash_out`} />
              <StatTile label="Awaiting approval" value={d.ledger.filter((t) => t.status === 'submitted' || t.status === 'approved').length} hint="Not yet in the balance" to={`/finance/transactions?account=${d.account.id}&status=submitted`} />
            </div>
            <Card className="p-0" aria-labelledby="ledger-title">
              <div className="p-5 pb-0">
                <CardHeader id="ledger-title" title="Ledger" action={<DateRangeFilter today={clock.today()} label="Date" value={{ from, to }} onChange={setRange} />} />
                <p className="mb-2 text-xs text-muted">Running balance counts posted entries only.</p>
              </div>
              <ListTable
                label="Ledger"
                rows={d.ledger.filter((t) => withinRange(t.date, from, to))}
                rowKey={(t) => t.id}
                href={(t) => `/finance/transactions/${t.id}`}
                exportName={`ledger-${d.account.id}`}
                exportDate={clock.today()}
                empty={<EmptyState title="No entries yet" />}
                columns={[
                  { key: 'date', header: 'Date', cell: (t) => shortDay(t.date), value: (t) => t.date },
                  { key: 'no', header: 'Number', cell: (t) => <span className="font-mono text-xs text-muted">{t.number}</span>, value: (t) => t.number, hide: 'lg' },
                  { key: 'desc', header: 'Description', cell: (t) => <span className="line-clamp-1">{t.description}</span>, value: (t) => t.description },
                  { key: 'cat', header: 'Category', cell: (t) => t.categoryName, value: (t) => t.categoryName, hide: 'lg' },
                  { key: 'ref', header: 'Reference', cell: (t) => <span className="font-mono text-xs">{t.reference || '—'}</span>, value: (t) => t.reference, hide: 'xl' },
                  { key: 'status', header: 'Status', cell: (t) => <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>, value: (t) => TRANSACTION_STATUS_LABEL[t.status] },
                  { key: 'amount', header: 'Amount', align: 'right', cell: (t) => <span className={cn('font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>{t.kind === 'cash_out' ? '-' : '+'}{money(t.amount)}</span>, value: (t) => (t.kind === 'cash_out' ? -t.amount : t.amount), total: (sum) => `${sum < 0 ? '-' : '+'}${money(Math.abs(sum))}` },
                  { key: 'run', header: 'Balance', align: 'right', cell: (t) => <span className="tabular">{money(t.running)}</span>, value: (t) => t.running, hide: 'lg' },
                ]}
                card={(t) => (
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{t.description}</p>
                      <p className="text-xs text-muted">
                        {shortDay(t.date)} · {t.categoryName}
                      </p>
                    </div>
                    <span className={cn('text-sm font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>{t.kind === 'cash_out' ? '-' : '+'}{money(t.amount)}</span>
                  </div>
                )}
              />
            </Card>
            <Card aria-labelledby="counts-title">
              <CardHeader id="counts-title" title="Cash counts" />
              {d.reconciliations.length === 0 ? (
                <p className="text-sm text-muted">No count on record. Count the drawer weekly and save the result here.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.reconciliations.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 text-sm first:pt-0 last:pb-0">
                      <span className="w-16 shrink-0 text-xs text-muted">{shortDay(r.date)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          Book {money(r.expected)} · counted {money(r.counted)} ·{' '}
                          <span className={cn('font-semibold', r.difference === 0 ? 'text-success' : 'text-danger')}>{r.difference === 0 ? 'matched' : `${r.difference > 0 ? 'over' : 'short'} by ${money(Math.abs(r.difference))}`}</span>
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {r.by}
                          {r.note && ` · ${r.note}`}
                        </span>
                      </span>
                      {r.adjustmentId && (
                        <Link to={`/finance/transactions/${r.adjustmentId}`} className="shrink-0 text-xs text-accent-text hover:underline">
                          Adjustment entry
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </Gate>
  )
}

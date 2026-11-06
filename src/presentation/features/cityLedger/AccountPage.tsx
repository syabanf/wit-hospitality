import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { FileText, Mail, Pencil, Wallet } from 'lucide-react'
import { CITY_AGING_BUCKETS, CITY_AGING_LABEL, CITY_LEDGER_METHODS, LEDGER_ITEM_LABEL, WRITE_OFF_LIMIT, type CityLedgerMethod } from '@/domain/cityLedger'
import { PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { shortDay } from '@/lib/dates'
import { money, percent } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { FactGrid } from '../../ui/Headline'
import { Popover } from '../../ui/Popover'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { AccountForm } from './AccountForm'
import { INVOICE_TONE } from './tones'

/** One company or agent: what it owes and why, its invoices and payments, and the actions finance takes on them. */
export default function AccountPage() {
  const { id = '' } = useParams()
  const { cityLedger } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource(`cityLedger.account:${id}`, () => cityLedger.account(id), { keepPrevious: false })
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const [through, setThrough] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(title: string, run: () => Promise<unknown>) {
    setBusy(true)
    try {
      await run()
      toast({ title })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not done', description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  const d = data.data
  const a = d.account
  const open = d.invoices.filter((i) => i.open > 0)

  return (
    <div className="space-y-4">
      <Card aria-labelledby="acc-title">
        <CardHeader
          id="acc-title"
          title={`${a.code} ${a.name}`}
          action={
            <>
              <Link to={`/city-ledger/${a.id}/statement`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
                <FileText aria-hidden className="size-3.5" /> Statement
              </Link>
              {can('finance', 'edit') && a.credit > 0 && open.length > 0 && (
                <Button size="sm" variant="soft" loading={busy} onClick={() => void act('Credit spread over the open invoices', () => cityLedger.applyCredit(a.id))}>
                  Apply credit
                </Button>
              )}
              {can('finance', 'edit') && (
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${a.name}`} onClick={() => setEditing((v) => !v)}>
                  <Pencil aria-hidden className="size-4" />
                </Button>
              )}
            </>
          }
        />
        {editing && (
          <AccountForm
            id={a.id}
            initial={{ name: a.name, kind: a.kind, contact: a.contact, billingEmail: a.billingEmail, phone: a.phone, address: a.address, npwp: a.npwp, creditLimit: a.creditLimit, termsDays: a.termsDays, commissionPct: a.commissionPct, active: a.active, villaIds: a.villaIds }}
            villas={d.villas}
            onDone={() => {
              setEditing(false)
              data.reload()
            }}
          />
        )}
        <p className="mb-3 text-sm text-muted">
          {a.kindLabel}
          {a.commissionPct ? `, ${a.commissionPct}% commission` : ''} · {a.contact} · {a.billingEmail} · {a.phone} · {a.address}
          {a.npwp && ` · NPWP ${a.npwp}`} · {a.termsDays} days{a.active ? '' : ' · closed for new bookings'}
        </p>
        <FactGrid
          className="grid-cols-2 sm:grid-cols-4"
          facts={[
            ['Balance', money(a.balance)],
            ['Overdue', <span key="o" className={a.overdue > 0 ? 'text-danger' : undefined}>{money(a.overdue)}</span>],
            ['Credit used', `${percent(a.usedPct, { digits: 0 })} of ${money(a.creditLimit)}`],
            ['Credit on account', money(a.credit)],
          ]}
        />
        <FactGrid className="mt-3 grid-cols-2 sm:grid-cols-5" facts={CITY_AGING_BUCKETS.map((k) => [CITY_AGING_LABEL[k], money(a.aging[k])] as const)} />
      </Card>

      <Card aria-labelledby="open-title">
        <CardHeader
          id="open-title"
          title="Transferred, not invoiced"
          action={
            can('finance', 'create') &&
            d.uninvoiced.length > 0 && (
              <>
                <Input type="date" aria-label="Invoice transfers up to" className="h-8 w-40" value={through || d.today} max={d.today} onChange={(e) => setThrough(e.target.value)} />
                <Button size="sm" variant="accent" loading={busy} onClick={() => void act('Invoice issued', () => cityLedger.issueInvoice(a.id, through || d.today))}>
                  Issue invoice
                </Button>
              </>
            )
          }
        />
        {d.uninvoiced.length === 0 ? (
          <EmptyState title="Nothing waits for an invoice" />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {d.uninvoiced.map((u) => (
              <li key={u.bookingId} className="flex justify-between gap-3 py-2">
                <span>
                  <Link to={`/bookings/${u.bookingId}/folio`} className="font-mono hover:underline">{u.code}</Link> <span className="text-muted">transferred {shortDay(u.date)}</span>
                </span>
                <span className="tabular">{money(u.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="inv-title">
        <CardHeader id="inv-title" title="Invoices" />
        {d.invoices.length === 0 ? (
          <EmptyState title="No invoice issued yet" />
        ) : (
          <DataTable
            label="Invoices"
            rows={d.invoices}
            rowKey={(i) => i.id}
            columns={[
              { key: 'n', header: 'Invoice', cell: (i) => <Link to={`/city-ledger/invoices/${i.id}`} className="font-mono font-medium hover:underline">{i.number}</Link> },
              { key: 'i', header: 'Issued', cell: (i) => shortDay(i.issuedOn) },
              { key: 'd', header: 'Due', cell: (i) => `${shortDay(i.dueOn)}${i.daysOverdue > 0 ? `, ${i.daysOverdue} days late` : ''}` },
              { key: 'g', header: 'Net due', align: 'right', cell: (i) => money(i.net) },
              { key: 'p', header: 'Paid', align: 'right', cell: (i) => money(i.paid + i.writtenOff) },
              { key: 'o', header: 'Open', align: 'right', cell: (i) => money(i.open) },
              { key: 's', header: 'State', cell: (i) => <StatusPill tone={INVOICE_TONE[i.state]}>{i.stateLabel}</StatusPill> },
              {
                key: 'a',
                header: '',
                align: 'right',
                cell: (i) => (
                  <span className="inline-flex gap-1">
                    {can('finance', 'edit') && (
                      <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(`${i.number} sent to ${a.billingEmail}`, () => cityLedger.sendInvoice(i.id))}>
                        <Mail aria-hidden className="size-3.5" /> {i.sentAt ? 'Send again' : 'Email'}
                      </Button>
                    )}
                    {can('finance', 'submit') && i.open - i.pending > 0 && i.open - i.pending <= WRITE_OFF_LIMIT && <WriteOff invoice={i} accountId={a.id} onDone={data.reload} />}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card aria-labelledby="pay-title">
        <CardHeader id="pay-title" title="Payments" action={can('finance', 'submit') && <Button size="sm" variant="accent" onClick={() => setPaying((v) => !v)}><Wallet aria-hidden className="size-4" /> Record payment</Button>} />
        {paying && (
          <PaymentForm
            accountId={a.id}
            open={open.map((i) => ({ id: i.id, number: i.number, open: i.open - i.pending }))}
            cashAccounts={d.cashAccounts}
            onDone={() => {
              setPaying(false)
              data.reload()
            }}
          />
        )}
        {d.payments.length === 0 ? (
          <EmptyState title="No payment recorded" />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {d.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-mono">{p.number}</span> · {shortDay(p.date)} · {PAYMENT_METHOD_LABEL[p.method]}
                  {p.reference && ` · ${p.reference}`}
                  {p.invoiceNumbers && <span className="text-muted"> · to {p.invoiceNumbers}</span>}
                  {p.credit > 0 && <span className="text-muted"> · {money(p.credit)} credit</span>}
                </span>
                <span className="flex items-center gap-2">
                  {p.transaction && (
                    <Link to={`/finance/transactions/${p.transaction.id}`} className="text-xs hover:underline">
                      <StatusPill tone={p.posted ? 'success' : 'warning'}>{p.statusLabel}</StatusPill>
                    </Link>
                  )}
                  <span className="tabular font-medium">{money(p.amount)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {d.writeOffs.length > 0 && (
          <>
            <p className="mt-4 mb-1 text-sm font-semibold">Write-offs</p>
            <ul className="divide-y divide-line text-sm">
              {d.writeOffs.map((w) => (
                <li key={w.id} className="flex flex-wrap justify-between gap-3 py-2">
                  <span>
                    <span className="font-mono">{w.number}</span> · {w.invoiceNumber} · {w.reason}{' '}
                    <Link to={`/accounting/manual/${w.manualJournalId}`} className="text-xs hover:underline">
                      <StatusPill tone={w.posted ? 'success' : w.live ? 'warning' : 'danger'}>{w.posted ? 'Posted' : w.live ? 'In approval' : 'Rejected'}</StatusPill>
                    </Link>
                  </span>
                  <span className="tabular">{money(w.amount)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card aria-labelledby="led-title">
        <CardHeader id="led-title" title="Account ledger" />
        {d.ledger.lines.length === 0 ? (
          <EmptyState title="Nothing on the account yet" />
        ) : (
          <DataTable
            label="Account ledger"
            rows={[...d.ledger.lines].reverse()}
            rowKey={(l) => `${l.kind}-${l.ref}-${l.date}`}
            columns={[
              { key: 'd', header: 'Date', cell: (l) => shortDay(l.date) },
              { key: 'k', header: 'Item', cell: (l) => LEDGER_ITEM_LABEL[l.kind] },
              { key: 'r', header: 'Reference', cell: (l) => (l.href ? <Link to={l.href} className="font-mono hover:underline">{l.ref}</Link> : <span className="font-mono">{l.ref}</span>) },
              { key: 'x', header: 'Description', cell: (l) => <span className="text-muted">{l.description}</span> },
              { key: 'dr', header: 'Charged', align: 'right', cell: (l) => (l.debit ? money(l.debit) : '') },
              { key: 'cr', header: 'Paid or taken off', align: 'right', cell: (l) => (l.credit ? money(l.credit) : '') },
              { key: 'b', header: 'Balance', align: 'right', cell: (l) => money(l.balance) },
            ]}
          />
        )}
      </Card>
    </div>
  )
}

function PaymentForm({ accountId, open, cashAccounts, onDone }: { accountId: string; open: ReadonlyArray<{ id: string; number: string; open: number }>; cashAccounts: ReadonlyArray<{ id: string; name: string; kind: string }>; onDone: () => void }) {
  const { cityLedger } = useServices()
  const toast = useToast()
  const [method, setMethod] = useState<CityLedgerMethod>('bank_transfer')
  const [pick, setPick] = useState(false)
  const [shares, setShares] = useState<Record<string, number>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const boxes = cashAccounts.filter((c) => (method === 'cash' ? c.kind === 'cashbox' : c.kind === 'bank'))

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const p = await cityLedger.recordPayment({
        accountId,
        method,
        cashAccountId: String(f.get('cashAccountId') ?? ''),
        amount: Number(f.get('amount')) || 0,
        reference: String(f.get('reference') ?? ''),
        note: String(f.get('note') ?? ''),
        allocations: pick ? open.map((i) => ({ invoiceId: i.id, amount: shares[i.id] ?? 0 })).filter((x) => x.amount > 0) : null,
      })
      toast({ title: `${p.number} recorded`, description: 'The cash-in waits for approval in Finance; it counts once posted.' })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="mb-4 grid grid-cols-1 gap-3 rounded-panel bg-raised p-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Method" htmlFor="clp-method" error={errors.method}>
        <Select id="clp-method" className="w-full" value={method} options={CITY_LEDGER_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setMethod(e.target.value as CityLedgerMethod)} />
      </Field>
      <Field label="Landed in" htmlFor="clp-box" error={errors.cashAccountId}>
        <Select id="clp-box" name="cashAccountId" key={method} className="w-full" options={boxes.map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      <Field label="Amount, Rp" htmlFor="clp-amount" error={errors.amount ?? errors.form}>
        <Input id="clp-amount" name="amount" type="number" inputMode="numeric" min={1000} step={1000} className="tabular" />
      </Field>
      <Field label="Bank reference" htmlFor="clp-ref" error={errors.reference}>
        <Input id="clp-ref" name="reference" placeholder="From the bank statement" />
      </Field>
      <Field label="Note" htmlFor="clp-note">
        <Input id="clp-note" name="note" />
      </Field>
      <fieldset className="sm:col-span-2 lg:col-span-3">
        <legend className="mb-1.5 text-xs font-medium text-muted">Spread over</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="clp-mode" checked={!pick} onChange={() => setPick(false)} /> Oldest invoices first
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="clp-mode" checked={pick} onChange={() => setPick(true)} disabled={open.length === 0} /> Invoices I pick
          </label>
        </div>
        {pick && (
          <ul className="mt-2 space-y-2">
            {open.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-40 font-mono">{i.number}</span>
                <span className="w-36 text-muted">{money(i.open)} open</span>
                <Input aria-label={`Amount to ${i.number}`} type="number" inputMode="numeric" min={0} max={i.open} step={1000} className="h-8 w-40 tabular" value={shares[i.id] || ''} onChange={(e) => setShares((s) => ({ ...s, [i.id]: Number(e.target.value) || 0 }))} />
              </li>
            ))}
          </ul>
        )}
        {errors.allocations && <p role="alert" className="mt-1.5 text-xs font-medium text-danger">{errors.allocations}</p>}
        <p className="mt-1.5 text-xs text-muted">What the invoices do not take stays on the account as credit.</p>
      </fieldset>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="accent" loading={saving}>Submit for approval</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  )
}

function WriteOff({ invoice, accountId, onDone }: { invoice: { id: string; number: string; open: number; pending: number }; accountId: string; onDone: () => void }) {
  const { cityLedger } = useServices()
  const toast = useToast()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const left = invoice.open - invoice.pending

  async function save(e: FormEvent<HTMLFormElement>, close: () => void) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    try {
      const w = await cityLedger.writeOff({ accountId, invoiceId: invoice.id, amount: Number(f.get('amount')) || 0, reason: String(f.get('reason') ?? '') })
      toast({ title: `${w.number} sent for approval`, description: 'The manual journal waits in the approval inbox.' })
      close()
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    }
  }

  return (
    <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => <Button {...props} size="sm" variant="ghost">Write off</Button>}>
      {(close) => (
        <form onSubmit={(e) => void save(e, close)} className="space-y-3 text-left">
          <p className="text-sm font-semibold">Write off what is left on {invoice.number}</p>
          <Field label="Amount, Rp" htmlFor={`wo-${invoice.id}`} error={errors.amount ?? errors.form} hint={`Up to ${money(left)}; it posts once signed`}>
            <Input id={`wo-${invoice.id}`} name="amount" type="number" inputMode="numeric" min={1} max={left} defaultValue={left} className="tabular" />
          </Field>
          <Field label="Reason" htmlFor={`wor-${invoice.id}`} error={errors.reason}>
            <Input id={`wor-${invoice.id}`} name="reason" placeholder="Bank charges taken off the transfer" />
          </Field>
          <Button type="submit" variant="accent" size="sm">Send for approval</Button>
        </form>
      )}
    </Popover>
  )
}

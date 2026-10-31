import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import type { TransactionView, WorkOrderView } from '@/application/views'
import type { Attachment } from '@/domain/attachment'
import { EXPENSE_KIND_LABEL, EXPENSE_KINDS, EXPENSE_METHOD_LABEL, type ExpenseInput, type ExpenseKind, type ExpenseMethod, type Vendor, type WorkOrderExpense } from '@/domain/maintenance'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { FactGrid } from '../../ui/Headline'
import { Popover } from '../../ui/Popover'
import { useToast } from '../../ui/useToast'
import { AttachmentList, AttachmentPicker } from '../shared/Attachments'
import { TRANSACTION_TONE } from '../shared/tones'

type Line = WorkOrderExpense & { entry: TransactionView | null }

interface Props {
  workOrder: WorkOrderView
  expenses: readonly Line[]
  vendors: readonly Vendor[]
  canAdd: boolean
  today: string
  onChanged: () => void
}

/** What the job cost in money that left an account: one line per purchase or bill, each with its own ledger entry. */
export function WorkOrderExpenses({ workOrder: w, expenses, vendors, canAdd, today, onChanged }: Props) {
  const { maintenance } = useServices()
  const toast = useToast()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  /** Receipts of the form that is open; one form shows at a time. */
  const [receipts, setReceipts] = useState<Attachment[]>([])

  const read = (f: FormData): ExpenseInput => {
    const vendorId = String(f.get('vendorId') ?? '') || null
    return {
      kind: String(f.get('kind')) as ExpenseKind,
      description: String(f.get('description') ?? ''),
      payee: String(f.get('payee') ?? '') || vendors.find((v) => v.id === vendorId)?.name || '',
      vendorId,
      amount: Number(f.get('amount')),
      method: String(f.get('method')) as ExpenseMethod,
      reference: String(f.get('reference') ?? ''),
      receipts,
      paidOn: String(f.get('paidOn') ?? today),
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>, close: () => void, line?: Line) {
    e.preventDefault()
    const input = read(new FormData(e.currentTarget))
    setBusy(true)
    setErrors({})
    try {
      if (line) await maintenance.correctExpense(w.id, line.id, input)
      else await maintenance.addExpense(w.id, input)
      toast({ title: line ? `Corrected and resubmitted line ${line.line}` : 'Expense submitted for approval', description: `${money(input.amount)} · ${EXPENSE_METHOD_LABEL[input.method]}` })
      setReceipts([])
      close()
      onChanged()
    } catch (error) {
      const fe = fieldErrors(error)
      setErrors(fe)
      toast({ tone: 'danger', title: 'Could not save the expense', description: Object.values(fe)[0] })
    } finally {
      setBusy(false)
    }
  }

  const form = (close: () => void, line?: Line) => {
    const id = line?.id ?? 'new'
    return (
      <form onSubmit={(e) => void submit(e, close, line)} className="space-y-3">
        <p className="text-sm font-semibold">{line ? `Correct line ${line.line}` : 'Add an expense'}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind" htmlFor={`x-kind-${id}`} error={errors.kind}>
            <Select id={`x-kind-${id}`} name="kind" className="w-full" defaultValue={line?.kind ?? (w.vendorId ? 'vendor' : 'parts')} options={EXPENSE_KINDS.map((k) => ({ value: k, label: EXPENSE_KIND_LABEL[k] }))} />
          </Field>
          <Field label="Paid by" htmlFor={`x-method-${id}`} error={errors.method}>
            <Select id={`x-method-${id}`} name="method" className="w-full" defaultValue={line?.method ?? (w.vendorId ? 'bank_transfer' : 'cash')} options={(['cash', 'bank_transfer'] as const).map((m) => ({ value: m, label: m === 'cash' ? 'Cash' : 'Bank transfer' }))} />
          </Field>
        </div>
        <Field label="What" htmlFor={`x-desc-${id}`} error={errors.description}>
          <Input id={`x-desc-${id}`} name="description" defaultValue={line?.description} placeholder="Capacitor and refrigerant" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor" htmlFor={`x-vendor-${id}`}>
            <Select id={`x-vendor-${id}`} name="vendorId" className="w-full" defaultValue={line?.vendorId ?? w.vendorId ?? ''} options={[{ value: '', label: 'Not a vendor' }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]} />
          </Field>
          <Field label="Payee" htmlFor={`x-payee-${id}`} error={errors.payee} hint="Shop name when not a vendor">
            <Input id={`x-payee-${id}`} name="payee" defaultValue={line?.payee} placeholder="Toko Listrik Jaya" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount, Rp" htmlFor={`x-amt-${id}`} error={errors.amount}>
            <Input id={`x-amt-${id}`} name="amount" type="number" inputMode="numeric" min={1000} step={1000} defaultValue={line?.amount} className="tabular" />
          </Field>
          <Field label="Paid on" htmlFor={`x-date-${id}`} error={errors.paidOn}>
            <Input id={`x-date-${id}`} name="paidOn" type="date" max={today} defaultValue={line?.paidOn ?? today} />
          </Field>
        </div>
        <Field label="Invoice or receipt number" htmlFor={`x-ref-${id}`} error={errors.reference}>
          <Input id={`x-ref-${id}`} name="reference" defaultValue={line?.reference} placeholder="INV/CD/1031" />
        </Field>
        <Field label="Receipt or invoice" htmlFor={`x-rec-${id}`} error={errors.receipts}>
          <AttachmentPicker id={`x-rec-${id}`} value={receipts} onChange={setReceipts} hint="Photo or PDF" />
        </Field>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <Button type="submit" variant="accent" size="sm" loading={busy}>
          {line ? 'Resubmit' : 'Submit for approval'}
        </Button>
      </form>
    )
  }

  return (
    <Card aria-labelledby="wo-exp">
      <CardHeader
        id="wo-exp"
        title="Expenses"
        action={
          canAdd && (
            <Popover align="right" className="w-[22rem] max-w-[calc(100vw-2rem)] animate-pop-in p-4" trigger={(props) => (
              <Button {...props} size="sm" variant="accent" onClick={() => {
                setReceipts([])
                props.onClick()
              }}>
                <Plus aria-hidden className="size-3.5" /> Expense
              </Button>
            )}>
              {(close) => form(close)}
            </Popover>
          )
        }
      />
      <FactGrid className="grid-cols-3" facts={[['Recorded', money(w.spent.recorded)], ['Approved', money(w.spent.approved)], ['Posted', money(w.spent.posted)]]} />
      {expenses.length === 0 ? (
        <p className="mt-4 rounded-panel bg-raised px-4 py-5 text-center text-sm text-muted">{canAdd ? 'No money paid yet. Add each purchase or bill as it is paid.' : 'Expenses can be added once the work starts.'}</p>
      ) : (
        <ul className="stagger mt-4 divide-y divide-line">
          {expenses.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {e.line}. {EXPENSE_KIND_LABEL[e.kind]}: {e.description}
                </span>
                <span className="block truncate text-xs text-muted">
                  {e.payee} · {EXPENSE_METHOD_LABEL[e.method]} · {shortDay(e.paidOn)}
                  {e.reference && ` · ${e.reference}`}
                </span>
                {e.entry?.status === 'rejected' && e.entry.rejectionReason && <span className="block text-xs text-danger">Rejected: {e.entry.rejectionReason}</span>}
                <span className="mt-2 block">
                  <AttachmentList files={e.entry?.attachments ?? e.receipts} empty="No receipt attached" />
                </span>
              </span>
              {e.entry && (
                <Link to={`/finance/transactions/${e.entry.id}`} className="font-mono text-xs text-muted hover:underline">
                  {e.entry.number}
                </Link>
              )}
              {e.entry && <StatusPill tone={TRANSACTION_TONE[e.entry.status]}>{TRANSACTION_STATUS_LABEL[e.entry.status]}</StatusPill>}
              <span className="shrink-0 font-semibold tabular">{money(e.amount)}</span>
              {e.entry?.status === 'rejected' && canAdd && (
                <Popover align="right" className="w-[22rem] max-w-[calc(100vw-2rem)] animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="icon-sm" variant="ghost" aria-label={`Correct line ${e.line}`} onClick={() => {
                    setReceipts([...(e.entry?.attachments ?? e.receipts)])
                    props.onClick()
                  }}>
                    <Pencil aria-hidden className="size-4" />
                  </Button>
                )}>
                  {(close) => form(close, e)}
                </Popover>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

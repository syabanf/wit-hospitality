import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import { CODE_KIND_LABEL, CODE_KINDS, DEPARTMENT_LABEL, DEPARTMENTS, type CodeKind, type Department, type TransactionCode } from '@/domain/transactionCode'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'

type Data = Awaited<ReturnType<ReturnType<typeof useServices>['accounting']['transactionCodes']>>

function CodeForm({ initial, accounts, onDone, onCancel }: { initial?: TransactionCode; accounts: Data['accounts']; onDone: (code: string) => void; onCancel: () => void }) {
  const { accounting } = useServices()
  const [kind, setKind] = useState<CodeKind>(initial?.kind ?? 'charge')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const saved = await accounting.saveTransactionCode(initial?.id ?? null, {
        code: String(f.get('code') ?? ''),
        name: String(f.get('name') ?? ''),
        kind,
        department: f.get('department') as Department,
        accountId: kind === 'payment' ? null : String(f.get('accountId') ?? ''),
        active: initial?.active ?? true,
      })
      onDone(saved.code)
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.code}` : 'New transaction code'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.code}` : 'New transaction code'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
          <Field label="Code" htmlFor="tc-code" error={errors.code}>
            <Input id="tc-code" name="code" defaultValue={initial?.code} placeholder="BIKE" className="font-mono uppercase" />
          </Field>
          <Field label="Name" htmlFor="tc-name" error={errors.name}>
            <Input id="tc-name" name="name" defaultValue={initial?.name} placeholder="Scooter rental" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Kind" htmlFor="tc-kind" error={errors.kind}>
            <Select id="tc-kind" className="w-full" value={kind} disabled={initial?.kind === 'payment'} onChange={(e) => setKind(e.target.value as CodeKind)} options={CODE_KINDS.map((k) => ({ value: k, label: CODE_KIND_LABEL[k] }))} />
          </Field>
          <Field label="Department" htmlFor="tc-department" error={errors.department}>
            <Select id="tc-department" name="department" className="w-full" defaultValue={initial?.department ?? 'extras'} options={DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABEL[d] }))} />
          </Field>
          <Field label="Revenue account" htmlFor="tc-account" error={errors.accountId} hint={kind === 'payment' ? 'A payment books by its cash entry.' : 'Postings from now on book here.'}>
            <Select id="tc-account" name="accountId" className="w-full" disabled={kind === 'payment'} defaultValue={initial?.accountId ?? accounts[0]?.id} options={accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save code' : 'Add code'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** Folio transaction codes with the revenue account each books to; finance adds, edits and retires them here. */
export default function TransactionCodesPage() {
  const { accounting } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('accounting.transactionCodes', () => accounting.transactionCodes())
  const [editing, setEditing] = useState<string | null>(null)
  const editable = can('finance', 'edit')

  async function toggle(c: TransactionCode, active: boolean) {
    try {
      await accounting.setTransactionCodeActive(c.id, active)
      toast({ title: active ? `Restored ${c.code}` : `Deactivated ${c.code}`, description: active ? 'The desk can post on it again.' : 'Lines already posted keep it; new postings cannot pick it.' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not change ${c.code}`, description: error instanceof Error ? error.message : undefined })
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { codes, accounts } = data.data
  const current = editing && editing !== 'new' ? codes.find((c) => c.id === editing) : undefined
  const revenue = codes.filter((c) => c.kind !== 'payment')
  const top = [...revenue].sort((a, b) => b.revenue - a.revenue)[0]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 min-[1360px]:grid-cols-4">
        <StatTile label="Charge codes" value={revenue.filter((c) => c.active).length} hint={`${codes.filter((c) => !c.active).length} inactive`} />
        <StatTile label="Payment codes" value={codes.filter((c) => c.kind === 'payment').length} hint="One per payment method" />
        <StatTile label="Revenue this year" value={money(revenue.reduce((s, c) => s + c.revenue, 0))} hint="On coded journal lines" to="/reports/revenue-codes" />
        <StatTile label="Top code" value={top?.code ?? 'None'} hint={top ? money(top.revenue) : ''} to="/reports/revenue-codes" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Every folio line carries a code: room nights post on ROOM, menu items on the code of their category, manual charges on the code the desk picks, payments on their method. A charge code names the revenue account its lines book to, so this page decides guest revenue; the{' '}
          <Link to="/finance/categories" className="font-medium text-fg underline">
            Categories page
          </Link>{' '}
          maps the cash entries that are not guest money.
        </p>
        {editable && (
          <Button variant="accent" aria-pressed={editing === 'new'} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            <Plus aria-hidden className="size-4" /> Code
          </Button>
        )}
      </div>
      {(editing === 'new' || current) && (
        <CodeForm
          key={editing}
          initial={current}
          accounts={accounts}
          onCancel={() => setEditing(null)}
          onDone={(code) => {
            toast({ title: current ? `Saved ${code}` : `Added ${code}`, description: 'Postings from now on use it; posted journals stay as they are.' })
            setEditing(null)
            data.reload()
          }}
        />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {(['charge', 'payment'] as const).map((group) => (
          <Card key={group} aria-labelledby={`tc-${group}`}>
            <CardHeader id={`tc-${group}`} title={group === 'charge' ? 'Charges and rebates' : 'Payments'} />
            <ul className="divide-y divide-line">
              {codes
                .filter((c) => (group === 'payment' ? c.kind === 'payment' : c.kind !== 'payment'))
                .map((c) => (
                  <li key={c.id} className={cn('flex items-center gap-3 py-2.5', !c.active && 'opacity-60')}>
                    <span className="w-16 shrink-0 font-mono text-xs font-semibold">{c.code}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {DEPARTMENT_LABEL[c.department]} · {c.account ? `${c.account.code} ${c.account.name}` : 'Books by its cash entry'}
                      </span>
                    </span>
                    {c.kind === 'rebate' && <Tag tone="info">{CODE_KIND_LABEL.rebate}</Tag>}
                    {c.kind !== 'payment' && <span className="shrink-0 text-sm font-semibold tabular">{money(c.revenue)}</span>}
                    {editable && (
                      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.code}`} aria-pressed={editing === c.id} onClick={() => setEditing(editing === c.id ? null : c.id)}>
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                    )}
                    <Switch label={`${c.code} active`} checked={c.active} disabled={!editable} onChange={(on) => void toggle(c, on)} />
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}

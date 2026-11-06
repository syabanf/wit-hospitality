import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, Trash2 } from 'lucide-react'
import type { Attachment } from '@/domain/attachment'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'
import { VillaSelect } from './shared'

interface Row {
  accountId: string
  debit: string
  credit: string
}
const EMPTY: Row = { accountId: '', debit: '', credit: '' }

/** A balanced adjusting journal with memo and evidence; save as draft or submit for approval. */
export default function ManualJournalFormPage() {
  const { accounting } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const options = useResource('accounting.manualOptions', () => accounting.manualOptions())
  const [date, setDate] = useState('')
  const [villaId, setVilla] = useState('')
  const [memo, setMemo] = useState('')
  const [rows, setRows] = useState<Row[]>([EMPTY, EMPTY])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const lines = rows.map((r) => ({ accountId: r.accountId, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0 }))
  const debits = lines.reduce((s, l) => s + l.debit, 0)
  const credits = lines.reduce((s, l) => s + l.credit, 0)
  const setRow = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  async function save(submit: boolean) {
    if (!options.data) return
    setSaving(true)
    setErrors({})
    try {
      const m = await accounting.createManualJournal({ date: date || options.data.today, villaId: villaId || null, memo, lines, attachments }, submit)
      toast({ title: `${submit ? 'Submitted' : 'Saved'} ${m.number}`, description: submit ? 'It posts once every approval level has signed.' : 'Submit it when it is ready.' })
      navigate(`/accounting/manual/${m.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the journal', description: Object.values(e)[0] })
    } finally {
      setSaving(false)
    }
  }

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={6} />
  const o = options.data
  const accountOptions = [{ value: '', label: 'Pick the account' }, ...o.accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))]

  return (
    <>
      <PageBar fallback="/accounting/manual" label="Manual journals" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(true)
        }}
        className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
      >
        <Card aria-labelledby="mj-title">
          <CardHeader id="mj-title" title="Manual journal" action={<StatusPill tone={debits === credits && debits > 0 ? 'success' : 'warning'}>{debits === credits ? 'Balanced' : `Out by ${money(Math.abs(debits - credits))}`}</StatusPill>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date" htmlFor="mj-date" error={errors.date}>
              <Input id="mj-date" type="date" value={date || o.today} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Villa" htmlFor="mj-villa">
              <VillaSelect villas={o.villas} value={villaId} onChange={setVilla} />
            </Field>
            <Field label="Memo" htmlFor="mj-memo" error={errors.memo} className="sm:col-span-2">
              <Textarea id="mj-memo" value={memo} placeholder="What the journal corrects or accrues" onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
          <div className="mt-5 space-y-2" role="group" aria-label="Journal lines">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_auto]">
                <Select aria-label={`Account, line ${i + 1}`} className="col-span-2 w-full sm:col-span-1" value={r.accountId} options={accountOptions} onChange={(e) => setRow(i, { accountId: e.target.value })} />
                <Input aria-label={`Debit, line ${i + 1}`} type="number" inputMode="numeric" min={0} step={1000} placeholder="Debit" className="tabular" value={r.debit} onChange={(e) => setRow(i, { debit: e.target.value, credit: e.target.value ? '' : r.credit })} />
                <Input aria-label={`Credit, line ${i + 1}`} type="number" inputMode="numeric" min={0} step={1000} placeholder="Credit" className="tabular" value={r.credit} onChange={(e) => setRow(i, { credit: e.target.value, debit: e.target.value ? '' : r.debit })} />
                <Button size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={rows.length <= 2} onClick={() => setRows((list) => list.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
            ))}
            {errors.lines && <p role="alert" className="text-xs font-medium text-danger">{errors.lines}</p>}
            {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
            <Button variant="soft" size="sm" onClick={() => setRows((list) => [...list, EMPTY])}>
              <Plus aria-hidden className="size-4" /> Line
            </Button>
          </div>
        </Card>
        <div className="space-y-4">
          <Card aria-labelledby="mj-totals">
            <CardHeader id="mj-totals" title="Totals" />
            <p className="flex justify-between text-sm"><span className="text-muted">Debits</span><span className="tabular">{money(debits)}</span></p>
            <p className="mt-1 flex justify-between text-sm"><span className="text-muted">Credits</span><span className="tabular">{money(credits)}</span></p>
            <div className="mt-4">
              <AttachmentPicker id="mj-files" value={attachments} onChange={setAttachments} />
            </div>
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="accent" disabled={saving}>Submit for approval</Button>
            <Button variant="card" disabled={saving} onClick={() => void save(false)}>Save draft</Button>
          </div>
        </div>
      </form>
    </>
  )
}

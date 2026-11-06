import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { PackageCheck, Shirt, Trash2, Truck } from 'lucide-react'
import type { Attachment } from '@/domain/attachment'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { LAUNDRY_STATUS_LABEL, type LaundryBatch, type LinenPar } from '@/domain/housekeeping'
import type { StockItem } from '@/domain/stock'
import { shortDay } from '@/lib/dates'
import { money, percent } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'
import { TRANSACTION_TONE } from '../shared/tones'
import { LAUNDRY_TONE } from './tones'

type Panel = { kind: 'send' | 'discard' } | { kind: 'return'; batchId: string } | { kind: 'par'; groupId: string } | null

/** Linen per villa by where it is, the par per room type, and laundry batches out and back. */
export function LinenTab() {
  const { housekeeping, clock } = useServices()
  const data = useResource('housekeeping.linen', () => housekeeping.linen())
  const [villaId, setVillaId] = useState('')
  const [panel, setPanel] = useState<Panel>(null)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const villas = d.villas.filter((v) => v.levels.length > 0 && (!villaId || v.villa.id === villaId))
  const done = () => {
    setPanel(null)
    data.reload()
  }
  const toggle = (next: Exclude<Panel, null>) => setPanel(JSON.stringify(panel) === JSON.stringify(next) ? null : next)
  const out = d.batches.filter((b) => b.status === 'out')
  const returning = panel?.kind === 'return' ? d.batches.find((b) => b.id === panel.batchId) : undefined
  const editing = panel?.kind === 'par' ? d.pars.find((p) => p.group.id === panel.groupId) : undefined
  const formVilla = villaId || villas[0]?.villa.id || ''

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Clean in store is what the villa owns less the set in each room, the soiled bags and what is out at the laundry. Departure cleans fill the soiled bags.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Villa" value={villaId} options={[{ value: '', label: 'All villas' }, ...d.villas.filter((v) => v.levels.length > 0).map((v) => ({ value: v.villa.id, label: v.villa.name }))]} onChange={(e) => setVillaId(e.target.value)} />
          {d.canEdit && (
            <>
              <Button variant="accent" aria-pressed={panel?.kind === 'send'} onClick={() => toggle({ kind: 'send' })}>
                <Truck aria-hidden className="size-4" /> Send to laundry
              </Button>
              <Button variant="card" aria-pressed={panel?.kind === 'discard'} onClick={() => toggle({ kind: 'discard' })}>
                <Trash2 aria-hidden className="size-4" /> Discard
              </Button>
            </>
          )}
        </div>
      </div>

      {panel?.kind === 'send' && <SendForm key={formVilla} villaId={formVilla} villas={d.villas.filter((v) => v.levels.length > 0).map((v) => v.villa)} items={d.items} soiled={d.soiled} today={clock.today()} onDone={done} />}
      {panel?.kind === 'discard' && <DiscardForm key={formVilla} villaId={formVilla} villas={d.villas.filter((v) => v.levels.length > 0).map((v) => v.villa)} items={d.items} onDone={done} />}
      {returning && <ReturnForm key={returning.id} batch={returning} items={d.items} today={clock.today()} onDone={done} />}
      {editing && <ParForm key={editing.group.id} groupName={editing.group.name} groupId={editing.group.id} par={editing.par} items={d.items} onDone={done} />}

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Items under par" value={villas.reduce((s, v) => s + v.levels.filter((l) => l.owned < l.par).length, 0)} hint="Owned below the sets per room" />
        <StatTile label="Soiled pieces" value={d.soiled.filter((c) => !villaId || c.villaId === villaId).reduce((s, c) => s + c.quantity, 0)} hint="Waiting for the laundry" />
        <StatTile label="Batches out" value={out.filter((b) => !villaId || b.villaId === villaId).length} hint={`${out.reduce((s, b) => s + b.sent, 0)} pieces`} />
        <StatTile label="Lost at laundry" value={d.batches.filter((b) => !villaId || b.villaId === villaId).reduce((s, b) => s + b.missing + b.damaged, 0)} hint="Missing or damaged, written off" />
      </div>

      {villas.map((v) => (
        <Card key={v.villa.id} className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4">
            <p className="flex items-center gap-2 font-semibold">
              <Shirt aria-hidden className="size-4 text-muted" /> {v.villa.name}
            </p>
            {v.flagged > 0 ? <Tag tone="danger">{v.flagged} flagged</Tag> : <Tag tone="success">At par</Tag>}
          </div>
          <DataTable
            className="px-4 pb-2"
            label={`${v.villa.name} linen`}
            rows={v.levels}
            rowKey={(l) => l.itemId}
            columns={[
              { key: 'item', header: 'Item', cell: (l) => l.item.name },
              { key: 'par', header: 'Par', align: 'right', cell: (l) => l.par },
              { key: 'owned', header: 'Owned', align: 'right', cell: (l) => l.owned },
              { key: 'coverage', header: 'Coverage', align: 'right', cell: (l) => <span className={l.owned < l.par ? 'font-semibold text-danger' : undefined}>{percent(l.coverage, { digits: 0 })}</span> },
              { key: 'inUse', header: 'In rooms', align: 'right', cell: (l) => l.inUse },
              { key: 'clean', header: 'Clean', align: 'right', cell: (l) => (l.short ? <Tag tone="danger">{l.short} short</Tag> : l.clean) },
              { key: 'soiled', header: 'Soiled', align: 'right', cell: (l) => l.soiled },
              { key: 'laundry', header: 'At laundry', align: 'right', cell: (l) => l.laundry },
              { key: 'discarded', header: 'Discarded', align: 'right', cell: (l) => l.discarded },
            ]}
          />
        </Card>
      ))}

      <Card>
        <CardHeader title="Laundry batches" icon={<Truck aria-hidden className="size-4 text-muted" />} />
        <DataTable
          label="Laundry batches"
          rows={d.batches.filter((b) => !villaId || b.villaId === villaId)}
          rowKey={(b) => b.id}
          columns={[
            { key: 'number', header: 'Batch', cell: (b) => <span className="font-mono">{b.number}</span> },
            { key: 'villa', header: 'Villa', cell: (b) => b.villaName },
            { key: 'vendor', header: 'Vendor', cell: (b) => b.vendor },
            { key: 'sent', header: 'Sent', cell: (b) => `${shortDay(b.sentOn)}, ${b.sent} pcs` },
            { key: 'back', header: 'Back', cell: (b) => (b.returnedOn ? `${shortDay(b.returnedOn)}, ${b.returned} pcs` : '') },
            { key: 'lost', header: 'Lost', align: 'right', cell: (b) => (b.missing + b.damaged ? <Tag tone="danger">{b.missing} missing, {b.damaged} damaged</Tag> : 0) },
            { key: 'cost', header: 'Cost', align: 'right', cell: (b) => (b.cost ? money(b.cost) : '') },
            {
              key: 'status',
              header: 'Status',
              cell: (b) =>
                b.entry ? (
                  <Link to={`/finance/transactions/${b.entry.id}`}>
                    <StatusPill tone={TRANSACTION_TONE[b.entry.status]}>{TRANSACTION_STATUS_LABEL[b.entry.status]}</StatusPill>
                  </Link>
                ) : (
                  <StatusPill tone={LAUNDRY_TONE[b.status]}>{LAUNDRY_STATUS_LABEL[b.status]}</StatusPill>
                ),
            },
            { key: 'act', header: '', cell: (b) => (d.canEdit && b.status === 'out' ? <Button size="sm" variant="soft" onClick={() => toggle({ kind: 'return', batchId: b.id })}>Record return</Button> : null) },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Linen par per room type" />
        <DataTable
          label="Linen par per room type"
          rows={d.pars.filter((p) => !villaId || p.group.villaId === villaId)}
          rowKey={(p) => p.group.id}
          columns={[
            { key: 'group', header: 'Room type', cell: (p) => p.group.name },
            { key: 'villa', header: 'Villa', cell: (p) => p.villaName },
            { key: 'sets', header: 'Sets', align: 'right', cell: (p) => p.par?.sets ?? '' },
            { key: 'lines', header: 'One room', cell: (p) => (p.par ? p.par.lines.map((l) => `${l.quantity} ${d.items.find((i) => i.id === l.itemId)?.name.toLowerCase() ?? ''}`).join(', ') : 'No par yet') },
            { key: 'act', header: '', cell: (p) => (d.canEdit ? <Button size="sm" variant="soft" onClick={() => toggle({ kind: 'par', groupId: p.group.id })}>Edit</Button> : null) },
          ]}
        />
      </Card>
    </div>
  )
}

/** Saves with field errors kept and a toast either way. */
function useSave(onDone: () => void) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  async function run(save: () => Promise<string>) {
    setSaving(true)
    setErrors({})
    try {
      toast({ title: await save() })
      onDone()
    } catch (error) {
      const fe = fieldErrors(error)
      setErrors(fe)
      toast({ tone: 'danger', title: 'Could not save', description: Object.values(fe)[0] })
    } finally {
      setSaving(false)
    }
  }
  return { saving, errors, run }
}

function Shell({ title, saving, errors, submit, onSubmit, children }: { title: string; saving: boolean; errors: Record<string, string>; submit: string; onSubmit: () => void; children: ReactNode }) {
  return (
    <Card className="animate-rise space-y-4">
      <CardHeader title={title} className="mb-0" />
      {children}
      {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
      <Button variant="accent" loading={saving} onClick={onSubmit}>
        {submit}
      </Button>
    </Card>
  )
}

/** One quantity box per linen item. */
function Counts({ items, value, onChange, label, error }: { items: readonly StockItem[]; value: Record<string, number>; onChange: (v: Record<string, number>) => void; label: string; error?: string }) {
  return (
    <Field label={label} error={error}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {items.map((i) => (
          <label key={i.id} className="text-xs text-muted">
            {i.name}
            <Input className="mt-1 h-10" type="number" min={0} inputMode="numeric" value={value[i.id] || ''} onChange={(e) => onChange({ ...value, [i.id]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
    </Field>
  )
}

const toLines = (counts: Record<string, number>) => Object.entries(counts).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ itemId, quantity }))
type VillaOption = { id: string; name: string }

function SendForm({ villaId: initial, villas, items, soiled, today, onDone }: { villaId: string; villas: readonly VillaOption[]; items: readonly StockItem[]; soiled: ReadonlyArray<{ villaId: string; itemId: string; quantity: number }>; today: string; onDone: () => void }) {
  const { housekeeping } = useServices()
  const { saving, errors, run } = useSave(onDone)
  const bagged = (villaId: string) => Object.fromEntries(soiled.filter((c) => c.villaId === villaId).map((c) => [c.itemId, c.quantity]))
  const [form, setForm] = useState({ villaId: initial, vendor: '', sentOn: today, note: '' })
  const [counts, setCounts] = useState<Record<string, number>>(() => bagged(initial))
  return (
    <Shell title="Send soiled linen to the laundry" saving={saving} errors={errors} submit="Send the batch" onSubmit={() => void run(async () => `Sent ${(await housekeeping.sendLaundry({ ...form, lines: toLines(counts) })).number}`)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Villa" error={errors.villaId}>
          <Select
            className="w-full"
            value={form.villaId}
            options={villas.map((v) => ({ value: v.id, label: v.name }))}
            onChange={(e) => {
              setForm({ ...form, villaId: e.target.value })
              setCounts(bagged(e.target.value))
            }}
          />
        </Field>
        <Field label="Laundry" error={errors.vendor}>
          <Input className="h-10" value={form.vendor} placeholder="Bersih Laundry Canggu" onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
        </Field>
        <Field label="Sent on" error={errors.sentOn}>
          <Input className="h-10" type="date" value={form.sentOn} onChange={(e) => setForm({ ...form, sentOn: e.target.value })} />
        </Field>
      </div>
      <Counts label="Pieces, from the soiled bags" items={items} value={counts} onChange={setCounts} error={errors.lines} />
    </Shell>
  )
}

function DiscardForm({ villaId: initial, villas, items, onDone }: { villaId: string; villas: readonly VillaOption[]; items: readonly StockItem[]; onDone: () => void }) {
  const { housekeeping } = useServices()
  const { saving, errors, run } = useSave(onDone)
  const [form, setForm] = useState({ villaId: initial, from: 'soiled' as 'soiled' | 'clean', reason: '' })
  const [counts, setCounts] = useState<Record<string, number>>({})
  return (
    <Shell title="Discard linen" saving={saving} errors={errors} submit="Write off the pieces" onSubmit={() => void run(async () => `Wrote off ${(await housekeeping.discardLinen({ ...form, lines: toLines(counts) })).length} items from the villa store`)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Villa">
          <Select className="w-full" value={form.villaId} options={villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => setForm({ ...form, villaId: e.target.value })} />
        </Field>
        <Field label="Taken from">
          <Select className="w-full" value={form.from} options={[{ value: 'soiled', label: 'Soiled bags' }, { value: 'clean', label: 'Clean store' }]} onChange={(e) => setForm({ ...form, from: e.target.value as 'soiled' | 'clean' })} />
        </Field>
        <Field label="Reason" error={errors.reason}>
          <Input className="h-10" value={form.reason} placeholder="Torn, stained beyond cleaning" onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
      </div>
      <Counts label="Pieces" items={items} value={counts} onChange={setCounts} error={errors.lines} />
    </Shell>
  )
}

function ReturnForm({ batch, items, today, onDone }: { batch: LaundryBatch & { villaName: string }; items: readonly StockItem[]; today: string; onDone: () => void }) {
  const { housekeeping } = useServices()
  const { saving, errors, run } = useSave(onDone)
  const [lines, setLines] = useState(() => batch.lines.map((l) => ({ itemId: l.itemId, sent: l.sent, returned: l.sent, damaged: 0 })))
  const [form, setForm] = useState({ returnedOn: today, cost: 0, method: 'cash' as 'cash' | 'bank_transfer', reference: '' })
  const [files, setFiles] = useState<Attachment[]>([])
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  return (
    <Shell
      title={`${batch.number} back from ${batch.vendor}`}
      saving={saving}
      errors={errors}
      submit={form.cost > 0 ? 'Record the return and submit the bill' : 'Record the return'}
      onSubmit={() => void run(async () => {
        const b = await housekeeping.returnLaundry(batch.id, { ...form, lines, attachments: files })
        return b.writeOffs.length ? `${b.number} back, losses written off` : `${b.number} back in the clean store`
      })}
    >
      <Field label="Counted back" error={errors.lines}>
        <ul className="space-y-2">
          {lines.map((l, i) => (
            <li key={l.itemId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-36 flex-1">
                {items.find((x) => x.id === l.itemId)?.name} <span className="text-muted">sent {l.sent}</span>
              </span>
              <Input aria-label="Back clean" className="h-10 w-24" type="number" min={0} value={l.returned} onChange={(e) => set(i, { returned: Number(e.target.value) })} />
              <Input aria-label="Damaged" className="h-10 w-24" type="number" min={0} value={l.damaged} onChange={(e) => set(i, { damaged: Number(e.target.value) })} />
              {l.sent - l.returned - l.damaged > 0 && <Tag tone="danger">{l.sent - l.returned - l.damaged} missing</Tag>}
            </li>
          ))}
        </ul>
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Returned on" error={errors.returnedOn}>
          <Input className="h-10" type="date" value={form.returnedOn} onChange={(e) => setForm({ ...form, returnedOn: e.target.value })} />
        </Field>
        <Field label="Bill, rupiah" error={errors.cost}>
          <Input className="h-10" type="number" min={0} step={1000} value={form.cost || ''} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} />
        </Field>
        <Field label="Paid by">
          <Select className="w-full" value={form.method} options={[{ value: 'cash', label: 'Cash from the cashbox' }, { value: 'bank_transfer', label: 'Bank transfer' }]} onChange={(e) => setForm({ ...form, method: e.target.value as 'cash' | 'bank_transfer' })} />
        </Field>
        <Field label="Invoice number">
          <Input className="h-10" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </Field>
      </div>
      <AttachmentPicker id="laundry-bill" value={files} onChange={setFiles} hint="The laundry's bill; needed above the proof threshold" />
    </Shell>
  )
}

function ParForm({ groupId, groupName, par, items, onDone }: { groupId: string; groupName: string; par: LinenPar | null; items: readonly StockItem[]; onDone: () => void }) {
  const { housekeeping } = useServices()
  const { saving, errors, run } = useSave(onDone)
  const [sets, setSets] = useState(par?.sets ?? 3)
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries((par?.lines ?? []).map((l) => [l.itemId, l.quantity])))
  return (
    <Shell title={`${groupName} linen par`} saving={saving} errors={errors} submit="Save the par" onSubmit={() => void run(async () => (await housekeeping.saveLinenPar(groupId, { sets, lines: toLines(counts) }), `Saved the ${groupName} par`))}>
      <Field label="Sets per room" error={errors.sets} hint="One in the room, one in the store, one at the laundry is three.">
        <Input className="h-10 w-28" type="number" min={1} max={6} value={sets} onChange={(e) => setSets(Number(e.target.value))} />
      </Field>
      <Counts label="Pieces in one room" items={items} value={counts} onChange={setCounts} error={errors.lines} />
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <PackageCheck aria-hidden className="size-3.5" /> Buy linen through Stock receipts; it lands in the clean store.
      </p>
    </Shell>
  )
}

import { useState, type FormEvent, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import type { Attachment } from '@/domain/attachment'
import type { Catalog } from '@/domain/property'
import { STOCK_KIND_LABEL, STOCK_KINDS, STOCK_UNITS, type MoveKind, type StockItem, type StockItemInput } from '@/domain/stock'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'

interface Line {
  itemId: string
  quantity: number
  unitCost: number
}

/** Rows of item and quantity, with the price paid when `costs` is set. */
function LineEditor({ items, lines, onChange, costs = false, error }: { items: readonly StockItem[]; lines: Line[]; onChange: (lines: Line[]) => void; costs?: boolean; error?: string }) {
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const options = [{ value: '', label: 'Pick an item' }, ...items.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))]
  return (
    <Field label="Items" error={error}>
      <ul className="space-y-2">
        {lines.map((l, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Select aria-label={`Item ${i + 1}`} className="min-w-48 flex-1" value={l.itemId} options={options} onChange={(e) => set(i, { itemId: e.target.value, unitCost: items.find((x) => x.id === e.target.value)?.averageCost ?? l.unitCost })} />
            <Input aria-label={`Quantity ${i + 1}`} className="h-10 w-24" type="number" inputMode="numeric" min={0} value={l.quantity || ''} onChange={(e) => set(i, { quantity: Number(e.target.value) })} />
            {costs && <Input aria-label={`Unit cost ${i + 1}`} className="h-10 w-36 tabular" type="number" inputMode="numeric" min={0} step={500} value={l.unitCost || ''} placeholder="Rp per unit" onChange={(e) => set(i, { unitCost: Number(e.target.value) })} />}
            <Button size="icon-sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => onChange(lines.filter((_, j) => j !== i))}>
              <X aria-hidden className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="soft" className="mt-2" onClick={() => onChange([...lines, { itemId: '', quantity: 1, unitCost: 0 }])}>
        <Plus aria-hidden className="size-3.5" /> Line
      </Button>
    </Field>
  )
}

/** Form shell: title, fields, error and the two buttons. */
function FormCard({ title, onSubmit, saving, submitLabel, errors, onCancel, children }: { title: string; onSubmit: () => Promise<void>; saving: boolean; submitLabel: string; errors: Record<string, string>; onCancel: () => void; children: ReactNode }) {
  return (
    <Card as="div" aria-label={title} className="animate-rise">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          void onSubmit()
        }}
        className="space-y-4"
      >
        <p className="text-lg font-semibold tracking-tight">{title}</p>
        {children}
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {submitLabel}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** Runs a save, keeps field errors, and toasts the outcome. */
function useSave() {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  async function run(save: () => Promise<string>, onDone: () => void) {
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

const villaOptions = (catalog: Catalog) => catalog.villas.map((v) => ({ value: v.id, label: v.name }))
const cleanLines = (lines: Line[]) => lines.filter((l) => l.itemId)

interface Props {
  catalog: Catalog
  items: readonly StockItem[]
  villaId: string
  onDone: () => void
  onCancel: () => void
}

/** A purchase into a villa store; the money goes for approval with the receipt. */
export function ReceiptForm({ catalog, items, villaId: initialVilla, onDone, onCancel }: Props) {
  const { stock, clock } = useServices()
  const { saving, errors, run } = useSave()
  const [villaId, setVillaId] = useState(initialVilla || catalog.villas[0]?.id || '')
  const [lines, setLines] = useState<Line[]>([{ itemId: '', quantity: 1, unitCost: 0 }])
  const [receipts, setReceipts] = useState<Attachment[]>([])
  const [form, setForm] = useState({ supplier: '', reference: '', method: 'cash' as 'cash' | 'bank_transfer', receivedOn: clock.today() })
  const total = cleanLines(lines).reduce((s, l) => s + l.quantity * l.unitCost, 0)
  const active = items.filter((i) => i.active)

  return (
    <FormCard
      title="Receive stock"
      saving={saving}
      submitLabel="Receive and submit the cash-out"
      errors={errors}
      onCancel={onCancel}
      onSubmit={() => run(async () => {
        const r = await stock.receive({ villaId, supplier: form.supplier, reference: form.reference, method: form.method, receivedOn: form.receivedOn, attachments: receipts, lines: cleanLines(lines) })
        return `Received ${r.number}, the cash-out waits for approval`
      }, onDone)}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Villa store" htmlFor="sr-villa" error={errors.villaId}>
          <Select id="sr-villa" className="w-full" value={villaId} options={villaOptions(catalog)} onChange={(e) => setVillaId(e.target.value)} />
        </Field>
        <Field label="Supplier" htmlFor="sr-supplier" error={errors.supplier}>
          <Input id="sr-supplier" value={form.supplier} placeholder="Pepito Market" onChange={(e) => setForm({ ...form, supplier: e.target.value })} />
        </Field>
        <Field label="Paid by" htmlFor="sr-method" error={errors.method}>
          <Select id="sr-method" className="w-full" value={form.method} options={[{ value: 'cash', label: 'Cash from the cashbox' }, { value: 'bank_transfer', label: 'Bank transfer' }]} onChange={(e) => setForm({ ...form, method: e.target.value as 'cash' | 'bank_transfer' })} />
        </Field>
        <Field label="Received on" htmlFor="sr-date" error={errors.receivedOn}>
          <Input id="sr-date" type="date" max={clock.today()} value={form.receivedOn} onChange={(e) => setForm({ ...form, receivedOn: e.target.value })} />
        </Field>
      </div>
      <LineEditor items={active} lines={lines} onChange={setLines} costs error={errors.lines} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Invoice or receipt number" htmlFor="sr-ref">
          <Input id="sr-ref" value={form.reference} placeholder="PPT/2210/118" onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </Field>
        <Field label="Receipt" htmlFor="sr-receipt" error={errors.receipts}>
          <AttachmentPicker id="sr-receipt" value={receipts} onChange={setReceipts} hint="Photo or PDF; needed above the proof threshold" />
        </Field>
      </div>
      <p className="text-sm text-muted">
        Total <span className="font-semibold text-fg tabular">{money(total)}</span>
      </p>
    </FormCard>
  )
}

const MOVE_TITLE: Record<MoveKind, string> = { issue: 'Issue to a unit', transfer: 'Transfer to another villa', write_off: 'Write off' }

/** Stock out of a store: to a unit, to another store, or written off with the reason. */
export function MoveForm({ kind, catalog, items, villaId: initialVilla, onDone, onCancel }: Props & { kind: MoveKind }) {
  const { stock } = useServices()
  const { saving, errors, run } = useSave()
  const [villaId, setVillaId] = useState(initialVilla || catalog.villas[0]?.id || '')
  const [unitId, setUnitId] = useState('')
  const [toVillaId, setToVillaId] = useState('')
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<Line[]>([{ itemId: '', quantity: 1, unitCost: 0 }])

  return (
    <FormCard
      title={MOVE_TITLE[kind]}
      saving={saving}
      submitLabel={MOVE_TITLE[kind]}
      errors={errors}
      onCancel={onCancel}
      onSubmit={() => run(async () => {
        const moved = await stock.move({ kind, villaId, unitId: kind === 'issue' ? unitId : null, toVillaId: kind === 'transfer' ? toVillaId : null, reason, lines: cleanLines(lines).map(({ itemId, quantity }) => ({ itemId, quantity })) })
        return `Recorded ${moved.length} movements`
      }, onDone)}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="From the store of" htmlFor="sm-villa" error={errors.villaId}>
          <Select id="sm-villa" className="w-full" value={villaId} options={villaOptions(catalog)} onChange={(e) => setVillaId(e.target.value)} />
        </Field>
        {kind === 'issue' && (
          <Field label="Unit" htmlFor="sm-unit" error={errors.unitId}>
            <Select id="sm-unit" className="w-full" value={unitId} options={[{ value: '', label: 'Pick the unit' }, ...catalog.units.filter((u) => u.villaId === villaId).map((u) => ({ value: u.id, label: u.code }))]} onChange={(e) => setUnitId(e.target.value)} />
          </Field>
        )}
        {kind === 'transfer' && (
          <Field label="To the store of" htmlFor="sm-to" error={errors.toVillaId}>
            <Select id="sm-to" className="w-full" value={toVillaId} options={[{ value: '', label: 'Pick the villa' }, ...villaOptions(catalog).filter((v) => v.value !== villaId)]} onChange={(e) => setToVillaId(e.target.value)} />
          </Field>
        )}
        <Field label={kind === 'write_off' ? 'Reason' : 'Note'} htmlFor="sm-reason" error={errors.reason}>
          <Input id="sm-reason" value={reason} placeholder={kind === 'write_off' ? 'Damaged, expired or lost' : 'Optional'} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <LineEditor items={items.filter((i) => i.active)} lines={lines} onChange={setLines} error={errors.lines} />
    </FormCard>
  )
}

/** A shelf count: every item the store carries with the quantity the console expects. */
export function CountForm({ catalog, villaId: initialVilla, onDone, onCancel }: Omit<Props, 'items'>) {
  const { stock } = useServices()
  const { saving, errors, run } = useSave()
  const [villaId, setVillaId] = useState(initialVilla || catalog.villas[0]?.id || '')
  const sheet = useResource(`stock.countSheet:${villaId}`, () => stock.countSheet(villaId), { keepPrevious: false })
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [countedBy, setCountedBy] = useState('')
  const [note, setNote] = useState('')
  const levels = sheet.data ?? []
  const variance = levels.reduce((s, l) => s + (counted[l.item.id] === undefined || counted[l.item.id] === '' ? 0 : (Number(counted[l.item.id]) - l.onHand) * l.item.averageCost), 0)

  return (
    <FormCard
      title="Count a store"
      saving={saving}
      submitLabel="Post the count"
      errors={errors}
      onCancel={onCancel}
      onSubmit={() => run(async () => {
        const lines = levels.filter((l) => (counted[l.item.id] ?? '') !== '').map((l) => ({ itemId: l.item.id, counted: Number(counted[l.item.id]) }))
        const c = await stock.count({ villaId, countedBy, note, lines })
        return `Posted ${c.number}`
      }, onDone)}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Villa store" htmlFor="sc-villa" error={errors.villaId}>
          <Select id="sc-villa" className="w-full" value={villaId} options={villaOptions(catalog)} onChange={(e) => {
            setVillaId(e.target.value)
            setCounted({})
          }} />
        </Field>
        <Field label="Counted by" htmlFor="sc-by" error={errors.countedBy}>
          <Input id="sc-by" value={countedBy} placeholder="Wayan Sudiarta" onChange={(e) => setCountedBy(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="sc-note">
          <Input id="sc-note" value={note} placeholder="Monthly count" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <Field label="Counted on the shelf" error={errors.lines} hint="Leave an item empty to skip it.">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
          {levels.map((l) => {
            const value = counted[l.item.id] ?? ''
            const diff = value === '' ? 0 : Number(value) - l.onHand
            return (
              <li key={l.item.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{l.item.name}</span>
                <span className="w-20 text-right text-xs text-muted tabular">expects {l.onHand}</span>
                <Input aria-label={`Counted ${l.item.name}`} className="h-10 w-24" type="number" inputMode="numeric" min={0} value={value} onChange={(e) => setCounted({ ...counted, [l.item.id]: e.target.value })} />
                <span className={`w-10 text-right text-xs tabular ${diff < 0 ? 'text-danger' : diff > 0 ? 'text-success' : 'text-muted'}`}>{diff > 0 ? `+${diff}` : diff}</span>
              </li>
            )
          })}
        </ul>
      </Field>
      <p className="text-sm text-muted">
        Variance value <span className={`font-semibold tabular ${variance < 0 ? 'text-danger' : 'text-fg'}`}>{money(variance)}</span>
      </p>
    </FormCard>
  )
}

/** A stock item's master data. */
export function ItemForm({ initial, onDone, onCancel }: { initial?: StockItem; onDone: () => void; onCancel: () => void }) {
  const { stock } = useServices()
  const { saving, errors, run } = useSave()
  const [form, setForm] = useState<StockItemInput>(initial ? { code: initial.code, name: initial.name, kind: initial.kind, unit: initial.unit, reorderLevel: initial.reorderLevel, par: initial.par, active: initial.active } : { code: '', name: '', kind: 'amenity', unit: 'piece', reorderLevel: 10, par: 0, active: true })

  return (
    <FormCard
      title={initial ? `Edit ${initial.name}` : 'Add a stock item'}
      saving={saving}
      submitLabel={initial ? 'Save item' : 'Add item'}
      errors={errors}
      onCancel={onCancel}
      onSubmit={() => run(async () => {
        const input = { ...form, code: form.code.trim().toUpperCase() }
        const saved = initial ? await stock.updateItem(initial.id, input) : await stock.createItem(input)
        return initial ? `Saved ${saved.code}` : `Added ${saved.code}`
      }, onDone)}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <Field label="Code" htmlFor="si-code" error={errors.code}>
          <Input id="si-code" value={form.code} placeholder="AM-SOAP" onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Name" htmlFor="si-name" error={errors.name} className="sm:col-span-2">
          <Input id="si-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Kind" htmlFor="si-kind" error={errors.kind}>
          <Select id="si-kind" className="w-full" value={form.kind} options={STOCK_KINDS.map((k) => ({ value: k, label: STOCK_KIND_LABEL[k] }))} onChange={(e) => setForm({ ...form, kind: e.target.value as StockItem['kind'], par: e.target.value === 'minibar' ? form.par : 0 })} />
        </Field>
        <Field label="Unit" htmlFor="si-unit" error={errors.unit}>
          <Select id="si-unit" className="w-full" value={form.unit} options={STOCK_UNITS.map((u) => ({ value: u, label: u }))} onChange={(e) => setForm({ ...form, unit: e.target.value as StockItem['unit'] })} />
        </Field>
        <Field label="Reorder at" htmlFor="si-reorder" error={errors.reorderLevel}>
          <Input id="si-reorder" type="number" inputMode="numeric" min={0} value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: Number(e.target.value) })} />
        </Field>
        {form.kind === 'minibar' && (
          <Field label="Minibar par per unit" htmlFor="si-par" error={errors.par}>
            <Input id="si-par" type="number" inputMode="numeric" min={0} value={form.par} onChange={(e) => setForm({ ...form, par: Number(e.target.value) })} />
          </Field>
        )}
      </div>
      <Switch label="Item active" checked={form.active} onChange={(active) => setForm({ ...form, active })} />
    </FormCard>
  )
}

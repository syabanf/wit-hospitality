import { useState, type FormEvent } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { CHARGED_LABEL, FEE_BASIS_LABEL, OWNER_STAY_PRICING_LABEL, OWNER_STAY_STATUS_LABEL, type ChargedExpenses, type ContractInput, type FeeBasis, type OwnerStayPricing, type VillaOwner, type VillaOwnerInput } from '@/domain/owner'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { OwnersTabs } from './OwnersTabs'

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))
const EMPTY_OWNER: VillaOwnerInput = { name: '', email: '', phone: '', bank: { bank: '', accountName: '', accountNumber: '' }, npwp: '', userId: null }

function OwnerForm({ owner, onDone }: { owner: VillaOwner | null; onDone: () => void }) {
  const { owners } = useServices()
  const [form, setForm] = useState<VillaOwnerInput>(owner ?? EMPTY_OWNER)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (patch: Partial<VillaOwnerInput>) => setForm((f) => ({ ...f, ...patch }))
  const bank = (patch: Partial<VillaOwnerInput['bank']>) => setForm((f) => ({ ...f, bank: { ...f.bank, ...patch } }))
  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await owners.saveOwner(owner?.id ?? null, form)
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    }
  }
  return (
    <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-4 sm:grid-cols-2">
      <Field label="Name" htmlFor="ow-name" error={errors.name ?? errors.form}>
        <Input id="ow-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Email" htmlFor="ow-email" error={errors.email}>
        <Input id="ow-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field label="Phone" htmlFor="ow-phone">
        <Input id="ow-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
      </Field>
      <Field label="NPWP (optional)" htmlFor="ow-npwp">
        <Input id="ow-npwp" value={form.npwp} onChange={(e) => set({ npwp: e.target.value })} />
      </Field>
      <Field label="Bank" htmlFor="ow-bank">
        <Input id="ow-bank" value={form.bank.bank} onChange={(e) => bank({ bank: e.target.value })} />
      </Field>
      <Field label="Account number" htmlFor="ow-acc" error={errors.bank}>
        <Input id="ow-acc" value={form.bank.accountNumber} onChange={(e) => bank({ accountNumber: e.target.value })} />
      </Field>
      <Field label="Account name" htmlFor="ow-accname">
        <Input id="ow-accname" value={form.bank.accountName} onChange={(e) => bank({ accountName: e.target.value })} />
      </Field>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="accent">Save owner</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  )
}

function ContractForm({ initial, id, villas, ownerList, onDone }: { initial: ContractInput; id: string | null; villas: ReadonlyArray<{ id: string; name: string }>; ownerList: readonly VillaOwner[]; onDone: () => void }) {
  const { owners } = useServices()
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (patch: Partial<ContractInput>) => setForm((f) => ({ ...f, ...patch }))
  const num = (key: keyof ContractInput) => ({ id: `ct-${key}`, inputMode: 'decimal' as const, value: String(form[key] ?? ''), onChange: (e: { target: { value: string } }) => set({ [key]: Number(e.target.value) || 0 }) })
  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await owners.saveContract(id, form)
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    }
  }
  return (
    <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Villa" htmlFor="ct-villa" error={errors.villaId ?? errors.form}>
        <Select id="ct-villa" className="w-full" value={form.villaId} options={[{ value: '', label: 'Pick a villa' }, ...villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => set({ villaId: e.target.value })} />
      </Field>
      <Field label="Owner" htmlFor="ct-owner" error={errors.ownerId}>
        <Select id="ct-owner" className="w-full" value={form.ownerId} options={[{ value: '', label: 'Pick the owner' }, ...ownerList.map((o) => ({ value: o.id, label: o.name }))]} onChange={(e) => set({ ownerId: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Start" htmlFor="ct-start" error={errors.start}>
          <Input id="ct-start" type="date" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label="End" htmlFor="ct-end" error={errors.end}>
          <Input id="ct-end" type="date" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
      </div>
      <Field label="Fee taken from" htmlFor="ct-basis">
        <Select id="ct-basis" className="w-full" value={form.feeBasis} options={options(FEE_BASIS_LABEL)} onChange={(e) => set({ feeBasis: e.target.value as FeeBasis })} />
      </Field>
      <Field label="Management fee, percent" htmlFor="ct-feePct" error={errors.feePct}>
        <Input {...num('feePct')} />
      </Field>
      <Field label="Fixed monthly fee" htmlFor="ct-fixedMonthlyFee" error={errors.fixedMonthlyFee}>
        <Input {...num('fixedMonthlyFee')} />
      </Field>
      <Field label="Costs charged to the owner" htmlFor="ct-charged">
        <Select id="ct-charged" className="w-full" value={form.charged} options={options(CHARGED_LABEL)} onChange={(e) => set({ charged: e.target.value as ChargedExpenses })} />
      </Field>
      <Field label="Maintenance threshold" htmlFor="ct-maintenanceThreshold" error={errors.maintenanceThreshold} hint="For maintenance contracts: entries from this amount">
        <Input {...num('maintenanceThreshold')} />
      </Field>
      <Field label="FF&E reserve, percent of revenue" htmlFor="ct-reservePct" error={errors.reservePct}>
        <Input {...num('reservePct')} />
      </Field>
      <Field label="Owner nights a year" htmlFor="ct-ownerNightsPerYear" error={errors.ownerNightsPerYear}>
        <Input {...num('ownerNightsPerYear')} />
      </Field>
      <Field label="Owner stays priced" htmlFor="ct-pricing">
        <Select id="ct-pricing" className="w-full" value={form.ownerStayPricing} options={options(OWNER_STAY_PRICING_LABEL)} onChange={(e) => set({ ownerStayPricing: e.target.value as OwnerStayPricing })} />
      </Field>
      <Field label="Owner stay price" htmlFor="ct-ownerStayPrice" error={errors.ownerStayPrice}>
        <Input {...num('ownerStayPrice')} />
      </Field>
      <Field label="Payout by day of the next month" htmlFor="ct-payoutDay" error={errors.payoutDay}>
        <Input {...num('payoutDay')} />
      </Field>
      <div className="flex items-end gap-2 lg:col-span-2">
        <Button type="submit" variant="accent">Save contract</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  )
}

/** Investors, the contracts that hand their villas to the operator, and the owner stays they ask for. */
export default function VillaOwnersPage() {
  const { owners } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('owners.overview', () => owners.overview())
  const [editing, setEditing] = useState<{ kind: 'owner' | 'contract'; id: string | null } | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const edit = can('finance', 'post')

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const done = () => {
    setEditing(null)
    data.reload()
  }
  async function decide(id: string, approve: boolean) {
    try {
      const unitId = picks[id] ?? ''
      await owners.decideStay(id, approve ? { approve: true, unitId, note: '' } : { approve: false, note: picks[`note-${id}`] ?? '' })
      toast({ title: approve ? 'Owner stay approved and the unit blocked' : 'Owner stay declined' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not done', description: error instanceof Error ? error.message : undefined })
    }
  }
  const contractInput = (id: string | null): ContractInput => {
    const c = d.contracts.find((x) => x.id === id)
    return c ? { villaId: c.villaId, ownerId: c.ownerId, start: c.start, end: c.end, feeBasis: c.feeBasis, feePct: c.feePct, fixedMonthlyFee: c.fixedMonthlyFee, charged: c.charged, maintenanceThreshold: c.maintenanceThreshold, ownerNightsPerYear: c.ownerNightsPerYear, ownerStayPricing: c.ownerStayPricing, ownerStayPrice: c.ownerStayPrice, reservePct: c.reservePct, payoutDay: c.payoutDay, document: c.document } : { villaId: '', ownerId: '', start: d.today, end: `${Number(d.today.slice(0, 4)) + 3}${d.today.slice(4)}`, feeBasis: 'gop', feePct: 20, fixedMonthlyFee: 0, charged: 'operating', maintenanceThreshold: 0, ownerNightsPerYear: 21, ownerStayPricing: 'free', ownerStayPrice: 0, reservePct: 3, payoutDay: 10, document: null }
  }

  return (
    <div className="space-y-4">
      <OwnersTabs />
      <Card aria-labelledby="ow-title">
        <CardHeader id="ow-title" title="Villa owners" action={edit && <Button size="sm" onClick={() => setEditing({ kind: 'owner', id: null })}><Plus aria-hidden className="size-4" /> Owner</Button>} />
        {editing?.kind === 'owner' && <OwnerForm owner={d.owners.find((o) => o.id === editing.id) ?? null} onDone={done} />}
        <ul className="divide-y divide-line">
          {d.owners.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{o.name}</p>
                <p className="text-xs text-muted">
                  {o.email} · {o.phone} · {o.bank.bank} {o.bank.accountNumber}
                  {o.npwp && ` · NPWP ${o.npwp}`}
                  {o.userId ? ' · has a portal login' : ''}
                </p>
              </div>
              {edit && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${o.name}`} onClick={() => setEditing({ kind: 'owner', id: o.id })}><Pencil aria-hidden className="size-4" /></Button>}
            </li>
          ))}
        </ul>
      </Card>

      <Card aria-labelledby="ct-title">
        <CardHeader id="ct-title" title="Management contracts" action={edit && <Button size="sm" onClick={() => setEditing({ kind: 'contract', id: null })}><Plus aria-hidden className="size-4" /> Contract</Button>} />
        {editing?.kind === 'contract' && <ContractForm id={editing.id} initial={contractInput(editing.id)} villas={d.catalog.villas} ownerList={d.owners} onDone={done} />}
        {d.contracts.length === 0 ? (
          <EmptyState title="No contracts">Villas without a contract are the operator’s own.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {d.contracts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {c.villa.name} · {c.ownerName} <span className="text-xs text-muted">{c.number}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {shortDay(c.start)} to {shortDay(c.end)} · {c.feePct}% of {FEE_BASIS_LABEL[c.feeBasis].toLowerCase()}
                    {c.fixedMonthlyFee ? ` plus ${money(c.fixedMonthlyFee)} a month` : ''} · {CHARGED_LABEL[c.charged].toLowerCase()} · reserve {c.reservePct}% · owner nights {c.nightsUsed} of {c.ownerNightsPerYear} · paid by the {c.payoutDay}th
                  </p>
                </div>
                {edit && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.number}`} onClick={() => setEditing({ kind: 'contract', id: c.id })}><Pencil aria-hidden className="size-4" /></Button>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">Saka and Tirta have no contract: they are the operator’s own villas.</p>
      </Card>

      <Card aria-labelledby="os-title">
        <CardHeader id="os-title" title="Owner stay requests" />
        {d.stays.length === 0 ? (
          <EmptyState title="No owner stays asked for" />
        ) : (
          <ul className="divide-y divide-line">
            {d.stays.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {r.number} · {r.villaName} · {shortDay(r.checkIn)} to {shortDay(r.checkOut)}
                    <StatusPill tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'neutral'}>{OWNER_STAY_STATUS_LABEL[r.status]}</StatusPill>
                  </p>
                  <p className="text-xs text-muted">
                    {r.ownerName}, {r.guests} guests{r.note && ` · ${r.note}`}
                    {r.unitCode && ` · ${r.unitCode}`}
                    {r.decidedBy && ` · ${r.status} by ${r.decidedBy}${r.decisionNote ? `: ${r.decisionNote}` : ''}`}
                  </p>
                </div>
                {r.status === 'pending' && can('booking', 'approve') && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select aria-label={`Unit for ${r.number}`} compact value={picks[r.id] ?? ''} options={[{ value: '', label: 'Pick a unit' }, ...d.catalog.units.filter((u) => u.villaId === r.villaId).map((u) => ({ value: u.id, label: u.code }))]} onChange={(e) => setPicks((p) => ({ ...p, [r.id]: e.target.value }))} />
                    <Button size="sm" variant="accent" disabled={!picks[r.id]} onClick={() => void decide(r.id, true)}>Approve</Button>
                    <Input className="h-8 w-40" aria-label={`Reason to decline ${r.number}`} placeholder="Reason to decline" value={picks[`note-${r.id}`] ?? ''} onChange={(e) => setPicks((p) => ({ ...p, [`note-${r.id}`]: e.target.value }))} />
                    <Button size="sm" variant="soft" onClick={() => void decide(r.id, false)}>Decline</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

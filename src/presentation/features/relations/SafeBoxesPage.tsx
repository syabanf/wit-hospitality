import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { KeyRound, Plus } from 'lucide-react'
import type { RentalView, SafeBoxView } from '@/application/relations'
import { BOX_ENTRY_LABEL, SAFE_BOX_SIZE_LABEL, SAFE_BOX_SIZES, SAFE_BOX_STATUS_LABEL, SIGNATURE_LABEL, type SafeBoxSize, type Signed } from '@/domain/relations'
import { cn } from '@/lib/cn'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { CheckRow } from '../shared/CheckRow'
import { BOX_TONE, useRun, when } from './shared'
import { SignaturePad } from './SignaturePad'

const UNSIGNED: Signed = { signature: 'drawn', signatureData: '' }

/** Safe deposit boxes per property: which are free, who holds a key, and every time a guest opened theirs. */
export default function SafeBoxesPage() {
  const { safeBoxes } = useServices()
  const { can } = useAccess()
  const data = useResource('safeBoxes.list', () => safeBoxes.list())
  const { busy, errors, run } = useRun(data.reload)
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const [signed, setSigned] = useState<Signed>(UNSIGNED)
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { boxes, rentals, catalog, stays } = data.data
  const villas = catalog.villas.filter((v) => boxes.some((b) => b.villaId === v.id))
  const villaId = params.get('villa') ?? villas[0]?.id ?? catalog.villas[0]?.id ?? ''
  const here = boxes.filter((b) => b.villaId === villaId)
  const selected = here.find((b) => b.id === params.get('box')) ?? null
  const logChip = (params.get('log') ?? 'open') as 'open' | 'closed' | 'all'
  const villaRentals = rentals.filter((r) => r.villaId === villaId)
  const log = villaRentals.filter((r) => logChip === 'all' || r.status === logChip)
  const edit = can('guest', 'edit')
  const pick = (box: SafeBoxView) => {
    setSigned(UNSIGNED)
    update('box', box.id === selected?.id ? '' : box.id)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="Property" value={villaId} onChange={(e) => setParams(new URLSearchParams({ villa: e.target.value }), { replace: true })} options={catalog.villas.map((v) => ({ value: v.id, label: v.name }))} />
          <p className="text-sm text-muted">
            {here.filter((b) => b.status === 'free').length} free · {here.filter((b) => b.status === 'in_use').length} in use · {here.filter((b) => b.status === 'out_of_order').length} out of order
          </p>
        </div>
        {edit && (
          <Button variant="card" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Add a box
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Add a box">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void run('add', 'Added the box', () => safeBoxes.save(null, { villaId, number: String(f.get('number') ?? ''), size: String(f.get('size')) as SafeBoxSize, note: String(f.get('note') ?? ''), outOfOrder: false })).then((ok) => ok && setAdding(false))
            }}
          >
            <Field label="Box number" htmlFor="sb-number" error={errors.number}>
              <Input id="sb-number" name="number" className="w-28" />
            </Field>
            <Field label="Size" htmlFor="sb-size" error={errors.size}>
              <Select id="sb-size" name="size" options={SAFE_BOX_SIZES.map((s) => ({ value: s, label: SAFE_BOX_SIZE_LABEL[s] }))} />
            </Field>
            <Field label="Note" htmlFor="sb-note" className="min-w-48 flex-1">
              <Input id="sb-note" name="note" placeholder="Behind the front desk" />
            </Field>
            <Button type="submit" variant="solid" loading={busy === 'add'}>
              Add
            </Button>
          </form>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card aria-labelledby="sb-boxes">
          <CardHeader id="sb-boxes" title="Boxes" />
          {here.length === 0 ? (
            <EmptyState title="No boxes here">Add the property's safe deposit boxes to open them for guests.</EmptyState>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {here.map((b) => (
                <li key={b.id}>
                  <button type="button" aria-pressed={b.id === selected?.id} onClick={() => pick(b)} className={cn('w-full rounded-panel border p-3 text-left text-sm transition-colors', b.id === selected?.id ? 'border-fg bg-raised' : 'border-line bg-card hover:bg-raised')}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-lg font-semibold">Box {b.number}</span>
                      <Tag tone={BOX_TONE[b.status]}>{SAFE_BOX_STATUS_LABEL[b.status]}</Tag>
                    </span>
                    <span className="block text-xs text-muted">{SAFE_BOX_SIZE_LABEL[b.size]}</span>
                    <span className="mt-1 block truncate text-xs">{b.rental ? `${b.rental.guestName} · ${b.rental.bookingCode}` : b.note || ' '}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="sb-panel">
          {!selected ? (
            <>
              <CardHeader id="sb-panel" title="Pick a box" />
              <p className="text-sm text-muted">Open a free box for a guest in house, or pick one in use to log an access or close it at check-out.</p>
            </>
          ) : selected.rental ? (
            <RentalPanel key={selected.id} rental={selected.rental} edit={edit} busy={busy} errors={errors} run={run} signed={signed} setSigned={setSigned} />
          ) : (
            <>
              <CardHeader id="sb-panel" title={`Box ${selected.number}`} action={<Tag tone={BOX_TONE[selected.status]}>{SAFE_BOX_STATUS_LABEL[selected.status]}</Tag>} />
              {edit && selected.status === 'free' && (
                <form
                  className="space-y-3"
                  onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    const f = new FormData(e.currentTarget)
                    void run('open', `Opened box ${selected.number}`, () => safeBoxes.open({ boxId: selected.id, bookingId: String(f.get('bookingId') ?? ''), items: String(f.get('items') ?? ''), keyNumber: String(f.get('keyNumber') ?? ''), ...signed }))
                  }}
                >
                  <Field label="Stay" htmlFor="sb-stay" error={errors.bookingId}>
                    <Select id="sb-stay" name="bookingId" className="w-full" options={stays.filter((b) => b.place.villa.id === villaId).map((b) => ({ value: b.id, label: `${b.guestName} · ${b.code}, ${b.unitCode}` }))} />
                  </Field>
                  <Field label="Items" htmlFor="sb-items" hint="Optional; many guests prefer not to say">
                    <Input id="sb-items" name="items" placeholder="Passports, a watch" />
                  </Field>
                  <Field label="Key handed" htmlFor="sb-key" error={errors.keyNumber}>
                    <Input id="sb-key" name="keyNumber" placeholder="K-07" />
                  </Field>
                  <SignaturePad id="sb-sign-open" value={signed} onChange={setSigned} error={errors.signature} />
                  {errors.form && <p className="text-xs font-medium text-danger">{errors.form}</p>}
                  <Button type="submit" variant="accent" loading={busy === 'open'}>
                    <KeyRound aria-hidden className="size-4" /> Open and hand the key
                  </Button>
                </form>
              )}
              {edit && (
                <form
                  className="mt-4 space-y-3 border-t border-line pt-4"
                  onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    const f = new FormData(e.currentTarget)
                    void run('box', `Saved box ${selected.number}`, () => safeBoxes.save(selected.id, { villaId, number: String(f.get('number') ?? ''), size: String(f.get('size')) as SafeBoxSize, note: String(f.get('note') ?? ''), outOfOrder: f.get('outOfOrder') === 'on' }))
                  }}
                >
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Number" htmlFor="sb-edit-number" error={errors.number}>
                      <Input id="sb-edit-number" name="number" defaultValue={selected.number} />
                    </Field>
                    <Field label="Size" htmlFor="sb-edit-size">
                      <Select id="sb-edit-size" name="size" className="w-full" defaultValue={selected.size} options={SAFE_BOX_SIZES.map((s) => ({ value: s, label: SAFE_BOX_SIZE_LABEL[s] }))} />
                    </Field>
                  </div>
                  <Field label="Note" htmlFor="sb-edit-note">
                    <Input id="sb-edit-note" name="note" defaultValue={selected.note} />
                  </Field>
                  <CheckRow name="outOfOrder" label="Out of order" defaultChecked={selected.status === 'out_of_order'} />
                  <Button type="submit" variant="card" loading={busy === 'box'}>
                    Save the box
                  </Button>
                </form>
              )}
            </>
          )}
        </Card>
      </div>

      <Card className="p-0" aria-label="Box log">
        <TableToolbar
          chips={[
            { value: 'open' as const, label: 'Open', count: villaRentals.filter((r) => r.status === 'open').length },
            { value: 'closed' as const, label: 'Closed', count: villaRentals.filter((r) => r.status === 'closed').length },
            { value: 'all' as const, label: 'All', count: villaRentals.length },
          ]}
          chip={logChip}
          onChip={(v) => update('log', v === 'open' ? '' : v)}
          summary={`${log.length} of ${villaRentals.length} rentals`}
        />
        {log.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No rentals">No box is {logChip === 'all' ? 'on record' : logChip} at this property.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {log.map((r) => (
              <li key={r.id} className="px-4 py-3 text-sm">
                <p className="font-medium">
                  <span className="mr-2 font-mono text-xs text-muted">{r.number}</span>
                  Box {r.boxNumber} ·{' '}
                  <Link to={`/bookings/${r.bookingId}`} className="text-accent-text hover:underline">
                    {r.guestName}, {r.bookingCode}
                  </Link>
                </p>
                <p className="text-xs text-muted">{r.log.map((e) => `${BOX_ENTRY_LABEL[e.kind]} ${when(e.at)} by ${e.by}`).join(' · ')}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

interface RentalPanelProps {
  rental: RentalView
  edit: boolean
  busy: string | null
  errors: Record<string, string>
  run: (key: string, title: string, action: () => Promise<unknown>) => Promise<boolean>
  signed: Signed
  setSigned: (s: Signed) => void
}

/** A box in use: the guest, the key, the log, an access and the close at check-out. */
function RentalPanel({ rental: r, edit, busy, errors, run, signed, setSigned }: RentalPanelProps) {
  const { safeBoxes } = useServices()
  const [action, setAction] = useState<'add' | 'take' | 'close'>('take')
  const [keyBack, setKeyBack] = useState(true)
  return (
    <>
      <CardHeader id="sb-panel" title={`Box ${r.boxNumber}`} action={<Tag tone="info">{r.number}</Tag>} />
      <p className="text-sm">
        <Link to={`/bookings/${r.bookingId}`} className="text-accent-text hover:underline">
          {r.guestName}, {r.bookingCode}
        </Link>
      </p>
      <p className="text-xs text-muted">
        Key {r.keyNumber} · opened {when(r.openedAt)} by {r.openedBy}
        {r.items && ` · ${r.items}`}
      </p>
      <ol className="mt-3 space-y-1.5 text-sm">
        {r.log.map((e, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{BOX_ENTRY_LABEL[e.kind]}</span>
            <span className="text-xs text-muted">
              {when(e.at)} · {e.by} · {SIGNATURE_LABEL[e.signature]}
            </span>
            {e.signatureData && <img src={e.signatureData} alt={`Signature, ${BOX_ENTRY_LABEL[e.kind].toLowerCase()}`} className="h-8 rounded border border-line bg-on-ink" />}
          </li>
        ))}
      </ol>
      {edit && (
        <form
          className="mt-4 space-y-3 border-t border-line pt-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const note = String(f.get('note') ?? '')
            if (action === 'close') void run('close', `Closed box ${r.boxNumber}`, () => safeBoxes.close(r, { keyReturned: keyBack, keyFee: keyBack ? 0 : Number(f.get('keyFee') || 0), note, ...signed }))
            else void run('access', `Logged box ${r.boxNumber}`, () => safeBoxes.access(r, { kind: action, note, ...signed }))
          }}
        >
          <Field label="What the guest does" htmlFor="sb-action" error={errors.kind}>
            <Select id="sb-action" className="w-full" value={action} onChange={(e) => setAction(e.target.value as typeof action)} options={[{ value: 'take', label: 'Takes items out' }, { value: 'add', label: 'Adds items' }, { value: 'close', label: 'Closes the box, returns the key' }]} />
          </Field>
          {action === 'close' && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={keyBack} onChange={(e) => setKeyBack(e.target.checked)} className="size-4 accent-accent" />
                Key returned
              </label>
              {!keyBack && (
                <Field label="Lost key fee, rupiah" htmlFor="sb-fee" error={errors.keyFee} hint="Goes on the folio; zero to waive it">
                  <Input id="sb-fee" name="keyFee" type="number" min={0} step={1} defaultValue={0} inputMode="numeric" />
                </Field>
              )}
            </>
          )}
          <Field label="Note" htmlFor="sb-access-note">
            <Input id="sb-access-note" name="note" />
          </Field>
          <SignaturePad id="sb-sign" value={signed} onChange={setSigned} error={errors.signature} />
          {errors.form && <p className="text-xs font-medium text-danger">{errors.form}</p>}
          <Button type="submit" variant={action === 'close' ? 'accent' : 'solid'} loading={busy === 'close' || busy === 'access'}>
            {action === 'close' ? 'Close the box' : 'Log the access'}
          </Button>
        </form>
      )}
    </>
  )
}

import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { Gauge, Pencil, Plus, Search } from 'lucide-react'
import { METER_KIND_LABEL, METER_KINDS, METER_PAYER_LABEL, METER_PAYERS, METER_UNIT_OF, READING_PURPOSE_LABEL, type Meter, type MeterKind, type MeterPayer } from '@/domain/utilities'
import type { Unit, Villa } from '@/domain/property'
import { shortDay, shortMonth } from '@/lib/dates'
import { money } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'
import { TableToolbar } from '../../ui/TableToolbar'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { billedLine } from './links'
import { ReadingForm } from './ReadingForm'

type Data = Awaited<ReturnType<ReturnType<typeof useServices>['villaOps']['utilities']>>

function MeterForm({ initial, villas, units, onDone, onCancel }: { initial: Meter | null; villas: readonly Villa[]; units: readonly Unit[]; onDone: (m: Meter) => void; onCancel: () => void }) {
  const { villaOps } = useServices()
  const [villaId, setVillaId] = useState(initial?.villaId ?? villas[0]?.id ?? '')
  const [kind, setKind] = useState<MeterKind>(initial?.kind ?? 'electricity')
  const [active, setActive] = useState(initial?.active ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const unitId = String(f.get('unitId') ?? '')
      onDone(await villaOps.saveMeter(initial?.id ?? null, { villaId, unitId: unitId || null, kind, number: String(f.get('number')), unit: METER_UNIT_OF[kind], tariff: Number(f.get('tariff')), payer: f.get('payer') as MeterPayer, active }))
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label={initial ? `Edit ${initial.number}` : 'Add a meter'}>
      <Field label="Villa" htmlFor="meter-villa" error={errors.villaId}>
        <Select id="meter-villa" className="w-full" value={villaId} disabled={!!initial} options={villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => setVillaId(e.target.value)} />
      </Field>
      <Field label="Serves" htmlFor="meter-unit" error={errors.unitId}>
        <Select id="meter-unit" name="unitId" className="w-full" defaultValue={initial?.unitId ?? ''} options={[{ value: '', label: 'The whole villa' }, ...units.filter((u) => u.villaId === villaId).map((u) => ({ value: u.id, label: u.code }))]} />
      </Field>
      <Field label="Kind" htmlFor="meter-kind" error={errors.kind ?? errors.unit}>
        <Select id="meter-kind" className="w-full" value={kind} options={METER_KINDS.map((k) => ({ value: k, label: `${METER_KIND_LABEL[k]}, ${METER_UNIT_OF[k]}` }))} onChange={(e) => setKind(e.target.value as MeterKind)} />
      </Field>
      <Field label="Meter number" htmlFor="meter-number" error={errors.number ?? errors.form}>
        <Input id="meter-number" name="number" defaultValue={initial?.number} placeholder="PLN-KR-04" required />
      </Field>
      <Field label={`Tariff per ${METER_UNIT_OF[kind]}`} htmlFor="meter-tariff" error={errors.tariff}>
        <Input id="meter-tariff" name="tariff" type="number" min={0} defaultValue={initial?.tariff ?? 0} required />
      </Field>
      <Field label="Who pays" htmlFor="meter-payer" error={errors.payer}>
        <Select id="meter-payer" name="payer" className="w-full" defaultValue={initial?.payer ?? 'operator'} options={METER_PAYERS.map((p) => ({ value: p, label: METER_PAYER_LABEL[p] }))} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
        <Switch checked={active} onChange={setActive} label="In use" />
        <span className="mr-auto text-sm">In use</span>
        <Button type="submit" variant="accent" loading={saving}>
          {initial ? 'Save meter' : 'Add meter'}
        </Button>
        <Button variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function LongStayCard({ d, onSaved }: { d: Data; onSaved: () => void }) {
  const { villaOps } = useServices()
  const toast = useToast()
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(d.settings.map((s) => [s.villa.id, String(s.longStayNights)])))
  async function save(villaId: string, name: string) {
    try {
      const saved = await villaOps.saveUtilitySettings(villaId, Number(values[villaId]))
      toast({ title: `Saved ${name}`, description: `Meters read on stays of ${saved.longStayNights} nights or more` })
      onSaved()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save the setting', description: error instanceof Error ? error.message : undefined })
    }
  }
  return (
    <Card aria-labelledby="long-stay-title">
      <CardHeader id="long-stay-title" title="Long stays" />
      <p className="mb-3 text-xs text-muted">Stays this long or longer get meter readings at check-in and check-out; a guest-paid meter bills the usage on the folio.</p>
      <ul className="space-y-2">
        {d.settings.map((s) => (
          <li key={s.villa.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{s.villa.name}</span>
            <Input aria-label={`${s.villa.name} long stay nights`} type="number" min={1} max={365} className="h-10 w-24" disabled={!d.can.settings} value={values[s.villa.id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [s.villa.id]: e.target.value }))} />
            {d.can.settings && (
              <Button size="sm" variant="soft" disabled={values[s.villa.id] === String(s.longStayNights)} onClick={() => void save(s.villa.id, s.villa.name)}>
                Save
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Electricity, water and gas: meters per villa, readings, monthly consumption and what it billed. */
export default function UtilitiesPage() {
  const { villaOps, clock } = useServices()
  const toast = useToast()
  const data = useResource('villaOps.utilities', () => villaOps.utilities())
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [reading, setReading] = useState(false)
  const [chartKind, setChartKind] = useState<MeterKind>('electricity')
  const [month, setMonth] = useState<string | null>(null)

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const villa = params.get('villa') ?? ''
  const kind = (METER_KINDS.find((k) => k === params.get('kind')) ?? 'all') as MeterKind | 'all'
  const payer = params.get('payer') ?? ''
  const q = (params.get('q') ?? '').toLowerCase()
  const meterBase = d.meters.filter((m) => (!villa || m.villaId === villa) && (!payer || m.payer === payer) && (!q || [m.number, m.villaName, m.unitCode].some((v) => v.toLowerCase().includes(q))))
  const meters = kind === 'all' ? meterBase : meterBase.filter((m) => m.kind === kind)
  const readingRows = d.readings.filter((r) => (!villa || r.villaId === villa) && (kind === 'all' || r.kind === kind) && (!q || [r.meterNumber, r.villaName, r.bookingCode ?? ''].some((v) => v.toLowerCase().includes(q))) && (!month || r.on.slice(0, 7) === month))
  const current = d.meters.find((m) => m.id === editing) ?? null
  const unitOf = METER_UNIT_OF[chartKind]
  const thisMonth = d.today.slice(0, 7)
  const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
  const filtered = kind !== 'all' || !!villa || !!payer || !!q || !!month

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Staff read every meter once a month, and at check-in and check-out on long stays. Usage a guest pays lands on the folio; usage the owner pays lands on the owner statement.</p>
        <div className="flex flex-wrap gap-2">
          {d.can.edit && d.meters.length > 0 && (
            <Button variant="card" aria-pressed={reading} onClick={() => setReading((v) => !v)}>
              <Gauge aria-hidden className="size-4" /> Reading
            </Button>
          )}
          {d.can.create && (
            <Button variant="accent" aria-pressed={editing === 'new'} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              <Plus aria-hidden className="size-4" /> Meter
            </Button>
          )}
        </div>
      </div>
      {reading && (
        <Card aria-label="Record a reading">
          <ReadingForm
            meters={d.meters.filter((m) => m.active)}
            today={d.today}
            onDone={(r) => {
              toast({ title: `Read ${d.meters.find((m) => m.id === r.meterId)?.number ?? 'the meter'}`, description: `${r.consumption} used since the last reading, ${billedLine(r).toLowerCase()}` })
              setReading(false)
              data.reload()
            }}
            onCancel={() => setReading(false)}
          />
        </Card>
      )}
      {(editing === 'new' || current) && (
        <Card aria-label={current ? `Edit ${current.number}` : 'Add a meter'}>
          <MeterForm
            key={editing ?? ''}
            initial={current}
            villas={d.villas}
            units={d.units}
            onDone={(m) => {
              toast({ title: current ? `Saved ${m.number}` : `Added ${m.number}` })
              setEditing(null)
              data.reload()
            }}
            onCancel={() => setEditing(null)}
          />
        </Card>
      )}
      <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Meters in use" value={d.meters.filter((m) => m.active).length} onClick={() => setParams({}, { replace: true })} />
        <StatTile label="Readings this month" value={d.readings.filter((r) => r.on.slice(0, 7) === thisMonth).length} active={month === thisMonth} onClick={() => setMonth(month === thisMonth ? null : thisMonth)} />
        <StatTile label="Billed to guests" value={money(sum(d.perVilla.map((v) => v.billedGuest)))} active={payer === 'guest'} onClick={() => update({ payer: payer === 'guest' ? '' : 'guest' })} />
        <StatTile label="Billed to owners" value={money(sum(d.perVilla.map((v) => v.billedOwner)))} active={payer === 'owner'} onClick={() => update({ payer: payer === 'owner' ? '' : 'owner' })} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card aria-labelledby="consumption-title" className="min-w-0">
          <CardHeader id="consumption-title" title="Consumption per month" action={<Tabs label="Meter kind" options={METER_KINDS.map((k) => ({ value: k, label: METER_KIND_LABEL[k] }))} value={chartKind} onChange={setChartKind} />} />
          <ColumnChart
            className="h-56"
            label={`${METER_KIND_LABEL[chartKind]} per month, ${unitOf}`}
            data={d.months.map((m, i) => ({ key: m, label: shortMonth(`${m}-01`), value: d.byKind[chartKind][i] ?? 0 }))}
            selected={month}
            onSelect={(m) => {
              setMonth(month === m ? null : m)
              update({ kind: chartKind })
            }}
            format={(v) => `${v.toLocaleString('en-US')} ${unitOf}`}
          />
          <p className="mt-3 text-xs text-muted">Pick a month to list its readings below.</p>
        </Card>
        <LongStayCard key={d.settings.map((s) => s.longStayNights).join()} d={d} onSaved={data.reload} />
      </div>
      <Card className="p-0" aria-label="Per villa">
        <ListTable
          label="Consumption per villa, six months"
          rows={d.perVilla}
          rowKey={(r) => r.villa.id}
          href={(r) => `/maintenance/utilities?villa=${r.villa.id}`}
          defaultSort={{ key: 'villa', dir: 'asc' }}
          empty={<EmptyState title="No meters yet" />}
          columns={[
            { key: 'villa', header: 'Villa', cell: (r) => r.villa.name, value: (r) => r.villa.name },
            { key: 'el', header: 'Electricity, kWh', align: 'right', cell: (r) => <span className="tabular">{r.electricity.toLocaleString('en-US')}</span>, value: (r) => r.electricity },
            { key: 'wa', header: 'Water, m3', align: 'right', cell: (r) => <span className="tabular">{r.water.toLocaleString('en-US')}</span>, value: (r) => r.water, hide: 'lg' },
            { key: 'gas', header: 'Gas, m3', align: 'right', cell: (r) => <span className="tabular">{r.gas.toLocaleString('en-US')}</span>, value: (r) => r.gas, hide: 'xl' },
            { key: 'guest', header: 'Billed to guests', align: 'right', cell: (r) => <span className="tabular">{money(r.billedGuest)}</span>, value: (r) => r.billedGuest, hide: 'lg' },
            { key: 'owner', header: 'Billed to owners', align: 'right', cell: (r) => <span className="tabular">{money(r.billedOwner)}</span>, value: (r) => r.billedOwner, hide: 'lg' },
          ]}
          card={(r) => (
            <div>
              <p className="font-medium">{r.villa.name}</p>
              <p className="text-xs text-muted">
                {r.electricity.toLocaleString('en-US')} kWh · {r.water.toLocaleString('en-US')} m3 · {money(r.billedGuest + r.billedOwner)} billed
              </p>
            </div>
          )}
        />
      </Card>
      <Card className="p-0">
        <TableToolbar
          chips={(['all', ...METER_KINDS] as const).map((k) => ({ value: k, label: k === 'all' ? 'All' : METER_KIND_LABEL[k], count: k === 'all' ? meterBase.length : meterBase.filter((m) => m.kind === k).length }))}
          chip={kind}
          onChip={(k) => update({ kind: k === 'all' ? '' : k })}
          summary={`${meters.length} of ${d.meters.length} meters`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Meter, villa or stay" aria-label="Search meters" value={params.get('q') ?? ''} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Villa" value={villa} options={[{ value: '', label: 'All villas' }, ...d.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => update({ villa: e.target.value })} />
              <Select aria-label="Who pays" value={payer} options={[{ value: '', label: 'Anyone pays' }, ...METER_PAYERS.map((p) => ({ value: p, label: METER_PAYER_LABEL[p] }))]} onChange={(e) => update({ payer: e.target.value })} />
            </>
          }
          active={filtered}
          onClear={() => {
            setMonth(null)
            setParams({}, { replace: true })
          }}
        />
        <ListTable
          label="Meters"
          rows={meters}
          rowKey={(m) => m.id}
          href={(m) => `/maintenance/utilities?q=${encodeURIComponent(m.number)}`}
          defaultSort={{ key: 'number', dir: 'asc' }}
          exportName="meters"
          exportDate={clock.today()}
          empty={<EmptyState title="No meter matches" />}
          columns={[
            { key: 'number', header: 'Meter', cell: (m) => <span className="font-mono text-xs">{m.number}</span>, value: (m) => m.number },
            { key: 'kind', header: 'Kind', cell: (m) => METER_KIND_LABEL[m.kind], value: (m) => m.kind },
            { key: 'where', header: 'Serves', cell: (m) => `${m.villaName}${m.unitCode ? `, ${m.unitCode}` : ''}`, value: (m) => m.villaName, hide: 'lg' },
            { key: 'tariff', header: 'Tariff', align: 'right', cell: (m) => <span className="tabular">{money(m.tariff)} / {m.unit}</span>, value: (m) => m.tariff, hide: 'xl' },
            { key: 'payer', header: 'Pays', cell: (m) => <Tag tone={m.payer === 'guest' ? 'info' : m.payer === 'owner' ? 'warning' : 'neutral'}>{METER_PAYER_LABEL[m.payer]}</Tag>, value: (m) => m.payer },
            { key: 'last', header: 'Last reading', cell: (m) => (m.last ? `${m.last.value} ${m.unit}, ${shortDay(m.last.on)}` : 'Never read'), value: (m) => m.last?.on ?? '', hide: 'lg' },
            ...(d.can.edit
              ? [
                  {
                    key: 'edit',
                    header: '',
                    align: 'right' as const,
                    cell: (m: Data['meters'][number]) => (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${m.number}`} aria-pressed={editing === m.id} onClick={() => setEditing(editing === m.id ? null : m.id)}>
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
          card={(m) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {METER_KIND_LABEL[m.kind]} <span className="font-mono text-xs text-muted">{m.number}</span>
                </p>
                <p className="truncate text-xs text-muted">
                  {m.villaName}
                  {m.unitCode && `, ${m.unitCode}`} · {m.last ? `${m.last.value} ${m.unit} on ${shortDay(m.last.on)}` : 'never read'}
                </p>
              </div>
              {d.can.edit && (
                <span onClick={(e) => e.stopPropagation()}>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${m.number}`} onClick={() => setEditing(editing === m.id ? null : m.id)}>
                    <Pencil aria-hidden className="size-4" />
                  </Button>
                </span>
              )}
            </div>
          )}
        />
      </Card>
      <Card className="p-0">
        <ListTable
          label={month ? `Readings in ${shortMonth(`${month}-01`)}` : 'Readings'}
          rows={readingRows}
          rowKey={(r) => r.id}
          href={(r) => (r.bookingId ? `/bookings/${r.bookingId}` : `/maintenance/utilities?q=${encodeURIComponent(r.meterNumber)}`)}
          defaultSort={{ key: 'on', dir: 'desc' }}
          exportName="meter-readings"
          exportDate={clock.today()}
          empty={<EmptyState title="No reading matches" />}
          columns={[
            { key: 'on', header: 'Date', cell: (r) => shortDay(r.on), value: (r) => r.on },
            { key: 'meter', header: 'Meter', cell: (r) => <span className="font-mono text-xs">{r.meterNumber}</span>, value: (r) => r.meterNumber },
            { key: 'for', header: 'For', cell: (r) => `${READING_PURPOSE_LABEL[r.purpose]}${r.bookingCode ? `, ${r.bookingCode}` : ''}${r.replacement ? ', new meter' : ''}`, value: (r) => r.purpose, hide: 'lg' },
            { key: 'value', header: 'Value', align: 'right', cell: (r) => <span className="tabular">{r.value.toLocaleString('en-US')}</span>, value: (r) => r.value, hide: 'xl' },
            { key: 'used', header: 'Used', align: 'right', cell: (r) => <span className="tabular">{r.consumption.toLocaleString('en-US')} {r.unit}</span>, value: (r) => r.consumption },
            { key: 'billed', header: 'Billed', align: 'right', cell: (r) => billedLine(r), value: (r) => r.amount, hide: 'lg' },
          ]}
          card={(r) => (
            <div>
              <p className="font-medium">
                <span className="font-mono text-xs">{r.meterNumber}</span> · {r.consumption.toLocaleString('en-US')} {r.unit}
              </p>
              <p className="text-xs text-muted">
                {shortDay(r.on)} · {READING_PURPOSE_LABEL[r.purpose]}
                {r.bookingCode && `, ${r.bookingCode}`} · {billedLine(r)}
              </p>
            </div>
          )}
        />
      </Card>
    </div>
  )
}

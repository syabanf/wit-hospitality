import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Droplets, LayoutTemplate } from 'lucide-react'
import type { WorkOrder } from '@/domain/maintenance'
import type { Catalog } from '@/domain/property'
import { POOL_RANGE, UPKEEP_JOBS, UPKEEP_TEMPLATE_LABEL, UPKEEP_TEMPLATES, type UpkeepTemplate } from '@/domain/upkeep'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

/** Applies the pool, garden or fogging plans to a villa, on the preventive plans page. */
export function TemplateForm({ catalog, today, onDone, onCancel }: { catalog: Pick<Catalog, 'villas' | 'units'>; today: string; onDone: (count: number, label: string) => void; onCancel: () => void }) {
  const { villaOps } = useServices()
  const [villaId, setVillaId] = useState(catalog.villas[0]?.id ?? '')
  const [template, setTemplate] = useState<UpkeepTemplate>('pool')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const unitId = String(f.get('unitId') ?? '')
      const plans = await villaOps.applyTemplate({ villaId, unitId: unitId || null, template, startOn: String(f.get('startOn')) })
      onDone(plans.length, UPKEEP_TEMPLATE_LABEL[template])
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby="template-title">
      <CardHeader id="template-title" title="Apply an upkeep template" icon={<LayoutTemplate aria-hidden className="size-5 text-muted" />} />
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Template" htmlFor="tpl-template" error={errors.template}>
          <Select id="tpl-template" className="w-full" value={template} options={UPKEEP_TEMPLATES.map((t) => ({ value: t, label: UPKEEP_TEMPLATE_LABEL[t] }))} onChange={(e) => setTemplate(e.target.value as UpkeepTemplate)} />
        </Field>
        <Field label="Villa" htmlFor="tpl-villa" error={errors.villaId ?? errors.form}>
          <Select id="tpl-villa" className="w-full" value={villaId} options={catalog.villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => setVillaId(e.target.value)} />
        </Field>
        <Field label="Where" htmlFor="tpl-unit" error={errors.unitId}>
          <Select id="tpl-unit" name="unitId" className="w-full" options={[{ value: '', label: 'The whole villa' }, ...catalog.units.filter((u) => u.villaId === villaId).map((u) => ({ value: u.id, label: u.code }))]} />
        </Field>
        <Field label="First day" htmlFor="tpl-start" error={errors.startOn}>
          <Input id="tpl-start" name="startOn" type="date" defaultValue={today} required />
        </Field>
        <ul className="space-y-1 text-xs text-muted sm:col-span-2 xl:col-span-4">
          {UPKEEP_JOBS[template].map((j) => (
            <li key={j.key}>
              {j.title}: every {j.every} {j.unit === 'days' ? (j.every === 1 ? 'day' : 'days') : j.every === 1 ? 'month' : 'months'}
              {j.readings && ', records pH and chlorine'}
              {j.outsideWindow && ", outside the guest's service window"}
              {j.notifyStay && ', tells the guest in house'}
            </li>
          ))}
        </ul>
        <div className="flex gap-2 sm:col-span-2 xl:col-span-4">
          <Button type="submit" variant="accent" loading={saving}>
            Add the plans
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** A pool, garden or fogging task's checklist, pool chemistry and the guest's window, on the work order page. */
export function UpkeepCard({ workOrder: w, onChanged }: { workOrder: WorkOrder; onChanged: () => void }) {
  const { villaOps } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const upkeep = w.upkeep
  const [ticks, setTicks] = useState<boolean[]>(() => upkeep?.checklist.map((c) => c.done) ?? [])
  const [ph, setPh] = useState(upkeep?.readings ? String(upkeep.readings.ph) : '')
  const [chlorine, setChlorine] = useState(upkeep?.readings ? String(upkeep.readings.chlorine) : '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'save' | 'notify' | null>(null)
  if (!upkeep) return null
  const open = w.status !== 'verified' && w.status !== 'cancelled'
  const editable = open && can('maintenance', 'edit')

  async function save() {
    setBusy('save')
    setErrors({})
    try {
      const readings = upkeep!.readingsRequired && ph !== '' && chlorine !== '' ? { ph: Number(ph), chlorine: Number(chlorine) } : null
      const saved = await villaOps.recordUpkeep(w.id, { checklist: ticks, readings, noticeSent: false })
      toast({ title: `Saved the checklist on ${w.number}`, description: saved.upkeep?.readings?.flags.length ? `Out of range: ${saved.upkeep.readings.flags.join(', ')}` : undefined })
      onChanged()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setBusy(null)
    }
  }

  async function notify() {
    setBusy('notify')
    try {
      await villaOps.notifyStay(w.id)
      toast({ title: `Told ${upkeep!.notice?.bookingCode} about the visit` })
      onChanged()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not send the notice', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card aria-labelledby="wo-upkeep">
      <CardHeader id="wo-upkeep" title="Upkeep checklist" icon={<Droplets aria-hidden className="size-5 text-muted" />} />
      {upkeep.window && (
        <p className="mb-3 rounded-panel bg-info-soft px-3 py-2 text-sm text-info-text">
          {upkeep.outsideWindow ? 'Work outside' : 'Work within'} the guest's service window, {upkeep.window.from} to {upkeep.window.to}.
        </p>
      )}
      <ul className="space-y-2">
        {upkeep.checklist.map((c, i) => (
          <li key={c.item}>
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={ticks[i] ?? false} disabled={!editable} onChange={(e) => setTicks((t) => t.map((x, k) => (k === i ? e.target.checked : x)))} />
              {c.item}
            </label>
          </li>
        ))}
      </ul>
      {errors.checklist && (
        <p role="alert" className="mt-2 text-xs font-medium text-danger">
          {errors.checklist}
        </p>
      )}
      {upkeep.readingsRequired && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label={`pH, ${POOL_RANGE.ph[0]} to ${POOL_RANGE.ph[1]}`} htmlFor="wo-ph" error={errors.ph}>
            <Input id="wo-ph" type="number" step="0.1" min={0} max={14} value={ph} disabled={!editable} onChange={(e) => setPh(e.target.value)} />
          </Field>
          <Field label={`Chlorine ppm, ${POOL_RANGE.chlorine[0]} to ${POOL_RANGE.chlorine[1]}`} htmlFor="wo-cl" error={errors.chlorine ?? errors.readings ?? errors.form}>
            <Input id="wo-cl" type="number" step="0.1" min={0} max={20} value={chlorine} disabled={!editable} onChange={(e) => setChlorine(e.target.value)} />
          </Field>
          {upkeep.readings && (
            <div className="col-span-2 flex flex-wrap gap-2">
              {upkeep.readings.flags.length ? upkeep.readings.flags.map((f) => <Tag key={f} tone="danger">{f}</Tag>) : <Tag tone="success">In range</Tag>}
            </div>
          )}
        </div>
      )}
      {editable && (
        <Button className="mt-4" variant="solid" size="sm" loading={busy === 'save'} onClick={() => void save()}>
          Save checklist
        </Button>
      )}
      {upkeep.notice && (
        <div className={cn('mt-4 rounded-panel bg-raised p-3 text-sm')}>
          <p className="font-medium">
            Notice for{' '}
            <Link to={`/bookings/${upkeep.notice.bookingId}`} className="hover:underline">
              {upkeep.notice.bookingCode}
            </Link>
          </p>
          <p className="mt-1 text-muted">{upkeep.notice.text}</p>
          {upkeep.notice.sentOn ? (
            <p className="mt-2 text-xs text-muted">Sent on {shortDay(upkeep.notice.sentOn)}.</p>
          ) : (
            can('booking', 'edit') && (
              <Button className="mt-2" size="sm" variant="soft" loading={busy === 'notify'} onClick={() => void notify()}>
                Notify the guest
              </Button>
            )
          )}
        </div>
      )}
    </Card>
  )
}

import { useState, type FormEvent } from 'react'
import { OWNER_STAY_PRICING_LABEL, OWNER_STAY_STATUS_LABEL } from '@/domain/owner'
import { addDays, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

/** The owner asks for dates in their villa; the operator approves and blocks a unit as an owner stay. */
export default function PortalStaysPage() {
  const { portal } = useServices()
  const toast = useToast()
  const data = useResource('portal.stays', () => portal.stays())
  const [form, setForm] = useState({ contractId: '', checkIn: '', checkOut: '', guests: 2, note: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const contractId = form.contractId || d.contracts[0]?.id || ''

  async function ask(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      await portal.requestStay({ ...form, contractId })
      toast({ title: 'Stay requested', description: 'The operator confirms it and holds a unit for you.' })
      setForm((f) => ({ ...f, checkIn: '', checkOut: '', note: '' }))
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
      <Card aria-labelledby="ps-ask">
        <CardHeader id="ps-ask" title="Ask for a stay" />
        <ul className="mb-4 space-y-1 text-sm">
          {d.contracts.map((c) => (
            <li key={c.id}>
              <span className="font-medium">{c.villa.name}</span>: {c.used} of {c.allowance} owner nights used this year · {OWNER_STAY_PRICING_LABEL[c.pricing].toLowerCase()}
              {c.price ? `, ${money(c.price)}` : ''}
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => void ask(e)} className="space-y-3">
          <Field label="Villa" htmlFor="ps-villa">
            <Select id="ps-villa" className="w-full" value={contractId} options={d.contracts.map((c) => ({ value: c.id, label: c.villa.name }))} onChange={(e) => setForm((f) => ({ ...f, contractId: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Arrive" htmlFor="ps-in">
              <Input id="ps-in" type="date" min={d.today} value={form.checkIn} onChange={(e) => setForm((f) => ({ ...f, checkIn: e.target.value, checkOut: f.checkOut > e.target.value ? f.checkOut : addDays(e.target.value, 3) }))} />
            </Field>
            <Field label="Leave" htmlFor="ps-out">
              <Input id="ps-out" type="date" min={form.checkIn || d.today} value={form.checkOut} onChange={(e) => setForm((f) => ({ ...f, checkOut: e.target.value }))} />
            </Field>
          </div>
          <Field label="Guests" htmlFor="ps-guests">
            <Input id="ps-guests" inputMode="numeric" value={String(form.guests)} onChange={(e) => setForm((f) => ({ ...f, guests: Number(e.target.value) || 0 }))} />
          </Field>
          <Field label="Note for the operator" htmlFor="ps-note" error={errors.form}>
            <Textarea id="ps-note" rows={2} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </Field>
          <Button type="submit" variant="accent" loading={busy} className="w-full">
            Ask for these dates
          </Button>
        </form>
      </Card>
      <Card aria-labelledby="ps-list">
        <CardHeader id="ps-list" title="Your stays" />
        {d.requests.length === 0 ? (
          <EmptyState title="No stays yet" />
        ) : (
          <ul className="divide-y divide-line">
            {d.requests.map((r) => (
              <li key={r.id} className="py-3">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {r.villaName}, {shortDay(r.checkIn)} to {shortDay(r.checkOut)}
                  <StatusPill tone={r.status === 'approved' ? 'success' : r.status === 'pending' ? 'warning' : 'neutral'}>{OWNER_STAY_STATUS_LABEL[r.status]}</StatusPill>
                </p>
                <p className="text-xs text-muted">
                  {r.number} · {r.guests} guests{r.unitCode && ` · ${r.unitCode}`}
                  {r.decisionNote && ` · ${r.decisionNote}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Clock, Pencil, Sparkles } from 'lucide-react'
import type { AppServices } from '@/application/performance'
import type { BookingView } from '@/application/views'
import { SETUP_LABEL, SETUPS, WINDOW_MODE_LABEL, WINDOW_MODES, type GuestPreferences, type ServiceWindow, type Setup, type WindowMode } from '@/domain/hospitality'
import { money } from '@/lib/format'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { FactGrid } from '../../ui/Headline'
import { useToast } from '../../ui/useToast'
import { WindowTag } from '../shared/WindowTag'

type Hospitality = Awaited<ReturnType<AppServices['booking']['detail']>>['hospitality']
type Editing = 'host' | 'window' | 'preferences' | 'late' | null
const SETUP_OPTIONS = SETUPS.map((id) => ({ id, label: SETUP_LABEL[id] }))
const text = (f: FormData, key: string) => String(f.get(key) ?? '').trim()

/** Host, the guest's wishes, when housekeeping may come in, late check-out and a clean on request. */
export function HospitalityCard({ booking: b, hospitality: h, onChanged }: { booking: BookingView; hospitality: Hospitality; onChanged: () => void }) {
  const { booking } = useServices()
  const toast = useToast()
  const [editing, setEditing] = useState<Editing>(null)
  const [busy, setBusy] = useState<Editing | 'clean'>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [setups, setSetups] = useState<Setup[]>([...h.preferences.setups])
  const [mode, setMode] = useState<WindowMode>(h.window.mode)
  const villa = h.kind === 'villa'
  const live = b.status === 'confirmed' || b.status === 'checked_in'
  const p = h.preferences

  /** Runs a change; an action that returns text puts it under the toast title. */
  async function run(key: NonNullable<typeof busy>, title: string, action: () => Promise<unknown>, description?: string) {
    setBusy(key)
    setErrors({})
    try {
      const said = await action()
      toast({ title, description: typeof said === 'string' ? said : description })
      setEditing(null)
      onChanged()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not ${title.charAt(0).toLowerCase()}${title.slice(1)}`, description: Object.values(e)[0] })
    } finally {
      setBusy(null)
    }
  }
  const open = (next: Editing) => {
    setErrors({})
    setSetups([...p.setups])
    setMode(h.window.mode)
    setEditing(editing === next ? null : next)
  }
  const submit = (handler: (f: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    handler(new FormData(e.currentTarget))
  }

  const savePreferences = (f: FormData) => {
    const next: GuestPreferences = { breakfastTime: text(f, 'breakfastTime'), dietary: text(f, 'dietary'), setups, arrivalTime: text(f, 'arrivalTime'), notes: text(f, 'notes') }
    void run('preferences', 'Saved the guest’s wishes', () => booking.setPreferences(b.id, next))
  }
  const saveWindow = (f: FormData) => {
    const next: ServiceWindow = { mode, from: mode === 'window' ? text(f, 'from') : '', to: mode === 'window' ? text(f, 'to') : '' }
    void run('window', 'Saved the service window', () => booking.setServiceWindow(b.id, next))
  }
  const lateCheckout = (f: FormData) => {
    const until = text(f, 'until')
    void run('late', `Gave late check-out to ${until}`, async () => {
      const r = await booking.lateCheckout(b.id, until)
      return r.charge ? `${money(r.charge)} went on the folio.` : 'Free of charge.'
    })
  }

  const arrival = h.late.nextArrival ? `The next guest arrives at ${h.late.nextArrival}. ` : ''
  const free = h.late.fee === 0 || (villa && (!h.late.nextArrival || b.place.villa.operation === 'mixed'))
  const lateNote = `${arrival}${free ? 'No charge.' : `${money(h.late.fee)} on the folio.`}`

  return (
    <Card aria-labelledby="stay-service-title">
      <CardHeader
        id="stay-service-title"
        title={villa ? 'Host and guest wishes' : 'Guest wishes'}
        action={
          b.status === 'checked_in' && (
            <Button size="sm" variant="soft" loading={busy === 'clean'} onClick={() => void run('clean', 'Asked housekeeping for a clean', () => booking.requestClean(b.id), 'A stayover task is on today’s board.')}>
              <Sparkles aria-hidden className="size-3.5" /> Clean today
            </Button>
          )
        }
      />
      <FactGrid
        className="grid-cols-2"
        facts={[
          ...(villa ? ([['Host', h.host ? <Link key="host" to={`/hr/employees/${h.host.id}`} className="hover:underline">{h.host.name}</Link> : 'No host yet']] as const) : []),
          ['Service', <WindowTag key="w" window={h.window} />],
          ['Arrives at', p.arrivalTime || 'Not said'],
          ...(villa ? ([['Breakfast', p.breakfastTime || 'Not said'], ['Diet', p.dietary || 'None']] as const) : []),
          ['Late check-out', b.lateCheckout ? `To ${b.lateCheckout.until}, ${b.lateCheckout.charge ? money(b.lateCheckout.charge) : 'free'}` : 'No'],
        ]}
      />
      {villa && p.setups.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Setups the guest asked for">
          {p.setups.map((s) => (
            <li key={s}>
              <Tag tone="info">{SETUP_LABEL[s]}</Tag>
            </li>
          ))}
        </ul>
      )}
      {p.notes && <p className="mt-3 text-sm text-body">{p.notes}</p>}

      {live && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="soft" aria-pressed={editing === 'preferences'} onClick={() => open('preferences')}>
            <Pencil aria-hidden className="size-3.5" /> Wishes
          </Button>
          <Button size="sm" variant="soft" aria-pressed={editing === 'window'} onClick={() => open('window')}>
            Service window
          </Button>
          {h.mayChangeHost && (
            <Button size="sm" variant="soft" aria-pressed={editing === 'host'} onClick={() => open('host')}>
              Change host
            </Button>
          )}
          {!b.lateCheckout && (
            <Button size="sm" variant="soft" aria-pressed={editing === 'late'} onClick={() => open('late')}>
              <Clock aria-hidden className="size-3.5" /> Late check-out
            </Button>
          )}
        </div>
      )}

      {editing === 'preferences' && (
        <form onSubmit={submit(savePreferences)} className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2">
          <Field label="Arrives at" htmlFor="pref-arrival" error={errors.arrivalTime}>
            <Input id="pref-arrival" name="arrivalTime" type="time" defaultValue={p.arrivalTime} className="tabular" />
          </Field>
          {villa && (
            <>
              <Field label="Breakfast at" htmlFor="pref-breakfast" error={errors.breakfastTime}>
                <Input id="pref-breakfast" name="breakfastTime" type="time" defaultValue={p.breakfastTime} className="tabular" />
              </Field>
              <Field label="Diet and allergies" htmlFor="pref-diet" error={errors.dietary} className="sm:col-span-2">
                <Input id="pref-diet" name="dietary" defaultValue={p.dietary} placeholder="Vegetarian, no peanuts" />
              </Field>
              <Field label="Setups" error={errors.setups} hint="Paid setups go to the host as requests; the guest pays once the price is agreed" className="sm:col-span-2">
                <CheckboxGrid name="setups" options={SETUP_OPTIONS} selected={setups} onChange={(next) => setSetups(next as Setup[])} />
              </Field>
            </>
          )}
          <Field label="Notes" htmlFor="pref-notes" error={errors.notes} className="sm:col-span-2">
            <Textarea id="pref-notes" name="notes" defaultValue={p.notes} rows={2} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="accent" loading={busy === 'preferences'}>
              Save wishes
            </Button>
          </div>
        </form>
      )}

      {editing === 'window' && (
        <form onSubmit={submit(saveWindow)} className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Field label="Housekeeping comes" htmlFor="win-mode" error={errors.mode}>
            <Select id="win-mode" className="w-full" value={mode} onChange={(e) => setMode(e.target.value as WindowMode)} options={WINDOW_MODES.map((m) => ({ value: m, label: WINDOW_MODE_LABEL[m] }))} />
          </Field>
          {mode === 'window' && (
            <>
              <Field label="From" htmlFor="win-from" error={errors.from}>
                <Input id="win-from" name="from" type="time" defaultValue={h.window.from || '10:00'} className="tabular" />
              </Field>
              <Field label="To" htmlFor="win-to" error={errors.to}>
                <Input id="win-to" name="to" type="time" defaultValue={h.window.to || '12:00'} className="tabular" />
              </Field>
            </>
          )}
          <div className="sm:col-span-3">
            <Button type="submit" variant="accent" loading={busy === 'window'}>
              Save window
            </Button>
          </div>
        </form>
      )}

      {editing === 'host' && (
        <form onSubmit={submit((f) => void run('host', 'Changed the host', () => booking.setHost(b.id, text(f, 'hostId') || null)))} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <Field label="Host" htmlFor="stay-host" error={errors.hostId} hint="Staff allocated to this villa in HR" className="min-w-0 flex-1">
            <Select id="stay-host" name="hostId" className="w-full" defaultValue={h.host?.id ?? ''} options={[{ value: '', label: 'No host' }, ...h.hosts.map((e) => ({ value: e.id, label: e.name }))]} />
          </Field>
          <Button type="submit" variant="accent" loading={busy === 'host'}>
            Save host
          </Button>
        </form>
      )}

      {editing === 'late' && (
        <form onSubmit={submit(lateCheckout)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <Field label="Leaves at" htmlFor="late-until" error={errors.until} hint={`Check-out is ${h.late.checkOutTime}. ${lateNote}`} className="min-w-0 flex-1">
            <Input id="late-until" name="until" type="time" defaultValue="16:00" className="tabular" />
          </Field>
          <Button type="submit" variant="accent" loading={busy === 'late'}>
            Give late check-out
          </Button>
        </form>
      )}
    </Card>
  )
}

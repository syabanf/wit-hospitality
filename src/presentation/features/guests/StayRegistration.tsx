import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { UserPlus } from 'lucide-react'
import { countryName, type StayCompanion } from '@/domain/guest'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { DocumentFields, readDocument } from './DocumentFields'

/** Add or edit one companion with the same fields as the lead guest. */
function CompanionForm({ bookingId, companion, onDone }: { bookingId: string; companion: StayCompanion | null; onDone: () => void }) {
  const { guest } = useServices()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const prefix = `cmp-${companion?.id ?? 'new'}-`

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    e.stopPropagation()
    const f = new FormData(e.currentTarget)
    const input = { ...readDocument(f, prefix), name: String(f.get(`${prefix}name`) ?? ''), adult: f.get(`${prefix}adult`) === 'on' }
    setSaving(true)
    setErrors({})
    try {
      await (companion ? guest.updateCompanion(companion.id, input) : guest.addCompanion(bookingId, input))
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-2" aria-label={companion ? `Edit ${companion.name}` : 'Add a companion'}>
      <Field label="Full name" htmlFor={`${prefix}name`} error={errors.name}>
        <Input id={`${prefix}name`} name={`${prefix}name`} defaultValue={companion?.name} />
      </Field>
      <label className="flex items-center gap-2 self-end pb-2.5 text-sm">
        <input type="checkbox" name={`${prefix}adult`} defaultChecked={companion?.adult ?? true} className="size-4 accent-accent" /> Adult, 18 or over
      </label>
      <DocumentFields doc={companion ?? undefined} prefix={prefix} errors={errors} />
      {errors.form && <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">{errors.form}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="solid" size="sm" loading={saving}>
          {companion ? 'Save companion' : 'Add companion'}
        </Button>
        <Button variant="soft" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * Who stays: the lead guest and each companion, with what Immigration still needs from every foreign adult.
 * Check-in refuses until the list is complete, so the desk fixes it here first.
 */
export function StayRegistration({ bookingId, adults }: { bookingId: string; adults?: number }) {
  const { guest } = useServices()
  const data = useResource(`guest.registration:${bookingId}`, () => guest.registration(bookingId), { keepPrevious: false })
  const [open, setOpen] = useState<string | null>(null)
  const [removing, setRemoving] = useState('')
  if (!data.data) return null
  const { booking, companions, people } = data.data
  const done = () => {
    setOpen(null)
    data.reload()
  }
  const registeredAdults = people.filter((p) => p.adult).length

  return (
    <section className="space-y-2 rounded-panel border border-line p-3" aria-labelledby={`reg-${bookingId}`}>
      <div className="flex items-center gap-2">
        <h3 id={`reg-${bookingId}`} className="flex-1 text-sm font-semibold">
          Who stays
        </h3>
        <Button variant="soft" size="sm" onClick={() => setOpen(open === 'new' ? null : 'new')} aria-pressed={open === 'new'}>
          <UserPlus aria-hidden className="size-4" /> Companion
        </Button>
      </div>
      <ul className="space-y-1.5 text-sm">
        {people.map((p) => (
          <li key={p.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted">
                {countryName(p.doc.nationality)}
                {!p.adult && ', child'}
                {p.id === booking.guestId && ', lead guest'}
              </span>
              {p.expired ? <Tag tone="danger">Document expired</Tag> : p.missing.length > 0 ? <Tag tone="warning">Needs {p.missing.length} fields</Tag> : p.foreign && p.adult ? <Tag tone="success">Ready for APOA</Tag> : null}
              <span className="ml-auto flex gap-1">
                {p.id === booking.guestId ? (
                  <Link to={`/guests/${p.id}`} className="text-xs text-accent-text hover:underline">
                    Edit profile
                  </Link>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setOpen(open === p.id ? null : p.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={removing === p.id}
                      onClick={async () => {
                        setRemoving(p.id)
                        await guest.removeCompanion(p.id).finally(() => setRemoving(''))
                        data.reload()
                      }}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </span>
            </div>
            {p.missing.length > 0 && <p className="text-xs text-warning">Missing: {p.missing.join(', ')}</p>}
            {open === p.id && <CompanionForm bookingId={bookingId} companion={companions.find((c) => c.id === p.id) ?? null} onDone={done} />}
          </li>
        ))}
      </ul>
      {adults !== undefined && adults > registeredAdults && <p className="text-xs text-muted">{adults} adults arriving, {registeredAdults} registered. Add each foreign adult for the Immigration report.</p>}
      {open === 'new' && <CompanionForm bookingId={bookingId} companion={null} onDone={done} />}
    </section>
  )
}

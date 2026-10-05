import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import { ID_TYPE_LABEL, type GuestInput, type IdType } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'
import { BookingRows } from '../shared/BookingRows'

export default function GuestPage() {
  const { id = '' } = useParams()
  const { guest } = useServices()
  const toast = useToast()
  const resource = useResource(`guest.detail:${id}`, () => guest.detail(id), { keepPrevious: false })
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input: GuestInput = {
      name: String(f.get('name') ?? ''),
      email: String(f.get('email') ?? ''),
      phone: String(f.get('phone') ?? ''),
      nationality: String(f.get('nationality') ?? ''),
      idType: f.get('idType') as IdType,
      idNumber: String(f.get('idNumber') ?? ''),
      notes: String(f.get('notes') ?? ''),
    }
    setSaving(true)
    setErrors({})
    try {
      const saved = await guest.update(id, input)
      toast({ title: `Updated ${saved.name}` })
      setEditing(false)
      resource.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Gate resource={resource} what="guest" back={{ to: '/guests', label: 'Back to guests' }}>
      {({ guest: g, bookings }) => (
        <>
          <PageBar
            fallback="/guests"
            label="Guests"
            actions={
              <>
                <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                  <Pencil aria-hidden className="size-4" /> Edit profile
                </Button>
                <Link to={`/bookings/new?guest=${g.id}`} className={buttonStyles({ variant: 'accent' })}>
                  <Plus aria-hidden className="size-4" /> New booking
                </Link>
              </>
            }
          />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <Card aria-label={g.name}>
                <div className="flex items-start gap-4">
                  <Avatar name={g.name} size="lg" />
                  <div className="min-w-0 flex-1">
                    <Headline>{g.name}</Headline>
                    <p className="mt-1 text-sm text-muted">
                      {g.nationality} · {ID_TYPE_LABEL[g.idType]} <span className="font-mono">{g.idNumber}</span>
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <a href={`mailto:${g.email}`} className="text-accent-text hover:underline">
                        {g.email}
                      </a>
                      <a href={`tel:${g.phone.replace(/\s/g, '')}`} className="text-accent-text hover:underline">
                        {g.phone}
                      </a>
                    </div>
                  </div>
                </div>
                <FactGrid
                  className="mt-6 grid-cols-2 sm:grid-cols-4"
                  facts={[
                    ['Stays', g.stays],
                    ['Nights', g.nights],
                    ['Spent', money(g.spent)],
                    ['Guest since', shortDay(g.createdOn)],
                  ]}
                />
                {g.notes && <p className="mt-4 rounded-panel bg-info-soft p-3.5 text-sm text-body">{g.notes}</p>}
              </Card>

              {editing && (
                <Card as="div" aria-label="Edit guest">
                  <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Full name" htmlFor="e-name" error={errors.name}>
                      <Input id="e-name" name="name" defaultValue={g.name} />
                    </Field>
                    <Field label="Nationality" htmlFor="e-nat" error={errors.nationality}>
                      <Input id="e-nat" name="nationality" defaultValue={g.nationality} />
                    </Field>
                    <Field label="Email" htmlFor="e-email" error={errors.email}>
                      <Input id="e-email" name="email" type="email" defaultValue={g.email} />
                    </Field>
                    <Field label="Phone" htmlFor="e-phone" error={errors.phone}>
                      <Input id="e-phone" name="phone" defaultValue={g.phone} />
                    </Field>
                    <Field label="ID type" htmlFor="e-idtype">
                      <Select id="e-idtype" name="idType" className="w-full" defaultValue={g.idType} options={(['passport', 'ktp'] as IdType[]).map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} />
                    </Field>
                    <Field label="ID number" htmlFor="e-idno">
                      <Input id="e-idno" name="idNumber" defaultValue={g.idNumber} className="font-mono" />
                    </Field>
                    <Field label="Notes" htmlFor="e-notes" className="sm:col-span-2">
                      <Textarea id="e-notes" name="notes" defaultValue={g.notes} />
                    </Field>
                    {errors.form && <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">{errors.form}</p>}
                    <div className="flex gap-2 sm:col-span-2">
                      <Button type="submit" variant="accent" loading={saving}>
                        Save profile
                      </Button>
                      <Button variant="soft" onClick={() => setEditing(false)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Card>
              )}

              <Card aria-labelledby="history-title">
                <CardHeader id="history-title" title="Stay history" action={<span className="text-xs text-muted">{plural(bookings.length, 'booking')}</span>} />
                <BookingRows bookings={bookings} empty="No stays on file yet." primary={(b) => `${b.unitCode} · ${b.place.villa.name}`} />
              </Card>
            </div>
            <div className="space-y-4">
              <Card aria-labelledby="checkin-title">
                <CardHeader id="checkin-title" title="At check-in" />
                <ul className="space-y-2 text-sm text-body">
                  <li>Match the {ID_TYPE_LABEL[g.idType].toLowerCase()} number against the booking.</li>
                  <li>Confirm the check-out morning and the rate.</li>
                  <li>Record the deposit in the cashbox with the booking linked.</li>
                </ul>
                <Link to="/finance/transactions/new?kind=cash_in" className={buttonStyles({ variant: 'solid', size: 'sm', className: 'mt-4' })}>
                  Record a deposit
                </Link>
              </Card>
            </div>
          </div>
        </>
      )}
    </Gate>
  )
}

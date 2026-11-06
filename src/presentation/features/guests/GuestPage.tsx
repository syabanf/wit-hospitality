import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Ban, Merge, Pencil, Plus } from 'lucide-react'
import { countryName, documentExpired, foreignDataMissing, ID_TYPE_LABEL, isForeign, PREFERENCE_LABEL, SEX_LABEL, VIP_LEVELS, VISA_TYPE_LABEL, vipLabel, type GuestInput, type GuestPreferences, type VipLevel } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { GuestMessagesCard } from '../messages/ConversationCard'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { Tag } from '../../ui/Badge'
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
import { GuestAlerts } from '../shared/GuestAlerts'
import { DocumentFields, readDocument } from './DocumentFields'

const PREFERENCE_KEYS = Object.keys(PREFERENCE_LABEL) as Array<keyof GuestPreferences>

export default function GuestPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { guest, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const resource = useResource(`guest.detail:${id}`, async () => ({ ...(await guest.detail(id)), duplicates: (await guest.duplicates()).filter((d) => d.a.id === id || d.b.id === id) }), { keepPrevious: false })
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [blacklistReason, setBlacklistReason] = useState('')
  const [mergeWith, setMergeWith] = useState(params.get('merge') ?? '')
  const mayApprove = can('guest', 'approve')

  async function run(work: () => Promise<unknown>, done: string) {
    setSaving(true)
    setErrors({})
    try {
      await work()
      toast({ title: done })
      resource.reload()
      return true
    } catch (error) {
      setErrors(fieldErrors(error))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input: GuestInput = {
      ...readDocument(f),
      name: String(f.get('name') ?? ''),
      email: String(f.get('email') ?? ''),
      phone: String(f.get('phone') ?? ''),
      notes: String(f.get('notes') ?? ''),
      vipLevel: Number(f.get('vipLevel')) as VipLevel,
      vipReason: String(f.get('vipReason') ?? ''),
      tags: String(f.get('tags') ?? '').split(','),
      preferences: Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, String(f.get(`pref-${k}`) ?? '').trim()])) as unknown as GuestPreferences,
    }
    if (await run(() => guest.update(id, input), `Updated ${input.name}`)) setEditing(false)
  }

  return (
    <Gate resource={resource} what="guest" back={{ to: '/guests', label: 'Back to guests' }}>
      {({ guest: g, bookings, duplicates }) => {
        const missing = foreignDataMissing(g)
        const expired = isForeign(g) && documentExpired(g, clock.today())
        const others = duplicates.map((d) => (d.a.id === g.id ? d.b : d.a))
        return (
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
                        {countryName(g.nationality)} · {ID_TYPE_LABEL[g.idType]} <span className="font-mono">{g.idNumber || 'no number'}</span>
                        {g.idExpiry && <> · valid to {shortDay(g.idExpiry)}</>}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        <a href={`mailto:${g.email}`} className="text-accent-text hover:underline">
                          {g.email}
                        </a>
                        <a href={`tel:${g.phone.replace(/\s/g, '')}`} className="text-accent-text hover:underline">
                          {g.phone}
                        </a>
                      </div>
                      {g.tags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {g.tags.map((t) => (
                            <Tag key={t} tone="neutral">
                              {t}
                            </Tag>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <GuestAlerts guest={g} className="mt-4" />
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-5"
                    facts={[
                      ['Stays', g.stays],
                      ['Lifetime nights', g.nights],
                      ['Lifetime revenue', money(g.spent)],
                      ['Last stay', g.lastStay ? shortDay(g.lastStay) : 'None yet'],
                      ['Guest since', shortDay(g.createdOn)],
                    ]}
                  />
                  {g.notes && <p className="mt-4 rounded-panel bg-info-soft p-3.5 text-sm whitespace-pre-line text-body">{g.notes}</p>}
                </Card>

                {editing && (
                  <Card as="div" aria-label="Edit guest">
                    <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Full name" htmlFor="e-name" error={errors.name}>
                        <Input id="e-name" name="name" defaultValue={g.name} />
                      </Field>
                      <Field label="Email" htmlFor="e-email" error={errors.email}>
                        <Input id="e-email" name="email" type="email" defaultValue={g.email} />
                      </Field>
                      <Field label="Phone" htmlFor="e-phone" error={errors.phone}>
                        <Input id="e-phone" name="phone" defaultValue={g.phone} />
                      </Field>
                      <Field label="Tags" htmlFor="e-tags" hint="Separate with commas">
                        <Input id="e-tags" name="tags" defaultValue={g.tags.join(', ')} />
                      </Field>
                      <p className="text-xs font-semibold tracking-wider text-muted uppercase sm:col-span-2">Document and entry</p>
                      <DocumentFields doc={g} errors={errors} />
                      <p className="text-xs font-semibold tracking-wider text-muted uppercase sm:col-span-2">Preferences and VIP</p>
                      {PREFERENCE_KEYS.map((k) => (
                        <Field key={k} label={PREFERENCE_LABEL[k]} htmlFor={`e-pref-${k}`}>
                          <Input id={`e-pref-${k}`} name={`pref-${k}`} defaultValue={g.preferences[k]} />
                        </Field>
                      ))}
                      <Field label="VIP level" htmlFor="e-vip">
                        <Select id="e-vip" name="vipLevel" className="w-full" defaultValue={String(g.vipLevel)} options={VIP_LEVELS.map((l) => ({ value: String(l), label: vipLabel(l) }))} />
                      </Field>
                      <Field label="VIP reason" htmlFor="e-vipreason" error={errors.vipReason}>
                        <Input id="e-vipreason" name="vipReason" defaultValue={g.vipReason} />
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
                <GuestMessagesCard guestId={g.id} />
              </div>
              <div className="space-y-4">
                <Card aria-labelledby="immigration-title">
                  <CardHeader id="immigration-title" title="Immigration" />
                  {!isForeign(g) ? (
                    <p className="text-sm text-body">Indonesian guest: the KTP is enough, nothing goes to Immigration.</p>
                  ) : (
                    <>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                        <dt className="text-muted">Born</dt>
                        <dd>{g.birthDate ? `${shortDay(g.birthDate)}${g.birthPlace ? `, ${g.birthPlace}` : ''}` : '-'}</dd>
                        <dt className="text-muted">Sex</dt>
                        <dd>{g.sex ? SEX_LABEL[g.sex] : '-'}</dd>
                        <dt className="text-muted">Visa</dt>
                        <dd>{g.visaType ? VISA_TYPE_LABEL[g.visaType] : '-'}</dd>
                        <dt className="text-muted">Entered</dt>
                        <dd>{g.entryDate ? `${shortDay(g.entryDate)}, ${g.entryPort}` : '-'}</dd>
                      </dl>
                      {missing.length > 0 ? (
                        <p className="mt-3 rounded-panel bg-warning-soft p-3 text-sm text-warning">Check-in needs: {missing.join(', ')}.</p>
                      ) : (
                        <p className="mt-3 text-sm text-success">Ready for check-in and the APOA report.</p>
                      )}
                      {expired && <p className="mt-2 rounded-panel bg-danger-soft p-3 text-sm text-danger">The {ID_TYPE_LABEL[g.idType].toLowerCase()} has expired; check-in is refused until a valid one is on file.</p>}
                      <Link to="/guests/foreign" className={buttonStyles({ variant: 'soft', size: 'sm', className: 'mt-3' })}>
                        Foreign guests report
                      </Link>
                    </>
                  )}
                </Card>

                <Card aria-labelledby="prefs-title">
                  <CardHeader id="prefs-title" title="Preferences" />
                  {PREFERENCE_KEYS.some((k) => g.preferences[k]) ? (
                    <dl className="space-y-2 text-sm">
                      {PREFERENCE_KEYS.filter((k) => g.preferences[k]).map((k) => (
                        <div key={k}>
                          <dt className="text-xs text-muted">{PREFERENCE_LABEL[k]}</dt>
                          <dd>{g.preferences[k]}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-sm text-muted">None recorded. Add them with Edit profile.</p>
                  )}
                </Card>

                <Card aria-labelledby="blacklist-title">
                  <CardHeader id="blacklist-title" title="Blacklist" icon={<Ban aria-hidden className="size-4" />} />
                  {g.blacklist ? (
                    <p className="text-sm text-body">
                      {g.blacklist.reason}
                      <span className="mt-1 block text-xs text-muted">
                        Set by {g.blacklist.setBy} on {shortDay(g.blacklist.setOn)}. New bookings need a manager’s override.
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted">Not blacklisted.</p>
                  )}
                  {mayApprove ? (
                    g.blacklist ? (
                      <Button variant="soft" size="sm" className="mt-3" loading={saving} onClick={() => void run(() => guest.setBlacklist(g.id, null), `${g.name} is off the blacklist`)}>
                        Lift the blacklist
                      </Button>
                    ) : (
                      <form
                        className="mt-3 space-y-2"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void run(() => guest.setBlacklist(g.id, blacklistReason), `Blacklisted ${g.name}`).then((ok) => ok && setBlacklistReason(''))
                        }}
                      >
                        <Field label="Reason" htmlFor="bl-reason" error={errors.form}>
                          <Input id="bl-reason" value={blacklistReason} onChange={(e) => setBlacklistReason(e.target.value)} placeholder="What happened, and when" />
                        </Field>
                        <Button type="submit" variant="solid" size="sm" loading={saving}>
                          Blacklist
                        </Button>
                      </form>
                    )
                  ) : (
                    <p className="mt-2 text-xs text-muted">A villa manager sets or lifts the blacklist.</p>
                  )}
                </Card>

                {(others.length > 0 || mergeWith) && (
                  <Card aria-labelledby="merge-title">
                    <CardHeader id="merge-title" title="Merge a duplicate" icon={<Merge aria-hidden className="size-4" />} />
                    <p className="text-sm text-body">The other profile’s stays, orders, payments, groups and lost items move here; its blank fields fill this one, then it is deleted.</p>
                    <Select aria-label="Profile to merge into this one" className="mt-3 w-full" value={mergeWith} onChange={(e) => setMergeWith(e.target.value)} options={[{ value: '', label: 'Pick the duplicate' }, ...others.map((o) => ({ value: o.id, label: `${o.name} · ${o.email || o.phone}` }))]} />
                    {mayApprove ? (
                      <Button
                        variant="accent"
                        size="sm"
                        className="mt-3"
                        disabled={!mergeWith}
                        loading={saving}
                        onClick={async () => {
                          if (!(await run(() => guest.merge(g.id, mergeWith), `Merged into ${g.name}`))) return
                          setMergeWith('')
                          void navigate(`/guests/${g.id}`, { replace: true })
                        }}
                      >
                        Merge into {g.name}
                      </Button>
                    ) : (
                      <p className="mt-2 text-xs text-muted">A villa manager merges profiles.</p>
                    )}
                  </Card>
                )}
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

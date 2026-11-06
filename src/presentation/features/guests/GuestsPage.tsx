import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Copy, Plus, Search, UserRoundPlus } from 'lucide-react'
import { countryName, ID_TYPE_LABEL, ID_TYPES, searchGuests, vipLabel, type GuestInput, type IdType } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { TableToolbar } from '../../ui/TableToolbar'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { useToast } from '../../ui/useToast'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { withinRange } from '@/lib/dates'
import { CountrySelect } from './DocumentFields'

const KEYS = ['q', 'from', 'to', 'vip', 'nat', 'flag'] as const
type Key = (typeof KEYS)[number]
type Flag = '' | 'returning' | 'blacklisted'
const MATCH_LABEL = { email: 'same email', phone: 'same phone', document: 'same document number' } as const

export default function GuestsPage() {
  const { guest, clock } = useServices()
  const data = useResource('guest.list', async () => ({ ...(await guest.list()), duplicates: await guest.duplicates() }))
  const [params, setParams] = useSearchParams()
  const value = (k: Key) => params.get(k) ?? ''
  const query = value('q')
  const from = value('from') || undefined
  const to = value('to') || undefined
  const toast = useToast()

  function update(next: Partial<Record<Key, string>>) {
    const search = new URLSearchParams(params)
    for (const key of KEYS) {
      const v = key in next ? next[key] : value(key)
      if (v) search.set(key, v)
      else search.delete(key)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }
  const clear = () => update(Object.fromEntries(KEYS.map((k) => [k, ''])))
  const [adding, setAdding] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function add(e: FormEvent<HTMLFormElement>) {
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
      const g = await guest.create(input)
      toast({ title: `Added ${g.name}`, description: 'Fill in the passport and entry details on the profile before check-in.' })
      setAdding(false)
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const all = data.data.guests
  const flag = value('flag') as Flag
  const rows = searchGuests(all, query).filter(
    (g) =>
      ((!from && !to) || (g.lastStay !== null && withinRange(g.lastStay, from, to))) &&
      (!value('vip') || g.vipLevel > 0) &&
      (!value('nat') || g.nationality === value('nat')) &&
      (flag !== 'returning' || g.stays > 1) &&
      (flag !== 'blacklisted' || g.blacklist !== null),
  )
  const nationalities = [...new Set(all.map((g) => g.nationality))].map((c) => ({ value: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label))
  const duplicates = data.data.duplicates

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Everyone who has stayed or is booked to stay. A guest profile is created with the first booking.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="card" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <UserRoundPlus aria-hidden className="size-4" /> New guest
          </Button>
          <Link to="/bookings/new" className={buttonStyles({ variant: 'accent' })}>
            <Plus aria-hidden className="size-4" /> New booking
          </Link>
        </div>
      </div>
      {adding && (
        <Card as="div" aria-label="New guest">
          <form onSubmit={(e) => void add(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="ng-name" error={errors.name}>
              <Input id="ng-name" name="name" />
            </Field>
            <Field label="Nationality" htmlFor="ng-nat" error={errors.nationality}>
              <CountrySelect id="ng-nat" name="nationality" />
            </Field>
            <Field label="Email" htmlFor="ng-email" error={errors.email}>
              <Input id="ng-email" name="email" type="email" />
            </Field>
            <Field label="Phone" htmlFor="ng-phone" error={errors.phone}>
              <Input id="ng-phone" name="phone" placeholder="+62 …" />
            </Field>
            <Field label="Document" htmlFor="ng-idtype">
              <Select id="ng-idtype" name="idType" className="w-full" options={ID_TYPES.map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} />
            </Field>
            <Field label="Document number" htmlFor="ng-idno">
              <Input id="ng-idno" name="idNumber" className="font-mono" />
            </Field>
            <Field label="Notes" htmlFor="ng-notes" className="sm:col-span-2">
              <Textarea id="ng-notes" name="notes" rows={2} />
            </Field>
            {errors.form && <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">{errors.form}</p>}
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" variant="accent" loading={saving}>
                Add guest
              </Button>
              <Button variant="soft" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Guests" value={all.length} onClick={clear} />
        <StatTile label="In house now" value={all.filter((g) => g.inHouse).length} to="/bookings?status=checked_in" />
        <StatTile label="Returning" value={all.filter((g) => g.stays > 1).length} hint="More than one stay" onClick={() => update({ flag: 'returning' })} active={flag === 'returning'} />
        <StatTile label="VIP" value={all.filter((g) => g.vipLevel > 0).length} onClick={() => update({ vip: '1' })} active={!!value('vip')} />
      </div>
      {duplicates.length > 0 && (
        <Card aria-labelledby="dup-title">
          <CardHeader id="dup-title" title="Possible duplicates" icon={<Copy aria-hidden className="size-4" />} action={<span className="text-xs text-muted">{plural(duplicates.length, 'pair')}</span>} />
          <ul className="divide-y divide-line text-sm">
            {duplicates.map((d) => (
              <li key={`${d.a.id}-${d.b.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <Link to={`/guests/${d.a.id}`} className="font-medium hover:underline">
                  {d.a.name}
                </Link>
                <span className="text-muted">and</span>
                <Link to={`/guests/${d.b.id}`} className="font-medium hover:underline">
                  {d.b.name}
                </Link>
                <Tag tone="warning">{MATCH_LABEL[d.match]}</Tag>
                <Link to={`/guests/${d.a.id}?merge=${d.b.id}`} className={buttonStyles({ variant: 'soft', size: 'sm', className: 'ml-auto' })}>
                  Review and merge
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card className="p-0">
        <TableToolbar
          summary={`${rows.length} of ${all.length} guests`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Name, email, phone, nationality or tag" aria-label="Search guests" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Nationality" value={value('nat')} onChange={(e) => update({ nat: e.target.value })} options={[{ value: '', label: 'Every nationality' }, ...nationalities]} />
              <Select aria-label="VIP" value={value('vip')} onChange={(e) => update({ vip: e.target.value })} options={[{ value: '', label: 'VIP or not' }, { value: '1', label: 'VIP only' }]} />
              <Select aria-label="Guest kind" value={flag} onChange={(e) => update({ flag: e.target.value })} options={[{ value: '', label: 'Every guest' }, { value: 'returning', label: 'Returning' }, { value: 'blacklisted', label: 'Blacklisted' }]} />
            </>
          }
          date={<DateRangeFilter today={clock.today()} label="Last stay" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={KEYS.some((k) => !!value(k))}
          onClear={clear}
        />
        <ListTable
          label="Guests"
          rows={rows}
          rowKey={(g) => g.id}
          href={(g) => `/guests/${g.id}`}
          defaultSort={{ key: 'last', dir: 'desc' }}
          exportName="guests"
          exportDate={clock.today()}
          empty={
            <EmptyState title="No guest matches" action={<Button variant="solid" size="sm" onClick={clear}>Clear filters</Button>}>
              Try a part of the name or the email.
            </EmptyState>
          }
          columns={[
            {
              key: 'name',
              header: 'Guest',
              cell: (g) => (
                <span className="flex items-center gap-3">
                  <Avatar name={g.name} size="sm" />
                  {g.name}
                  {g.inHouse && <Tag tone="success">In house</Tag>}
                  {g.vipLevel > 0 && <Tag tone="info">{vipLabel(g.vipLevel)}</Tag>}
                  {g.blacklist && <Tag tone="danger">Blacklisted</Tag>}
                </span>
              ),
              value: (g) => g.name,
            },
            { key: 'nat', header: 'Nationality', cell: (g) => countryName(g.nationality), value: (g) => countryName(g.nationality) },
            { key: 'contact', header: 'Contact', cell: (g) => <span className="text-muted">{g.email}</span>, value: (g) => g.email, hide: 'xl' },
            { key: 'stays', header: 'Stays', align: 'right', cell: (g) => <span className="tabular">{g.stays}</span>, value: (g) => g.stays },
            { key: 'nights', header: 'Nights', align: 'right', cell: (g) => <span className="tabular">{g.nights}</span>, value: (g) => g.nights, hide: 'lg' },
            { key: 'last', header: 'Last stay', cell: (g) => (g.lastStay ? shortDay(g.lastStay) : <span className="text-muted">None yet</span>), value: (g) => g.lastStay ?? '' },
            { key: 'spent', header: 'Revenue', align: 'right', cell: (g) => <span className="font-semibold tabular">{money(g.spent)}</span>, value: (g) => g.spent },
          ]}
          card={(g) => (
            <div className="flex items-center gap-3">
              <Avatar name={g.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {g.name}
                  {g.vipLevel > 0 && <Tag tone="info" className="ml-2">{vipLabel(g.vipLevel)}</Tag>}
                  {g.blacklist && <Tag tone="danger" className="ml-2">Blacklisted</Tag>}
                </p>
                <p className="text-xs text-muted">
                  {countryName(g.nationality)} · {plural(g.stays, 'stay')} · {g.lastStay ? shortDay(g.lastStay) : 'no stay yet'}
                </p>
              </div>
              <span className="text-sm font-semibold tabular">{money(g.spent)}</span>
            </div>
          )}
        />
      </Card>
    </div>
  )
}

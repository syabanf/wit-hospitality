import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Plus, Search, UserRoundPlus } from 'lucide-react'
import { ID_TYPE_LABEL, searchGuests, type GuestInput, type IdType } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
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

export default function GuestsPage() {
  const { guest, clock } = useServices()
  const data = useResource('guest.list', () => guest.list())
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  const toast = useToast()

  function update(next: { q?: string; from?: string; to?: string }) {
    const merged = { q: query, from: from ?? '', to: to ?? '', ...next }
    const search = new URLSearchParams(params)
    for (const key of ['q', 'from', 'to'] as const) {
      if (merged[key]) search.set(key, merged[key])
      else search.delete(key)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }
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
      toast({ title: `Added ${g.name}` })
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
  const rows = searchGuests(all, query).filter((g) => (!from && !to) || (g.lastStay !== null && withinRange(g.lastStay, from, to)))

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
              <Input id="ng-nat" name="nationality" />
            </Field>
            <Field label="Email" htmlFor="ng-email" error={errors.email}>
              <Input id="ng-email" name="email" type="email" />
            </Field>
            <Field label="Phone" htmlFor="ng-phone" error={errors.phone}>
              <Input id="ng-phone" name="phone" placeholder="+62 …" />
            </Field>
            <Field label="ID type" htmlFor="ng-idtype">
              <Select id="ng-idtype" name="idType" className="w-full" options={(['passport', 'ktp'] as IdType[]).map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} />
            </Field>
            <Field label="ID number" htmlFor="ng-idno">
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
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Guests" value={all.length} to="/guests" />
        <StatTile label="In house now" value={all.filter((g) => g.inHouse).length} to="/bookings?status=checked_in" />
        <StatTile label="Returning" value={all.filter((g) => g.stays > 1).length} hint="More than one stay" to="/guests" />
      </div>
      <Card className="p-0">
        <TableToolbar
          summary={`${rows.length} of ${all.length} guests`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Name, email, phone or nationality" aria-label="Search guests" value={query} onChange={(e) => update({ q: e.target.value })} />}
          date={<DateRangeFilter today={clock.today()} label="Last stay" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={!!query || !!from || !!to}
          onClear={() => update({ q: '', from: '', to: '' })}
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
            <EmptyState title="No guest matches" action={<Button variant="solid" size="sm" onClick={() => update({ q: '', from: '', to: '' })}>Clear filters</Button>}>
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
                </span>
              ),
              value: (g) => g.name,
            },
            { key: 'nat', header: 'Nationality', cell: (g) => g.nationality, value: (g) => g.nationality },
            { key: 'contact', header: 'Contact', cell: (g) => <span className="text-muted">{g.email}</span>, value: (g) => g.email, hide: 'xl' },
            { key: 'stays', header: 'Stays', align: 'right', cell: (g) => <span className="tabular">{g.stays}</span>, value: (g) => g.stays },
            { key: 'nights', header: 'Nights', align: 'right', cell: (g) => <span className="tabular">{g.nights}</span>, value: (g) => g.nights, hide: 'lg' },
            { key: 'last', header: 'Last stay', cell: (g) => (g.lastStay ? shortDay(g.lastStay) : <span className="text-muted">None yet</span>), value: (g) => g.lastStay ?? '' },
            { key: 'spent', header: 'Spent', align: 'right', cell: (g) => <span className="font-semibold tabular">{money(g.spent)}</span>, value: (g) => g.spent },
          ]}
          card={(g) => (
            <div className="flex items-center gap-3">
              <Avatar name={g.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{g.name}</p>
                <p className="text-xs text-muted">
                  {g.nationality} · {plural(g.stays, 'stay')} · {g.lastStay ? shortDay(g.lastStay) : 'no stay yet'}
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

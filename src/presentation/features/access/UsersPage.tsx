import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { Pencil, Plus, Search } from 'lucide-react'
import { ROLE_LABEL, ROLES, type Role, type User, type UserInput, type UserStatus } from '@/domain/access'
import type { Employee } from '@/domain/hr'
import type { Catalog } from '@/domain/property'
import { shortDay } from '@/lib/dates'
import { seriesColor } from '../../charts/colors'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { DonutLegend } from '../reports/DonutLegend'

interface UserFormProps {
  initial?: User
  catalog: Catalog
  employees: readonly Employee[]
  save: (input: UserInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

function UserForm({ initial, catalog, employees, save, onDone, onCancel }: UserFormProps) {
  const [locationIds, setLocationIds] = useState<string[]>([...(initial?.locationIds ?? [])])
  const [villaIds, setVillaIds] = useState<string[]>([...(initial?.villaIds ?? [])])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({
        name: String(f.get('name') ?? ''),
        email: String(f.get('email') ?? '').trim(),
        role: f.get('role') as Role,
        status: f.get('status') as UserStatus,
        locationIds,
        villaIds,
        employeeId: String(f.get('employeeId') ?? '') || null,
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.name}` : 'New login'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.name}` : 'New login'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="u-name" error={errors.name}>
            <Input id="u-name" name="name" defaultValue={initial?.name} placeholder="Full name" />
          </Field>
          <Field label="Email" htmlFor="u-email" error={errors.email}>
            <Input id="u-email" name="email" type="email" defaultValue={initial?.email} placeholder="name@balivillas.id" />
          </Field>
          <Field label="Role" htmlFor="u-role" error={errors.role}>
            <Select id="u-role" name="role" className="w-full" defaultValue={initial?.role ?? 'staff'} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          </Field>
          <Field label="Status" htmlFor="u-status">
            <Select id="u-status" name="status" className="w-full" defaultValue={initial?.status ?? 'active'} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
          </Field>
          <Field label="Linked employee" htmlFor="u-emp" hint="Gives the login an employee area with its own attendance, payslips and requests" className="sm:col-span-2">
            <Select id="u-emp" name="employeeId" className="w-full" defaultValue={initial?.employeeId ?? ''} options={[{ value: '', label: 'Not an employee' }, ...employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))]} />
          </Field>
          <Field label="Locations" hint="Leave empty for every location" className="sm:col-span-2">
            <CheckboxGrid name="locationIds" options={catalog.locations.map((l) => ({ id: l.id, label: l.name }))} selected={locationIds} onChange={setLocationIds} />
          </Field>
          <Field label="Villas" hint="Narrows further than the locations; leave empty for every villa inside them" className="sm:col-span-2">
            <CheckboxGrid name="villaIds" options={catalog.villas.map((v) => ({ id: v.id, label: v.name }))} selected={villaIds} onChange={setVillaIds} />
          </Field>
        </div>
        {errors.form && (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.form}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save login' : 'Add login'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** Every login with its role and villa scope; add, edit and deactivate in place. */
export default function UsersPage() {
  const { access } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('access.users', () => access.users())
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<string | null | 'new'>(null)
  const query = params.get('q') ?? ''
  const role = params.get('role') ?? ''
  const status = params.get('status') ?? ''

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }
  function done(title: string, description?: string) {
    toast({ title, description })
    setEditing(null)
    data.reload()
  }
  async function toggle(u: User, active: boolean) {
    try {
      await access.setUserActive(u.id, active)
      toast({ title: active ? `Activated ${u.name}` : `Deactivated ${u.name}`, description: active ? 'They can sign in again.' : 'History stays; the login no longer works.' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not change ${u.name}`, description: error instanceof Error ? error.message : undefined })
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const q = query.trim().toLowerCase()
  const rows = d.users.filter((u) => (!role || u.role === role) && (!status || u.status === status) && (!q || [u.name, u.email, u.scope].some((v) => v.toLowerCase().includes(q))))
  const current = editing && editing !== 'new' ? d.users.find((u) => u.id === editing) : undefined
  const editable = can('access', 'edit')
  const byRole = ROLES.map((r, i) => ({ id: r, label: ROLE_LABEL[r], value: d.users.filter((u) => u.role === r && (!status || u.status === status)).length, color: seriesColor((i % 5) + 1) })).filter((s) => s.value > 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Who can sign in, as which role, and which locations or villas they see. Deactivate a login instead of deleting it so its history stays.</p>
        {can('access', 'create') && (
          <Button variant="accent" aria-pressed={editing === 'new'} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            <Plus aria-hidden className="size-4" /> Login
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 stagger xl:grid-cols-4">
        <StatTile label="Logins" value={d.users.length} hint={`${d.users.filter((u) => u.status === 'active').length} active`} active={!status} onClick={() => update({ status: '' })} />
        <StatTile label="Inactive" value={d.users.filter((u) => u.status === 'inactive').length} hint="Kept for history" active={status === 'inactive'} onClick={() => update({ status: status === 'inactive' ? '' : 'inactive' })} />
        <StatTile label="Restricted to villas" value={d.users.filter((u) => u.villaIds.length > 0 || u.locationIds.length > 0).length} hint="See part of the portfolio" />
        <StatTile label="Signed in today" value={d.users.filter((u) => u.lastLoginOn === d.today).length} hint={shortDay(d.today)} />
      </div>
      <Card aria-labelledby="by-role-title">
        <CardHeader id="by-role-title" title="Logins by role" action={role && <Button size="sm" variant="soft" onClick={() => update({ role: '' })}>All roles</Button>} />
        <DonutLegend label="Logins by role" size={150} format={String} slices={byRole} picked={role || null} onPick={(id) => update({ role: role === id ? '' : id })} centre={<p className="text-[22px] leading-none font-medium tracking-tight tabular">{d.users.length}</p>} />
      </Card>
      {(editing === 'new' || current) && (
        <UserForm
          initial={current}
          catalog={d.catalog}
          employees={d.employees}
          save={(input) => (current ? access.updateUser(current.id, input) : access.createUser(input))}
          onDone={() => done(current ? `Saved ${current.name}` : 'Added the login', current ? undefined : 'The first password is welcome123; ask them to change it in Settings.')}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card className="p-0" aria-label="Users">
        <TableToolbar
          summary={`${rows.length} of ${d.users.length} logins`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Name, email or scope" aria-label="Search users" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Role" value={role} options={[{ value: '', label: 'All roles' }, ...ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))]} onChange={(e) => update({ role: e.target.value })} />
              <Select aria-label="Status" value={status} options={[{ value: '', label: 'Active and inactive' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} onChange={(e) => update({ status: e.target.value })} />
            </>
          }
          active={!!query || !!role || !!status}
          onClear={() => setParams({}, { replace: true })}
        />
        <ListTable
          label="Users"
          rows={rows}
          rowKey={(u) => u.id}
          href={() => '/access/users'}
          defaultSort={{ key: 'name', dir: 'asc' }}
          exportName="users"
          exportDate={d.today}
          empty={<EmptyState title="No login matches" />}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (u) => (
                <span className="flex items-center gap-2">
                  <Avatar name={u.name} size="sm" />
                  <span className="min-w-0 truncate">{u.name}</span>
                </span>
              ),
              value: (u) => u.name,
            },
            { key: 'email', header: 'Email', cell: (u) => <span className="text-muted">{u.email}</span>, value: (u) => u.email, hide: 'lg' },
            { key: 'role', header: 'Role', cell: (u) => <Tag tone={u.role === 'owner' || u.role === 'admin' ? 'accent' : 'info'}>{ROLE_LABEL[u.role]}</Tag>, value: (u) => ROLE_LABEL[u.role] },
            { key: 'scope', header: 'Sees', cell: (u) => <span className="line-clamp-1">{u.scope}</span>, value: (u) => u.scope, hide: 'lg' },
            { key: 'employee', header: 'Employee', cell: (u) => (u.employee ? <span className="font-mono text-xs">{u.employee.code}</span> : <span className="text-muted">None</span>), value: (u) => u.employee?.code ?? '', hide: 'xl' },
            { key: 'login', header: 'Last sign-in', cell: (u) => (u.lastLoginOn ? shortDay(u.lastLoginOn) : 'Never'), value: (u) => u.lastLoginOn ?? '', hide: 'xl' },
            { key: 'status', header: 'Status', cell: (u) => <StatusPill tone={u.status === 'active' ? 'success' : 'neutral'}>{u.status === 'active' ? 'Active' : 'Inactive'}</StatusPill>, value: (u) => u.status },
            {
              key: 'actions',
              header: '',
              align: 'right',
              cell: (u) => (
                <span className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  <Switch label={`${u.name} active`} checked={u.status === 'active'} disabled={!editable} onChange={(on) => void toggle(u, on)} />
                  {editable && (
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${u.name}`} aria-pressed={editing === u.id} onClick={() => setEditing(editing === u.id ? null : u.id)}>
                      <Pencil aria-hidden className="size-4" />
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
          card={(u) => (
            <div className="flex items-center gap-3">
              <Avatar name={u.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{u.name}</p>
                <p className="truncate text-xs text-muted">
                  {ROLE_LABEL[u.role]} · {u.scope}
                </p>
              </div>
              <StatusPill tone={u.status === 'active' ? 'success' : 'neutral'}>{u.status === 'active' ? 'Active' : 'Inactive'}</StatusPill>
            </div>
          )}
        />
      </Card>
    </div>
  )
}

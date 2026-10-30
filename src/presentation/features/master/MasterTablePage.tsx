import { useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react'
import { ROLE_LABEL } from '@/domain/access'
import { LISTING_STATUS_LABEL, type AirbnbAccount, type Listing } from '@/domain/airbnb'
import type { ApprovalRule } from '@/domain/approval'
import { isSystemCategory, KIND_LABEL, type CashAccount, type Category } from '@/domain/finance'
import type { Shift } from '@/domain/hr'
import { facilityLabel, UNIT_STATUS_LABEL, type Location, type Unit, type UnitGroup, type Villa } from '@/domain/property'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { ListTable, type Column } from '../../ui/ListTable'
import { Popover } from '../../ui/Popover'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { AirbnbAccountForm, ListingForm } from '../airbnb/forms'
import { AccountForm } from '../finance/AccountForm'
import { CategoryForm } from '../finance/CategoryForm'
import { GroupForm, LocationForm, UnitForm, VillaForm } from '../property/forms'
import { masterPageFor, type MasterKind } from './pages'
import { RuleForm } from './RuleForm'

type Tab = MasterKind

/** One reference table with add and edit in place; the route decides which one. */
export default function MasterTablePage() {
  const { master, property, airbnb, finance } = useServices()
  const toast = useToast()
  const data = useResource('master.all', () => master.all())
  const [params, setParams] = useSearchParams()
  const { pathname } = useLocation()
  const page = masterPageFor(pathname)
  const tab: Tab = page?.kind ?? 'locations'
  const [editing, setEditing] = useState<{ tab: Tab; id: string | null } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  function done(title: string) {
    toast({ title })
    setEditing(null)
    data.reload()
  }
  const opening = (t: Tab, id: string | null = null) => editing?.tab === t && editing.id === id
  const addButton = (t: Tab, label: string) => (
    <Button variant="accent" aria-pressed={opening(t)} onClick={() => setEditing(opening(t) ? null : { tab: t, id: null })}>
      <Plus aria-hidden className="size-4" /> {label}
    </Button>
  )
  const editCell = (t: Tab, id: string, label: string) => (
    <span onClick={(e) => e.stopPropagation()}>
      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${label}`} aria-pressed={opening(t, id)} onClick={() => setEditing(opening(t, id) ? null : { tab: t, id })}>
        <Pencil aria-hidden className="size-4" />
      </Button>
    </span>
  )

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const cat = d.catalog
  const current = editing?.id ?? null

  function table<T>(rows: readonly T[], rowKey: (r: T) => string, href: (r: T) => string, columns: Column<T>[], card: (r: T) => ReactNode, label: string) {
    return <ListTable label={label} rows={rows} rowKey={rowKey} href={href} columns={columns} card={card} exportName={label.toLowerCase()} exportDate={d.today} empty={<EmptyState title={`No ${label.toLowerCase()} yet`} />} />
  }
  const nameCard = (title: string, sub: string) => (
    <div className="min-w-0">
      <p className="truncate font-medium">{title}</p>
      <p className="truncate text-xs text-muted">{sub}</p>
    </div>
  )

  let panel: ReactNode = null
  let form: ReactNode = null
  let action: ReactNode = null

  if (tab === 'locations') {
    const row = cat.locations.find((l) => l.id === current)
    action = addButton('locations', 'Location')
    if (opening('locations') || row) form = <LocationForm initial={row} save={(i) => (row ? property.updateLocation(row.id, i) : property.createLocation(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Added the location')} onCancel={() => setEditing(null)} />
    panel = table<Location>(
      cat.locations,
      (l) => l.id,
      (l) => `/property?location=${l.id}`,
      [
        { key: 'name', header: 'Location', cell: (l) => l.name, value: (l) => l.name },
        { key: 'area', header: 'Area', cell: (l) => l.area, value: (l) => l.area },
        { key: 'villas', header: 'Villas', align: 'right', cell: (l) => cat.villas.filter((v) => v.locationId === l.id).length, value: (l) => cat.villas.filter((v) => v.locationId === l.id).length },
        { key: 'units', header: 'Units', align: 'right', cell: (l) => cat.units.filter((u) => cat.villa(u.villaId).locationId === l.id).length, value: (l) => cat.units.filter((u) => cat.villa(u.villaId).locationId === l.id).length },
        { key: 'edit', header: '', align: 'right', cell: (l) => editCell('locations', l.id, l.name) },
      ],
      (l) => nameCard(l.name, l.area),
      'Locations',
    )
  }

  if (tab === 'villas') {
    const row = cat.villas.find((v) => v.id === current)
    action = (
      <>
        {addButton('villas', 'Villa')}
        <Link to="/property/new" className={buttonStyles({ variant: 'card' })}>
          <Wand2 aria-hidden className="size-4" /> Wizard
        </Link>
      </>
    )
    if (opening('villas') || row) form = <VillaForm initial={row} catalog={cat} save={(i) => (row ? property.updateVilla(row.id, i) : property.createVilla(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Added the villa')} onCancel={() => setEditing(null)} />
    panel = table<Villa>(
      cat.villas,
      (v) => v.id,
      (v) => `/property/villas/${v.id}`,
      [
        { key: 'code', header: 'Code', cell: (v) => <span className="font-mono">{v.code}</span>, value: (v) => v.code },
        { key: 'name', header: 'Villa', cell: (v) => v.name, value: (v) => v.name },
        { key: 'loc', header: 'Location', cell: (v) => cat.location(v.locationId).name, value: (v) => cat.location(v.locationId).name },
        { key: 'units', header: 'Units', align: 'right', cell: (v) => cat.units.filter((u) => u.villaId === v.id).length, value: (v) => cat.units.filter((u) => u.villaId === v.id).length },
        { key: 'fac', header: 'Facilities', cell: (v) => <span className="line-clamp-1 text-muted">{v.facilities.map(facilityLabel).join(', ') || 'None'}</span>, value: (v) => v.facilities.length, hide: 'lg' },
        { key: 'edit', header: '', align: 'right', cell: (v) => editCell('villas', v.id, v.name) },
      ],
      (v) => nameCard(`${v.code} · ${v.name}`, cat.location(v.locationId).name),
      'Villas',
    )
  }

  if (tab === 'groups') {
    const row = cat.groups.find((g) => g.id === current)
    const [villaId, setVillaId] = [params.get('villa') ?? cat.villas[0]?.id ?? '', (id: string) => setParams({ villa: id }, { replace: true })]
    action = (
      <>
        <Select aria-label="Villa for a new type" tone="card" value={villaId} options={cat.villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => setVillaId(e.target.value)} />
        {addButton('groups', 'Room type')}
      </>
    )
    if (opening('groups') || row) form = <GroupForm initial={row} villaId={row?.villaId ?? villaId} save={(i) => (row ? property.updateGroup(row.id, i) : property.createGroup(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Added the room type')} onCancel={() => setEditing(null)} />
    panel = table<UnitGroup>(
      cat.groups,
      (g) => g.id,
      (g) => `/property/villas/${g.villaId}`,
      [
        { key: 'name', header: 'Room type', cell: (g) => g.name, value: (g) => g.name },
        { key: 'villa', header: 'Villa', cell: (g) => cat.villa(g.villaId).name, value: (g) => cat.villa(g.villaId).name },
        { key: 'units', header: 'Units', cell: (g) => cat.units.filter((u) => u.groupId === g.id).map((u) => u.code).join(' · ') || 'None', value: (g) => cat.units.filter((u) => u.groupId === g.id).length },
        { key: 'swap', header: 'Interchangeable', cell: (g) => <Tag tone={g.interchangeable ? 'info' : 'neutral'}>{g.interchangeable ? 'Yes' : 'Fixed'}</Tag>, value: (g) => (g.interchangeable ? 1 : 0) },
        { key: 'edit', header: '', align: 'right', cell: (g) => editCell('groups', g.id, g.name) },
      ],
      (g) => nameCard(g.name, cat.villa(g.villaId).name),
      'Room types',
    )
  }

  if (tab === 'units') {
    const row = cat.units.find((u) => u.id === current)
    const villaId = params.get('villa') ?? row?.villaId ?? cat.villas[0]?.id ?? ''
    const villa = cat.villas.find((v) => v.id === villaId) ?? cat.villas[0]
    action = (
      <>
        <Select aria-label="Villa for a new unit" tone="card" value={villaId} options={cat.villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => setParams({ villa: e.target.value }, { replace: true })} />
        {addButton('units', 'Unit')}
      </>
    )
    if ((opening('units') || row) && villa) {
      const target = row ? cat.villa(row.villaId) : villa
      form = <UnitForm initial={row} villa={target} groups={cat.groups.filter((g) => g.villaId === target.id)} save={(i) => (row ? property.updateUnit(row.id, i) : property.createUnit(i))} onDone={() => done(row ? `Saved ${row.code}` : 'Added the unit')} onCancel={() => setEditing(null)} />
    }
    panel = table<Unit>(
      cat.units,
      (u) => u.id,
      (u) => `/property/units/${u.id}`,
      [
        { key: 'code', header: 'Unit', cell: (u) => <span className="font-mono">{u.code}</span>, value: (u) => u.code },
        { key: 'name', header: 'Name', cell: (u) => u.name, value: (u) => u.name },
        { key: 'villa', header: 'Villa', cell: (u) => cat.villa(u.villaId).name, value: (u) => cat.villa(u.villaId).name, hide: 'lg' },
        { key: 'group', header: 'Room type', cell: (u) => (u.groupId ? cat.group(u.groupId).name : 'None'), value: (u) => (u.groupId ? cat.group(u.groupId).name : ''), hide: 'lg' },
        { key: 'beds', header: 'Beds', align: 'right', cell: (u) => u.bedrooms, value: (u) => u.bedrooms, hide: 'xl' },
        { key: 'rate', header: 'Rate', align: 'right', cell: (u) => <span className="tabular">{money(u.nightlyRate)}</span>, value: (u) => u.nightlyRate },
        { key: 'status', header: 'Status', cell: (u) => <StatusPill tone={u.status === 'active' ? 'success' : u.status === 'maintenance' ? 'warning' : 'neutral'}>{UNIT_STATUS_LABEL[u.status]}</StatusPill>, value: (u) => UNIT_STATUS_LABEL[u.status] },
        { key: 'edit', header: '', align: 'right', cell: (u) => editCell('units', u.id, u.code) },
      ],
      (u) => nameCard(`${u.code} · ${u.name}`, `${cat.villa(u.villaId).name} · ${money(u.nightlyRate)}`),
      'Units',
    )
  }

  if (tab === 'airbnb') {
    const row = d.accounts.find((a) => a.id === current)
    action = addButton('airbnb', 'Account')
    if (opening('airbnb') || row) form = <AirbnbAccountForm initial={row} save={(i) => (row ? airbnb.updateAccount(row.id, i) : airbnb.createAccount(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Added the account')} onCancel={() => setEditing(null)} />
    panel = table<AirbnbAccount>(
      d.accounts,
      (a) => a.id,
      (a) => `/airbnb/accounts/${a.id}`,
      [
        { key: 'name', header: 'Account', cell: (a) => a.name, value: (a) => a.name },
        { key: 'email', header: 'Email', cell: (a) => <span className="text-muted">{a.email}</span>, value: (a) => a.email },
        { key: 'listings', header: 'Listings', align: 'right', cell: (a) => d.listings.filter((l) => l.accountId === a.id).length, value: (a) => d.listings.filter((l) => l.accountId === a.id).length },
        { key: 'status', header: 'Status', cell: (a) => <Tag tone={a.status === 'active' ? 'success' : 'neutral'}>{a.status === 'active' ? 'Active' : 'Paused'}</Tag>, value: (a) => a.status },
        { key: 'edit', header: '', align: 'right', cell: (a) => editCell('airbnb', a.id, a.name) },
      ],
      (a) => nameCard(a.name, a.email),
      'Airbnb accounts',
    )
  }

  if (tab === 'listings') {
    const row = d.listings.find((l) => l.id === current)
    action = addButton('listings', 'Listing')
    if (opening('listings') || row) form = <ListingForm initial={row} catalog={cat} accounts={d.accounts} listings={d.listings} save={(i) => (row ? airbnb.updateListing(row.id, i) : airbnb.createListing(i))} onDone={() => done(row ? 'Saved the listing' : 'Added the listing')} onCancel={() => setEditing(null)} />
    panel = table<Listing>(
      d.listings,
      (l) => l.id,
      (l) => `/property/units/${l.unitId}`,
      [
        { key: 'unit', header: 'Unit', cell: (l) => <span className="font-mono">{cat.unit(l.unitId).code}</span>, value: (l) => cat.unit(l.unitId).code },
        { key: 'title', header: 'Listing', cell: (l) => <span className="line-clamp-1">{l.title}</span>, value: (l) => l.title },
        { key: 'acc', header: 'Account', cell: (l) => d.accounts.find((a) => a.id === l.accountId)?.name, value: (l) => d.accounts.find((a) => a.id === l.accountId)?.name ?? '', hide: 'lg' },
        { key: 'id', header: 'Airbnb id', cell: (l) => <span className="font-mono text-xs">{l.airbnbId}</span>, value: (l) => l.airbnbId, hide: 'xl' },
        { key: 'status', header: 'Status', cell: (l) => <StatusPill tone={l.status === 'active' ? 'success' : 'neutral'}>{LISTING_STATUS_LABEL[l.status]}</StatusPill>, value: (l) => l.status },
        { key: 'edit', header: '', align: 'right', cell: (l) => editCell('listings', l.id, cat.unit(l.unitId).code) },
      ],
      (l) => nameCard(`${cat.unit(l.unitId).code} · ${l.title}`, d.accounts.find((a) => a.id === l.accountId)?.name ?? ''),
      'Listings',
    )
  }

  if (tab === 'cash') {
    const row = d.cashAccounts.find((a) => a.id === current)
    action = addButton('cash', 'Account')
    if (opening('cash') || row) form = <AccountForm initial={row} locations={cat.locations} today={d.today} save={(i) => (row ? finance.updateAccount(row.id, i) : finance.createAccount(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Opened the account')} onCancel={() => setEditing(null)} />
    panel = table<CashAccount>(
      d.cashAccounts,
      (a) => a.id,
      (a) => `/finance/accounts/${a.id}`,
      [
        { key: 'name', header: 'Account', cell: (a) => a.name, value: (a) => a.name },
        { key: 'kind', header: 'Kind', cell: (a) => <Tag tone={a.kind === 'bank' ? 'info' : 'neutral'}>{a.kind === 'bank' ? 'Bank' : 'Cashbox'}</Tag>, value: (a) => a.kind },
        { key: 'loc', header: 'Location', cell: (a) => (a.locationId ? cat.location(a.locationId).name : 'All locations'), value: (a) => (a.locationId ? cat.location(a.locationId).name : '') },
        { key: 'open', header: 'Opening balance', align: 'right', cell: (a) => <span className="tabular">{money(a.openingBalance)}</span>, value: (a) => a.openingBalance },
        { key: 'edit', header: '', align: 'right', cell: (a) => editCell('cash', a.id, a.name) },
      ],
      (a) => nameCard(a.name, a.locationId ? cat.location(a.locationId).name : 'All locations'),
      'Cash accounts',
    )
  }

  if (tab === 'categories') {
    const row = d.categories.find((c) => c.id === current)
    action = addButton('categories', 'Category')
    if (opening('categories') || row) form = <CategoryForm initial={row} villas={cat.villas} save={(i) => (row ? finance.updateCategory(row.id, i) : finance.createCategory(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Added the category')} onCancel={() => setEditing(null)} />
    const scopeText = (c: Category) => (c.villaIds.length === 0 ? 'Every villa' : c.villaIds.map((id) => cat.villas.find((v) => v.id === id)?.name ?? id).join(', '))
    panel = table<Category>(
      d.categories,
      (c) => c.id,
      (c) => `/finance/transactions?category=${c.id}`,
      [
        { key: 'name', header: 'Category', cell: (c) => <span className={c.active ? undefined : 'text-muted'}>{c.name}</span>, value: (c) => c.name },
        { key: 'kind', header: 'Kind', cell: (c) => KIND_LABEL[c.kind], value: (c) => KIND_LABEL[c.kind] },
        { key: 'villas', header: 'Enabled for', cell: (c) => <span className="line-clamp-1 text-muted">{scopeText(c)}</span>, value: (c) => scopeText(c), hide: 'lg' },
        { key: 'slot', header: 'Chart colour', cell: (c) => (c.slot ? `Slot ${c.slot}` : 'Other'), value: (c) => c.slot, hide: 'xl' },
        {
          key: 'active',
          header: 'Active',
          align: 'right',
          cell: (c) => (
            <span onClick={(e) => e.stopPropagation()} title={isSystemCategory(c.id) ? 'System category: always active' : undefined}>
              <Switch label={`${c.name} active`} checked={c.active} disabled={isSystemCategory(c.id)} onChange={(on) => void finance.setCategoryActive(c.id, on).then(() => done(on ? `Restored ${c.name}` : `Archived ${c.name}`))} />
            </span>
          ),
        },
        { key: 'edit', header: '', align: 'right', cell: (c) => editCell('categories', c.id, c.name) },
      ],
      (c) => nameCard(c.name, `${KIND_LABEL[c.kind]} · ${scopeText(c)}`),
      'Categories',
    )
  }

  if (tab === 'rules') {
    const row = d.rules.find((r) => r.id === current)
    action = addButton('rules', 'Rule')
    if (opening('rules') || row) form = <RuleForm initial={row} villas={cat.villas} save={(i) => (row ? finance.updateRule(row.id, i) : finance.createRule(i))} onDone={() => done(row ? `Saved ${row.name}` : 'Added the rule')} onCancel={() => setEditing(null)} />
    const villaName = (r: ApprovalRule) => (r.villaId ? (cat.villas.find((v) => v.id === r.villaId)?.name ?? r.villaId) : 'Every villa')
    const chain = (r: ApprovalRule) => r.levels.map((l) => ROLE_LABEL[l]).join(' › ')
    panel = table<ApprovalRule>(
      d.rules,
      (r) => r.id,
      () => '/approvals',
      [
        { key: 'name', header: 'Rule', cell: (r) => <span className={r.active ? undefined : 'text-muted'}>{r.name}</span>, value: (r) => r.name },
        { key: 'kind', header: 'Applies to', cell: (r) => (r.kind === 'all' ? 'In and out' : KIND_LABEL[r.kind]), value: (r) => r.kind },
        { key: 'villa', header: 'Villa', cell: villaName, value: villaName, hide: 'lg' },
        { key: 'min', header: 'From amount', align: 'right', cell: (r) => <span className="tabular">{money(r.minAmount)}</span>, value: (r) => r.minAmount },
        { key: 'chain', header: 'Chain', cell: (r) => <span className="line-clamp-1">{chain(r)}</span>, value: (r) => r.levels.length },
        { key: 'active', header: 'Active', cell: (r) => <Tag tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Off'}</Tag>, value: (r) => (r.active ? 1 : 0) },
        {
          key: 'edit',
          header: '',
          align: 'right',
          cell: (r) => (
            <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {editCell('rules', r.id, r.name)}
              <Popover
                align="right"
                className="w-64 p-4"
                trigger={(props) => (
                  <Button {...props} size="icon-sm" variant="ghost" aria-label={`Delete ${r.name}`}>
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                )}
              >
                {(close) => (
                  <div className="space-y-3">
                    <p className="text-sm">Remove {r.name}? Entries already in flight keep their chain.</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="accent" loading={deleting === r.id} onClick={() => { setDeleting(r.id); void finance.deleteRule(r.id).then(() => { close(); done(`Removed ${r.name}`) }).finally(() => setDeleting(null)) }}>
                        Delete
                      </Button>
                      <Button size="sm" variant="soft" onClick={close}>
                        Keep
                      </Button>
                    </div>
                  </div>
                )}
              </Popover>
            </span>
          ),
        },
      ],
      (r) => nameCard(r.name, `${villaName(r)} · from ${money(r.minAmount)} · ${chain(r)}`),
      'Approval rules',
    )
  }

  if (tab === 'shifts') {
    action = (
      <Link to="/hr/roster" className={buttonStyles({ variant: 'card' })}>
        Open the roster
      </Link>
    )
    panel = table<Shift>(
      d.shifts,
      (sh) => sh.id,
      () => '/hr/roster',
      [
        { key: 'name', header: 'Shift', cell: (sh) => sh.name, value: (sh) => sh.name },
        { key: 'start', header: 'Starts', cell: (sh) => <span className="font-mono">{sh.start}</span>, value: (sh) => sh.start },
        { key: 'end', header: 'Ends', cell: (sh) => <span className="font-mono">{sh.end}</span>, value: (sh) => sh.end },
      ],
      (sh) => nameCard(sh.name, `${sh.start} to ${sh.end}`),
      'Shifts',
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">
          {page?.blurb ?? 'Reference data'}. Rows open the record; the pencil edits it here.{' '}
          <Link to="/master" className="text-accent-text hover:underline">
            All master data
          </Link>
        </p>
        <div className="flex flex-wrap gap-2">{action}</div>
      </div>
      {form}
      <Card className="p-0" aria-label={page?.label ?? 'Master data'}>
        {panel}
      </Card>
      <p className="text-xs text-muted">{plural(cat.units.length, 'unit')} in {plural(cat.villas.length, 'villa')} across {plural(cat.locations.length, 'location')}.</p>
    </div>
  )
}

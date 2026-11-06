import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Pencil, Plus, QrCode } from 'lucide-react'
import type { MenuItemView } from '@/application/views'
import type { Attachment } from '@/domain/attachment'
import { hoursLabel, leadLabel, MENU_CATEGORIES, MENU_CATEGORY_LABEL, PARTNER_KIND_LABEL, PARTNER_KINDS, PRICE_UNIT_LABEL, PRICE_UNITS, type MenuCategory, type MenuItemInput, type PartnerInput, type PartnerKind, type PriceUnit, type ServicePartner } from '@/domain/serviceOrder'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'
import { toClock, toMinutes } from './clock'

const blankItem = (villaId: string): MenuItemInput => ({ villaId, category: 'food', name: '', description: '', photo: null, price: 0, unit: 'item', availableFrom: 8 * 60, availableTo: 22 * 60, leadMinutes: 30, active: true, partnerId: null, costPrice: 0 })

function ItemForm({ initial, id, villas, partners, onSaved, onCancel }: { initial: MenuItemInput; id: string | null; villas: ReadonlyArray<{ id: string; name: string }>; partners: readonly ServicePartner[]; onSaved: () => void; onCancel: () => void }) {
  const { orders } = useServices()
  const toast = useToast()
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = <K extends keyof MenuItemInput>(key: K, value: MenuItemInput[K]) => setForm((f) => ({ ...f, [key]: value }))

  async function save() {
    setBusy(true)
    setErrors({})
    try {
      const saved = await orders.saveItem(id, form)
      toast({ title: id ? `Saved ${saved.name}` : `Added ${saved.name}`, description: `${money(saved.price)} ${PRICE_UNIT_LABEL[saved.unit]}` })
      onSaved()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the item', description: Object.values(e)[0] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Villa" htmlFor="mi-villa" error={errors.villaId}>
        <Select id="mi-villa" value={form.villaId} options={villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => set('villaId', e.target.value)} />
      </Field>
      <Field label="Category" htmlFor="mi-cat" error={errors.category}>
        <Select id="mi-cat" value={form.category} options={MENU_CATEGORIES.map((c) => ({ value: c, label: MENU_CATEGORY_LABEL[c] }))} onChange={(e) => set('category', e.target.value as MenuCategory)} />
      </Field>
      <Field label="Name" htmlFor="mi-name" error={errors.name} className="sm:col-span-2">
        <Input id="mi-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Description" htmlFor="mi-desc" className="sm:col-span-2 lg:col-span-4">
        <Textarea id="mi-desc" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="Price" htmlFor="mi-price" error={errors.price}>
        <Input id="mi-price" type="number" min={0} step={1000} inputMode="numeric" value={form.price || ''} onChange={(e) => set('price', Number(e.target.value) || 0)} />
      </Field>
      <Field label="Priced" htmlFor="mi-unit" error={errors.unit}>
        <Select id="mi-unit" value={form.unit} options={PRICE_UNITS.map((u) => ({ value: u, label: PRICE_UNIT_LABEL[u] }))} onChange={(e) => set('unit', e.target.value as PriceUnit)} />
      </Field>
      <Field label="Served from" htmlFor="mi-from" error={errors.availableFrom}>
        <Input id="mi-from" type="time" value={toClock(form.availableFrom)} onChange={(e) => set('availableFrom', toMinutes(e.target.value))} />
      </Field>
      <Field label="Until" htmlFor="mi-to" error={errors.availableTo}>
        <Input id="mi-to" type="time" value={toClock(form.availableTo)} onChange={(e) => set('availableTo', toMinutes(e.target.value))} />
      </Field>
      <Field label="Notice, minutes" htmlFor="mi-lead" error={errors.leadMinutes}>
        <Input id="mi-lead" type="number" min={0} step={15} inputMode="numeric" value={form.leadMinutes} onChange={(e) => set('leadMinutes', Number(e.target.value) || 0)} />
      </Field>
      <Field label="Delivered by" htmlFor="mi-partner" error={errors.partnerId}>
        <Select id="mi-partner" value={form.partnerId ?? ''} options={[{ value: '', label: 'Our own team' }, ...partners.map((p) => ({ value: p.id, label: p.name }))]} onChange={(e) => set('partnerId', e.target.value || null)} />
      </Field>
      <Field label="Partner bills per unit" htmlFor="mi-cost" error={errors.costPrice} hint="What the villa pays the partner">
        <Input id="mi-cost" type="number" min={0} step={1000} inputMode="numeric" value={form.costPrice || ''} disabled={!form.partnerId} onChange={(e) => set('costPrice', Number(e.target.value) || 0)} />
      </Field>
      <div className="flex items-center justify-between gap-3 self-end text-sm">
        On the menu
        <Switch label="On the menu" checked={form.active} onChange={(v) => set('active', v)} />
      </div>
      <Field label="Photo" htmlFor="mi-photo" className="sm:col-span-2 lg:col-span-4">
        <AttachmentPicker id="mi-photo" value={form.photo ? [form.photo] : []} onChange={(files: readonly Attachment[]) => set('photo', files.at(-1) ?? null)} hint="One photo, shown on the guest’s menu" />
      </Field>
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
        <Button variant="accent" loading={busy} onClick={() => void save()}>
          Save item
        </Button>
        <Button variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function PartnerForm({ initial, id, onSaved }: { initial: PartnerInput; id: string | null; onSaved: () => void }) {
  const { orders } = useServices()
  const toast = useToast()
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await orders.savePartner(id, form)
      toast({ title: `Saved ${form.name}` })
      onSaved()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid grid-cols-1 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-2">
      <Field label="Name" htmlFor={`pt-name-${id ?? 'new'}`} error={errors.name}>
        <Input id={`pt-name-${id ?? 'new'}`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Provides" htmlFor={`pt-kind-${id ?? 'new'}`}>
        <Select id={`pt-kind-${id ?? 'new'}`} value={form.kind} options={PARTNER_KINDS.map((k) => ({ value: k, label: PARTNER_KIND_LABEL[k] }))} onChange={(e) => setForm({ ...form, kind: e.target.value as PartnerKind })} />
      </Field>
      <Field label="Contact" htmlFor={`pt-contact-${id ?? 'new'}`}>
        <Input id={`pt-contact-${id ?? 'new'}`} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
      </Field>
      <Field label="Phone" htmlFor={`pt-phone-${id ?? 'new'}`} error={errors.phone}>
        <Input id={`pt-phone-${id ?? 'new'}`} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </Field>
      <Button variant="solid" size="sm" className="justify-self-start" loading={busy} onClick={() => void save()}>
        Save partner
      </Button>
    </div>
  )
}

/** The room service menu per villa: prices, hours, notice, and who delivers each item at what cost. */
export default function CatalogPage() {
  const { orders } = useServices()
  const data = useResource('orders.menu', () => orders.menu())
  const [params, setParams] = useSearchParams()
  const villaId = params.get('villa') ?? ''
  const category = (MENU_CATEGORIES.find((c) => c === params.get('category')) ?? '') as MenuCategory | ''
  const query = params.get('q') ?? ''
  const [partner, setPartner] = useState<string | 'new' | null>(null)

  const update = (key: 'villa' | 'category' | 'q' | 'edit', value: string) => {
    const search = new URLSearchParams(params)
    if (value) search.set(key, value)
    else search.delete(key)
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const q = query.trim().toLowerCase()
  const rows = d.items.filter((i) => (!villaId || i.villaId === villaId) && (!category || i.category === category) && (!q || `${i.name} ${i.description} ${i.partner?.name ?? ''}`.toLowerCase().includes(q)))
  const inputOf = ({ id: _id, villaName: _v, partner: _p, margin: _m, ...input }: MenuItemView): MenuItemInput => input
  const editId = d.canEdit ? params.get('edit') : null
  const current = editId && editId !== 'new' ? d.items.find((i) => i.id === editId) : undefined
  const editing = editId === 'new' ? { id: null, input: blankItem(villaId || d.catalog.villas[0]?.id || '') } : current ? { id: current.id, input: inputOf(current) } : null
  const editHref = (id: string) => {
    const search = new URLSearchParams(params)
    search.set('edit', id)
    return `/services/catalog?${search.toString()}`
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">What guests can order in each villa. Prices print on the guest’s menu page; partner costs stay inside and show the margin.</p>
        <div className="flex flex-wrap gap-2">
          <Link to="/services/qr" className={buttonStyles({ variant: 'card' })}>
            <QrCode aria-hidden className="size-4" /> Room QR cards
          </Link>
          {d.canEdit && (
            <Button variant="accent" onClick={() => update('edit', 'new')}>
              <Plus aria-hidden className="size-4" /> New item
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <Card aria-label={editing.id ? 'Edit item' : 'New item'}>
          <CardHeader title={editing.id ? `Edit ${editing.input.name}` : 'New menu item'} />
          <ItemForm
            key={editing.id ?? 'new'}
            id={editing.id}
            initial={editing.input}
            villas={d.catalog.villas}
            partners={d.partners}
            onCancel={() => update('edit', '')}
            onSaved={() => {
              update('edit', '')
              data.reload()
            }}
          />
        </Card>
      )}
      <Card className="p-0">
        <TableToolbar
          chips={[{ value: '', label: 'All', count: d.items.length }, ...MENU_CATEGORIES.map((c) => ({ value: c, label: MENU_CATEGORY_LABEL[c], count: d.items.filter((i) => i.category === c).length }))]}
          chip={category}
          onChip={(c) => update('category', c)}
          summary={`${rows.length} of ${d.items.length} items`}
          search={<Input className="h-10" placeholder="Item, description or partner" aria-label="Search the menu" value={query} onChange={(e) => update('q', e.target.value)} />}
          filters={<Select aria-label="Villa" value={villaId} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => update('villa', e.target.value)} />}
          active={!!villaId || !!category || !!query}
          onClear={() => setParams({}, { replace: true })}
        />
        <ListTable
          label="Menu items"
          rows={rows}
          rowKey={(i) => i.id}
          href={(i) => editHref(i.id)}
          exportName="room-service-menu"
          empty={<EmptyState title="No item matches" />}
          columns={[
            { key: 'name', header: 'Item', cell: (i) => <span className="flex items-center gap-2">{i.photo?.url && <img src={i.photo.url} alt="" className="size-9 shrink-0 rounded-lg object-cover" />}{i.name}{!i.active && <Tag tone="neutral">Off</Tag>}</span>, value: (i) => i.name },
            { key: 'cat', header: 'Category', cell: (i) => MENU_CATEGORY_LABEL[i.category], value: (i) => MENU_CATEGORY_LABEL[i.category], hide: 'lg' },
            { key: 'villa', header: 'Villa', cell: (i) => i.villaName, value: (i) => i.villaName, hide: 'lg' },
            { key: 'hours', header: 'Served', cell: (i) => <span className="text-xs">{hoursLabel(i)}<span className="block text-muted">{leadLabel(i.leadMinutes)}</span></span>, value: (i) => hoursLabel(i), hide: 'xl' },
            { key: 'partner', header: 'Delivered by', cell: (i) => i.partner?.name ?? <span className="text-muted">Our team</span>, value: (i) => i.partner?.name ?? '', hide: 'lg' },
            { key: 'price', header: 'Price', align: 'right', cell: (i) => <span className="tabular">{money(i.price)}<span className="block text-xs text-muted">{PRICE_UNIT_LABEL[i.unit]}</span></span>, value: (i) => i.price },
            { key: 'margin', header: 'Margin', align: 'right', cell: (i) => <span className="tabular">{money(i.margin)}</span>, value: (i) => i.margin, hide: 'lg' },
          ]}
          card={(i) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{i.name}</p>
                <p className="truncate text-xs text-muted">
                  {i.villaName} · {money(i.price)} {PRICE_UNIT_LABEL[i.unit]} · {hoursLabel(i)}
                </p>
              </div>
              {!i.active && <StatusPill tone="neutral">Off</StatusPill>}
            </div>
          )}
        />
      </Card>
      <Card aria-labelledby="partners-title">
        <CardHeader
          id="partners-title"
          title="Service partners"
          action={
            d.canEdit && (
              <Button size="sm" variant="soft" onClick={() => setPartner(partner === 'new' ? null : 'new')}>
                <Plus aria-hidden className="size-3.5" /> Partner
              </Button>
            )
          }
        />
        <p className="mb-3 text-sm text-muted">Spa therapists, drivers and tour operators who bill the villa. Their bill becomes a cash-out for approval when the order is delivered.</p>
        {partner === 'new' && <PartnerForm id={null} initial={{ name: '', kind: 'spa', contact: '', phone: '', active: true }} onSaved={() => { setPartner(null); data.reload() }} />}
        <ul className="divide-y divide-line">
          {d.partners.map((p) => (
            <li key={p.id} className="py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-muted">
                    {PARTNER_KIND_LABEL[p.kind]} · {p.contact} {p.phone} · {d.items.filter((i) => i.partnerId === p.id).length} items
                  </p>
                </div>
                {p.owed !== null && (
                  <Link to="/reports/partner-balances" className="shrink-0 text-right hover:underline">
                    <span className="block text-sm font-semibold tabular">{money(p.owed)}</span>
                    <span className="block text-xs text-muted">owed</span>
                  </Link>
                )}
                {d.canEdit && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setPartner(partner === p.id ? null : p.id)}>
                    <Pencil aria-hidden className="size-3.5" />
                  </Button>
                )}
              </div>
              {partner === p.id && (
                <div className="mt-3">
                  <PartnerForm id={p.id} initial={{ name: p.name, kind: p.kind, contact: p.contact, phone: p.phone, active: p.active }} onSaved={() => { setPartner(null); data.reload() }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

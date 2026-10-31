import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Send } from 'lucide-react'
import { orderTotals, type OrderLine } from '@/domain/serviceOrder'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { MenuList, OrderLines } from './orderParts'
import { nextSlot, toClock, toMinutes } from './clock'


/** The desk orders for a stay from that villa's menu; items can go on the house with a reason. */
export default function NewOrderPage() {
  const { orders } = useServices()
  const toast = useToast()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const options = useResource('orders.formOptions', () => orders.formOptions())
  const [bookingId, setBookingId] = useState(params.get('booking') ?? '')
  const [cart, setCart] = useState<Record<string, number>>({})
  const [comp, setComp] = useState<Record<string, boolean>>({})
  const [requestedOn, setRequestedOn] = useState('')
  const [requestedAt, setRequestedAt] = useState(nextSlot)
  const [note, setNote] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [discountPct, setDiscountPct] = useState(0)
  const [discountReason, setDiscountReason] = useState('')
  const [compReason, setCompReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={8} />
  const o = options.data
  const stay = o.stays.find((b) => b.id === bookingId) ?? null
  const menu = stay ? o.menu.filter((i) => i.villaId === stay.place.villa.id) : []
  const day = requestedOn || o.today
  const lines: OrderLine[] = menu
    .filter((i) => (cart[i.id] ?? 0) > 0)
    .map((i) => ({ itemId: i.id, name: i.name, category: i.category, unit: i.unit, price: i.price, quantity: cart[i.id] ?? 0, costPrice: i.costPrice, partnerId: i.partnerId, comp: Boolean(comp[i.id]) }))
  const totals = orderTotals({ lines, discountPct })

  async function submit() {
    if (!stay) return
    setBusy(true)
    setErrors({})
    try {
      const placed = await orders.place({ bookingId: stay.id, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, comp: l.comp })), note, requestedOn: day, requestedAt, priority: urgent ? 'urgent' : 'normal', discountPct, discountReason, compReason })
      toast({ title: `Placed ${placed.number}`, description: `${placed.unitCode} · ${money(placed.totals.charge)}` })
      navigate(`/services/orders/${placed.id}`)
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not place the order', description: Object.values(e)[0] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageBar fallback="/services/orders" label="Room service orders" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="no-stay">
            <CardHeader id="no-stay" title="For which stay" />
            <Field label="Guest in house or arriving soon" htmlFor="no-booking" error={errors.bookingId}>
              <Select
                id="no-booking"
                value={bookingId}
                options={[{ value: '', label: 'Pick the stay' }, ...o.stays.map((b) => ({ value: b.id, label: `${b.unitCode} · ${b.guestName} · ${b.status === 'checked_in' ? `until ${shortDay(b.checkOut)}` : `arrives ${shortDay(b.checkIn)}`}` }))]}
                onChange={(e) => {
                  setBookingId(e.target.value)
                  setCart({})
                  setComp({})
                }}
              />
            </Field>
            {o.stays.length === 0 && <p className="mt-2 text-sm text-muted">Nobody is in house or arriving in the next three days.</p>}
          </Card>
          {stay ? (
            <Card aria-labelledby="no-menu">
              <CardHeader id="no-menu" title={`${stay.place.villa.name} menu`} />
              <MenuList items={menu} cart={cart} onChange={(id, q) => setCart((c) => ({ ...c, [id]: q }))} />
            </Card>
          ) : (
            <EmptyState title="Pick a stay to see its villa’s menu" />
          )}
        </div>
        <div className="space-y-4">
          <Card aria-labelledby="no-summary" className="xl:sticky xl:top-4">
            <CardHeader id="no-summary" title="Order" />
            {lines.length === 0 ? (
              <p className="text-sm text-muted">Add items from the menu.</p>
            ) : (
              <>
                <OrderLines lines={lines} totals={totals} discountPct={discountPct} showCost />
                {o.canComp && (
                  <div className="mt-3 space-y-2 rounded-panel bg-raised p-3">
                    <p className="text-xs font-semibold text-muted">On the house</p>
                    {lines.map((l) => (
                      <div key={l.itemId} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{l.name}</span>
                        <Switch label={`${l.name} on the house`} checked={l.comp} onChange={(v) => setComp((c) => ({ ...c, [l.itemId]: v }))} />
                      </div>
                    ))}
                    {lines.some((l) => l.comp) && (
                      <Field label="Why" htmlFor="no-comp" error={errors.compReason}>
                        <Input id="no-comp" value={compReason} onChange={(e) => setCompReason(e.target.value)} placeholder="Welcome drink, complaint, anniversary" />
                      </Field>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Day" htmlFor="no-day" error={errors.requestedOn}>
                <Input id="no-day" type="date" min={o.today} value={day} onChange={(e) => setRequestedOn(e.target.value)} />
              </Field>
              <Field label="Time" htmlFor="no-time" error={errors.requestedAt}>
                <Input id="no-time" type="time" step={900} value={toClock(requestedAt)} onChange={(e) => setRequestedAt(toMinutes(e.target.value))} />
              </Field>
              <Field label="Discount %" htmlFor="no-disc" error={errors.discountPct} hint={o.canDiscountPast ? undefined : `Up to ${o.discountLimitPct}%`} className="col-span-2 sm:col-span-1">
                <Input id="no-disc" type="number" min={0} max={100} inputMode="numeric" value={discountPct || ''} onChange={(e) => setDiscountPct(Number(e.target.value) || 0)} />
              </Field>
              <div className="col-span-2 flex items-center justify-between gap-3 self-end text-sm sm:col-span-1">
                Urgent
                <Switch label="Urgent" checked={urgent} onChange={setUrgent} />
              </div>
              {discountPct > 0 && (
                <Field label="Discount reason" htmlFor="no-disc-why" error={errors.discountReason} className="col-span-2">
                  <Input id="no-disc-why" value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} />
                </Field>
              )}
              <Field label="Note for the team" htmlFor="no-note" className="col-span-2">
                <Textarea id="no-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Allergies, where to serve, flight number" />
              </Field>
            </div>
            <Button variant="accent" className="mt-4 w-full" loading={busy} disabled={!stay || lines.length === 0} onClick={() => void submit()}>
              <Send aria-hidden className="size-4" /> Place order · {money(totals.charge)}
            </Button>
            {(errors.form || errors.lines) && (
              <p role="alert" className="mt-2 text-xs font-medium text-danger">
                {errors.form ?? errors.lines}
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}

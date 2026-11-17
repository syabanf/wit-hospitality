import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Banknote, ListChecks, Wrench } from 'lucide-react'
import { CHECK_KIND_LABEL, INVENTORY_CATEGORY_LABEL, ITEM_CONDITION_LABEL, linesOff, type LineDiff } from '@/domain/unitInventory'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

function ChargeForm({ checkId, diff, onDone, onCancel }: { checkId: string; diff: LineDiff; onDone: () => void; onCancel: () => void }) {
  const { villaOps } = useServices()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const l = diff.line
  const id = `charge-${l.itemId}`

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await villaOps.chargeLine(checkId, l.itemId, { quantity: Number(f.get('quantity')), reason: String(f.get('reason')) })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 grid grid-cols-1 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[120px_minmax(0,1fr)_auto]" aria-label={`Charge ${l.name}`}>
      <Field label="Quantity" htmlFor={`${id}-q`} error={errors.quantity}>
        <Input id={`${id}-q`} name="quantity" type="number" min={1} max={l.expected} defaultValue={Math.max(1, l.expected - l.counted)} required />
      </Field>
      <Field label={`Reason, at ${money(l.replacementCost)} each`} htmlFor={`${id}-r`} error={errors.reason ?? errors.form}>
        <Input id={`${id}-r`} name="reason" placeholder="Broken during the stay" required />
      </Field>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="accent" loading={saving}>
          Charge
        </Button>
        <Button variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** One inventory check: every line against the list and the stay's pre-arrival count, and what to do with the lines off. */
export default function CheckPage() {
  const { id = '' } = useParams()
  return <CheckBody key={id} id={id} />
}

function CheckBody({ id }: { id: string }) {
  const { villaOps } = useServices()
  const toast = useToast()
  const resource = useResource(`villaOps.check:${id}`, () => villaOps.check(id), { keepPrevious: false })
  const [charging, setCharging] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function act(key: string, run: () => Promise<unknown>, title: string) {
    setBusy(key)
    try {
      await run()
      toast({ title })
      resource.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not do that', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="inventory check" back={{ to: '/housekeeping', label: 'Back to housekeeping' }}>
      {(d) => {
        const c = d.check
        const off = linesOff(c)
        const post = c.kind === 'post_departure'
        return (
          <>
            <PageBar fallback="/housekeeping" label="Housekeeping" />
            <div className="space-y-4">
              <Card aria-label={c.number}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-xs text-muted">{c.number}</p>
                    <Headline className="mt-1">{`${CHECK_KIND_LABEL[c.kind]}, ${d.unit.code}`}</Headline>
                    <p className="mt-1 text-sm text-muted">
                      <Link to={`/property/units/${d.unit.id}`} className="hover:underline">
                        {d.unit.name}
                      </Link>
                      , {d.villa.name}
                    </p>
                  </div>
                  <StatusPill tone={off ? 'danger' : 'success'}>{off ? `${off} items off` : 'All in order'}</StatusPill>
                </div>
                <FactGrid
                  className="mt-6 grid-cols-2 sm:grid-cols-4"
                  facts={[
                    ['Stay', d.booking ? <Link key="b" to={`/bookings/${d.booking.id}`} className="hover:underline">{c.bookingCode}</Link> : c.bookingCode],
                    ['Counted', `${shortDay(c.on)} by ${c.by}`],
                    ['Compared with', d.pre ? <Link key="p" to={`/housekeeping/checks/${d.pre.id}`} className="hover:underline">{d.pre.number}</Link> : post ? 'No pre-arrival check' : 'The list'],
                    ['Folio', post ? (d.inHouse ? 'Open: charges go on the bill' : 'Closed at check-out') : 'Charges come after departure'],
                  ]}
                />
              </Card>
              <Card aria-labelledby="lines-title">
                <CardHeader id="lines-title" title="Items" icon={<ListChecks aria-hidden className="size-5 text-muted" />} />
                <ul className="divide-y divide-line">
                  {d.diffs.map((diff) => {
                    const l = diff.line
                    const badLine = l.condition !== 'ok'
                    return (
                      <li key={l.itemId} className={cn('py-3 first:pt-0 last:pb-0', diff.flagged && '-mx-3 rounded-panel bg-danger-soft/50 px-3 first:pt-3 last:pb-3')}>
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">
                              {l.name} <span className="text-muted tabular">{l.counted} of {l.expected}</span>
                            </p>
                            <p className="text-xs text-muted">
                              {INVENTORY_CATEGORY_LABEL[l.category]}
                              {diff.vsList !== 0 && ` · ${signed(diff.vsList)} against the list`}
                              {diff.vsPre !== null && diff.vsPre !== 0 && ` · ${signed(diff.vsPre)} since arrival`}
                              {diff.conditionChanged && ' · condition changed since arrival'}
                              {l.note && ` · ${l.note}`}
                            </p>
                          </div>
                          <Tag tone={l.condition === 'ok' ? 'success' : l.condition === 'damaged' ? 'warning' : 'danger'}>{ITEM_CONDITION_LABEL[l.condition]}</Tag>
                        </div>
                        {badLine && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {l.charge ? (
                              <Tag tone="info">Charged {money(l.charge.amount)} by {l.charge.by}</Tag>
                            ) : (
                              post &&
                              d.can.charge && (
                                <Button size="sm" variant="soft" aria-pressed={charging === l.itemId} onClick={() => setCharging(charging === l.itemId ? null : l.itemId)}>
                                  <Banknote aria-hidden className="size-3.5" /> Charge the guest
                                </Button>
                              )
                            )}
                            {l.workOrder ? (
                              <Link to={`/maintenance/work-orders/${l.workOrder.id}`} className="text-xs font-medium text-accent-text hover:underline">
                                {l.workOrder.number}
                              </Link>
                            ) : (
                              d.can.workOrder && (
                                <Button size="sm" variant="soft" loading={busy === `wo-${l.itemId}`} onClick={() => void act(`wo-${l.itemId}`, () => villaOps.raiseWorkOrder(c.id, l.itemId), `Raised a work order for ${l.name}`)}>
                                  <Wrench aria-hidden className="size-3.5" /> Work order
                                </Button>
                              )
                            )}
                            {l.adjusted ? (
                              <Tag tone="neutral">List adjusted</Tag>
                            ) : (
                              d.can.adjust && (
                                <Button size="sm" variant="ghost" loading={busy === `adj-${l.itemId}`} onClick={() => void act(`adj-${l.itemId}`, () => villaOps.adjustLine(c.id, l.itemId), `The list now expects ${l.counted} ${l.name}`)}>
                                  Expect {l.counted} from now on
                                </Button>
                              )
                            )}
                          </div>
                        )}
                        {charging === l.itemId && (
                          <ChargeForm
                            checkId={c.id}
                            diff={diff}
                            onDone={() => {
                              toast({ title: `Charged ${l.name} to ${c.bookingCode}` })
                              setCharging(null)
                              resource.reload()
                            }}
                            onCancel={() => setCharging(null)}
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Card>
            </div>
          </>
        )
      }}
    </Gate>
  )
}

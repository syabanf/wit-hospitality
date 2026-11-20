import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { CHECK_KIND_LABEL, CHECK_KINDS, INVENTORY_CATEGORY_LABEL, ITEM_CONDITION_LABEL, ITEM_CONDITIONS, type CheckKind, type ItemCondition } from '@/domain/unitInventory'
import { cn } from '@/lib/cn'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'

interface Count {
  counted: number
  condition: ItemCondition
  note: string
}

/** Counting a unit's list before an arrival or after a departure: one row per item, prefilled from the list or the arrival count. */
export default function NewCheckPage() {
  const [params] = useSearchParams()
  const unitId = params.get('unit') ?? ''
  const bookingId = params.get('booking') ?? ''
  const kind = (CHECK_KINDS.find((k) => k === params.get('kind')) ?? 'pre_arrival') as CheckKind
  const { villaOps } = useServices()
  const resource = useResource(`villaOps.checkForm:${unitId}:${bookingId}:${kind}`, () => villaOps.checkForm(unitId, bookingId, kind), { keepPrevious: false })
  return (
    <Gate resource={resource} what="stay" back={{ to: '/housekeeping', label: 'Back to housekeeping' }}>
      {(d) => <CountForm key={`${unitId}:${bookingId}:${kind}`} data={d} />}
    </Gate>
  )
}

function CountForm({ data: d }: { data: Awaited<ReturnType<ReturnType<typeof useServices>['villaOps']['checkForm']>> }) {
  const { villaOps } = useServices()
  const toast = useToast()
  const navigate = useNavigate()
  const start = (itemId: string, expected: number): Count => {
    const before = d.pre?.lines.find((l) => l.itemId === itemId)
    return { counted: before ? before.counted : expected, condition: before?.condition ?? 'ok', note: '' }
  }
  const [counts, setCounts] = useState<Record<string, Count>>(() => Object.fromEntries(d.items.map((i) => [i.id, start(i.id, i.expected)])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const set = (itemId: string, change: Partial<Count>) => setCounts((c) => ({ ...c, [itemId]: { ...c[itemId]!, ...change } }))

  if (d.done)
    return (
      <>
        <PageBar fallback="/housekeeping" label="Housekeeping" />
        <Card>
          <p className="text-sm">
            {d.booking.code} already has a {CHECK_KIND_LABEL[d.kind].toLowerCase()}.{' '}
            <Link to={`/housekeeping/checks/${d.done.id}`} className="font-medium text-accent-text hover:underline">
              Open {d.done.number}
            </Link>
          </p>
        </Card>
      </>
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      const check = await villaOps.recordCheck({ unitId: d.unit.id, bookingId: d.booking.id, kind: d.kind, lines: d.items.map((i) => ({ itemId: i.id, ...counts[i.id]! })) })
      toast({ title: `Recorded ${check.number}`, description: `${CHECK_KIND_LABEL[d.kind]} on ${d.unit.code}` })
      navigate(`/housekeeping/checks/${check.id}`, { replace: true })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageBar fallback="/housekeeping" label="Housekeeping" />
      <form onSubmit={(e) => void submit(e)}>
        <Card aria-labelledby="count-title">
          <CardHeader id="count-title" title={`${CHECK_KIND_LABEL[d.kind]}, ${d.unit.code} for ${d.booking.code}`} />
          <p className="mb-4 text-sm text-muted">
            Count each item and mark its condition. {d.pre ? `The counts start from ${d.pre.number}, the arrival check.` : 'The counts start from the list.'}
          </p>
          {d.items.length === 0 ? (
            <div className="space-y-3 text-sm">
              <p>{d.unit.code} has no inventory list yet.</p>
              <Link to={`/property/units/${d.unit.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                Set up the list
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {d.items.map((item, i) => {
                const c = counts[item.id]!
                const off = c.condition !== 'ok' || c.counted !== item.expected
                const err = errors[`lines.${i}.counted`] ?? errors[`lines.${i}.condition`] ?? errors[`lines.${i}.note`]
                return (
                  <li key={item.id} className={cn('grid grid-cols-1 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_96px_140px] sm:items-center', off && 'text-danger')}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">
                        {item.name} <span className="text-muted tabular">of {item.expected}</span>
                      </p>
                      <p className="truncate text-xs text-muted">{INVENTORY_CATEGORY_LABEL[item.category]}</p>
                      {err && (
                        <p role="alert" className="mt-1 text-xs font-medium text-danger">
                          {err}
                        </p>
                      )}
                    </div>
                    <Input aria-label={`${item.name} counted`} type="number" min={0} className="h-10" value={c.counted} onChange={(e) => set(item.id, { counted: Number(e.target.value) })} />
                    <Select aria-label={`${item.name} condition`} className="w-full" value={c.condition} options={ITEM_CONDITIONS.map((x) => ({ value: x, label: ITEM_CONDITION_LABEL[x] }))} onChange={(e) => set(item.id, { condition: e.target.value as ItemCondition })} />
                    {c.condition !== 'ok' && <Input aria-label={`${item.name} note`} className="h-10 sm:col-span-3" placeholder="What is wrong with it" value={c.note} onChange={(e) => set(item.id, { note: e.target.value })} />}
                  </li>
                )
              })}
            </ul>
          )}
          {(errors.form || errors.lines || errors.bookingId || errors.kind) && (
            <p role="alert" className="mt-3 text-sm font-medium text-danger">
              {errors.form ?? errors.lines ?? errors.bookingId ?? errors.kind}
            </p>
          )}
          {d.items.length > 0 && (
            <div className="mt-4 flex gap-2">
              <Button type="submit" variant="accent" loading={saving}>
                Record the check
              </Button>
            </div>
          )}
        </Card>
      </form>
    </>
  )
}

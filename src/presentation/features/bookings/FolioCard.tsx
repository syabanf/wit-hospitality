import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { HandCoins, Plus, Printer } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { CHARGE_CATEGORIES, CHARGE_CATEGORY_LABEL, FOLIO_KIND_LABEL, FOLIO_KINDS, filterFolio, type ChargeCategory, type FolioKind, type GuestFolio } from '@/domain/folio'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { FactGrid } from '../../ui/Headline'
import { Popover } from '../../ui/Popover'
import { useToast } from '../../ui/useToast'
import { FolioLines } from '../shared/FolioLines'

interface FolioCardProps {
  booking: BookingView
  folio: GuestFolio
  /** The discount limit, and whether the signed-in person may approve past it. */
  limitPct: number
  mayApprove: boolean
  onChanged: () => void
}

/** The stay's folio: running balance, a filter by kind, and the desk's charge and allowance postings. */
export function FolioCard({ booking: b, folio: f, limitPct, mayApprove, onChanged }: FolioCardProps) {
  const { booking } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const [kind, setKind] = useState<FolioKind | ''>('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'charge' | 'allowance' | null>(null)
  const mayPost = b.status === 'checked_in' && can('booking', 'edit')
  const kinds = FOLIO_KINDS.filter((k) => f.lines.some((l) => l.kind === k))

  async function post(e: FormEvent<HTMLFormElement>, what: 'charge' | 'allowance', close: () => void) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const amount = Number(form.get('amount')) || 0
    setBusy(what)
    setErrors({})
    try {
      if (what === 'charge') await booking.postCharge(b.id, { category: String(form.get('category')) as ChargeCategory, description: String(form.get('description') ?? ''), amount })
      else await booking.postAllowance(b.id, { amount, reason: String(form.get('reason') ?? '') })
      toast({ title: what === 'charge' ? `Charged ${money(amount)}` : `Allowance of ${money(amount)} posted` })
      close()
      onChanged()
    } catch (error) {
      const found = fieldErrors(error)
      setErrors(found)
      toast({ tone: 'danger', title: `Could not post the ${what}`, description: Object.values(found)[0] })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card id="folio" aria-labelledby="folio-title">
      <CardHeader
        id="folio-title"
        title="Folio"
        action={
          <>
            <Link to={`/bookings/${b.id}/folio`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
              <Printer aria-hidden className="size-3.5" /> Print
            </Link>
            {mayPost && (
              <>
                <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="sm" variant="soft" disabled={f.due.charges === 0}>
                    <HandCoins aria-hidden className="size-3.5" /> Post allowance
                  </Button>
                )}>
                  {(close) => (
                    <form onSubmit={(e) => void post(e, 'allowance', close)} className="space-y-3">
                      <p className="text-sm font-semibold">Take some of the charges off</p>
                      <Field label="Amount, Rp" htmlFor="fa-amount" error={errors.amount} hint={`Open charges ${money(f.due.charges)}`}>
                        <Input id="fa-amount" name="amount" type="number" inputMode="numeric" min={1000} max={f.due.charges} step={1000} className="tabular" />
                      </Field>
                      <Field label="Reason" htmlFor="fa-reason" error={errors.reason}>
                        <Input id="fa-reason" name="reason" placeholder="Why the guest gets it" />
                      </Field>
                      {!mayApprove && <p className="text-xs text-muted">Past {limitPct}% of the charges on the stay, a villa manager gives it.</p>}
                      <Button type="submit" variant="accent" size="sm" loading={busy === 'allowance'}>
                        Post allowance
                      </Button>
                    </form>
                  )}
                </Popover>
                <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
                  <Button {...props} size="sm" variant="accent">
                    <Plus aria-hidden className="size-3.5" /> Post charge
                  </Button>
                )}>
                  {(close) => (
                    <form onSubmit={(e) => void post(e, 'charge', close)} className="space-y-3">
                      <p className="text-sm font-semibold">Charge the guest</p>
                      <Field label="For" htmlFor="fc-category" error={errors.category}>
                        <Select id="fc-category" name="category" className="w-full" options={CHARGE_CATEGORIES.map((c) => ({ value: c, label: CHARGE_CATEGORY_LABEL[c] }))} />
                      </Field>
                      <Field label="What was charged" htmlFor="fc-description" error={errors.description}>
                        <Input id="fc-description" name="description" placeholder="2 × Bintang from the minibar" />
                      </Field>
                      <Field label="Amount, Rp" htmlFor="fc-amount" error={errors.amount} hint="Taken with the bill at check-out">
                        <Input id="fc-amount" name="amount" type="number" inputMode="numeric" min={1000} step={1000} className="tabular" />
                      </Field>
                      <Button type="submit" variant="accent" size="sm" loading={busy === 'charge'}>
                        Post charge
                      </Button>
                    </form>
                  )}
                </Popover>
              </>
            )}
          </>
        }
      />
      <FactGrid
        className="grid-cols-2 sm:grid-cols-4"
        facts={[
          ['Debits', money(f.debits)],
          ['Credits', money(f.credits)],
          ['Balance', <span key="b" className={f.balance > 0 ? 'text-accent-text' : undefined}>{money(f.balance)}</span>],
          ['Deposit held', money(f.depositHeld)],
        ]}
      />
      <div className="mt-4 mb-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{f.balance > 0 ? 'Check-out takes this balance.' : f.balance < 0 ? 'The guest is in credit.' : 'Nothing owed.'}</p>
        <Select compact aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as FolioKind | '')} options={[{ value: '', label: 'Every kind' }, ...kinds.map((k) => ({ value: k, label: FOLIO_KIND_LABEL[k] }))]} />
      </div>
      <FolioLines lines={filterFolio(f.lines, kind)} />
    </Card>
  )
}

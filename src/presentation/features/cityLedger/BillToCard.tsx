import { useState, type FormEvent } from 'react'
import { Building, Pencil } from 'lucide-react'
import type { BillingTarget } from '@/application/cityLedger'
import { BILLING_INSTRUCTION_LABEL, type CityLedgerBillingInput } from '@/domain/cityLedger'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { BillingFields } from './BillingPicker'

/**
 * Who pays a booking or a group after the stay, and the form to set, change or remove it before
 * check-out. A change counts from now on: transfers already posted stay on the account they went to.
 */
export function BillToCard({ target, version, onChanged }: { target: BillingTarget; version: string; onChanged: () => void }) {
  const { cityLedger } = useServices()
  const toast = useToast()
  const key = 'bookingId' in target ? `booking:${target.bookingId}` : `group:${target.groupId}`
  const options = useResource(`cityLedger.billing:${key}:${version}`, () => cityLedger.billing(target), { keepPrevious: false })
  const [draft, setDraft] = useState<CityLedgerBillingInput | null | undefined>(undefined)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const o = options.data
  if (!o || (!o.current && !o.fromGroup && (!o.allowed || o.accounts.length === 0))) return null
  const editing = draft !== undefined

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      const next = await cityLedger.setBilling(target, draft ?? null)
      toast({ title: next ? 'Bill to saved' : 'The guest pays again', description: 'Transfers already posted stay where they are.' })
      setDraft(undefined)
      options.reload()
      onChanged()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby={`bill-to-${key}`}>
      <CardHeader
        id={`bill-to-${key}`}
        title="Bill to"
        action={
          o.allowed &&
          !editing && (
            <Button size="sm" variant="soft" onClick={() => setDraft(o.current ? { accountId: o.current.accountId, instruction: o.current.instruction } : null)}>
              <Pencil aria-hidden className="size-3.5" /> {o.current ? 'Change' : 'Set'}
            </Button>
          )
        }
      />
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="space-y-3">
          <BillingFields idPrefix={`bt-${key}`} value={draft} onChange={setDraft} accounts={o.accounts} mayOverride={o.mayOverride} villaIds={o.villaIds} amount={o.amount} error={errors.accountId ?? errors.form} />
          <p className="text-xs text-muted">The change counts from now on. Transfers already posted stay on the account they went to.</p>
          <div className="flex gap-2">
            <Button type="submit" variant="accent" size="sm" loading={saving} disabled={!draft && !o.current}>
              Save
            </Button>
            <Button size="sm" variant="soft" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : o.current ? (
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <Building aria-hidden className="size-4 text-muted" /> {o.current.code} {o.current.name}
          </p>
          <p className="text-muted">The account pays {BILLING_INSTRUCTION_LABEL[o.current.instruction].toLowerCase()}; the rest stays with the guest.</p>
          {o.current.override && (
            <p className="text-xs text-muted">
              Past the credit limit, allowed by {o.current.override.by}: {o.current.override.reason}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">{o.fromGroup ? `The group bills ${o.fromGroup.code} ${o.fromGroup.name}, ${BILLING_INSTRUCTION_LABEL[o.fromGroup.instruction].toLowerCase()}.` : 'The guest pays.'}</p>
      )}
      {!o.allowed && o.why && <p className="mt-2 text-xs text-muted">{o.why}</p>}
    </Card>
  )
}

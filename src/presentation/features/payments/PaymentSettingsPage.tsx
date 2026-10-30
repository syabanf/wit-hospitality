import { useState, type FormEvent } from 'react'
import { DEFAULT_PAYMENT_POLICY, type PaymentPolicy } from '@/domain/payment'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

const FIELDS: ReadonlyArray<{ group: string; key: keyof PaymentPolicy; label: string; hint: string; step: number }> = [
  { group: 'Deposit and balance', key: 'depositPct', label: 'Deposit, % of the stay', hint: 'Asked of direct bookings when they are made', step: 1 },
  { group: 'Deposit and balance', key: 'balanceDueDays', label: 'Balance due, days before arrival', hint: 'After this the booking reads overdue', step: 1 },
  { group: 'Deposit and balance', key: 'autoCancelDays', label: 'Flag unpaid drafts after, days', hint: 'Drafts with no deposit show on Receivables', step: 1 },
  { group: 'Payment links', key: 'linkExpiryHours', label: 'Link expires after, hours', hint: 'An unpaid link turns expired', step: 1 },
  { group: 'Gateway fees', key: 'qrisFeePct', label: 'QRIS fee, %', hint: 'Booked as a cash-out under Payment fees', step: 0.1 },
  { group: 'Gateway fees', key: 'cardFeePct', label: 'Card fee, %', hint: 'Booked as a cash-out under Payment fees', step: 0.1 },
  { group: 'Gateway fees', key: 'vaFee', label: 'Virtual account fee, Rp', hint: 'Flat fee per payment', step: 500 },
]

/** The rules payments follow: deposit, due dates, link expiry and gateway fees. */
export default function PaymentSettingsPage() {
  const { payments } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('payments.policy', () => payments.policy())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState(0)
  const editable = can('payments', 'edit')

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const policy = Object.fromEntries(FIELDS.map((x) => [x.key, Number(f.get(x.key))])) as unknown as PaymentPolicy
    setSaving(true)
    setErrors({})
    try {
      data.setData(await payments.savePolicy(policy))
      toast({ title: 'Payment policy saved' })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const p = data.data
  const groups = [...new Set(FIELDS.map((x) => x.group))]
  return (
    <>
      <PageBar fallback="/payments" label="Payments" />
      <form key={version} onSubmit={(e) => void save(e)} className="space-y-4">
        <div className="stagger grid grid-cols-1 gap-4 xl:grid-cols-3">
          {groups.map((g) => (
            <Card key={g} aria-label={g}>
              <CardHeader title={g} />
              <div className="space-y-4">
                {FIELDS.filter((x) => x.group === g).map((x) => (
                  <Field key={x.key} label={x.label} htmlFor={`pol-${x.key}`} hint={x.hint} error={errors[x.key]}>
                    <Input id={`pol-${x.key}`} name={x.key} type="number" inputMode="decimal" step={x.step} min={0} defaultValue={p[x.key]} disabled={!editable} className="tabular" />
                  </Field>
                ))}
              </div>
            </Card>
          ))}
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="accent" loading={saving}>
              Save policy
            </Button>
            <Button
              variant="soft"
              onClick={() => {
                data.setData({ ...DEFAULT_PAYMENT_POLICY })
                setVersion((v) => v + 1)
              }}
            >
              Back to defaults
            </Button>
          </div>
        )}
      </form>
    </>
  )
}

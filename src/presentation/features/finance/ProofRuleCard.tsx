import { useState, type FormEvent } from 'react'
import { Paperclip } from 'lucide-react'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

/** The receipt rule: cash-outs from this amount go for approval only with proof attached. */
export function ProofRuleCard() {
  const { finance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const policy = useResource('finance.proofPolicy', () => finance.proofPolicy())
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const editable = can('finance', 'edit')

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(undefined)
    try {
      const next = await finance.saveProofPolicy({ threshold: Number(new FormData(e.currentTarget).get('threshold')) })
      policy.setData(next)
      toast({ title: next.threshold > 0 ? `Receipts required from ${money(next.threshold)}` : 'Receipt rule switched off' })
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0])
    } finally {
      setSaving(false)
    }
  }

  if (!policy.data) return null
  return (
    <Card aria-labelledby="proof-rule">
      <CardHeader id="proof-rule" title="Receipt rule" icon={<Paperclip aria-hidden className="size-5 text-muted" />} />
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
        <Field label="Cash-outs from, Rp" htmlFor="proof-threshold" error={error} hint="Manual and work order expenses at or above this need a receipt before approval. 0 switches it off." className="min-w-0 flex-1">
          <Input id="proof-threshold" name="threshold" type="number" inputMode="numeric" min={0} step={50000} defaultValue={policy.data.threshold} disabled={!editable} className="tabular" />
        </Field>
        {editable && (
          <Button type="submit" variant="solid" loading={saving}>
            Save
          </Button>
        )}
      </form>
    </Card>
  )
}

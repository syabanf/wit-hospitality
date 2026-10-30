import { useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { INSPECTION_ITEMS, INSPECTION_LABEL, type HousekeepingRecord, type InspectionItem, type InspectionResult, type WorkOrder } from '@/domain/maintenance'
import { cn } from '@/lib/cn'
import { Button } from '../../ui/Button'
import { fieldErrors } from '../../ui/fieldErrors'

interface InspectionFormProps {
  unitCode: string
  save: (results: readonly InspectionResult[], raise: boolean) => Promise<{ record: HousekeepingRecord; workOrder: WorkOrder | null }>
  onDone: (result: { record: HousekeepingRecord; workOrder: WorkOrder | null }) => void
}

/** The room check before release; a failed line sends the room back and can open a work order. */
export function InspectionForm({ unitCode, save, onDone }: InspectionFormProps) {
  const [ok, setOk] = useState<Record<InspectionItem, boolean>>(() => Object.fromEntries(INSPECTION_ITEMS.map((i) => [i, true])) as Record<InspectionItem, boolean>)
  const [raise, setRaise] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const failed = INSPECTION_ITEMS.filter((i) => !ok[i])

  async function submit() {
    setSaving(true)
    setError('')
    try {
      onDone(await save(INSPECTION_ITEMS.map((item) => ({ item, ok: ok[item] })), raise && failed.length > 0))
    } catch (e) {
      setError(Object.values(fieldErrors(e))[0] ?? 'Could not save the inspection.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Inspect {unitCode}</p>
      <div className="space-y-2">
        {INSPECTION_ITEMS.map((item) => (
          <label key={item} className={cn('flex cursor-pointer items-center gap-3 rounded-panel px-3 py-2 text-sm transition-colors', ok[item] ? 'bg-raised' : 'bg-danger-soft text-danger')}>
            <input type="checkbox" checked={ok[item]} onChange={(e) => setOk({ ...ok, [item]: e.target.checked })} className="size-4 shrink-0 accent-accent" />
            <span className="min-w-0 flex-1">{INSPECTION_LABEL[item]}</span>
          </label>
        ))}
      </div>
      {failed.length > 0 && (
        <label className="flex cursor-pointer items-start gap-2 rounded-panel bg-warning-soft p-3 text-sm">
          <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} className="mt-0.5 size-4" />
          <span>Open a work order for the failed {failed.length === 1 ? 'check' : 'checks'}. The room goes back to dirty.</span>
        </label>
      )}
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      <Button size="sm" variant={failed.length ? 'solid' : 'accent'} loading={saving} onClick={() => void submit()}>
        <ClipboardCheck aria-hidden className="size-3.5" /> {failed.length ? 'Fail inspection' : 'Pass inspection'}
      </Button>
    </div>
  )
}

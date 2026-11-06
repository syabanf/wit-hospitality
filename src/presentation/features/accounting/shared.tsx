import { money } from '@/lib/format'
import { Select } from '../../ui/Field'

/** A debit or credit cell: blank when zero so the other column reads at a glance. */
export const Amount = ({ value }: { value: number }) => (value ? <span className="tabular">{money(value)}</span> : <span className="text-muted">–</span>)

export function VillaSelect({ villas, value, onChange }: { villas: ReadonlyArray<{ id: string; name: string }>; value: string; onChange: (id: string) => void }) {
  return <Select aria-label="Villa" value={value} options={[{ value: '', label: 'Whole portfolio' }, ...villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => onChange(e.target.value)} />
}

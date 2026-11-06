import { useSearchParams } from 'react-router'
import type { JournalSource } from '@/domain/journal'
import type { Tone } from '../../ui/Badge'

export const SOURCE_TONE: Record<JournalSource, Tone> = { opening: 'neutral', transaction: 'info', transfer: 'info', payroll: 'warning', manual: 'accent', folio: 'success', order: 'neutral' }

/** Filters kept in the URL so Back and shared links keep them. */
export function useFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams()
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ''])) as Record<K, string>
  const update = (next: Partial<Record<K, string>>) => {
    const merged = { ...values, ...next }
    const search = new URLSearchParams()
    for (const k of keys) if (merged[k]) search.set(k, merged[k])
    setParams(search, { replace: true })
  }
  return { values, update, active: keys.some((k) => values[k]) }
}

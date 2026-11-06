import type { ChargeCategory } from '@/domain/folio'

/** Manual folio lines on stays in house today. `stay` indexes the in-house stays by booking code; they all leave after today. */
export interface FolioSeed {
  seq: number
  stay: number
  kind: 'charge' | 'allowance'
  category: ChargeCategory | null
  description: string
  amount: number
  daysAgo: number
  /** Minutes since midnight. */
  at: number
  by: 'staff' | 'manager'
}

export const FOLIO_SEEDS: readonly FolioSeed[] = [
  { seq: 1, stay: 1, kind: 'charge', category: 'minibar', description: '2 × Bintang, 1 × Pringles', amount: 185_000, daysAgo: 1, at: 21 * 60, by: 'staff' },
  { seq: 2, stay: 8, kind: 'charge', category: 'late_checkout', description: 'Late check-out to 16:00, agreed with the guest', amount: 500_000, daysAgo: 0, at: 9 * 60 + 30, by: 'staff' },
  { seq: 3, stay: 8, kind: 'allowance', category: null, description: 'Half the late check-out: pool pump noise on the first night', amount: 250_000, daysAgo: 0, at: 9 * 60 + 45, by: 'manager' },
  { seq: 4, stay: 11, kind: 'charge', category: 'damage', description: 'Broken wine glass and a stained bath towel', amount: 350_000, daysAgo: 1, at: 18 * 60, by: 'staff' },
]

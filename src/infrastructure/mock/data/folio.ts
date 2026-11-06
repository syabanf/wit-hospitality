/** Manual folio lines on stays in house today. `stay` indexes the in-house stays by booking code; they all leave after today. */
export interface FolioSeed {
  seq: number
  stay: number
  kind: 'charge' | 'rebate'
  /** For a rebate: the seq of the charge it corrects. */
  of?: number
  /** The transaction code the line posts on. */
  code: string
  description: string
  amount: number
  daysAgo: number
  /** Minutes since midnight. */
  at: number
  by: 'staff' | 'manager'
}

export const FOLIO_SEEDS: readonly FolioSeed[] = [
  { seq: 1, stay: 1, kind: 'charge', code: 'MINI', description: '2 × Bintang, 1 × Pringles', amount: 185_000, daysAgo: 1, at: 21 * 60, by: 'staff' },
  { seq: 2, stay: 8, kind: 'charge', code: 'LATE', description: 'Late check-out to 16:00, agreed with the guest', amount: 605_000, daysAgo: 0, at: 9 * 60 + 30, by: 'staff' },
  { seq: 3, stay: 8, kind: 'rebate', of: 2, code: 'LATE', description: 'Half the late check-out: pool pump noise on the first night', amount: 302_500, daysAgo: 0, at: 9 * 60 + 45, by: 'manager' },
  { seq: 4, stay: 11, kind: 'charge', code: 'DMG', description: 'Broken wine glass and a stained bath towel', amount: 350_000, daysAgo: 1, at: 18 * 60, by: 'staff' },
]

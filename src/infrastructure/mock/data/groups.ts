import type { GroupBilling, GroupDiscount, GroupSource } from '@/domain/group'

/** One stay of a seeded group, in its unit. */
export interface GroupStaySeed {
  id: string
  code: string
  unitCode: string
  adults: number
  children: number
}

export interface GroupSeed {
  id: string
  code: string
  name: string
  leadGuestId: string
  source: GroupSource
  billing: GroupBilling
  discount: GroupDiscount | null
  note: string
  /** Every stay shares the dates; days from today and nights. */
  startOffset: number
  nights: number
  createdDaysAgo: number
  stays: readonly GroupStaySeed[]
}

/** Two groups after every planned stay in their units, so they never clash with the seed: a master-billed wedding and a family paying stay by stay. */
export const GROUP_SEEDS: readonly GroupSeed[] = [
  {
    id: 'bg-1',
    code: 'GRP-1001',
    name: 'Menon wedding',
    leadGuestId: 'g-07',
    source: 'direct',
    billing: 'master',
    discount: { pct: 10, reason: 'Wedding party of three villas' },
    note: 'Ceremony on the cliff lawn on the second evening. The couple pays every room; guests pay their own extras.',
    startOffset: 30,
    nights: 3,
    createdDaysAgo: 20,
    stays: [
      { id: 'bk-2101', code: 'BK-2101', unitCode: 'KR-01', adults: 2, children: 0 },
      { id: 'bk-2102', code: 'BK-2102', unitCode: 'KR-02', adults: 4, children: 0 },
      { id: 'bk-2103', code: 'BK-2103', unitCode: 'KR-03', adults: 3, children: 1 },
    ],
  },
  {
    id: 'bg-2',
    code: 'GRP-1002',
    name: 'Sato family holiday',
    leadGuestId: 'g-04',
    source: 'direct',
    billing: 'per_stay',
    discount: null,
    note: 'Grandparents in the ground-floor loft; each family pays its own stay.',
    startOffset: 27,
    nights: 4,
    createdDaysAgo: 10,
    stays: [
      { id: 'bk-2104', code: 'BK-2104', unitCode: 'LB-03', adults: 2, children: 0 },
      { id: 'bk-2105', code: 'BK-2105', unitCode: 'LB-01', adults: 2, children: 2 },
    ],
  },
]

import type { OverbookPolicy } from '@/domain/overbooking'
import type { RestrictionInput } from '@/domain/restriction'

/** A restriction in the seed: yearly ranges as written, one-off ranges as day offsets from today. */
export type RestrictionSeed = Omit<RestrictionInput, 'groupId' | 'unitId' | 'from' | 'to'> & { id: string; groupIds: readonly string[]; unitCode?: string } & ({ from: string; to: string } | { fromOffset: number; toOffset: number })

const SELLING = ['grp-saka-standard', 'grp-tirta-pool', 'grp-tirta-garden', 'grp-lumbung-loft', 'grp-karang-cliff', 'grp-pandawa-estate']

/**
 * The high season asks three nights of every arrival and New Year's week five; Karang takes no
 * Saturday arrivals in July and August. TR-04 is off sale for a week a month out while its bathroom
 * is redone. Seeded stays predate them and keep their dates.
 */
export const RESTRICTION_SEEDS: readonly RestrictionSeed[] = [
  { id: 'rst-high-mid', groupIds: SELLING, rule: 'min_stay', nights: 3, yearly: true, from: '07-01', to: '08-31', weekdays: [], note: 'High season' },
  { id: 'rst-high-end', groupIds: SELLING, rule: 'min_stay', nights: 3, yearly: true, from: '12-20', to: '01-05', weekdays: [], note: 'High season' },
  { id: 'rst-new-year', groupIds: SELLING, rule: 'min_stay_through', nights: 5, yearly: true, from: '12-28', to: '01-02', weekdays: [], note: 'New Year week' },
  { id: 'rst-karang-sat', groupIds: ['grp-karang-cliff'], rule: 'closed_to_arrival', nights: null, yearly: true, from: '07-01', to: '08-31', weekdays: [5], note: 'Saturday changeover crew is off in high season' },
  { id: 'rst-tr04-reno', groupIds: ['grp-tirta-garden'], unitCode: 'TR-04', rule: 'stop_sell', nights: null, yearly: false, fromOffset: 28, toOffset: 34, weekdays: [], note: 'Bathroom renovation' },
]

/** Saka sells its eight standard rooms by type and takes one stay a night past them. */
export const OVERBOOK_SEEDS: readonly OverbookPolicy[] = [{ groupId: 'grp-saka-standard', limit: 1 }]

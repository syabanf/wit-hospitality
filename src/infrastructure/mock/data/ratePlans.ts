import type { RatePlan, Season } from '@/domain/ratePlan'

const HIGH_SEASON: readonly Season[] = [
  { name: 'High season', from: '07-01', to: '08-31', kind: 'surcharge', value: 35 },
  { name: 'High season', from: '12-20', to: '01-05', kind: 'surcharge', value: 40 },
]

/**
 * One rate plan per room type: weekends 17 to 21% over the weekday rate and the high season on top.
 * Karang sells New Year's week at a fixed price inside the year-end season. KR-03 (no listing) and
 * SK-08 (listing paused) sell direct at these prices.
 */
export const RATE_PLANS: readonly RatePlan[] = [
  { groupId: 'grp-saka-standard', weekdayRate: 1_850_000, weekendRate: 2_200_000, seasons: HIGH_SEASON },
  { groupId: 'grp-tirta-pool', weekdayRate: 2_400_000, weekendRate: 2_850_000, seasons: HIGH_SEASON },
  { groupId: 'grp-tirta-garden', weekdayRate: 1_650_000, weekendRate: 1_950_000, seasons: HIGH_SEASON },
  { groupId: 'grp-lumbung-loft', weekdayRate: 2_100_000, weekendRate: 2_500_000, seasons: HIGH_SEASON },
  { groupId: 'grp-karang-cliff', weekdayRate: 3_200_000, weekendRate: 3_850_000, seasons: [...HIGH_SEASON, { name: 'New Year week', from: '12-28', to: '01-02', kind: 'fixed', value: 6_500_000 }] },
  { groupId: 'grp-pandawa-estate', weekdayRate: 4_500_000, weekendRate: 5_250_000, seasons: HIGH_SEASON },
]

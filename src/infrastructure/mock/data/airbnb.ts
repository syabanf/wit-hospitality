import type { AirbnbAccount, Listing } from '@/domain/airbnb'
import type { DateRates } from '@/domain/pricing'
import { addDays, weekdayIndex, type IsoDate } from '@/lib/dates'

export const ACCOUNTS: readonly AirbnbAccount[] = [
  { id: 'acc-saka-stays', name: 'Saka Stays', email: 'host@sakastays.com', status: 'active', slot: 2 },
  { id: 'acc-bali-escapes', name: 'Bali Escapes', email: 'reservations@baliescapes.co', status: 'active', slot: 3 },
  { id: 'acc-ubud-retreats', name: 'Ubud Retreats', email: 'stay@ubudretreats.id', status: 'active', slot: 4 },
]

type ListingSeed = Omit<Listing, 'dateRates'>

const listing = (accountId: string, code: string, title: string, airbnbId: string, status: Listing['status'] = 'active'): ListingSeed => ({
  id: `lst-${code.toLowerCase()}`,
  accountId,
  unitId: `unit-${code.toLowerCase()}`,
  title,
  airbnbId,
  status,
})

/** One listing per unit. KR-03 and PD-01 sell direct only. */
export const LISTINGS: readonly ListingSeed[] = [
  listing('acc-saka-stays', 'SK-01', 'Saka 1 · Private pool villa near Batu Bolong', '48213377'),
  listing('acc-saka-stays', 'SK-02', 'Saka 2 · Private pool villa near Batu Bolong', '48213412'),
  listing('acc-saka-stays', 'SK-03', 'Saka 3 · Private pool villa near Batu Bolong', '48213458'),
  listing('acc-saka-stays', 'SK-04', 'Saka 4 · Private pool villa near Batu Bolong', '48213490'),
  listing('acc-bali-escapes', 'SK-05', 'Canggu pool villa · Saka 5', '51902210'),
  listing('acc-bali-escapes', 'SK-06', 'Canggu pool villa · Saka 6', '51902244'),
  listing('acc-bali-escapes', 'SK-07', 'Canggu pool villa · Saka 7', '51902281'),
  listing('acc-bali-escapes', 'SK-08', 'Canggu pool villa · Saka 8', '51902305', 'paused'),
  listing('acc-ubud-retreats', 'TR-01', 'Tirta pool suite over the Ayung valley', '39877120'),
  listing('acc-ubud-retreats', 'TR-02', 'Tirta pool suite with sunrise terrace', '39877163'),
  listing('acc-ubud-retreats', 'TR-03', 'Tirta garden room, jungle view', '39877199'),
  listing('acc-ubud-retreats', 'TR-04', 'Tirta garden room, rice field view', '39877231'),
  listing('acc-bali-escapes', 'LB-01', 'Lumbung loft 1 · Petitenget', '52440018'),
  listing('acc-bali-escapes', 'LB-02', 'Lumbung loft 2 · Petitenget', '52440052'),
  listing('acc-bali-escapes', 'LB-03', 'Lumbung loft 3 · Petitenget', '52440087'),
  listing('acc-bali-escapes', 'LB-04', 'Lumbung loft 4 · Petitenget', '52440119'),
  listing('acc-bali-escapes', 'KR-01', 'Karang cliff villa 1, ocean view pool', '47110024'),
  listing('acc-bali-escapes', 'KR-02', 'Karang cliff villa 2, ocean view pool', '47110061'),
]

const isHighSeason = (date: IsoDate) => {
  const md = date.slice(5)
  return md >= '12-20' || md <= '01-05' || (md >= '07-01' && md <= '08-31')
}

/** Friday and Saturday nights sell 15% over the base rate and the high season 40%, from 60 days back to 180 ahead. */
export function seedDateRates(baseRate: number, today: IsoDate): DateRates {
  const rates: Record<IsoDate, number> = {}
  for (let i = -60; i < 180; i++) {
    const date = addDays(today, i)
    const uplift = isHighSeason(date) ? 0.4 : weekdayIndex(date) >= 4 && weekdayIndex(date) <= 5 ? 0.15 : 0
    if (uplift) rates[date] = Math.round((baseRate * (1 + uplift)) / 10_000) * 10_000
  }
  return rates
}

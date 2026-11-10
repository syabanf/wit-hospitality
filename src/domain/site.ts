import type { IsoDate } from '@/lib/dates'
import type { Listing } from './airbnb'
import type { Location, Unit, UnitGroup, Villa } from './property'
import type { RatePlan } from './ratePlan'
import type { Restriction } from './restriction'
import type { MenuCategory, MenuItem } from './serviceOrder'
import type { TaxSettings } from './tax'

/**
 * What the public website may read. Property, prices and stay rules are public by nature; who
 * stays, what they paid and who changed what never leave the console.
 */
export interface SiteInventory {
  locations: Location[]
  villas: Villa[]
  groups: UnitGroup[]
  units: Unit[]
  /** Only what prices a night: the listing's status and per-date prices. */
  listings: Array<Pick<Listing, 'unitId' | 'status' | 'dateRates'>>
  ratePlans: RatePlan[]
  restrictions: SiteRestriction[]
  tax: Pick<TaxSettings, 'rates' | 'directMode'>
  menu: SiteMenuItem[]
  contact: SiteContact
}

/** A stay rule without who set it or the staff note. */
export type SiteRestriction = Omit<Restriction, 'createdBy' | 'createdOn' | 'note'>

/** A menu line as the website prints it: no partner, cost or opening hours. */
export type SiteMenuItem = Pick<MenuItem, 'id' | 'villaId' | 'category' | 'name' | 'description' | 'price' | 'unit'>

/** The operator's public contact; null where the console has none yet. */
export interface SiteContact {
  whatsapp: string | null
  email: string | null
}

/** Nights a unit cannot sell: a stay or a block, with no name, code or price. `to` is exclusive. */
export interface SiteHold {
  unitId: string
  /** False for a stay booked against the room type that has no room yet. */
  unitAssigned: boolean
  from: IsoDate
  to: IsoDate
}

/** The categories the website shows as experiences, in order. */
export const SITE_EXPERIENCES: readonly MenuCategory[] = ['spa', 'tours', 'transport', 'food']

/** Two guests a bedroom. */
export const sleepsFor = (bedrooms: number) => bedrooms * 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "12-20" as "20 Dec"; a full date keeps its year. */
function dayLabel(md: string): string {
  const parts = md.split('-').map(Number)
  const [a = 0, b = 0, c] = parts
  return c === undefined ? `${b} ${MONTHS[a - 1] ?? ''}` : `${c} ${MONTHS[b - 1] ?? ''} ${a}`
}

/** One stay rule in words for guests, or null for a rule the website does not explain. */
export function stayNote(r: Pick<SiteRestriction, 'rule' | 'nights' | 'from' | 'to' | 'weekdays'>): string | null {
  const when = `${dayLabel(r.from)} to ${dayLabel(r.to)}`
  const days = r.weekdays.length ? ` on ${[...r.weekdays].sort().map((d) => ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][d]).join(' and ')}` : ''
  if (r.rule === 'min_stay') return `Arrivals from ${when} stay at least ${r.nights} nights.`
  if (r.rule === 'min_stay_through') return `Stays that include a night from ${when} last at least ${r.nights} nights.`
  if (r.rule === 'max_stay') return `Arrivals from ${when} stay at most ${r.nights} nights.`
  if (r.rule === 'closed_to_arrival') return `No arrivals${days} from ${when}.`
  if (r.rule === 'closed_to_departure') return `No departures${days} from ${when}.`
  return null
}

import { findConflicts, typeAvailability, validateStay, type Holding } from '@/domain/booking'
import { isOwnerEnquiry, validateEnquiry, type EnquiryInput } from '@/domain/enquiry'
import { findById } from '@/domain/errors'
import { DEPARTMENT_LABEL } from '@/domain/hr'
import { amenityLabel, buildCatalog, CANCELLATION_LABEL, CANCELLATION_TEXT, facilityLabel, sleeps, typeCapacity, type Location, type Photo, type Unit, type UnitGroup, type Villa } from '@/domain/property'
import { listNight, listNights, priceListFor } from '@/domain/ratePlan'
import { evaluateStay, type Restriction } from '@/domain/restriction'
import { MENU_CATEGORY_LABEL, type MenuCategory } from '@/domain/serviceOrder'
import { SITE_EXPERIENCES, stayNote, type SiteHold, type SiteMenuItem } from '@/domain/site'
import { modeFor, ratesOn, stayTax, taxNote } from '@/domain/tax'
import { addDays, eachDay, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'

/**
 * The public website. Every use case here runs without a session and returns only what a guest may
 * see: the property, prices, free room counts and quotes. Quotes price a direct stay exactly as the
 * console's booking quote does, so the website and the desk never disagree.
 */

interface Deps {
  ports: Ports
  today: () => IsoDate
  check: (errors: Record<string, string | undefined>) => void
}

/** Nights the from-price looks ahead. */
const FROM_PRICE_DAYS = 30
/** Nights the villa page's price strip shows. */
const STRIP_NIGHTS = 14

export interface SiteQuote {
  /** The unit the quote priced, the same one the console's quote would pick. */
  unitId: string
  nights: Array<{ date: IsoDate; rate: number }>
  net: number
  service: number
  pb1: number
  total: number
  /** Total over nights, rounded. */
  perNight: number
  note: string
}

/** A photo as the website serves it, without sign-in. */
export interface SitePhoto {
  url: string
  caption: string
}

export interface SiteRoomType {
  id: string
  name: string
  bedrooms: number
  /** What the smallest room of the type sleeps, extra beds included. */
  sleeps: number
  photos: SitePhoto[]
  /** Rooms of the type open for sale. */
  rooms: number
  amenities: string[]
  fromPrice: number | null
  strip: Array<{ date: IsoDate; rate: number }>
}

export interface SiteVilla {
  id: string
  name: string
  description: string
  location: Location
  /** False when no room is open for sale. */
  open: boolean
  rooms: number
  bedrooms: { min: number; max: number }
  sleeps: number
  fromPrice: number | null
  roomTypes: string[]
  facilities: string[]
  amenities: string[]
  address: string
  checkInTime: string
  checkOutTime: string
  houseRules: string[]
  cancellation: { label: string; text: string }
  /** The first is the cover; empty until the operator uploads some. */
  photos: SitePhoto[]
}

export interface SiteOffer {
  groupId: string
  name: string
  villa: SiteVilla
  free: number
  sleeps: number
  /** The party fits one room of the type. */
  fits: boolean
  /** Why these dates do not sell, in guest words; empty when they do. */
  rules: string[]
  quote: SiteQuote | null
}

export interface SiteSearch {
  location: string
  checkIn: IsoDate
  checkOut: IsoDate
  guests: number
}

/** A menu line merged across villas: the lowest price any villa sells it at. */
export interface SiteMenuLine {
  name: string
  description: string
  price: number
  unit: SiteMenuItem['unit']
  category: MenuCategory
}

/** Counts the home page prints, all read from the console's own records. */
export interface SiteFigures {
  villas: number
  /** Locations with at least one villa. */
  locations: number
  /** Rooms open for sale. */
  rooms: number
  /** Room types with a room open for sale. */
  roomTypes: number
  /** Distinct lines on the in-villa menu. */
  services: number
}

export type DayMoment = 'morning' | 'breakfast' | 'afternoon' | 'sunset' | 'night'
export const DAY_MOMENTS: readonly DayMoment[] = ['morning', 'breakfast', 'afternoon', 'sunset', 'night']

/** How each moment of the day picks its line from the menu. */
const DAY_PICK: Record<DayMoment, (i: SiteMenuLine) => boolean> = {
  morning: (i) => i.category === 'tours' && /sunrise/i.test(`${i.name} ${i.description}`),
  breakfast: (i) => i.category === 'breakfast' && /pool|floating/i.test(`${i.name} ${i.description}`),
  afternoon: (i) => i.category === 'spa',
  sunset: (i) => i.category === 'tours' && /sunset/i.test(`${i.name} ${i.description}`),
  night: (i) => i.category === 'food' && /bbq|dinner/i.test(i.name),
}
/** The category each moment falls back to when nothing matches. */
const DAY_FALLBACK: Record<DayMoment, MenuCategory> = { morning: 'tours', breakfast: 'breakfast', afternoon: 'spa', sunset: 'tours', night: 'food' }

/** One line per name, at the lowest price a villa sells it. */
export function menuLines(menu: readonly SiteMenuItem[]): SiteMenuLine[] {
  const byName = new Map<string, SiteMenuLine>()
  for (const i of menu) {
    const seen = byName.get(i.name)
    if (!seen || i.price < seen.price) byName.set(i.name, { name: i.name, description: i.description, price: i.price, unit: i.unit, category: i.category })
  }
  return [...byName.values()]
}

export function createSiteServices({ ports, today, check }: Deps) {
  async function world() {
    const inv = await ports.site.inventory()
    // The website gets no contact, licence or bank fields; the catalog takes them blank.
    const villas: Villa[] = inv.villas.map((v) => ({ ...v, phone: '', email: '', licenseNo: '', bankName: '', bankAccountNo: '', bankAccountName: '' }))
    const cat = buildCatalog(inv.locations, villas, inv.units, inv.groups)
    const restrictions: Restriction[] = inv.restrictions.map((r) => ({ ...r, createdBy: '', createdOn: '', note: '' }))
    const openUnits = (filter: (u: Unit) => boolean) => inv.units.filter((u) => u.status !== 'inactive' && filter(u))
    return { inv, villas, cat, restrictions, openUnits }
  }
  type World = Awaited<ReturnType<typeof world>>

  const listFor = (w: World, unit: Unit) =>
    priceListFor(
      unit,
      w.inv.listings.find((l) => l.unitId === unit.id),
      w.inv.ratePlans,
    )

  /** The cheapest night any of the units sells over the next month. */
  function fromPrice(w: World, units: readonly Unit[]): number | null {
    const dates = eachDay(today(), addDays(today(), FROM_PRICE_DAYS))
    const rates = units.flatMap((u) => {
      const list = listFor(w, u)
      return list ? dates.map((d) => listNight(list, u.nightlyRate, d).rate) : []
    })
    return rates.length ? Math.min(...rates) : null
  }

  const sitePhotos = (photos: readonly Photo[]): SitePhoto[] => photos.map((p) => ({ url: ports.files.photoUrl(p.fileId, 'site'), caption: p.caption }))
  /** What a room type promises: its smallest room, so every guest the website takes fits whichever room they get. */
  const typeSleeps = (units: readonly Unit[]) => {
    const c = typeCapacity(units)
    return c ? sleeps(c) : 0
  }

  /** The unit the console's quote would price for the room type: the first one not inactive. */
  const typeUnit = (w: World, groupId: string) => w.cat.units.find((u) => u.groupId === groupId && u.status !== 'inactive')

  /** The console's booking quote for a direct stay with no staff price: list nights, service and PB1 per the tax settings. */
  function quote(w: World, unit: Unit, checkIn: IsoDate, checkOut: IsoDate): SiteQuote | null {
    const list = listFor(w, unit)
    if (!list) return null
    const nights = listNights(list, unit.nightlyRate, checkIn, checkOut)
    const priced = { listRates: nights.map((n) => n.rate), rateOverride: null, discount: null }
    const stay = stayTax({ ...priced, checkIn, status: 'confirmed', checkedOutOn: null, priceMode: modeFor('direct', w.inv.tax) }, w.inv.tax)
    const count = Math.max(1, nights.length)
    return { unitId: unit.id, nights: nights.map((n) => ({ date: n.date, rate: n.rate })), net: stay.net, service: stay.service, pb1: stay.pb1, total: stay.total, perNight: Math.round(stay.total / count), note: taxNote(stay) }
  }

  function describeVilla(w: World, villa: Villa): SiteVilla {
    const units = w.openUnits((u) => u.villaId === villa.id)
    const bedrooms = units.map((u) => u.bedrooms)
    const groups = w.inv.groups.filter((g) => g.villaId === villa.id && units.some((u) => u.groupId === g.id))
    const ungrouped = units.filter((u) => !u.groupId)
    return {
      id: villa.id,
      name: villa.name,
      description: villa.description,
      location: w.cat.location(villa.locationId),
      open: units.length > 0,
      rooms: units.length,
      bedrooms: { min: bedrooms.length ? Math.min(...bedrooms) : 0, max: bedrooms.length ? Math.max(...bedrooms) : 0 },
      // The largest room type a guest can book, so the party pickers never offer a party no room takes.
      sleeps: Math.max(0, ...groups.map((g) => typeSleeps(units.filter((u) => u.groupId === g.id))), ...ungrouped.map((u) => sleeps(u))),
      fromPrice: fromPrice(w, units),
      roomTypes: groups.map((g) => g.name),
      facilities: villa.facilities.map(facilityLabel),
      amenities: [...new Set(units.flatMap((u) => u.amenities))].map(amenityLabel),
      address: villa.address,
      checkInTime: villa.checkInTime,
      checkOutTime: villa.checkOutTime,
      houseRules: villa.houseRules.split('\n').map((r) => r.trim()).filter(Boolean),
      cancellation: { label: CANCELLATION_LABEL[villa.cancellationPolicy], text: CANCELLATION_TEXT[villa.cancellationPolicy] },
      photos: sitePhotos(villa.photos),
    }
  }

  function describeType(w: World, g: UnitGroup): SiteRoomType {
    const units = w.openUnits((u) => u.groupId === g.id)
    const priced = typeUnit(w, g.id)
    const list = priced ? listFor(w, priced) : null
    const bedrooms = Math.max(0, ...units.map((u) => u.bedrooms))
    return {
      id: g.id,
      name: g.name,
      bedrooms,
      sleeps: typeSleeps(units),
      photos: sitePhotos(units.flatMap((u) => u.photos)),
      rooms: units.length,
      amenities: [...new Set(units.flatMap((u) => u.amenities))].map(amenityLabel),
      fromPrice: fromPrice(w, units),
      strip: priced && list ? listNights(list, priced.nightlyRate, today(), addDays(today(), STRIP_NIGHTS)).map((n) => ({ date: n.date, rate: n.rate })) : [],
    }
  }

  /** What each room type of the villas sells for the stay: free rooms, the rules it breaks and the quote. */
  async function offers(villas: (w: World) => readonly Villa[], checkIn: IsoDate, checkOut: IsoDate, guests: number) {
    const w = await world()
    const holds = await ports.site.holds(checkIn, checkOut)
    const holding: Holding[] = holds.map((h: SiteHold, i) => ({ id: `hold-${i}`, code: '', unitId: h.unitId, unitAssigned: h.unitAssigned, status: 'confirmed', checkIn: h.from, checkOut: h.to }))
    const list: SiteOffer[] = []
    for (const villa of villas(w)) {
      const view = describeVilla(w, villa)
      for (const g of w.inv.groups.filter((x) => x.villaId === villa.id)) {
        const units = w.openUnits((u) => u.groupId === g.id)
        if (units.length === 0) continue
        const sleeps = typeSleeps(units)
        let free: number
        let priced: Unit | undefined
        if (g.operatorAssigns) {
          free = typeAvailability(w.cat, g.id, checkIn, checkOut, holding, []).free
          priced = typeUnit(w, g.id)
        } else {
          const open = units.filter((u) => findConflicts(u.id, checkIn, checkOut, holding, []).length === 0)
          free = open.length
          const quoted = open.map((u) => ({ u, q: quote(w, u, checkIn, checkOut) })).filter((x) => x.q).sort((a, b) => (a.q?.total ?? 0) - (b.q?.total ?? 0))
          priced = quoted[0]?.u ?? typeUnit(w, g.id)
        }
        const rules = evaluateStay(w.restrictions, { groupId: g.id, unitId: g.operatorAssigns ? null : (priced?.id ?? null), checkIn, checkOut }).map((v) => v.message)
        list.push({ groupId: g.id, name: g.name, villa: view, free, sleeps, fits: guests <= sleeps, rules, quote: priced ? quote(w, priced, checkIn, checkOut) : null })
      }
    }
    return list
  }

  /** The line under every direct price: whether service and PB1 come on top. */
  const priceNote = (w: World) => {
    const rates = ratesOn(w.inv.tax, today())
    return taxNote({ mode: w.inv.tax.directMode, servicePct: rates?.servicePct ?? 0, pb1Pct: rates?.pb1Pct ?? 0 })
  }

  function figures(w: World): SiteFigures {
    const open = w.openUnits(() => true)
    return {
      villas: w.villas.length,
      locations: new Set(w.villas.map((v) => v.locationId)).size,
      rooms: open.length,
      roomTypes: new Set(open.map((u) => u.groupId)).size,
      services: menuLines(w.inv.menu).length,
    }
  }

  const sellable = (o: SiteOffer) => o.free > 0 && o.fits && o.rules.length === 0 && o.quote !== null

  return {
    /** The home page: villas, locations, the menu lines that make up a day and the experiences. */
    async home() {
      const w = await world()
      const lines = menuLines(w.inv.menu)
      const day = Object.fromEntries(DAY_MOMENTS.map((m) => [m, lines.find(DAY_PICK[m]) ?? lines.find((i) => i.category === DAY_FALLBACK[m]) ?? null])) as Record<DayMoment, SiteMenuLine | null>
      const experiences = SITE_EXPERIENCES.map((category) => {
        // The fullest offers first; the from-price is the cheapest line.
        const items = lines.filter((i) => i.category === category).sort((a, b) => b.price - a.price)
        return { category, label: MENU_CATEGORY_LABEL[category], from: items.length ? Math.min(...items.map((i) => i.price)) : null, items: items.slice(0, 3) }
      }).filter((e) => e.items.length > 0)
      const villas = w.villas.map((v) => describeVilla(w, v))
      return {
        today: today(),
        villas,
        locations: w.inv.locations.filter((l) => villas.some((v) => v.location.id === l.id && v.open)),
        day,
        experiences,
        contact: w.inv.contact,
        taxNote: priceNote(w),
        figures: figures(w),
      }
    },

    /** The company page: figures, each location with its villas, and the team as roles and head counts. */
    async about() {
      const w = await world()
      const villas = w.villas.map((v) => describeVilla(w, v))
      const departments = [...new Set(w.inv.team.map((r) => r.department))]
      return {
        today: today(),
        figures: figures(w),
        locations: w.inv.locations.map((l) => ({ location: l, villas: villas.filter((v) => v.location.id === l.id) })).filter((l) => l.villas.length > 0),
        team: departments.map((d) => ({ department: DEPARTMENT_LABEL[d], roles: w.inv.team.filter((r) => r.department === d).map(({ position, people }) => ({ position, people })) })),
        people: w.inv.team.reduce((sum, r) => sum + r.people, 0),
        contact: w.inv.contact,
      }
    },

    /** One villa's landing page: room types with prices for the next two weeks, facilities and stay rules. */
    async villa(id: string) {
      const w = await world()
      const villa = findById(w.villas, id, 'villa')
      const groups = w.inv.groups.filter((g) => g.villaId === id)
      const notes = [...new Set(w.restrictions.filter((r) => groups.some((g) => g.id === r.groupId) && r.unitId === null).map(stayNote).filter((n): n is string => n !== null))]
      return {
        today: today(),
        villa: describeVilla(w, villa),
        roomTypes: groups.map((g) => describeType(w, g)).filter((t) => t.rooms > 0),
        stayNotes: notes,
        others: w.villas.filter((v) => v.id !== id).map((v) => describeVilla(w, v)).filter((v) => v.open),
        contact: w.inv.contact,
        taxNote: priceNote(w),
      }
    },

    /** Free rooms and quotes for one villa's room types over the stay. */
    async availability(villaId: string, checkIn: IsoDate, checkOut: IsoDate, guests: number) {
      const problem = validateStay(checkIn, checkOut) ?? (checkIn < today() ? 'Pick a check-in date from today on.' : null)
      if (problem) return { problem, offers: [] as SiteOffer[] }
      return { problem: null, offers: await offers((w) => [findById(w.villas, villaId, 'villa')], checkIn, checkOut, guests) }
    },

    /** Room types free for the stay across villas, in a location or everywhere, cheapest first. */
    async search(q: SiteSearch) {
      const problem = validateStay(q.checkIn, q.checkOut) ?? (q.checkIn < today() ? 'Pick a check-in date from today on.' : null)
      const w = await world()
      const locations = w.inv.locations
      if (problem) return { problem, results: [] as SiteOffer[], unavailable: 0, locations, today: today() }
      const all = await offers((x) => x.villas.filter((v) => !q.location || v.locationId === q.location), q.checkIn, q.checkOut, q.guests)
      const results = all.filter(sellable).sort((a, b) => (a.quote?.total ?? 0) - (b.quote?.total ?? 0))
      return { problem: null, results, unavailable: all.length - results.length, locations, today: today() }
    },

    /** The villas and room types the request to book form offers. */
    async enquiryOptions() {
      const w = await world()
      return {
        today: today(),
        villas: w.villas.map((v) => describeVilla(w, v)).filter((v) => v.open),
        roomTypes: w.inv.groups.filter((g) => w.openUnits((u) => u.groupId === g.id).length > 0).map((g) => ({ id: g.id, villaId: g.villaId, name: g.name, sleeps: typeSleeps(w.openUnits((u) => u.groupId === g.id)) })),
        contact: w.inv.contact,
      }
    },

    /** Sends a request to book, or an owner's note about their villa; the team replies by WhatsApp or email. */
    async enquire(input: EnquiryInput) {
      const errors: Record<string, string | undefined> = validateEnquiry(input, today())
      if (!isOwnerEnquiry(input) && input.groupId && !errors.villaId) {
        const w = await world()
        const g = w.inv.groups.find((x) => x.id === input.groupId)
        if (!g || g.villaId !== input.villaId) errors.groupId = 'Pick a room type of this villa.'
      }
      check(errors)
      return ports.site.enquire(input)
    },
  }
}

export type SiteServices = ReturnType<typeof createSiteServices>

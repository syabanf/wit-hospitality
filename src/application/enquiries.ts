import type { Action, Module, Permissions, User } from '@/domain/access'
import { ENQUIRY_STATUSES, type Enquiry, type EnquiryStatus } from '@/domain/enquiry'
import { findById } from '@/domain/errors'
import { countryName, type Guest } from '@/domain/guest'
import type { Catalog } from '@/domain/property'
import { daysBetween, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; permissions: Permissions; can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
}

export interface EnquiryView extends Enquiry {
  villaName: string
  groupName: string | null
  countryName: string
  nights: number
  bookingCode: string | null
}

/** What the new booking form starts from when it converts an enquiry. */
export interface EnquiryPrefill {
  enquiryId: string
  number: string
  /** A guest already on file with the same email, else null and the form adds `guest`. */
  guestId: string | null
  guest: { name: string; email: string; phone: string; nationality: string }
  villaId: string
  groupId: string | null
  /** True when the room type sells by type and the operator assigns the room. */
  byType: boolean
  checkIn: IsoDate
  checkOut: IsoDate
  notes: string
}

/** Web enquiries for the reservations team, scoped to the villas the person may see. */
export function createEnquiryServices({ ports, today, catalog, allow, access, check }: Deps) {
  async function world() {
    await allow('booking', 'view')
    const [cat, list, bookings] = await Promise.all([catalog(), ports.enquiries.enquiries(), ports.booking.bookings()])
    const villaIds = new Set(cat.villas.map((v) => v.id))
    const describe = (e: Enquiry): EnquiryView => ({
      ...e,
      villaName: cat.villa(e.villaId).name,
      groupName: e.groupId ? (cat.groups.find((g) => g.id === e.groupId)?.name ?? null) : null,
      countryName: countryName(e.country),
      nights: daysBetween(e.checkIn, e.checkOut),
      bookingCode: e.bookingId ? (bookings.find((b) => b.id === e.bookingId)?.code ?? null) : null,
    })
    return { cat, views: list.filter((e) => villaIds.has(e.villaId)).map(describe) }
  }

  return {
    async list() {
      const [{ views }, a] = await Promise.all([world(), access()])
      const counts = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, views.filter((e) => e.status === s).length])) as Record<EnquiryStatus, number>
      return { today: today(), list: views, counts, mayEdit: a.can('booking', 'edit') && a.can('booking', 'create') }
    },

    /** New enquiries waiting for a reply; zero for someone who cannot see bookings. */
    async waiting() {
      const a = await access()
      if (!a.can('booking', 'view')) return 0
      return (await world()).views.filter((e) => e.status === 'new').length
    },

    async setStatus(id: string, status: 'contacted' | 'closed', note: string) {
      check({ note: status === 'closed' && note.trim().length < 3 ? 'Say why it is closed.' : undefined })
      return ports.enquiries.setStatus(id, status, note)
    },

    /** The booking form's starting values: guest, villa, room type, dates and the guest's note. */
    async prefill(id: string): Promise<EnquiryPrefill> {
      const { cat, views } = await world()
      const e = findById(views, id, 'enquiry')
      const guests: Guest[] = await ports.guest.guests()
      const known = guests.find((g) => g.email && g.email.toLowerCase() === e.email.toLowerCase())
      const group = e.groupId ? cat.groups.find((g) => g.id === e.groupId) : undefined
      return {
        enquiryId: e.id,
        number: e.number,
        guestId: known?.id ?? null,
        guest: { name: e.name, email: e.email, phone: e.whatsapp, nationality: e.country },
        villaId: e.villaId,
        groupId: e.groupId,
        byType: Boolean(group?.operatorAssigns),
        checkIn: e.checkIn,
        checkOut: e.checkOut,
        notes: [`Web enquiry ${e.number}, ${e.guests} ${e.guests === 1 ? 'guest' : 'guests'}.`, e.note].filter(Boolean).join(' '),
      }
    },

    /** Marks the enquiry converted with the booking just made from it. */
    convert: (id: string, bookingId: string) => ports.enquiries.convert(id, bookingId),
  }
}

import type { Action, Module, User } from '@/domain/access'
import { validatePreferences } from '@/domain/hospitality'
import type { Booking } from '@/domain/booking'
import { findById } from '@/domain/errors'
import type { Guest } from '@/domain/guest'
import { checkinTokenFor, checkinUrl, filterMessages, invoiceTokenFor, invoiceUrl, languageFor, validateMessagingSettings, validateSend, type Message, type MessagingSettings, type SendMessageInput, type TemplateKey } from '@/domain/messaging'
import type { PaymentMethod } from '@/domain/payment'
import { validatePreCheckIn, type PreCheckIn, type PreCheckInInput, type PreCheckInStatus } from '@/domain/precheckin'
import type { UploadFile } from '@/domain/attachment'
import type { Catalog } from '@/domain/property'
import { addDays, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { BookingView } from './views'

export interface MessageView extends Message {
  bookingCode: string
  guestName: string
  villaName: string
  unitCode: string
  /** The template's name, or "Free message". */
  templateName: string
}

/** A stay's online check-in as the front desk sees it. */
export interface PreCheckInView {
  booking: BookingView
  status: PreCheckInStatus
  record: PreCheckIn | null
  /** The guest-facing link and the local path that opens the same page here. */
  url: string
  path: string
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ can: (module: Module, action: Action) => boolean }>
  world: () => Promise<{ cat: Catalog; bookings: Booking[]; guests: Guest[]; views: BookingView[]; describe: (b: Booking) => BookingView }>
  check: (errors: Record<string, string | undefined>) => void
}

/** Guest messages and online check-in, narrowed to the stays the signed-in user may see. */
export function createMessagingServices({ ports, today, allow, access, world, check }: Deps) {
  async function messageWorld() {
    const [w, all, settings, a, accounts, invoices] = await Promise.all([world(), ports.messaging.messages(), ports.messaging.settings(), access(), ports.cityLedger.accounts(), ports.cityLedger.invoices()])
    const ids = new Set(w.bookings.map((b) => b.id))
    const nameOf = (key: TemplateKey | null) => (key ? (settings.templates.find((t) => t.key === key)?.name ?? key) : 'Free message')
    const describe = (m: Message): MessageView => {
      const b = w.describe(findById(w.bookings, m.bookingId, 'booking'))
      return { ...m, bookingCode: b.code, guestName: b.guestName, villaName: b.place.villa.name, unitCode: b.unitCode, templateName: nameOf(m.templateKey) }
    }
    // A city ledger invoice goes to a company, not a stay: finance sees it under the invoice number and the account.
    const billed = a.can('finance', 'view') ? all.flatMap((m) => (m.cityLedger ? [{ ...m, bookingCode: invoices.find((i) => i.id === m.cityLedger?.invoiceId)?.number ?? '', guestName: accounts.find((x) => x.id === m.cityLedger?.accountId)?.name ?? '', villaName: '', unitCode: '', templateName: nameOf(m.templateKey) }] : [])) : []
    const views = [...all.filter((m) => ids.has(m.bookingId)).map(describe), ...billed].sort((x, y) => y.queuedAt.localeCompare(x.queuedAt))
    return { w, settings, views }
  }

  async function preWorld() {
    const [w, records] = await Promise.all([world(), ports.precheckin.preCheckIns()])
    const viewOf = (b: Booking): PreCheckInView => {
      const record = records.find((r) => r.bookingId === b.id) ?? null
      return { booking: w.describe(b), status: record?.status ?? 'not_started', record, url: checkinUrl(b.id), path: `/checkin/${checkinTokenFor(b.id)}` }
    }
    return { w, viewOf }
  }

  const messaging = {
    async list() {
      await allow('booking', 'view')
      const mw = await messageWorld()
      return { list: mw.views, templates: mw.settings.templates, today: today() }
    },
    /** The conversation with one stay's guest, with what the send form needs. */
    async forBooking(bookingId: string) {
      const [mw, a] = await Promise.all([messageWorld(), access(), allow('booking', 'view')])
      const b = mw.w.describe(findById(mw.w.bookings, bookingId, 'booking'))
      return {
        booking: b,
        messages: mw.views.filter((m) => m.bookingId === bookingId),
        templates: mw.settings.templates,
        language: languageFor(b.guest),
        invoice: { url: invoiceUrl(b.id), path: `/invoice/${invoiceTokenFor(b.id)}` },
        canSend: a.can('booking', 'edit'),
      }
    },
    /** Every message to the guest across their stays. */
    async forGuest(guestId: string) {
      const [mw] = await Promise.all([messageWorld(), allow('booking', 'view')])
      return mw.views.filter((m) => m.guestId === guestId)
    },
    async send(input: SendMessageInput) {
      await allow('booking', 'edit')
      check(validateSend(input))
      return ports.messaging.send(input)
    },
    async resend(id: string) {
      await allow('booking', 'edit')
      return ports.messaging.resend(id)
    },
    async settings() {
      await allow('booking', 'view')
      const [settings, w, a] = await Promise.all([ports.messaging.settings(), world(), access()])
      return { settings, villas: w.cat.villas, canEdit: a.can('booking', 'edit') }
    },
    async saveSettings(settings: MessagingSettings) {
      await allow('booking', 'edit')
      check(validateMessagingSettings(settings))
      return ports.messaging.saveSettings(settings)
    },
    /** Public: the e-invoice link the thank-you message carries. */
    invoice: (token: string) => ports.messaging.invoice(token),
    filter: filterMessages,
  }

  const precheckin = {
    async forBooking(bookingId: string) {
      const pw = await preWorld()
      return pw.viewOf(findById(pw.w.bookings, bookingId, 'booking'))
    },
    /** Confirmed stays arriving today and over the next week, today first, each with its online check-in. */
    async arrivals(days = 7) {
      await allow('booking', 'view')
      const pw = await preWorld()
      const until = addDays(today(), days)
      const rows = pw.w.bookings.filter((b) => b.status === 'confirmed' && b.checkIn <= until && b.checkOut > today()).sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.code.localeCompare(b.code)).map(pw.viewOf)
      return { rows, today: today() }
    },
    /** Online check-in status per booking id, for today's arrivals on the phone. */
    async statuses(): Promise<Record<string, PreCheckInStatus>> {
      const records = await ports.precheckin.preCheckIns()
      return Object.fromEntries(records.map((r) => [r.bookingId, r.status]))
    },
    async verify(bookingId: string) {
      await allow('booking', 'edit')
      return ports.precheckin.verify(bookingId)
    },
    /** Public: the guest's page behind the link. */
    guest: (token: string) => ports.precheckin.guestView(token),
    /** Public: the form is checked here so the page shows every field error at once. */
    async submit(token: string, input: PreCheckInInput) {
      const view = await ports.precheckin.guestView(token)
      check({ ...validatePreCheckIn(input, view), ...(input.preferences ? validatePreferences(input.preferences) : {}) })
      return ports.precheckin.submit(token, input)
    },
    /** Public: an ID photo, stored once the link is known to be live. */
    async upload(token: string, file: UploadFile) {
      await ports.precheckin.guestView(token)
      return ports.files.upload(file)
    },
    payBalance: (token: string, method: PaymentMethod) => ports.precheckin.payBalance(token, method),
  }

  return { messaging, precheckin }
}

import type { Booking } from '@/domain/booking'
import type { Guest } from '@/domain/guest'
import { addressFor, checkinUrl, DEFAULT_TEMPLATES, invoiceUrl, languageFor, renderTemplate, SYSTEM_SENDER, type Message, type MessageStatus, type MessagingSettings, type TemplateKey } from '@/domain/messaging'
import type { Payment } from '@/domain/payment'
import { isIndonesian, type PreCheckIn, type TravellerDocument } from '@/domain/precheckin'
import type { Catalog } from '@/domain/property'
import { addDays, type IsoDate } from '@/lib/dates'

/** WiFi per villa for the welcome message. */
const WIFI: Record<string, string> = {
  'vil-saka': 'SakaGuest / saka2026',
  'vil-tirta': 'Tirta-Valley / ayung2026',
  'vil-lumbung': 'Lumbung-Loft / petitenget',
  'vil-karang': 'Karang-Cliff / uluwatu26',
  'vil-pandawa': 'Pandawa / ask the desk',
}

interface SeedInput {
  today: IsoDate
  catalog: Catalog
  bookings: readonly Booking[]
  guests: readonly Pick<Guest, 'id' | 'name' | 'email' | 'phone' | 'nationality' | 'idType' | 'idNumber'>[]
  payments: readonly Payment[]
}

/**
 * Message history for stays from ten days back to ten ahead: confirmation, receipts, pre-arrival, welcome,
 * reminder and thank you, as the triggers would have sent them. One pre-arrival bounced so the desk can resend it.
 * Two of today's arrivals sent their online check-in; one more arrival is already verified.
 */
export function seedMessaging({ today, catalog, bookings, guests, payments }: SeedInput) {
  const settings: MessagingSettings = { preArrivalDays: 3, wifi: { ...WIFI }, templates: DEFAULT_TEMPLATES.map((t) => structuredClone(t)) }
  const messages: Message[] = []
  const guestOf = (b: Booking) => guests.find((g) => g.id === b.guestId)
  const template = (key: TemplateKey) => settings.templates.find((t) => t.key === key)
  let n = 0

  function add(b: Booking, key: TemplateKey, on: IsoDate, minute: number, status: MessageStatus, extra: { link?: string; amount?: number; error?: string } = {}) {
    const guest = guestOf(b)
    const t = template(key)
    if (!guest || !t || on > today) return
    const place = catalog.place(b.unitId)
    const language = languageFor(guest)
    const vars = { guest: guest.name.split(' ')[0], villa: place.villa.name, unit: place.unit.code, code: b.code, checkIn: b.checkIn, checkOut: b.checkOut, wifi: WIFI[place.villa.id] ?? '', ...extra }
    const at = (plus: number) => `${on}T${String(Math.floor((minute + plus) / 60) % 24).padStart(2, '0')}:${String((minute + plus) % 60).padStart(2, '0')}:00`
    n += 1
    const failed = status === 'failed'
    messages.push({
      id: `msg-${n}`,
      number: `MSG-${String(n).padStart(4, '0')}`,
      bookingId: b.id,
      guestId: guest.id,
      to: failed ? guest.phone.replace(/\d{3}$/, '000') : addressFor(guest, t.channel),
      channel: t.channel,
      templateKey: key,
      language,
      subject: renderTemplate(t.subject[language], vars),
      body: renderTemplate(t.body[language], vars),
      status,
      sentBy: SYSTEM_SENDER,
      sentById: null,
      queuedAt: at(0),
      sentAt: failed ? null : at(0),
      deliveredAt: status === 'delivered' || status === 'read' ? at(1) : null,
      readAt: status === 'read' ? at(14) : null,
      failedAt: failed ? at(0) : null,
      error: extra.error ?? '',
      attempts: 1,
    })
  }

  const live = bookings.filter((b) => b.status !== 'draft' && b.status !== 'cancelled' && b.checkOut >= addDays(today, -10) && b.checkIn <= addDays(today, 10))
  live.forEach((b, i) => {
    add(b, 'booking_confirmed', b.createdOn, 9 * 60 + (i % 50), 'read')
    for (const p of payments.filter((x) => x.bookingId === b.id && x.status === 'paid' && x.kind !== 'refund' && x.kind !== 'payout' && x.paidOn)) add(b, 'payment_received', p.paidOn ?? today, 11 * 60 + (i % 40), 'delivered', { amount: p.amount })
    const preOn = addDays(b.checkIn, -settings.preArrivalDays)
    if (preOn <= today) add(b, 'pre_arrival', preOn < today ? preOn : today, 10 * 60, i === 3 ? 'failed' : i % 3 === 0 ? 'delivered' : 'read', { link: checkinUrl(b.id), ...(i === 3 ? { error: 'Number is not on WhatsApp' } : {}) })
    if (b.checkedInOn) add(b, 'welcome', b.checkedInOn, 14 * 60 + 20, 'read')
    if (b.status === 'checked_out' || (b.status === 'checked_in' && addDays(b.checkOut, -1) < today)) add(b, 'checkout_reminder', addDays(b.checkOut, -1), 18 * 60, 'read')
    if (b.checkedOutOn) add(b, 'post_stay', b.checkedOutOn, 13 * 60, 'delivered', { link: invoiceUrl(b.id) })
  })
  messages.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
  messages.forEach((m, i) => {
    m.id = `msg-${i + 1}`
    m.number = `MSG-${String(i + 1).padStart(4, '0')}`
  })

  // Online check-in: two of today's arrivals sent theirs, the next arrival after them is verified.
  const arrivals = bookings.filter((b) => b.status === 'confirmed' && b.checkIn >= today && !b.bookingGroupId).sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.code.localeCompare(b.code))
  const preCheckIns: PreCheckIn[] = arrivals.slice(0, 3).flatMap((b, i) => {
    const guest = guestOf(b)
    if (!guest) return []
    const local = isIndonesian(guest.nationality)
    const lead: TravellerDocument = {
      name: guest.name,
      nationality: guest.nationality,
      documentType: guest.idType,
      documentNumber: guest.idNumber,
      documentExpiry: local ? '' : addDays(today, 900 + i * 200),
      dateOfBirth: `${1984 + i * 3}-0${i + 3}-1${i}`,
      sex: i === 1 ? 'male' : 'female',
      entryDate: local ? '' : addDays(b.checkIn, -1),
      portOfEntry: local ? '' : 'Ngurah Rai International Airport (DPS)',
      visaType: local ? 'none' : 'voa',
    }
    const companion: TravellerDocument = { ...lead, name: i === 1 ? 'Sofia Rossi' : 'Daniel Brooks', nationality: local ? guest.nationality : 'Australia', documentType: local ? 'ktp' : 'passport', documentNumber: local ? `51710${i}4407890003` : `PA${930117 + i}`, dateOfBirth: `${1986 + i}-11-0${i + 2}`, sex: i === 1 ? 'female' : 'male' }
    const submittedAt = `${addDays(today, -1 - i)}T${String(19 + i).padStart(2, '0')}:12:00`
    const verified = i === 2
    return [
      {
        bookingId: b.id,
        email: guest.email,
        phone: guest.phone,
        arrivalTime: ['15:30', '13:45', '17:10'][i] ?? '14:00',
        flight: local ? '' : ['QZ 507', 'JQ 37', 'GA 404'][i] ?? '',
        adults: 2,
        children: i === 0 ? 1 : 0,
        travellers: [lead, companion],
        idPhotos: [{ id: `file-pre-${b.id}`, name: `${guest.idType}-${guest.name.split(' ')[0]?.toLowerCase()}.jpg`, type: 'image/jpeg', size: 0, url: '', uploadedBy: 'Guest', uploadedAt: submittedAt }],
        rulesName: guest.name,
        rulesAccepted: true,
        status: verified ? 'verified' : 'submitted',
        submittedAt,
        verifiedBy: verified ? 'Wayan Sudiarta' : null,
        verifiedById: verified ? 'usr-wayan' : null,
        verifiedAt: verified ? `${today}T08:40:00` : null,
      },
    ]
  })
  return { settings, messages, preCheckIns }
}

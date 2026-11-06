import { addDays, shortDay, withinRange, type IsoDate } from '@/lib/dates'
import { isIndonesian } from './precheckin'

export type MessageChannel = 'whatsapp' | 'email'
export const MESSAGE_CHANNELS: readonly MessageChannel[] = ['whatsapp', 'email']
export const CHANNEL_LABEL: Record<MessageChannel, string> = { whatsapp: 'WhatsApp', email: 'Email' }

export type MessageLanguage = 'en' | 'id'
export const MESSAGE_LANGUAGES: readonly MessageLanguage[] = ['en', 'id']
export const LANGUAGE_LABEL: Record<MessageLanguage, string> = { en: 'English', id: 'Bahasa Indonesia' }

/** Each template answers one trigger in the stay. */
export type TemplateKey = 'booking_confirmed' | 'payment_link' | 'payment_received' | 'pre_arrival' | 'welcome' | 'checkout_reminder' | 'post_stay'
export const TEMPLATE_KEYS: readonly TemplateKey[] = ['booking_confirmed', 'payment_link', 'payment_received', 'pre_arrival', 'welcome', 'checkout_reminder', 'post_stay']
/** When the console sends each template on its own. */
export const TRIGGER_LABEL: Record<TemplateKey, string> = {
  booking_confirmed: 'When the booking is confirmed',
  payment_link: 'When staff send a payment link',
  payment_received: 'When a payment is received',
  pre_arrival: 'Days before arrival, with the online check-in link',
  welcome: 'At check-in',
  checkout_reminder: 'The evening before departure',
  post_stay: 'At check-out, with the e-invoice and a review request',
}

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
export const MESSAGE_STATUSES: readonly MessageStatus[] = ['queued', 'sent', 'delivered', 'read', 'failed']
export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' }

export interface MessageTemplate {
  key: TemplateKey
  name: string
  channel: MessageChannel
  /** Off stops the automatic send; staff can still send the template by hand. */
  enabled: boolean
  /** Email subject per language; WhatsApp ignores it. */
  subject: Record<MessageLanguage, string>
  body: Record<MessageLanguage, string>
}

export interface MessagingSettings {
  /** The pre-arrival message goes this many days before check-in. */
  preArrivalDays: number
  /** Network and password per villa id, for the welcome message. */
  wifi: Record<string, string>
  templates: MessageTemplate[]
}

export interface Message {
  id: string
  number: string
  bookingId: string
  guestId: string
  /** The phone number or email address it went to. */
  to: string
  channel: MessageChannel
  /** Null for a free message typed by staff. */
  templateKey: TemplateKey | null
  language: MessageLanguage
  subject: string
  body: string
  status: MessageStatus
  /** 'System' for a trigger, else the staff member's name. */
  sentBy: string
  sentById: string | null
  /** ISO date-times. */
  queuedAt: string
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  failedAt: string | null
  /** What the provider answered when it failed. */
  error: string
  attempts: number
}

export const SYSTEM_SENDER = 'System'

/** What staff send from the booking page: a template, or their own words with `templateKey` null. */
export interface SendMessageInput {
  bookingId: string
  channel: MessageChannel
  templateKey: TemplateKey | null
  language: MessageLanguage
  /** Free messages only; a template renders its own body. */
  body: string
}

export function validateSend(input: SendMessageInput): Partial<Record<keyof SendMessageInput, string>> {
  const errors: Partial<Record<keyof SendMessageInput, string>> = {}
  if (!input.bookingId) errors.bookingId = 'Pick the booking.'
  if (!MESSAGE_CHANNELS.includes(input.channel)) errors.channel = 'Pick WhatsApp or email.'
  if (!MESSAGE_LANGUAGES.includes(input.language)) errors.language = 'Pick the language.'
  if (input.templateKey === null && input.body.trim().length < 2) errors.body = 'Write the message.'
  if (input.body.length > 2000) errors.body = 'Keep it under 2,000 characters.'
  return errors
}

export function validateMessagingSettings(s: MessagingSettings): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {}
  if (!Number.isInteger(s.preArrivalDays) || s.preArrivalDays < 1 || s.preArrivalDays > 14) errors.preArrivalDays = '1 to 14 days.'
  for (const t of s.templates) {
    for (const lang of MESSAGE_LANGUAGES) if (t.body[lang].trim().length < 10) errors[`${t.key}.${lang}`] = `Write the ${LANGUAGE_LABEL[lang]} text of ${t.name}.`
    if (!MESSAGE_CHANNELS.includes(t.channel)) errors[`${t.key}.channel`] = 'Pick WhatsApp or email.'
  }
  return errors
}

/** The values a template can name. Missing ones render as an empty string. */
export interface MessageVars {
  guest: string
  villa: string
  unit: string
  code: string
  checkIn: IsoDate
  checkOut: IsoDate
  link: string
  amount: number
  wifi: string
}

export const PLACEHOLDERS: readonly (keyof MessageVars)[] = ['guest', 'villa', 'unit', 'code', 'checkIn', 'checkOut', 'link', 'amount', 'wifi']

/** Fills `{guest}`, `{checkIn}` and the rest; unknown names stay as typed so staff see the mistake. */
export function renderTemplate(text: string, vars: Partial<MessageVars>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return whole
    const v = vars[name as keyof MessageVars]
    if (v === undefined) return ''
    if (name === 'amount') return `Rp ${Number(v).toLocaleString('id-ID')}`
    if (name === 'checkIn' || name === 'checkOut') return shortDay(String(v))
    return String(v)
  })
}

/** Indonesian guests read Bahasa Indonesia, everyone else English. */
export const languageFor = (guest: { nationality: string }): MessageLanguage => (isIndonesian(guest.nationality) ? 'id' : 'en')

/** Where a message to this guest goes on the channel, or empty when the profile has no contact for it. */
export const addressFor = (guest: { phone: string; email: string }, channel: MessageChannel) => (channel === 'whatsapp' ? guest.phone.trim() : guest.email.trim())

/** The guest-facing site the links point at; the console opens the same paths locally. */
export const GUEST_SITE = 'https://stay.balivillas.id'
export const REVIEW_LINK = 'https://g.page/r/balivillas/review'

/** Deterministic signed token from a booking id and a purpose. A real backend signs with a secret key. */
function sign(purpose: string, bookingId: string): string {
  let h = 2166136261
  for (const c of `${purpose}:${bookingId}:bali-villas`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (h >>> 0).toString(36).padStart(7, '0')
}
const tokenFor = (purpose: string, prefix: string) => (bookingId: string) => `${prefix}${bookingId.replace(/[^a-z0-9]/gi, '').toLowerCase()}${sign(purpose, bookingId)}`
export const invoiceTokenFor = tokenFor('invoice', 'iv')
export const checkinTokenFor = tokenFor('checkin', 'ci')

export const invoiceUrl = (bookingId: string) => `${GUEST_SITE}/invoice/${invoiceTokenFor(bookingId)}`
export const checkinUrl = (bookingId: string) => `${GUEST_SITE}/checkin/${checkinTokenFor(bookingId)}`
export const payUrl = (token: string) => `${GUEST_SITE}/pay/${token}`

/** The local path behind a guest-site link, so the console can open what the guest would see. */
export const localPath = (url: string) => (url.startsWith(GUEST_SITE) ? url.slice(GUEST_SITE.length) : null)

/** A stay as the time triggers read it. */
export interface TriggerStay {
  status: string
  checkIn: IsoDate
  checkOut: IsoDate
}

/** Hour of the day the time triggers go out: pre-arrival in the morning, the reminder in the evening. */
export const PRE_ARRIVAL_HOUR = 10
export const REMINDER_HOUR = 18

/**
 * Time triggers due for a stay at `now` (ISO date-time): pre-arrival from `days` before arrival up to
 * the day itself, the checkout reminder on the evening before departure. The caller drops those already sent.
 */
export function dueTimeTriggers(b: TriggerStay, now: string, days: number): TemplateKey[] {
  const today = now.slice(0, 10)
  const hour = Number(now.slice(11, 13))
  const due: TemplateKey[] = []
  const from = addDays(b.checkIn, -days)
  if (b.status === 'confirmed' && (today > from || (today === from && hour >= PRE_ARRIVAL_HOUR)) && today <= b.checkIn) due.push('pre_arrival')
  if (b.status === 'checked_in' && today === addDays(b.checkOut, -1) && hour >= REMINDER_HOUR) due.push('checkout_reminder')
  return due
}

/** The trigger a booking status change fires. */
export const STATUS_TRIGGER: Partial<Record<string, TemplateKey>> = { confirmed: 'booking_confirmed', checked_in: 'welcome', checked_out: 'post_stay' }

/** The provider moves a queued message on with time: sent after a second, delivered after five. */
export function providerStatus(m: Pick<Message, 'status' | 'queuedAt'>, now: string): MessageStatus {
  if (m.status !== 'queued' && m.status !== 'sent') return m.status
  const age = (Date.parse(`${now}Z`) - Date.parse(`${m.queuedAt}Z`)) / 1000
  return age >= 5 ? 'delivered' : age >= 1 ? 'sent' : m.status
}

export const canResend = (m: Pick<Message, 'status'>) => m.status === 'failed'

export interface MessageFilter {
  status?: MessageStatus | 'all'
  channel?: MessageChannel | ''
  templateKey?: TemplateKey | 'free' | ''
  query?: string
  from?: string
  to?: string
}

export function filterMessages<T extends Message & { bookingCode: string; guestName: string }>(list: readonly T[], f: MessageFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((m) => {
    if (f.status && f.status !== 'all' && m.status !== f.status) return false
    if (f.channel && m.channel !== f.channel) return false
    if (f.templateKey === 'free' && m.templateKey !== null) return false
    if (f.templateKey && f.templateKey !== 'free' && m.templateKey !== f.templateKey) return false
    if (!withinRange(m.queuedAt.slice(0, 10), f.from, f.to)) return false
    if (q && ![m.number, m.bookingCode, m.guestName, m.to, m.body].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

const T = (key: TemplateKey, name: string, channel: MessageChannel, subject: [string, string], en: string, id: string): MessageTemplate => ({ key, name, channel, enabled: true, subject: { en: subject[0], id: subject[1] }, body: { en, id } })

/** The starting templates in English and Bahasa Indonesia; settings edit and switch them. */
export const DEFAULT_TEMPLATES: readonly MessageTemplate[] = [
  T(
    'booking_confirmed',
    'Booking confirmation',
    'email',
    ['Your stay at {villa} is confirmed', 'Pemesanan Anda di {villa} terkonfirmasi'],
    'Hi {guest}, your stay at {villa} from {checkIn} to {checkOut} is confirmed. Booking {code}. We look forward to welcoming you.',
    'Halo {guest}, menginap Anda di {villa} dari {checkIn} sampai {checkOut} sudah terkonfirmasi. Kode pemesanan {code}. Kami menantikan kedatangan Anda.',
  ),
  T(
    'payment_link',
    'Payment link',
    'whatsapp',
    ['Payment for {code}', 'Pembayaran untuk {code}'],
    'Hi {guest}, here is the payment link for {amount} on booking {code}: {link}',
    'Halo {guest}, berikut tautan pembayaran sebesar {amount} untuk pemesanan {code}: {link}',
  ),
  T(
    'payment_received',
    'Payment receipt',
    'whatsapp',
    ['We received your payment', 'Pembayaran Anda sudah kami terima'],
    'Thank you {guest}, we received {amount} for booking {code}.',
    'Terima kasih {guest}, kami sudah menerima {amount} untuk pemesanan {code}.',
  ),
  T(
    'pre_arrival',
    'Pre-arrival and online check-in',
    'whatsapp',
    ['Check in online before you arrive', 'Check-in online sebelum tiba'],
    'Hi {guest}, we are getting {villa} ready for {checkIn}. Save time at arrival: confirm your details, upload your ID and sign the house rules here: {link}',
    'Halo {guest}, kami sedang menyiapkan {villa} untuk {checkIn}. Hemat waktu saat tiba: isi data, unggah identitas dan setujui aturan rumah di sini: {link}',
  ),
  T(
    'welcome',
    'Check-in welcome',
    'whatsapp',
    ['Welcome to {villa}', 'Selamat datang di {villa}'],
    'Welcome to {villa}, {guest}! You are in {unit}. WiFi: {wifi}. House rules: quiet hours from 22:00, no smoking indoors, no glass by the pool. Message us here any time.',
    'Selamat datang di {villa}, {guest}! Anda menempati {unit}. WiFi: {wifi}. Aturan rumah: jam tenang mulai 22.00, dilarang merokok di dalam, tidak ada gelas kaca di kolam. Hubungi kami di sini kapan saja.',
  ),
  T(
    'checkout_reminder',
    'Checkout reminder',
    'whatsapp',
    ['Check-out tomorrow', 'Check-out besok'],
    'Hi {guest}, a reminder that check-out from {unit} is tomorrow, {checkOut}, by 12:00. Tell us if you need a late check-out or an airport transfer.',
    'Halo {guest}, pengingat bahwa check-out dari {unit} besok, {checkOut}, paling lambat pukul 12.00. Kabari kami bila perlu late check-out atau antar ke bandara.',
  ),
  T(
    'post_stay',
    'Thank you and e-invoice',
    'email',
    ['Thank you for staying at {villa}', 'Terima kasih telah menginap di {villa}'],
    `Thank you for staying with us, {guest}. Your invoice for {code} is here: {link}. We would love a review: ${REVIEW_LINK}`,
    `Terima kasih telah menginap bersama kami, {guest}. Invoice untuk {code} ada di sini: {link}. Kami senang sekali bila Anda memberi ulasan: ${REVIEW_LINK}`,
  ),
]

export const DEFAULT_MESSAGING_SETTINGS: MessagingSettings = { preArrivalDays: 3, wifi: {}, templates: DEFAULT_TEMPLATES.map((t) => structuredClone(t)) }

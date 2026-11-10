import type { IsoDate } from '@/lib/dates'
import { validateStay } from './booking'
import { COUNTRIES } from './guest'

/**
 * A request to book sent from the public website. It holds no room: the reservations team answers
 * by WhatsApp or email and, when the guest says yes, makes the booking from it.
 */

export type EnquiryStatus = 'new' | 'contacted' | 'converted' | 'closed'
export const ENQUIRY_STATUSES: readonly EnquiryStatus[] = ['new', 'contacted', 'converted', 'closed']
export const ENQUIRY_STATUS_LABEL: Record<EnquiryStatus, string> = { new: 'New', contacted: 'Contacted', converted: 'Converted', closed: 'Closed' }

/** Converted is the end; a closed enquiry can be picked up again. Converting goes through the booking. */
export const ENQUIRY_TRANSITIONS: Record<EnquiryStatus, readonly EnquiryStatus[]> = {
  new: ['contacted', 'converted', 'closed'],
  contacted: ['converted', 'closed'],
  converted: [],
  closed: ['contacted'],
}
export const canMoveEnquiry = (from: EnquiryStatus, to: EnquiryStatus) => ENQUIRY_TRANSITIONS[from].includes(to)

export const MAX_PARTY = 16

/** A guest planning a stay, or a villa owner asking about management. Owners send no dates or party. */
export type EnquiryTopic = 'stay' | 'owner'
export const ENQUIRY_TOPIC_LABEL: Record<EnquiryTopic, string> = { stay: 'Stay', owner: 'Villa owner' }
export const isOwnerEnquiry = (e: Pick<EnquiryInput, 'topic'>) => e.topic === 'owner'

export interface EnquiryInput {
  name: string
  email: string
  /** WhatsApp number with the country code. */
  whatsapp: string
  /** ISO country code, as guest nationality reads it. */
  country: string
  checkIn: IsoDate
  checkOut: IsoDate
  guests: number
  villaId: string
  /** The room type asked for, or null for any in the villa. */
  groupId: string | null
  note: string
  /** Missing means a stay, as every enquiry was before owners could write. */
  topic?: EnquiryTopic
}

export interface Enquiry extends EnquiryInput {
  id: string
  /** ENQ-0001. */
  number: string
  status: EnquiryStatus
  /** The booking made from it, once converted. */
  bookingId: string | null
  createdOn: IsoDate
  /** ISO date-time the guest sent it. */
  createdAt: string
  /** Who last moved it, and why. */
  handledBy: string | null
  statusNote: string
}

/** What the website tells the guest after sending: no copy of their data. */
export interface EnquiryReceipt {
  number: string
  villaName: string
  checkIn: IsoDate
  checkOut: IsoDate
}

export const enquiryNumber = (seq: number) => `ENQ-${String(seq).padStart(4, '0')}`

export function validateEnquiry(input: EnquiryInput, today: IsoDate): Partial<Record<keyof EnquiryInput, string>> {
  const errors: Partial<Record<keyof EnquiryInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter your name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) errors.email = 'Enter an email address we can reply to.'
  if (!/^\+?[\d\s-]{7,}$/.test(input.whatsapp.trim())) errors.whatsapp = 'Enter a WhatsApp number with the country code.'
  if (!COUNTRIES[input.country]) errors.country = 'Pick your country.'
  if (isOwnerEnquiry(input)) {
    if (input.note.trim().length < 10) errors.note = 'Tell us where the villa is and how many rooms it has.'
    else if (input.note.length > 1000) errors.note = 'Keep the note under 1,000 characters.'
    return errors
  }
  const stay = validateStay(input.checkIn, input.checkOut)
  if (stay) errors.checkOut = stay
  else if (input.checkIn < today) errors.checkIn = 'Pick a check-in date from today on.'
  if (!Number.isInteger(input.guests) || input.guests < 1 || input.guests > MAX_PARTY) errors.guests = `Enter from 1 to ${MAX_PARTY} guests.`
  if (!input.villaId) errors.villaId = 'Pick a villa.'
  if (input.note.length > 1000) errors.note = 'Keep the note under 1,000 characters.'
  return errors
}

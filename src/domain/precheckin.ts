import type { IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import type { CheckInDetails } from './booking'
import { countryCode, type CompanionInput, type Guest, type IdType, type StayCompanion } from './guest'

export type PreCheckInStatus = 'not_started' | 'submitted' | 'verified'
export const PRECHECKIN_STATUS_LABEL: Record<PreCheckInStatus, string> = { not_started: 'Not started', submitted: 'Submitted', verified: 'Verified' }

export type Sex = 'female' | 'male'
export const SEX_LABEL: Record<Sex, string> = { female: 'Female', male: 'Male' }

export type VisaType = 'none' | 'visa_free' | 'voa' | 'evisa' | 'kitas' | 'other'
export const VISA_TYPES: readonly VisaType[] = ['none', 'visa_free', 'voa', 'evisa', 'kitas', 'other']
export const VISA_LABEL: Record<VisaType, string> = { none: 'Not needed', visa_free: 'Visa free', voa: 'Visa on arrival', evisa: 'e-Visa', kitas: 'KITAS', other: 'Other' }

/**
 * One adult's identity document. The names match the fields the guest profile is gaining
 * (nationality, documentType, documentNumber, documentExpiry, dateOfBirth, sex, entryDate, portOfEntry, visaType),
 * so verifying copies them across one to one; see `guestFieldsFrom`.
 */
export interface TravellerDocument {
  name: string
  nationality: string
  documentType: IdType
  documentNumber: string
  documentExpiry: IsoDate
  dateOfBirth: IsoDate
  sex: Sex
  /** Foreign guests: the day they entered Indonesia, where, and on what visa. */
  entryDate: IsoDate
  portOfEntry: string
  visaType: VisaType
}

/** What the guest fills in on /checkin/:token. */
export interface PreCheckInInput {
  email: string
  phone: string
  /** HH:MM, local time. */
  arrivalTime: string
  flight: string
  adults: number
  children: number
  /** One per adult, the lead guest first. */
  travellers: TravellerDocument[]
  idPhotos: Attachment[]
  /** The house rules signed with a typed name and a tick. */
  rulesName: string
  rulesAccepted: boolean
}

export interface PreCheckIn extends PreCheckInInput {
  bookingId: string
  status: Exclude<PreCheckInStatus, 'not_started'>
  /** ISO date-times. */
  submittedAt: string
  verifiedBy: string | null
  verifiedById: string | null
  verifiedAt: string | null
}

export const HOUSE_RULES: readonly string[] = [
  'Check-in from 14:00, check-out by 12:00.',
  'Quiet hours from 22:00 to 07:00.',
  'No smoking inside the rooms; use the garden.',
  'No glass by the pool, and children swim with an adult.',
  'Visitors register at the front desk; no parties without the manager’s approval.',
  'Damage and missing items are charged at check-out.',
]

export const isIndonesian = (nationality: string) => /^(indonesia|indonesian|id)$/i.test(nationality.trim())

export function emptyTraveller(name = '', nationality = ''): TravellerDocument {
  return { name, nationality, documentType: isIndonesian(nationality) ? 'ktp' : 'passport', documentNumber: '', documentExpiry: '', dateOfBirth: '', sex: 'female', entryDate: '', portOfEntry: '', visaType: isIndonesian(nationality) ? 'none' : 'voa' }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Field errors keyed like the form: `travellers.0.documentNumber`. `checkOut` checks the passport outlives the stay. */
export function validatePreCheckIn(input: PreCheckInInput, stay: { checkIn: IsoDate; checkOut: IsoDate }): Record<string, string> {
  const errors: Record<string, string> = {}
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email address.'
  if (!/^\+?[\d\s-]{7,}$/.test(input.phone)) errors.phone = 'Enter a mobile number with the country code.'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.arrivalTime)) errors.arrivalTime = 'Enter the time you expect to arrive.'
  if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 12) errors.adults = '1 to 12 adults.'
  if (!Number.isInteger(input.children) || input.children < 0 || input.children > 12) errors.children = '0 to 12 children.'
  if (input.travellers.length !== input.adults) errors.travellers = 'Add the ID of every adult.'
  input.travellers.forEach((t, i) => {
    const at = (field: keyof TravellerDocument, text: string) => (errors[`travellers.${i}.${field}`] = text)
    if (t.name.trim().length < 2) at('name', 'Enter the name as on the document.')
    if (!t.nationality.trim()) at('nationality', 'Enter the nationality.')
    if (t.documentNumber.trim().length < 5) at('documentNumber', 'Enter the document number.')
    if (!DATE.test(t.dateOfBirth) || t.dateOfBirth >= stay.checkIn) at('dateOfBirth', 'Enter the date of birth.')
    if (t.documentType === 'passport') {
      if (!DATE.test(t.documentExpiry)) at('documentExpiry', 'Enter the expiry date.')
      else if (t.documentExpiry <= stay.checkOut) at('documentExpiry', 'The passport expires before the stay ends.')
    }
    if (!isIndonesian(t.nationality)) {
      if (!DATE.test(t.entryDate) || t.entryDate > stay.checkIn) at('entryDate', 'Enter the day you enter Indonesia, on or before arrival.')
      if (t.portOfEntry.trim().length < 3) at('portOfEntry', 'Enter the airport or port of entry.')
      if (t.visaType === 'none') at('visaType', 'Pick the visa you enter on.')
    }
  })
  if (input.idPhotos.length === 0) errors.idPhotos = 'Upload a photo of the lead guest’s ID.'
  if (input.rulesName.trim().length < 2) errors.rulesName = 'Type your full name to sign.'
  if (!input.rulesAccepted) errors.rulesAccepted = 'Accept the house rules.'
  return errors
}

/** The guest record's visa type for the one the guest picked online; "other" and "not needed" leave it for the desk. */
const PROFILE_VISA: Record<VisaType, Guest['visaType']> = { none: null, visa_free: 'free', voa: 'voa', evisa: 'evoa', kitas: 'kitas', other: null }

/**
 * The mapping step from the lead traveller onto the guest profile: contact, nationality as an ISO code
 * (kept when the text names no known country) and the document, birth and entry fields Immigration needs.
 */
export function guestFieldsFrom(pre: Pick<PreCheckIn, 'travellers' | 'email' | 'phone'>, guest: Pick<Guest, 'email' | 'nationality'>): Pick<Guest, 'nationality' | 'idType' | 'idNumber' | 'idExpiry' | 'birthDate' | 'sex' | 'entryDate' | 'entryPort' | 'visaType' | 'email' | 'phone'> | null {
  const lead = pre.travellers[0]
  if (!lead) return null
  return {
    nationality: countryCode(lead.nationality) ?? guest.nationality,
    idType: lead.documentType,
    idNumber: lead.documentNumber.trim(),
    idExpiry: lead.documentExpiry || null,
    birthDate: lead.dateOfBirth || null,
    sex: lead.sex,
    entryDate: lead.entryDate || null,
    entryPort: lead.portOfEntry.trim(),
    visaType: PROFILE_VISA[lead.visaType],
    email: pre.email.trim() || guest.email,
    phone: pre.phone.trim(),
  }
}

/** The traveller fields a stay companion takes over; place of birth and address stay as the desk set them. */
export type CompanionFields = Omit<CompanionInput, 'birthPlace' | 'addressInIndonesia'>

const sameDocument = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase()

/**
 * The travellers after the lead as stay companions, all adults since the form asks one per adult. Each
 * matches a companion already on the stay by document number and updates it, or becomes a new one.
 */
export function companionFieldsFrom(pre: Pick<PreCheckIn, 'travellers'>, existing: readonly Pick<StayCompanion, 'id' | 'idNumber'>[]): Array<{ id: string | null; fields: CompanionFields }> {
  return pre.travellers.slice(1).map((t) => ({
    id: existing.find((c) => c.idNumber.trim() && sameDocument(c.idNumber, t.documentNumber))?.id ?? null,
    fields: {
      name: t.name.trim(),
      adult: true,
      nationality: countryCode(t.nationality) ?? t.nationality.trim(),
      idType: t.documentType,
      idNumber: t.documentNumber.trim(),
      idExpiry: t.documentExpiry || null,
      birthDate: t.dateOfBirth || null,
      sex: t.sex,
      entryDate: t.entryDate || null,
      entryPort: t.portOfEntry.trim(),
      visaType: PROFILE_VISA[t.visaType],
    },
  }))
}

/** What the check-in form starts from once the front desk verified the pre-check-in. */
export function checkInPrefill(pre: Pick<PreCheckIn, 'status' | 'arrivalTime' | 'adults' | 'children' | 'flight' | 'rulesAccepted'> | null): Partial<CheckInDetails> {
  if (!pre || pre.status !== 'verified') return {}
  return { idVerified: true, rulesExplained: pre.rulesAccepted, arrivalTime: pre.arrivalTime, adults: pre.adults, children: pre.children, notes: pre.flight ? `Flight ${pre.flight}` : '' }
}

/** The link stops working once the stay is over or called off. */
export const linkExpired = (b: { status: string; checkOut: IsoDate }, today: IsoDate) => b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show' || b.checkOut < today

/** The guest can still change what they sent until the desk verifies it or checks them in. */
export const guestCanEdit = (b: { status: string }, pre: Pick<PreCheckIn, 'status'> | null) => (b.status === 'confirmed' || b.status === 'draft') && pre?.status !== 'verified'

/** What the public page shows; read without a session. */
export interface PublicPreCheckIn {
  token: string
  bookingCode: string
  guestName: string
  villaName: string
  locationName: string
  unitName: string
  checkIn: IsoDate
  checkOut: IsoDate
  nights: number
  status: PreCheckInStatus
  editable: boolean
  /** What the guest sent, or a draft from the profile before they start. */
  form: PreCheckInInput
  /** Room balance still owed on a direct stay; zero for a channel stay. */
  balance: number
  /** A pending payment link for the balance, when one is open. */
  payToken: string | null
  houseRules: readonly string[]
  /** The villa's times, "HH:MM"; absent from an API that predates them. */
  checkInTime?: string
  checkOutTime?: string
  today: IsoDate
}

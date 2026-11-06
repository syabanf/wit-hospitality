import { addDays, type IsoDate } from '@/lib/dates'

/** Countries by ISO 3166-1 alpha-2 code; `nationality` on a guest or companion holds the code. */
export const COUNTRIES: Readonly<Record<string, string>> = {
  AE: 'United Arab Emirates',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CN: 'China',
  DE: 'Germany',
  DK: 'Denmark',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  HK: 'Hong Kong',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IN: 'India',
  IT: 'Italy',
  JP: 'Japan',
  KR: 'South Korea',
  MY: 'Malaysia',
  NG: 'Nigeria',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PH: 'Philippines',
  PL: 'Poland',
  PT: 'Portugal',
  RU: 'Russia',
  SA: 'Saudi Arabia',
  SE: 'Sweden',
  SG: 'Singapore',
  TH: 'Thailand',
  TW: 'Taiwan',
  US: 'United States',
  VN: 'Vietnam',
  ZA: 'South Africa',
}
export const HOME_COUNTRY = 'ID'
export const countryName = (code: string) => COUNTRIES[code] ?? code
export const COUNTRY_OPTIONS = Object.entries(COUNTRIES)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label))

/** The travel document on file: a passport, a stay permit (KITAS, KITAP) or an Indonesian KTP. */
export type IdType = 'passport' | 'kitas' | 'kitap' | 'ktp'
export const ID_TYPES: readonly IdType[] = ['passport', 'kitas', 'kitap', 'ktp']
export const ID_TYPE_LABEL: Record<IdType, string> = { passport: 'Passport', kitas: 'KITAS', kitap: 'KITAP', ktp: 'KTP' }

export type Sex = 'male' | 'female'
export const SEX_LABEL: Record<Sex, string> = { male: 'Male', female: 'Female' }

export type VisaType = 'voa' | 'evoa' | 'b211' | 'kitas' | 'free'
export const VISA_TYPES: readonly VisaType[] = ['voa', 'evoa', 'b211', 'kitas', 'free']
export const VISA_TYPE_LABEL: Record<VisaType, string> = { voa: 'Visa on arrival', evoa: 'e-VOA', b211: 'B211', kitas: 'KITAS', free: 'Visa free' }

/**
 * What Immigration asks of a foreign guest (APOA, Aplikasi Pelaporan Orang Asing). Guests and stay companions
 * both carry these fields under the same names. `idType` and `idNumber` are the document; dates are ISO days.
 */
export interface TravelDocument {
  /** ISO 3166-1 alpha-2 code, ID for Indonesians. */
  nationality: string
  idType: IdType
  idNumber: string
  idExpiry: IsoDate | null
  birthDate: IsoDate | null
  sex: Sex | null
  /** Optional on the APOA form. */
  birthPlace: string
  /** The day the guest entered Indonesia on this trip. */
  entryDate: IsoDate | null
  /** Airport or seaport of entry, for example Ngurah Rai (DPS). */
  entryPort: string
  visaType: VisaType | null
  /** Address in Indonesia; empty means the villa of the stay. */
  addressInIndonesia: string
}

export interface GuestPreferences {
  pillow: string
  bedSetup: string
  dietary: string
  allergies: string
  roomLocation: string
  celebrations: string
}
export const PREFERENCE_LABEL: Record<keyof GuestPreferences, string> = { pillow: 'Pillow', bedSetup: 'Bed setup', dietary: 'Dietary', allergies: 'Allergies', roomLocation: 'Room location', celebrations: 'Celebrations' }
export const NO_PREFERENCES: GuestPreferences = { pillow: '', bedSetup: '', dietary: '', allergies: '', roomLocation: '', celebrations: '' }

/** 0 is a regular guest; 1 to 3 rise in attention. */
export type VipLevel = 0 | 1 | 2 | 3
export const VIP_LEVELS: readonly VipLevel[] = [0, 1, 2, 3]
export const vipLabel = (level: VipLevel) => (level === 0 ? 'None' : `VIP ${level}`)

/** A guest the operator refuses; set and cleared by someone who may approve in the guest module. */
export interface Blacklist {
  reason: string
  setBy: string
  setOn: IsoDate
}

export interface Guest extends TravelDocument {
  id: string
  name: string
  email: string
  phone: string
  notes: string
  preferences: GuestPreferences
  vipLevel: VipLevel
  vipReason: string
  tags: readonly string[]
  blacklist: Blacklist | null
  createdOn: IsoDate
}

/** The contact and document fields are required; the rest keep their saved value when left out. */
export interface GuestInput extends Partial<Omit<TravelDocument, 'nationality' | 'idType' | 'idNumber'>> {
  name: string
  email: string
  phone: string
  nationality: string
  idType: IdType
  idNumber: string
  notes: string
  preferences?: GuestPreferences
  vipLevel?: VipLevel
  vipReason?: string
  tags?: readonly string[]
}

export const NO_DOCUMENT: Omit<TravelDocument, 'nationality' | 'idType' | 'idNumber'> = { idExpiry: null, birthDate: null, sex: null, birthPlace: '', entryDate: null, entryPort: '', visaType: null, addressInIndonesia: '' }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const badDay = (d: IsoDate | null | undefined) => !!d && !ISO_DAY.test(d)

export function validateGuest(input: GuestInput): Partial<Record<keyof GuestInput, string>> {
  const errors: Partial<Record<keyof GuestInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the guest name.'
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email address.'
  if (input.phone && !/^\+?[\d\s-]{7,}$/.test(input.phone)) errors.phone = 'Enter a phone number with the country code.'
  if (!COUNTRIES[input.nationality]) errors.nationality = 'Pick the nationality.'
  if (input.vipLevel && (input.vipReason ?? '').trim().length < 3) errors.vipReason = 'Say why the guest is a VIP.'
  for (const k of ['idExpiry', 'birthDate', 'entryDate'] as const) if (badDay(input[k])) errors[k] = 'Enter a date.'
  return errors
}

export const isForeign = (p: Pick<TravelDocument, 'nationality'>) => p.nationality !== HOME_COUNTRY

/** The APOA fields a foreign adult still lacks, in words for the refusal. Indonesians need none. */
export function foreignDataMissing(p: TravelDocument): string[] {
  if (!isForeign(p)) return []
  const missing: string[] = []
  if (p.idType === 'ktp') missing.push('a passport or stay permit')
  if (!p.idNumber.trim()) missing.push('document number')
  if (!p.idExpiry) missing.push('document expiry')
  if (!p.birthDate) missing.push('date of birth')
  if (!p.sex) missing.push('sex')
  if (!p.entryDate) missing.push('date of entry')
  if (!p.entryPort.trim()) missing.push('port of entry')
  if (!p.visaType) missing.push('visa type')
  return missing
}

export const documentExpired = (p: Pick<TravelDocument, 'idExpiry'>, on: IsoDate) => p.idExpiry !== null && p.idExpiry < on

/** Another person staying with the lead guest, registered at check-in with the same document fields. */
export interface StayCompanion extends TravelDocument {
  id: string
  bookingId: string
  name: string
  /** Children are listed but Immigration reports adults only. */
  adult: boolean
}
export type CompanionInput = Omit<StayCompanion, 'id' | 'bookingId'>

export function validateCompanion(input: CompanionInput): Partial<Record<keyof CompanionInput, string>> {
  const errors: Partial<Record<keyof CompanionInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the companion’s name.'
  if (!COUNTRIES[input.nationality]) errors.nationality = 'Pick the nationality.'
  for (const k of ['idExpiry', 'birthDate', 'entryDate'] as const) if (badDay(input[k])) errors[k] = 'Enter a date.'
  return errors
}

/** One person on one stay sent to Immigration. `personId` is the guest id or the companion id. */
export interface ForeignReport {
  id: string
  bookingId: string
  personId: string
  reportedAt: string
  reportedBy: string
  /** The APOA receipt number, when the officer has one. */
  reference: string
}

/** Immigration expects the report within 24 hours of check-in. */
export const reportDueAt = (checkedInOn: IsoDate, arrivalTime: string) => `${addDays(checkedInOn, 1)}T${arrivalTime || '14:00'}`
export const reportOverdue = (checkedInOn: IsoDate, arrivalTime: string, now: string) => now > reportDueAt(checkedInOn, arrivalTime)

/**
 * The column order of the export, modelled on the APOA bulk upload sheet. It approximates the form;
 * check it against the template Immigration currently publishes before uploading.
 */
export const APOA_COLUMNS = ['Full name', 'Sex', 'Place of birth', 'Date of birth', 'Nationality', 'Document type', 'Document number', 'Document expiry', 'Visa type', 'Date of entry', 'Port of entry', 'Address in Indonesia', 'Check-in date', 'Planned check-out', 'Room'] as const

export interface ApoaPerson extends TravelDocument {
  name: string
}

export function apoaRow(p: ApoaPerson, stay: { checkIn: IsoDate; checkOut: IsoDate; room: string; address: string }): string[] {
  return [p.name, p.sex === 'male' ? 'M' : p.sex === 'female' ? 'F' : '', p.birthPlace, p.birthDate ?? '', p.nationality, ID_TYPE_LABEL[p.idType], p.idNumber, p.idExpiry ?? '', p.visaType ? VISA_TYPE_LABEL[p.visaType] : '', p.entryDate ?? '', p.entryPort, p.addressInIndonesia || stay.address, stay.checkIn, stay.checkOut, stay.room]
}

const normalPhone = (phone: string) => phone.replace(/\D/g, '').replace(/^0+/, '')

/** Pairs that are likely the same person: the same email, phone or document number. */
export function findDuplicates<T extends Pick<Guest, 'id' | 'email' | 'phone' | 'idNumber'>>(list: readonly T[]): Array<{ a: T; b: T; match: 'email' | 'phone' | 'document' }> {
  const pairs: Array<{ a: T; b: T; match: 'email' | 'phone' | 'document' }> = []
  list.forEach((a, i) => {
    for (const b of list.slice(i + 1)) {
      const match = a.email && a.email.toLowerCase() === b.email.toLowerCase() ? 'email' : a.idNumber && a.idNumber.trim().toUpperCase() === b.idNumber.trim().toUpperCase() ? 'document' : normalPhone(a.phone).length >= 7 && normalPhone(a.phone) === normalPhone(b.phone) ? 'phone' : null
      if (match) pairs.push({ a, b, match })
    }
  })
  return pairs
}

/** What the desk must see before the guest arrives: VIP level, allergies and a blacklist. */
export function guestAlerts(g: Pick<Guest, 'vipLevel' | 'vipReason' | 'preferences' | 'blacklist'>): Array<{ tone: 'danger' | 'warning' | 'info'; text: string }> {
  const alerts: Array<{ tone: 'danger' | 'warning' | 'info'; text: string }> = []
  if (g.blacklist) alerts.push({ tone: 'danger', text: `Blacklisted: ${g.blacklist.reason}` })
  if (g.preferences.allergies.trim()) alerts.push({ tone: 'warning', text: `Allergies: ${g.preferences.allergies}` })
  if (g.vipLevel) alerts.push({ tone: 'info', text: `${vipLabel(g.vipLevel)}: ${g.vipReason}` })
  return alerts
}

export function searchGuests<T extends Guest>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]
  return list.filter((g) => [g.name, g.email, g.phone, countryName(g.nationality), ...g.tags].some((v) => v.toLowerCase().includes(q)))
}

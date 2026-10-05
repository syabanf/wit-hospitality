import type { IsoDate } from '@/lib/dates'

export type IdType = 'passport' | 'ktp'
export const ID_TYPE_LABEL: Record<IdType, string> = { passport: 'Passport', ktp: 'KTP' }

export interface Guest {
  id: string
  name: string
  email: string
  phone: string
  nationality: string
  idType: IdType
  idNumber: string
  notes: string
  createdOn: IsoDate
}

export interface GuestInput {
  name: string
  email: string
  phone: string
  nationality: string
  idType: IdType
  idNumber: string
  notes: string
}

export function validateGuest(input: GuestInput): Partial<Record<keyof GuestInput, string>> {
  const errors: Partial<Record<keyof GuestInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the guest name.'
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email address.'
  if (input.phone && !/^\+?[\d\s-]{7,}$/.test(input.phone)) errors.phone = 'Enter a phone number with the country code.'
  if (!input.nationality.trim()) errors.nationality = 'Enter the nationality.'
  return errors
}

export function searchGuests<T extends Guest>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]
  return list.filter((g) => [g.name, g.email, g.phone, g.nationality].some((v) => v.toLowerCase().includes(q)))
}

export type AirbnbAccountStatus = 'active' | 'paused'

export interface AirbnbAccount {
  id: string
  name: string
  email: string
  status: AirbnbAccountStatus
  /** Chart slot for revenue by source; direct bookings take slot 1. */
  slot: number
}

export type ListingStatus = 'active' | 'paused'
export const LISTING_STATUS_LABEL: Record<ListingStatus, string> = { active: 'Live', paused: 'Paused' }

/** One Airbnb listing per unit, under one of the accounts. */
export interface Listing {
  id: string
  accountId: string
  unitId: string
  title: string
  airbnbId: string
  status: ListingStatus
}

export interface AirbnbAccountInput {
  name: string
  email: string
  status: AirbnbAccountStatus
}
export interface ListingInput {
  accountId: string
  unitId: string
  title: string
  airbnbId: string
  status: ListingStatus
}

export function validateAirbnbAccount(input: AirbnbAccountInput, accounts: readonly AirbnbAccount[], excludeId?: string): Partial<Record<keyof AirbnbAccountInput, string>> {
  const errors: Partial<Record<keyof AirbnbAccountInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the host account name.'
  else if (accounts.some((a) => a.name.toLowerCase() === input.name.trim().toLowerCase() && a.id !== excludeId)) errors.name = `${input.name.trim()} already exists.`
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter the host login email.'
  return errors
}

export function validateListing(input: ListingInput, listings: readonly Listing[], excludeId?: string): Partial<Record<keyof ListingInput, string>> {
  const errors: Partial<Record<keyof ListingInput, string>> = {}
  if (!input.accountId) errors.accountId = 'Pick the host account.'
  if (!input.unitId) errors.unitId = 'Pick the unit.'
  else if (listings.some((l) => l.unitId === input.unitId && l.id !== excludeId)) errors.unitId = 'That unit already has a listing.'
  if (input.title.trim().length < 4) errors.title = 'Enter the listing title as Airbnb shows it.'
  if (!/^\d{6,12}$/.test(input.airbnbId)) errors.airbnbId = 'The Airbnb listing id is 6 to 12 digits.'
  else if (listings.some((l) => l.airbnbId === input.airbnbId && l.id !== excludeId)) errors.airbnbId = 'That listing id is already on file.'
  return errors
}

export const DIRECT_SOURCE = { id: 'direct', label: 'Direct', slot: 1 } as const

/** Every booking source a filter can pick: direct, then each Airbnb account. */
export function sourceOptions(accounts: readonly AirbnbAccount[]) {
  return [DIRECT_SOURCE, ...accounts.map((a) => ({ id: a.id, label: a.name, slot: a.slot }))]
}

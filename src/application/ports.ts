import type { Profile } from '@/domain/account'
import type { AirbnbAccount, AirbnbAccountInput, Listing, ListingInput, ListingStatus } from '@/domain/airbnb'
import type { Booking, BookingSource, BookingStatus, CheckInDetails, CheckOutDetails, UnitBlock } from '@/domain/booking'
import type { CashAccount, CashAccountInput, Category, Transaction, TransactionInput, TransactionKind, TransactionStatus } from '@/domain/finance'
import type { Guest, GuestInput } from '@/domain/guest'
import type { ServiceRequest, ServiceRequestInput, ServiceStatus } from '@/domain/roomService'
import type { GroupInput, Location, LocationInput, PropertyInput, Unit, UnitGroup, UnitInput, Villa, VillaInput } from '@/domain/property'
import type { IsoDate } from '@/lib/dates'

export interface Clock {
  today(): IsoDate
}

export interface PropertyPort {
  locations(): Promise<Location[]>
  villas(): Promise<Villa[]>
  units(): Promise<Unit[]>
  groups(): Promise<UnitGroup[]>
  createLocation(input: LocationInput): Promise<Location>
  updateLocation(id: string, input: LocationInput): Promise<Location>
  createVilla(input: VillaInput): Promise<Villa>
  /** The wizard: villa, its room types and rooms in one transaction. Returns the new villa. */
  createProperty(input: PropertyInput): Promise<Villa>
  updateVilla(id: string, input: VillaInput): Promise<Villa>
  createGroup(input: GroupInput): Promise<UnitGroup>
  updateGroup(id: string, input: GroupInput): Promise<UnitGroup>
  createUnit(input: UnitInput): Promise<Unit>
  updateUnit(id: string, input: UnitInput): Promise<Unit>
}

export interface AirbnbPort {
  accounts(): Promise<AirbnbAccount[]>
  listings(): Promise<Listing[]>
  setListingStatus(id: string, status: ListingStatus): Promise<Listing>
  createAccount(input: AirbnbAccountInput): Promise<AirbnbAccount>
  updateAccount(id: string, input: AirbnbAccountInput): Promise<AirbnbAccount>
  createListing(input: ListingInput): Promise<Listing>
  updateListing(id: string, input: ListingInput): Promise<Listing>
}

export interface NewBooking {
  guestId: string | null
  /** A guest created with the booking when `guestId` is null. */
  newGuest: GuestInput | null
  unitId: string
  source: BookingSource
  airbnbAccountId: string | null
  airbnbCode: string | null
  checkIn: IsoDate
  checkOut: IsoDate
  nightlyRate: number
  notes: string
  /** Save as confirmed straight away instead of as a draft. */
  confirm: boolean
}

export type BookingAction = Exclude<BookingStatus, 'draft'>

export interface BookingPort {
  bookings(): Promise<Booking[]>
  blocks(): Promise<UnitBlock[]>
  create(input: NewBooking): Promise<Booking>
  transition(id: string, to: BookingAction): Promise<Booking>
  /** Checks the guest in with the front desk record; the deposit is booked separately through FinancePort. */
  checkIn(id: string, details: CheckInDetails): Promise<Booking>
  checkOut(id: string, details: CheckOutDetails): Promise<Booking>
  moveUnit(id: string, unitId: string, reason: string): Promise<Booking>
  adjustStay(id: string, checkIn: IsoDate, checkOut: IsoDate): Promise<Booking>
  addBlock(input: Omit<UnitBlock, 'id'>): Promise<UnitBlock>
  removeBlock(id: string): Promise<void>
}

export interface GuestPort {
  guests(): Promise<Guest[]>
  create(input: GuestInput): Promise<Guest>
  update(id: string, input: GuestInput): Promise<Guest>
}

export type TransactionAction = Exclude<TransactionStatus, 'draft' | 'reversed'>

export interface FinancePort {
  accounts(): Promise<CashAccount[]>
  createAccount(input: CashAccountInput): Promise<CashAccount>
  updateAccount(id: string, input: CashAccountInput): Promise<CashAccount>
  categories(): Promise<Category[]>
  transactions(): Promise<Transaction[]>
  createTransaction(input: TransactionInput, submit: boolean): Promise<Transaction>
  transition(id: string, to: TransactionAction): Promise<Transaction>
  /** Posts a compensating entry and returns it; the original becomes `reversed`. */
  reverse(id: string, reason: string): Promise<Transaction>
  createCategory(input: { name: string; kind: TransactionKind }): Promise<Category>
  setCategoryActive(id: string, active: boolean): Promise<Category>
}

export interface ServicePort {
  requests(): Promise<ServiceRequest[]>
  create(input: ServiceRequestInput): Promise<ServiceRequest>
  update(id: string, input: ServiceRequestInput): Promise<ServiceRequest>
  transition(id: string, to: Exclude<ServiceStatus, 'open'>): Promise<ServiceRequest>
  assign(id: string, assignee: string): Promise<ServiceRequest>
  linkTransaction(id: string, transactionId: string): Promise<ServiceRequest>
}

export interface AccountPort {
  profile(): Promise<Profile>
  saveProfile(profile: Profile): Promise<Profile>
}

export interface Ports {
  clock: Clock
  property: PropertyPort
  airbnb: AirbnbPort
  booking: BookingPort
  guest: GuestPort
  finance: FinancePort
  service: ServicePort
  account: AccountPort
}

import type { AirbnbAccount, Listing } from '@/domain/airbnb'
import type { Booking, NightState, UnitBlock } from '@/domain/booking'
import type { CashAccount, Category, Transaction } from '@/domain/finance'
import type { Guest } from '@/domain/guest'
import type { ServiceRequest } from '@/domain/roomService'
import type { Location, Unit, UnitPlace, Villa } from '@/domain/property'
import type { Period } from '@/domain/dashboard'
import type { IsoDate } from '@/lib/dates'

/** A booking with everything a row or a record page prints. */
export interface BookingView extends Booking {
  guest: Guest
  guestName: string
  place: UnitPlace
  unitCode: string
  account: AirbnbAccount | null
  sourceLabel: string
  nights: number
  total: number
}

export interface TransactionView extends Transaction {
  category: Category
  categoryName: string
  account: CashAccount
  accountName: string
  location: Location
  villa: Villa | null
  unit: Unit | null
}

export interface DashboardFilter {
  period: Period
  /** Custom inclusive dates; when set they replace the period preset. */
  from?: string
  to?: string
  locationId?: string
  villaId?: string
  unitId?: string
  /** "direct" or an Airbnb account id. */
  source?: string
}

export interface Metric {
  value: number
  previous: number
  change: number | null
}

export interface UnitRow {
  place: UnitPlace
  tonight: NightState
  listing: Listing | null
  account: AirbnbAccount | null
  nextArrival: BookingView | null
}

export interface BlockView extends UnitBlock {
  place: UnitPlace
}

export interface CalendarSpan {
  kind: 'booking' | 'block'
  id: string
  start: number
  length: number
  label: string
  slot: number
  status: string
  /** True when the stay started before the visible window. */
  clippedStart: boolean
  clippedEnd: boolean
}

export interface CalendarRow {
  place: UnitPlace
  spans: CalendarSpan[]
  /** Night states per visible day, for the free cells. */
  states: NightState[]
}

export interface ServiceRequestView extends ServiceRequest {
  place: UnitPlace
  unitCode: string
  booking: BookingView | null
  guestName: string | null
}

export interface GuestRow extends Guest {
  stays: number
  nights: number
  spent: number
  lastStay: IsoDate | null
  inHouse: boolean
}

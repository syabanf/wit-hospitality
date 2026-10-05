import { Building2, DoorOpen, Globe, LayoutList, MapPin, Tags, Wallet, type LucideIcon } from 'lucide-react'

export type MasterKind = 'locations' | 'villas' | 'groups' | 'units' | 'airbnb' | 'listings' | 'cash' | 'categories'

export interface MasterPageDef {
  kind: MasterKind
  to: string
  label: string
  icon: LucideIcon
  blurb: string
}

/** One page per reference table, in the order the hub and the sidebar list them. */
export const MASTER_PAGES: readonly MasterPageDef[] = [
  { kind: 'locations', to: '/master/locations', label: 'Locations', icon: MapPin, blurb: 'Areas the villas sit in' },
  { kind: 'villas', to: '/master/villas', label: 'Villas', icon: Building2, blurb: 'Properties with their facilities' },
  { kind: 'groups', to: '/master/room-types', label: 'Room types', icon: LayoutList, blurb: 'Groups of rooms with one design' },
  { kind: 'units', to: '/master/units', label: 'Units', icon: DoorOpen, blurb: 'Rooms, rates and amenities' },
  { kind: 'airbnb', to: '/master/airbnb-accounts', label: 'Airbnb accounts', icon: Globe, blurb: 'Host logins' },
  { kind: 'listings', to: '/master/listings', label: 'Listings', icon: Globe, blurb: 'One per unit on Airbnb' },
  { kind: 'cash', to: '/master/cash-accounts', label: 'Cash accounts', icon: Wallet, blurb: 'Cashboxes and the bank' },
  { kind: 'categories', to: '/master/categories', label: 'Categories', icon: Tags, blurb: 'Income and expense lines' },
]

export const masterPageFor = (pathname: string) => MASTER_PAGES.find((p) => pathname === p.to || pathname.startsWith(`${p.to}/`)) ?? null

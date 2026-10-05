import type { Clock, Ports } from '@/application/ports'
import { createHttpClient } from './client'

const BOOKING_ACTION = { confirmed: 'confirm', checked_in: 'check-in', checked_out: 'check-out', cancelled: 'cancel' } as const
const TRANSACTION_ACTION = { submitted: 'submit', approved: 'approve', posted: 'post' } as const

/**
 * REST adapters behind the same ports as the mock, on the routes docs/05-api-rules.md lists.
 * Point VITE_API_URL at the Go API (`https://host/api/v1`) and the whole UI runs against it.
 */
export function createHttpPorts(baseUrl: string, clock: Clock): Ports {
  const http = createHttpClient(baseUrl)
  return {
    clock,
    property: {
      locations: () => http.get('locations'),
      villas: () => http.get('villas'),
      units: () => http.get('units'),
      groups: () => http.get('unit-groups'),
      createLocation: (input) => http.post('locations', input),
      updateLocation: (id, input) => http.patch(`locations/${id}`, input),
      createVilla: (input) => http.post('villas', input),
      createProperty: (input) => http.post('properties', input),
      updateVilla: (id, input) => http.patch(`villas/${id}`, input),
      createGroup: (input) => http.post('unit-groups', input),
      updateGroup: (id, input) => http.patch(`unit-groups/${id}`, input),
      createUnit: (input) => http.post('units', input),
      updateUnit: (id, input) => http.patch(`units/${id}`, input),
    },
    airbnb: {
      accounts: () => http.get('airbnb-accounts'),
      listings: () => http.get('airbnb-listings'),
      setListingStatus: (id, status) => http.patch(`airbnb-listings/${id}`, { status }),
      createAccount: (input) => http.post('airbnb-accounts', input),
      updateAccount: (id, input) => http.patch(`airbnb-accounts/${id}`, input),
      createListing: (input) => http.post('airbnb-listings', input),
      updateListing: (id, input) => http.patch(`airbnb-listings/${id}`, input),
    },
    booking: {
      bookings: () => http.get('bookings'),
      blocks: () => http.get('unit-blocks'),
      create: (input) => http.post('bookings', input),
      transition: (id, to) => http.post(`bookings/${id}/${BOOKING_ACTION[to]}`),
      checkIn: (id, details) => http.post(`bookings/${id}/check-in`, details),
      checkOut: (id, details) => http.post(`bookings/${id}/check-out`, details),
      moveUnit: (id, unitId, reason) => http.post(`bookings/${id}/move-unit`, { unitId, reason }),
      adjustStay: (id, checkIn, checkOut) => http.patch(`bookings/${id}`, { checkIn, checkOut }),
      addBlock: (input) => http.post('unit-blocks', input),
      removeBlock: (id) => http.delete(`unit-blocks/${id}`),
    },
    guest: {
      guests: () => http.get('guests'),
      create: (input) => http.post('guests', input),
      update: (id, input) => http.patch(`guests/${id}`, input),
    },
    finance: {
      accounts: () => http.get('cash-accounts'),
      createAccount: (input) => http.post('cash-accounts', input),
      updateAccount: (id, input) => http.patch(`cash-accounts/${id}`, input),
      categories: () => http.get('categories'),
      transactions: () => http.get('transactions'),
      createTransaction: (input, submit) => http.post('transactions', { ...input, submit }),
      transition: (id, to) => http.post(`transactions/${id}/${TRANSACTION_ACTION[to]}`),
      reverse: (id, reason) => http.post(`transactions/${id}/reverse`, { reason }),
      createCategory: (input) => http.post('categories', input),
      setCategoryActive: (id, active) => http.patch(`categories/${id}`, { active }),
    },
    service: {
      requests: () => http.get('service-requests'),
      create: (input) => http.post('service-requests', input),
      update: (id, input) => http.patch(`service-requests/${id}`, input),
      transition: (id, to) => http.post(`service-requests/${id}/${to === 'in_progress' ? 'start' : to === 'done' ? 'done' : 'cancel'}`),
      assign: (id, assignee) => http.patch(`service-requests/${id}`, { assignee }),
      linkTransaction: (id, transactionId) => http.patch(`service-requests/${id}`, { transactionId }),
    },
    account: {
      profile: () => http.get('me'),
      saveProfile: (profile) => http.put('me', profile),
    },
  }
}

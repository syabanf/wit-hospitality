// Builds the mock adapter's demo state with the front end's own seed builders and writes the
// identity, property and channel slices to api/seed/*.json for cmd/seed. Dates are absolute for the
// base date written into each file; cmd/seed shifts them so the demo always starts today.
// Run: node api/scripts/export-seed.mjs [YYYY-MM-DD]
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { withModules } from './vite-load.mjs'

const baseDate = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const out = (name) => fileURLToPath(new URL(`../seed/${name}`, import.meta.url))
const write = (name, value) => {
  writeFileSync(out(name), `${JSON.stringify(value, null, 2)}\n`)
  console.log(`wrote ${out(name)}`)
}

await withModules(['/src/infrastructure/mock/state.ts', '/src/infrastructure/mock/data/access.ts'], (state, access) => {
  const s = state.buildState(baseDate)
  write('identity.json', {
    baseDate,
    demoPassword: access.DEMO_PASSWORD,
    users: s.users,
    permissions: s.permissions,
    preferences: s.preferences,
    audit: s.audit,
  })
  write('property.json', {
    baseDate,
    locations: s.locations,
    villas: s.villas,
    groups: s.groups,
    units: s.units,
    ratePlans: s.ratePlans,
    blocks: s.blocks,
  })
  // Guest also keeps a copy of the booking facts it checks (state, lead guest, villa, check-in day,
  // party size) and of each group's lead guest; reservation owns both.
  const villaOf = new Map(s.units.map((u) => [u.id, u.villaId]))
  write('guest.json', {
    baseDate,
    guests: s.guests,
    companions: s.companions,
    foreignReports: s.foreignReports,
    lostItems: s.lostItems,
    lostFoundSettings: s.lostFoundSettings,
    stays: s.bookings.map((b) => ({
      id: b.id,
      code: b.code,
      guestId: b.guestId,
      unitId: b.unitId,
      villaId: villaOf.get(b.unitId),
      status: b.status,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      checkedInOn: b.checkedInOn,
      checkedOutOn: b.checkedOutOn,
      arrivalTime: b.arrival?.arrivalTime ?? '',
      adults: b.arrival?.adults ?? b.partySize?.adults ?? null,
    })),
    groupLeads: s.bookingGroups.map((g) => ({ id: g.id, leadGuestId: g.leadGuestId })),
    next: Object.fromEntries(['guest', 'companion', 'foreignReport', 'lostItem'].map((k) => [k, s.next[k] ?? 1])),
  })
  write('channel.json', {
    baseDate,
    accounts: s.accounts,
    listings: s.listings,
    enquiries: s.enquiries,
  })
})

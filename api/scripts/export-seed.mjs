// Builds the mock adapter's demo state with the front end's own seed builders and writes the
// identity, property, guest, channel, reservation, people and payroll slices to api/seed/*.json
// for cmd/seed. Dates are absolute for the base date written into each file; cmd/seed shifts them
// so the demo always starts today.
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
  const next = (keys) => Object.fromEntries(keys.map((k) => [k, s.next[k] ?? 1]))
  write('people.json', {
    baseDate,
    employees: s.employees,
    shifts: s.shifts,
    assignments: s.assignments,
    attendance: s.attendance,
    leaves: s.leaves,
    overtime: s.overtime,
    loans: s.loans,
    announcements: s.announcements,
    kpis: s.kpis,
    next: next(['employee', 'assignment', 'attendance', 'leave', 'overtime', 'loan', 'announcement', 'kpi']),
  })
  write('payroll.json', {
    baseDate,
    settings: s.payrollSettings,
    periods: s.periods,
    next: next(['adjustment']),
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
  // Unit movements live on each booking; walks start empty in the mock seed.
  write('reservation.json', {
    baseDate,
    bookings: s.bookings,
    groups: s.bookingGroups,
    restrictions: s.restrictions,
    overbooking: s.overbooking,
    walks: s.walks,
    preCheckIns: s.preCheckIns,
  })
  // Housekeeping also carries what the people and inventory stubs answer until those contexts run:
  // the attendants' records, roster and leaves, and the stock items (names and kinds).
  const groupVilla = new Map(s.groups.map((g) => [g.id, g.villaId]))
  write('housekeeping.json', {
    baseDate,
    settings: s.hkSettings,
    board: s.housekeeping,
    tasks: s.roomTasks,
    linenPars: s.linenPars,
    linenSoiled: s.linenSoiled,
    laundryBatches: s.laundryBatches,
    unitVillas: Object.fromEntries(villaOf),
    groupVillas: Object.fromEntries(groupVilla),
    next: { roomTask: s.next.roomTask ?? 1, laundryBatch: s.next.laundryBatch ?? 1, linenDiscard: 1 },
    staff: {
      employees: s.employees.map((e) => ({ id: e.id, name: e.name, department: e.department, position: e.position, status: e.status, villaIds: e.allocations.map((a) => a.villaId) })),
      roster: s.assignments.map((a) => ({ employeeId: a.employeeId, date: a.date, shiftId: a.shiftId, villaId: a.villaId })),
      leaves: s.leaves.filter((l) => l.status === 'approved').map((l) => ({ employeeId: l.employeeId, status: l.status, from: l.from, to: l.to })),
    },
    items: s.stockItems.map((i) => ({ id: i.id, code: i.code, name: i.name, kind: i.kind })),
  })
  // Messaging keeps a copy of billing's payment links for the payment_link template.
  write('messaging.json', {
    baseDate,
    settings: s.messaging,
    messages: s.messages,
    paymentLinks: s.paymentLinks.map((l) => ({ bookingId: l.bookingId, token: l.token, amount: l.amount, status: l.status })),
    bookingVillas: Object.fromEntries(s.bookings.map((b) => [b.id, villaOf.get(b.unitId)])),
    next: { message: s.next.message ?? 1 },
  })
})

// Builds the mock adapter's demo state with the front end's own seed builders and writes the
// identity, property, guest, channel, reservation, services, people, payroll, maintenance and
// inventory slices to api/seed/*.json for cmd/seed. Dates are absolute for the base date written
// into each file; cmd/seed shifts them so the demo always starts today.
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
  // Room service: partners, the menu per villa, orders (paid ones keep their payment id; partner
  // bills keep their transaction ids) and the service requests; next continues the mock's seq().
  write('services.json', {
    baseDate,
    partners: s.partners,
    menu: s.menu,
    orders: s.orders,
    requests: s.requests,
    next: { order: s.next.order ?? 1, request: s.next.request ?? 1 },
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
  // Housekeeping also carries the stock items (names and kinds) its inventory stub answers until
  // inventory runs.
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
  // Each statement carries its payout cash entry as finance holds it (id, number, status), so the
  // owners context knows which payouts are paid and which wait.
  const payoutOf = (id) => {
    const t = id ? s.transactions.find((x) => x.id === id) : null
    return t ? { transactionId: t.id, number: t.number, status: t.status } : null
  }
  write('owners.json', {
    baseDate,
    owners: s.villaOwners,
    contracts: s.contracts,
    statements: s.ownerStatements.map((st) => ({ ...st, payout: payoutOf(st.payoutTransactionId) })),
    stays: s.ownerStays,
    next: Object.fromEntries(['villaOwner', 'contract', 'statement', 'ownerStay'].map((k) => [k, s.next[k] ?? 1])),
  })
  // The status of each cash-out a seeded expense or purchase points at, until finance owns them.
  const cashOuts = (refs) =>
    refs.flatMap(({ transactionId, sourceId }) => {
      const t = s.transactions.find((x) => x.id === transactionId)
      return t ? [{ id: t.id, number: t.number, status: t.status, amount: t.amount, sourceId, createdById: t.createdById, createdBy: t.createdBy }] : []
    })
  write('maintenance.json', {
    baseDate,
    workOrders: s.workOrders,
    assets: s.assets,
    vendors: s.vendors,
    plans: s.plans,
    cashOuts: cashOuts(s.workOrders.flatMap((w) => w.expenses.map((e) => ({ transactionId: e.transactionId, sourceId: w.id })))),
    next: { workOrder: s.next.workOrder, asset: s.next.asset, vendor: s.next.vendor, plan: s.next.plan, transaction: s.next.transaction },
  })
  write('inventory.json', {
    baseDate,
    items: s.stockItems,
    movements: s.stockMovements,
    receipts: s.stockReceipts,
    counts: s.stockCounts,
    kits: s.amenityKits,
    links: s.minibarLinks,
    menuItems: s.menu.map((m) => ({ id: m.id, villaId: m.villaId, category: m.category, name: m.name, unit: m.unit, price: m.price, active: m.active })),
    cashOuts: cashOuts(s.stockReceipts.filter((r) => r.transactionId).map((r) => ({ transactionId: r.transactionId, sourceId: r.id }))),
    next: Object.fromEntries(['stockItem', 'stockMovement', 'stockReceipt', 'stockCount', 'stockTransfer', 'transaction'].filter((k) => s.next[k]).map((k) => [k, s.next[k]])),
  })
})

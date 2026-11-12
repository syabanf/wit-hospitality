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

await withModules(['/src/infrastructure/mock/state.ts', '/src/infrastructure/mock/data/access.ts', '/src/domain/payroll.ts'], (state, access, payroll) => {
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
  // partnerBills is where each bill stands, so the void check sees a seeded bill already paid.
  write('services.json', {
    baseDate,
    partners: s.partners,
    menu: s.menu,
    orders: s.orders,
    requests: s.requests,
    partnerBills: s.orders.flatMap((o) => {
      const partners = [...new Set(o.lines.filter((x) => x.partnerId && x.costPrice > 0).map((x) => x.partnerId))]
      return o.costTransactionIds.map((id, i) => ({ transactionId: id, orderId: o.id, partnerId: partners[i] ?? '', status: s.transactions.find((t) => t.id === id)?.status ?? 'submitted' }))
    }),
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
  // Billing keeps the folio postings (charges, rebates, city ledger transfers), guest payments and
  // links, the night audits and the nights they posted, the cashier shifts, the city ledger, the
  // policies, the tax settings and the transaction codes. Finance owns the cash accounts; billing
  // keeps a copy until finance answers its client.
  write('billing.json', {
    baseDate,
    businessDate: s.businessDate,
    paymentPolicy: s.paymentPolicy,
    shiftPolicy: s.shiftPolicy,
    tax: s.tax,
    transactionCodes: s.transactionCodes,
    folioPostings: s.folioPostings,
    payments: s.payments,
    paymentLinks: s.paymentLinks,
    nightAudits: s.nightAudits,
    nightsPosted: Object.fromEntries(s.bookings.filter((b) => b.nightsPosted?.length).map((b) => [b.id, b.nightsPosted])),
    cashierShifts: s.cashierShifts,
    // Services publishes no events for its seeded orders, so billing keeps the delivered and voided
    // ones from the same export.
    orders: s.orders.filter((o) => o.status === 'delivered' || o.status === 'voided'),
    handOvers: s.handOvers,
    cityLedgerAccounts: s.cityLedgerAccounts,
    cityLedgerInvoices: s.cityLedgerInvoices,
    cityLedgerPayments: s.cityLedgerPayments,
    cityLedgerWriteOffs: s.cityLedgerWriteOffs,
    cashAccounts: s.cashAccounts.map(({ id, name, kind, locationId }) => ({ id, name, kind, locationId: locationId ?? null })),
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
  // Finance keeps the cash ledger, the books and the cashier shifts, plus what its posting rules
  // read from other contexts: each stay's state and first billed day, the payment shares and order
  // money behind a cash entry, the entries room service requests paid, and the partner a bill pays.
  const links = new Map()
  const link = (id) => links.get(id) ?? links.set(id, { transactionId: id, shares: [], orderMoney: false, request: false, partnerId: null }).get(id)
  for (const p of s.payments) {
    if (!p.transactionId) continue
    const l = link(p.transactionId)
    if (l.shares.length === 0) l.orderMoney = (p.orderIds?.length ?? 0) > 0
    l.shares.push({ bookingId: p.bookingId, amount: p.amount })
  }
  for (const r of s.requests) if (r.transactionId) link(r.transactionId).request = true
  for (const o of s.orders) {
    // partnerCosts order: each partner with a costed line, in line order.
    const partners = [...new Set(o.lines.filter((x) => x.partnerId && x.costPrice > 0).map((x) => x.partnerId))]
    o.costTransactionIds.forEach((id, i) => {
      if (partners[i]) link(id).partnerId = partners[i]
    })
  }
  // The records other contexts keep a cash entry for, so the finance client can answer by source.
  const sources = []
  for (const p of s.payments) {
    if (p.transactionId) sources.push({ transactionId: p.transactionId, type: 'payment', id: p.id })
    for (const id of p.extraTransactionIds ?? []) sources.push({ transactionId: id, type: 'payment', id: p.id })
    if (p.feeTransactionId) sources.push({ transactionId: p.feeTransactionId, type: 'payment_fee', id: p.id })
  }
  for (const w of s.workOrders) for (const e of w.expenses) if (e.transactionId) sources.push({ transactionId: e.transactionId, type: 'maintenance_expense', id: w.id })
  for (const r of s.stockReceipts) if (r.transactionId) sources.push({ transactionId: r.transactionId, type: 'stock_purchase', id: r.id })
  for (const p of s.periods) if (p.transactionId) sources.push({ transactionId: p.transactionId, type: 'payroll', id: p.id })
  for (const p of s.cityLedgerPayments ?? []) if (p.transactionId) sources.push({ transactionId: p.transactionId, type: 'city_ledger_payment', id: p.id })
  for (const o of s.orders) for (const id of o.costTransactionIds) sources.push({ transactionId: id, type: 'service_order', id: o.id })
  write('finance.json', {
    baseDate,
    cashAccounts: s.cashAccounts,
    categories: s.categories,
    transactions: s.transactions,
    reconciliations: s.reconciliations,
    approvalRules: s.approvalRules,
    proofPolicy: s.proofPolicy,
    categoryAccounts: s.categoryAccounts,
    transactionCodes: s.transactionCodes,
    tax: s.tax,
    journals: s.journals,
    manualJournals: s.manualJournals,
    periodCloses: s.periodCloses,
    budgets: s.budgets,
    // Each villa's cost of a closed payroll, for the villa results owners read.
    payrollCosts: s.periods.filter((p) => p.status === 'closed').flatMap((p) => [...payroll.costByVilla(p.lines)].map(([villaId, amount]) => ({ month: p.month, villaId, amount }))),
    // The facts billing and owners name their records by, so finance answers their status.
    refs: [
      ...s.payments.filter((p) => p.transactionId).map((p) => ({ ref: p.id, transactionId: p.transactionId })),
      ...(s.cityLedgerPayments ?? []).filter((p) => p.transactionId).map((p) => ({ ref: p.id, transactionId: p.transactionId })),
    ],
    stays: s.bookings.map((b) => ({ id: b.id, code: b.code, villaId: villaOf.get(b.unitId) ?? null, status: b.status, billedOn: b.nightsPosted?.[0] ?? b.checkedOutOn ?? null })),
    links: [...links.values()],
    sources,
    next: Object.fromEntries(['transaction', 'journal', 'manualJournal', 'reconciliation', 'transfer', 'rule', 'category', 'cashierShift', 'handOver', 'entity'].map((k) => [k, s.next[k] ?? 1])),
  })
})

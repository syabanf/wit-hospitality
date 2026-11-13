// Which bounded context owns each contract path. First match wins, so specific paths sit above the
// prefix they share (unit-groups/{}/overbooking belongs to reservation, the rest of unit-groups to
// property). Paths are written without the /api/v1 prefix, parameters as {}. `done` marks a
// later-phase context whose endpoints are all built, so `make contract` holds it to that.
export const CONTEXTS = [
  { name: 'identity', phase: 0, summary: 'Sessions, users, roles and the permission matrix, villa and location scope, profile, audit trail' },
  { name: 'property', phase: 0, summary: 'Locations, villas, room types, units, unit blocks, facilities, rate plans, the New property wizard' },
  { name: 'channel', phase: 1, done: true, summary: 'Airbnb accounts and listings, the public site inventory and holds, web enquiries' },
  { name: 'reservation', phase: 1, done: true, summary: 'Bookings and their lifecycle, groups, stay restrictions, overbooking and walks, pre-check-in' },
  { name: 'guest', phase: 1, done: true, summary: 'Guest profiles, blacklist and merge, companions, foreign guest reports, lost and found' },
  { name: 'billing', phase: 2, done: true, summary: 'Folio, guest payments and links, cashier shifts, city ledger, night audit, tax settings, transaction codes' },
  { name: 'finance', phase: 2, done: true, summary: 'Cash accounts, categories, transactions and approvals, reconciliation, general ledger, tax, budgets' },
  { name: 'owners', phase: 2, done: true, summary: 'Villa owners, management contracts, owner statements, owner stays' },
  { name: 'services', phase: 3, done: true, summary: 'Service requests, room service menu, partners and orders, guest ordering' },
  { name: 'maintenance', phase: 3, done: true, summary: 'Work orders, assets, vendors, preventive plans' },
  { name: 'housekeeping', phase: 3, done: true, summary: 'Room states and inspections, daily tasks, linen and laundry' },
  { name: 'inventory', phase: 3, done: true, summary: 'Stock items, receipts, movements, counts, amenity kits, minibar' },
  { name: 'people', phase: 4, done: true, summary: 'Employees, shifts and rosters, attendance, leave, overtime, loans, announcements, KPI reviews' },
  { name: 'payroll', phase: 4, done: true, summary: 'Payroll settings and periods, payslips' },
  { name: 'messaging', phase: 4, done: true, summary: 'Guest messages and settings, e-invoice links' },
  { name: 'files', phase: 2, done: true, summary: 'Uploaded files and attachments' },
]

export const RULES = [
  ['identity', /^(auth|users|permissions|audit|me)(\/|$)/],
  ['reservation', /^unit-groups\/\{\}\/overbooking$/],
  ['property', /^(locations|villas|properties|unit-groups|units|rate-plans|unit-blocks|unit-status-history|site\/photos)(\/|$)/],
  ['channel', /^(airbnb-accounts|airbnb-listings|public|enquiries)(\/|$)/],
  ['guest', /^bookings\/\{\}\/companions$/],
  ['billing', /^bookings\/\{\}\/(folio|city-ledger-billing)(\/|$)/],
  ['billing', /^booking-groups\/\{\}\/(city-ledger|city-ledger-billing)$/],
  ['inventory', /^bookings\/\{\}\/minibar-checks$/],
  ['reservation', /^(bookings|booking-groups|whole-villa-bookings|stay-restrictions|overbooking-policies|walks|pre-checkins|checkin)(\/|$)/],
  ['guest', /^(guests|stay-companions|foreign-reports|lost-found)(\/|$)/],
  ['billing', /^(payments|payment-links|pay|cashier-shifts|city-ledger|night-audits)(\/|$)/],
  ['billing', /^ledger\/(tax-settings|transaction-codes)(\/|$)/],
  ['finance', /^(cash-accounts|categories|transactions|reconciliations|approval-rules|settings\/proof-policy|ledger|budgets)(\/|$)/],
  ['owners', /^(villa-owners|management-contracts|owner-statements|owner-stays|owner-portal)(\/|$)/],
  ['services', /^(service-requests|menu-items|service-partners|service-orders|order)(\/|$)/],
  ['maintenance', /^(work-orders|assets|vendors|preventive-plans)(\/|$)/],
  ['housekeeping', /^(housekeeping|linen|laundry)(\/|$)/],
  ['inventory', /^stock(\/|$)/],
  ['people', /^(employees|shifts|shift-assignments|attendance|leave-requests|overtime-requests|loans|announcements|kpi-reviews)(\/|$)/],
  ['payroll', /^payroll(\/|$)/],
  ['messaging', /^(messages|invoice)(\/|$)/],
  ['files', /^files$/],
]

export function ownerOf(path) {
  for (const [name, re] of RULES) if (re.test(path)) return name
  return null
}

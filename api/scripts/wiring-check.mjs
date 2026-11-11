// Runs the front end's own HTTP adapter (src/infrastructure/http) against a running Go API and
// compares what it returns with the mock adapter, the reference behaviour. Property and channel reads must
// match the mock exactly; access reads must match in shape and ids.
//   node api/scripts/wiring-check.mjs http://localhost:8080/api/v1
// The API must be freshly seeded (make seed) on the same business date.
import { withModules } from './vite-load.mjs'

const base = process.argv[2] ?? 'http://localhost:8080/api/v1'
const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.BUSINESS_TZ ?? 'Asia/Makassar' }).format(new Date())

// The adapter sends credentials: 'include'; Node's fetch keeps no cookies, so keep a jar here.
const jar = new Map()
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const headers = new Headers(init.headers)
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
  const res = await realFetch(url, { ...init, headers })
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';')
    const [name, value] = pair.split('=')
    if (attrs.some((a) => /max-age=(0|-)/i.test(a.trim())) || value === '') jar.delete(name)
    else jar.set(name, value)
  }
  return res
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// Same content regardless of object key order (Go writes map keys sorted).
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v)
const keys = (o) => Object.keys(o ?? {}).sort().join(',')
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

await withModules(['/src/infrastructure/http/index.ts', '/src/infrastructure/mock/index.ts'], async (http, mock) => {
  const clock = { today: () => today }
  const api = http.createHttpPorts(base, clock)
  const ref = mock.createMockPorts(clock, 0, null)

  check('no session before login', (await api.access.session()) === null)
  const kadek = await api.access.login({ email: 'kadek@balivillas.id', password: 'villa123' })
  const mockKadek = await ref.access.login({ email: 'kadek@balivillas.id', password: 'villa123' })
  check('login returns the User shape', keys(kadek) === keys(mockKadek) && kadek.id === 'usr-kadek', keys(kadek))
  check('session follows the cookie', (await api.access.session())?.id === 'usr-kadek')

  for (const [name, read] of [
    ['locations', (p) => p.property.locations()],
    ['villas', (p) => p.property.villas()],
    ['units', (p) => p.property.units()],
    ['unit-groups', (p) => p.property.groups()],
    ['rate-plans', (p) => p.property.ratePlans()],
    ['unit-blocks', (p) => p.booking.blocks()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    check(`${name} equals the mock (${got.length} rows)`, same(got, want), same(got, want) ? '' : JSON.stringify(got[0]))
  }

  // Guest reads: same records as the mock; Go writes keys in struct order, so compare canonically.
  for (const [name, read] of [
    ['guests', (p) => p.guest.guests()],
    ['stay-companions', (p) => p.guest.companions()],
    ['foreign-reports', (p) => p.guest.foreignReports()],
    ['lost-found', (p) => p.lostFound.items()],
    ['lost-found/settings', (p) => p.lostFound.settings()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const ok = same(canonical(got), canonical(want))
    check(`${name} equals the mock${Array.isArray(got) ? ` (${got.length} rows)` : ''}`, ok, ok ? '' : JSON.stringify(Array.isArray(got) ? got.find((g, i) => !same(canonical(g), canonical(want[i]))) : got))
  }
  // Guest writes follow the mock's rules: Kadek (manager) may approve in the guest module.
  for (const [label, run] of [
    ['a blacklist without a reason', (p) => p.guest.setBlacklist('g-02', 'no')],
    ['a merge of one profile with itself', (p) => p.guest.merge('g-16', 'g-16')],
    ['a companion on a closed stay', async (p) => p.guest.addCompanion((await ref.booking.bookings()).find((b) => b.status === 'checked_out').id, { name: 'Ana', adult: true, nationality: 'DE', idType: 'passport', idNumber: 'X1', idExpiry: null, birthDate: null, sex: null, birthPlace: '', entryDate: null, entryPort: '', visaType: null, addressInIndonesia: '' })],
    ['a lost item disposed before the holding period', (p) => p.lostFound.move('lf-4', { to: 'disposed', note: '' })],
    ['a returned lost item moving again', (p) => p.lostFound.move('lf-3', { to: 'stored', note: '' })],
    ['a holding period of 3 days', (p) => p.lostFound.saveSettings({ holdDays: 3 })],
  ]) {
    const outcome = async (p) => {
      try {
        await run(p)
        return 'accepted'
      } catch (e) {
        return `${e.code}: ${e.message}`
      }
    }
    const [got, want] = [await outcome(api), await outcome(ref)]
    check(`${label} is refused as the mock refuses it`, got === want && got !== 'accepted', got === want ? got : `${got} | mock ${want}`)
  }
  const blacklisted = await api.guest.setBlacklist('g-02', 'Left without paying the minibar')
  const mockBlacklisted = await ref.guest.setBlacklist('g-02', 'Left without paying the minibar')
  check('blacklisting a guest matches the mock', same(canonical(blacklisted), canonical(mockBlacklisted)), JSON.stringify(blacklisted.blacklist))
  const merged = await api.guest.merge('g-16', 'g-26')
  const mockMerged = await ref.guest.merge('g-16', 'g-26')
  check('merging the duplicate Sarah Cohen matches the mock', same(canonical(merged), canonical(mockMerged)) && (await api.guest.guests()).length === 25)
  const moved = await api.lostFound.move('lf-1', { to: 'stored', note: 'Front office safe' })
  const mockMoved = await ref.lostFound.move('lf-1', { to: 'stored', note: 'Front office safe' })
  check('a lost item moves as in the mock', moved.status === mockMoved.status && moved.history.length === mockMoved.history.length && moved.history.at(-1).note === 'Front office safe')

  const perms = await api.access.permissions()
  check('permissions equal the default matrix', same(canonical(perms), canonical(await ref.access.permissions())))
  const profile = await api.account.profile()
  check('profile shape', keys(profile) === keys(await ref.account.profile()), keys(profile))

  await checkOperations(api, ref)

  try {
    await api.access.users()
    check('a manager cannot list users', false)
  } catch (e) {
    check('a manager cannot list users', e.code === 'FORBIDDEN', `${e.code}: ${e.message}`)
  }
  try {
    await api.property.createLocation({ name: 'x', area: 'y' })
    check('a manager cannot create a location', false)
  } catch (e) {
    check('a manager cannot create a location', e.code === 'FORBIDDEN', `${e.code}: ${e.message}`)
  }

  // Reservation: every read model equals the mock's (Go sorts object keys, so compare canonically),
  // then the same commands on both sides give the same booking or the same refusal.
  for (const [name, read] of [
    ['bookings', (p) => p.booking.bookings()],
    ['booking-groups', (p) => p.groups.groups()],
    ['stay-restrictions', (p) => p.stayRules.restrictions()],
    ['overbooking-policies', (p) => p.stayRules.overbooking()],
    ['walks', (p) => p.stayRules.walks()],
    ['pre-checkins', (p) => p.precheckin.preCheckIns()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const equal = same(canonical(got), canonical(want))
    check(`${name} equals the mock (${got.length} rows)`, equal, equal ? '' : JSON.stringify(got.find((g, i) => !same(canonical(g), canonical(want[i])))))
  }
  const both = (run) => Promise.all([run(api), run(ref)].map((p) => p.then((v) => ({ v }), (e) => ({ e: `${e.code}: ${e.message}` }))))
  const sameResult = async (label, run, expectCode) => {
    const [got, want] = await both(run)
    const equal = got.e ? got.e === want.e : !want.e && same(canonical(got.v), canonical(want.v))
    const codeOk = !expectCode || (got.e ?? '').startsWith(`${expectCode}:`)
    check(label, equal && codeOk, equal && codeOk ? (got.e ?? '') : `api ${got.e ?? JSON.stringify(got.v)} / mock ${want.e ?? JSON.stringify(want.v)}`)
    return got.v
  }
  // KR-03 has no live listing, so its room type's rate plan prices it on both sides.
  const stay = { guestId: 'g-01', newGuest: null, unitId: 'unit-kr-03', groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: addDays(today, 25), checkOut: addDays(today, 27), channelRate: null, price: null, notes: 'Wiring check', confirm: true }
  const made = await sameResult('a direct booking on a rate plan equals the mock', (p) => p.booking.create(stay))
  await sameResult('an overlapping booking is refused like the mock', (p) => p.booking.create(stay), 'BOOKING_OVERLAP')
  await sameResult('a staff discount past the limit is refused like the mock', (p) => p.booking.setPrice(made.id, { rateOverride: null, discount: { kind: 'percent', value: 50, per: 'stay', reason: 'Wiring' }, reason: '' }))
  await sameResult('a block over the booking is refused like the mock', (p) => p.booking.addBlock({ unitId: 'unit-kr-03', from: stay.checkIn, to: stay.checkOut, reason: 'maintenance', note: '' }), 'BLOCK_OVERLAP')
  await sameResult('cancelling equals the mock', (p) => p.booking.transition(made.id, 'cancelled'))
  await sameResult('a cancelled booking cannot be confirmed', (p) => p.booking.transition(made.id, 'confirmed'), 'BOOKING_INVALID_STATE')
  const closed = { ...stay, unitId: 'unit-tr-04', checkIn: addDays(today, 29), checkOut: addDays(today, 31) }
  await sameResult('a stay over a stop sell is refused like the mock', (p) => p.booking.create(closed), 'RESTRICTION_VIOLATED')
  const [overridden] = await both((p) => p.booking.create({ ...closed, override: { reason: 'Wiring check override' } }))
  check('a manager sells past the stop sell with a reason', overridden.v?.restrictionNote?.kind === 'override', overridden.e ?? JSON.stringify(overridden.v?.restrictionNote))
  await sameResult('a room type full tonight is refused like the mock', (p) => p.booking.create({ ...stay, unitId: null, groupId: 'grp-saka-standard', checkIn: today, checkOut: addDays(today, 1) }), 'ROOM_TYPE_FULL')
  await sameResult('a room-by-room type cannot overbook', (p) => p.stayRules.setOverbooking('grp-karang-cliff', 1), 'OVERBOOK_ROOM_BY_ROOM')

  // Channel: Airbnb accounts and listings, web enquiries, the public site.
  const [accounts, mockAccounts] = await Promise.all([api.airbnb.accounts(), ref.airbnb.accounts()])
  check(`airbnb accounts equal the mock (${accounts.length} rows)`, same(accounts, mockAccounts))
  const [listings, mockListings] = await Promise.all([api.airbnb.listings(), ref.airbnb.listings()])
  const bare = (list) => list.map(({ dateRates: _rates, ...l }) => l)
  check(`airbnb listings equal the mock (${listings.length} rows)`, same(bare(listings), bare(mockListings)))
  // The seed moves date prices by whole weeks to keep weekend prices on weekends, so nights near a
  // high season edge may differ by a few days; compare the next four weeks away from the edges.
  const nearEdge = (date) => [-3, -2, -1, 0, 1, 2, 3].some((d) => ['12-20', '01-05', '07-01', '08-31'].includes(addDays(date, d).slice(5)))
  const nights = Array.from({ length: 28 }, (_, i) => addDays(today, i)).filter((d) => !nearEdge(d))
  const priced = (list) => list.map((l) => nights.map((d) => l.dateRates[d] ?? null))
  check(`listing date prices match the mock over ${nights.length} nights`, same(priced(listings), priced(mockListings)))
  const [enquiries, mockEnquiries] = await Promise.all([api.enquiries.enquiries(), ref.enquiries.enquiries()])
  check(`enquiries equal the mock (${enquiries.length} rows)`, same(canonical(enquiries), canonical(mockEnquiries)), same(canonical(enquiries), canonical(mockEnquiries)) ? '' : JSON.stringify(enquiries[0]))

  const [inv, mockInv] = await Promise.all([api.site.inventory(), ref.site.inventory()])
  for (const part of ['locations', 'villas', 'groups', 'units', 'ratePlans', 'contact', 'tax']) {
    check(`site inventory ${part} equals the mock`, same(canonical(inv[part]), canonical(mockInv[part])))
  }
  check('site inventory listings equal the mock', same(bare(inv.listings), bare(mockInv.listings)))
  check(`site inventory restrictions equal the mock (${inv.restrictions.length} rows)`, same(canonical(inv.restrictions), canonical(mockInv.restrictions)))
  console.log(`info site inventory parts other contexts own: menu ${inv.menu.length}/${mockInv.menu.length}, team ${inv.team.length}/${mockInv.team.length} (API/mock)`)
  const [from, to] = [addDays(today, -30), addDays(today, 90)]
  const [holds, mockHolds] = await Promise.all([api.site.holds(from, to), ref.site.holds(from, to)])
  const key = (h) => `${h.unitId} ${h.from} ${h.to} ${h.unitAssigned}`
  check(`site holds equal the mock's, stays and blocks (${holds.length} of ${mockHolds.length})`, same(holds.map(key).sort(), mockHolds.map(key).sort()))

  try {
    await api.airbnb.setListingPrices('lst-tr-04', { baseRate: 0, dateRates: {} })
    check('a zero base price is refused', false)
  } catch (e) {
    check('a zero base price is refused with VALIDATION_ERROR', e.code === 'VALIDATION_ERROR' && e.message === 'Enter the base price in whole rupiah.', `${e.code}: ${e.message}`)
  }
  const rateOf = async () => (await api.property.units()).find((u) => u.id === 'unit-tr-04').nightlyRate
  const before = await rateOf()
  await api.airbnb.setListingPrices('lst-tr-04', { baseRate: before + 10_000, dateRates: {} })
  check('a listing base price moves the unit rate', (await rateOf()) === before + 10_000)
  await api.airbnb.setListingPrices('lst-tr-04', { baseRate: before, dateRates: {} })
  try {
    await api.site.enquire({ name: 'M', email: 'mia', whatsapp: '1', country: 'ID', checkIn: today, checkOut: today, guests: 2, villaId: 'vil-saka', groupId: null, note: '' })
    check('a bad web enquiry is refused', false)
  } catch (e) {
    check('a bad web enquiry is refused with VALIDATION_ERROR', e.code === 'VALIDATION_ERROR' && e.message === 'Enter your name.', `${e.code}: ${e.message}`)
  }

  await api.access.logout()
  await api.access.login({ email: 'wayan@balivillas.id', password: 'villa123' })
  try {
    await api.airbnb.setListingPrices('lst-sk-01', { baseRate: 1_000_000, dateRates: {} })
    check('staff cannot edit listing prices', false)
  } catch (e) {
    check('staff cannot edit listing prices', e.code === 'FORBIDDEN' && e.message === 'Staff cannot edit in Airbnb.', `${e.code}: ${e.message}`)
  }
  check('staff read the Saka listings only', (await api.airbnb.listings()).every((l) => l.unitId.startsWith('unit-sk-')))

  await api.access.logout()
  await api.access.login({ email: 'rama@balivillas.id', password: 'villa123' })
  await ref.access.login({ email: 'rama@balivillas.id', password: 'villa123' })
  const [users, mockUsers] = await Promise.all([api.access.users(), ref.access.users()])
  check('users match the mock ids and shape', same(users.map((u) => u.id), mockUsers.map((u) => u.id)) && keys(users[0]) === keys(mockUsers[0]))
  const trail = await api.access.audit()
  const mockTrail = await ref.access.audit()
  check(`audit trail shape (${trail.length} lines)`, keys(trail[0]) === keys(mockTrail[0]) && trail[0].summary === 'Rama Wijaya signed in', trail[0]?.summary)

  try {
    await api.property.saveRatePlan('grp-saka-standard', { weekdayRate: 0, weekendRate: 1, seasons: [] })
    check('a bad rate plan is refused', false)
  } catch (e) {
    check('a bad rate plan is refused with VALIDATION_ERROR', e.code === 'VALIDATION_ERROR' && e.message === 'Enter the weekday rate in whole rupiah.', `${e.code}: ${e.message}`)
  }
  await api.access.logout()
  check('logout ends the session', (await api.access.session()) === null)
})

/** Same refusal on both sides; cash-out numbers differ by design (TX-M/TX-S until finance numbers them). */
async function refusal(label, run, ref) {
  const outcome = async (p) => {
    try {
      await run(p)
      return 'accepted'
    } catch (e) {
      return `${e.code}: ${e.message.replace(/TX-[MS]?\d+/g, 'TX-#')}`
    }
  }
  const [got, want] = [await outcome(ref.api), await outcome(ref.mock)]
  check(label, got === want && got !== 'accepted', got === want ? got : `${got} | mock: ${want}`)
}

/**
 * Maintenance and inventory, signed in as Kadek (manager): every read equals the mock regardless
 * of key order, then one write per rule family is run on both and compared.
 */
async function checkOperations(api, mock) {
  for (const [name, read] of [
    ['work-orders', (p) => p.maintenance.workOrders()],
    ['assets', (p) => p.maintenance.assets()],
    ['vendors', (p) => p.maintenance.vendors()],
    ['preventive-plans', (p) => p.maintenance.plans()],
    ['stock/items', (p) => p.stock.items()],
    ['stock/movements', (p) => p.stock.movements()],
    ['stock/receipts', (p) => p.stock.receipts()],
    ['stock/counts', (p) => p.stock.counts()],
    ['stock/kits', (p) => p.stock.kits()],
    ['stock/minibar-links', (p) => p.stock.minibarLinks()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(mock)])
    const ok = same(canonical(got), canonical(want))
    check(`${name} equals the mock (${got.length} rows)`, ok, ok ? '' : JSON.stringify(canonical(got).find((g, i) => !same(g, canonical(want)[i]))).slice(0, 300))
  }
  const both = { api, mock }

  // A work order with a block, started, with an expense submitted as a cash-out.
  const input = { villaId: 'vil-saka', unitId: 'unit-sk-02', assetId: null, category: 'plumbing', priority: 'high', title: 'Leaking shower mixer', description: 'Drips all night', assigneeId: null, vendorId: null, scheduledOn: null, parts: [{ name: 'Mixer cartridge', qty: 1, unitCost: 350000 }], labourCost: 0, vendorCost: 0, beforePhotos: [], afterPhotos: [] }
  const far = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
  const [wo, refWo] = await Promise.all([api.maintenance.createWorkOrder({ ...input, blockFrom: far(200), blockTo: far(202) }), mock.maintenance.createWorkOrder({ ...input, blockFrom: far(200), blockTo: far(202) })])
  check('a work order opens with the mock number and a block', wo.number === refWo.number && Boolean(wo.blockId) && keys(wo) === keys(refWo), `${wo.number} ${refWo.number}`)
  await refusal('an expense before the work starts is refused', (p) => p.maintenance.addExpense(p === api ? wo.id : refWo.id, { kind: 'parts', description: 'Cartridge', payee: 'Toko Bangunan', vendorId: null, amount: 350000, method: 'cash', reference: '', receipts: [], paidOn: today }), both)
  await Promise.all([api.maintenance.transitionWorkOrder(wo.id, 'in_progress', ''), mock.maintenance.transitionWorkOrder(refWo.id, 'in_progress', '')])
  const expense = { kind: 'parts', description: 'Cartridge', payee: 'Toko Bangunan', vendorId: null, amount: 350000, method: 'cash', reference: '', receipts: [], paidOn: today }
  const [paid, refPaid] = await Promise.all([api.maintenance.addExpense(wo.id, expense), mock.maintenance.addExpense(refWo.id, expense)])
  const line = (w) => ({ ...w.expenses[0], transactionId: '' })
  check('the expense line equals the mock apart from its cash-out id', same(canonical(line(paid)), canonical(line(refPaid))) && paid.history.at(-1).kind === 'cost', JSON.stringify(line(paid)))
  await refusal('a submitted expense cannot be corrected', (p) => p.maintenance.correctExpense(p === api ? wo.id : refWo.id, (p === api ? paid : refPaid).expenses[0].id, expense), both)
  const [done, refDone] = await Promise.all([api.maintenance.transitionWorkOrder(wo.id, 'done', ''), mock.maintenance.transitionWorkOrder(refWo.id, 'done', '')])
  check('finishing releases the block', done.blockId === null && refDone.blockId === null && done.status === 'done')

  // STOCK_SHORT, a receipt, a correction refused while submitted, and a count.
  const items = await api.stock.items()
  const soap = items.find((i) => i.kind === 'amenity')
  await refusal('writing off more than the store holds is STOCK_SHORT', (p) => p.stock.move({ kind: 'write_off', villaId: 'vil-saka', unitId: null, toVillaId: null, lines: [{ itemId: soap.id, quantity: 100000 }], reason: 'Damaged' }), both)
  const receipt = { villaId: 'vil-saka', supplier: 'Toko Bali', lines: [{ itemId: soap.id, quantity: 10, unitCost: 2500 }], method: 'cash', reference: '', attachments: [], receivedOn: today }
  const [rec, refRec] = await Promise.all([api.stock.receive(receipt), mock.stock.receive(receipt)])
  check('a receipt equals the mock apart from its cash-out id', same(canonical({ ...rec, transactionId: '' }), canonical({ ...refRec, transactionId: '' })), `${rec.number} ${refRec.number}`)
  const [priced, refPriced] = await Promise.all([api.stock.items(), mock.stock.items()])
  check('the average cost follows the receipt as in the mock', same(canonical(priced), canonical(refPriced)), String(priced.find((i) => i.id === soap.id)?.averageCost))
  await refusal('a submitted purchase cannot be corrected', (p) => p.stock.correctReceipt(p === api ? rec.id : refRec.id, { ...receipt, lines: [{ itemId: soap.id, quantity: 5, unitCost: 2500 }] }), both)
  const count = { villaId: 'vil-saka', countedBy: 'Kadek Ariani', lines: [{ itemId: soap.id, counted: 3 }], note: 'Wiring check' }
  const [counted, refCounted] = await Promise.all([api.stock.count(count), mock.stock.count(count)])
  check('a count equals the mock', same(canonical(counted), canonical(refCounted)), JSON.stringify(counted.lines))
  const [moves, refMoves] = await Promise.all([api.stock.movements(), mock.stock.movements()])
  check('movements after the writes equal the mock', same(canonical(moves), canonical(refMoves)), `${moves.length} vs ${refMoves.length}`)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nThe TypeScript HTTP adapter works against the Go API.')
process.exit(failures ? 1 : 0)

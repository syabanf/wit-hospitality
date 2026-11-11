// Runs the front end's own HTTP adapter (src/infrastructure/http) against a running Go API and
// compares what it returns with the mock adapter, the reference behaviour. Property, channel,
// reservation, guest and services reads must match the mock exactly; access reads must match in
// shape and ids; people and payroll reads must match the mock in content (key order aside) for an
// unscoped reader.
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

  // Billing: every read equals the mock's, then the folio, payment, audit and city ledger calls give
  // the same records or the same refusals.
  for (const [name, read] of [
    ['payments', (p) => p.payment.payments()],
    ['payment-links', (p) => p.payment.links()],
    ['payments/policy', (p) => p.payment.policy()],
    ['bookings/{id}/folio', (p) => p.folio.postings('bk-1294')],
    ['night-audits', (p) => p.audit.audits()],
    ['night-audits/business-date', (p) => p.audit.businessDate()],
    ['cashier-shifts', (p) => p.cashier.shifts()],
    ['cashier-shifts/hand-overs', (p) => p.cashier.handOvers()],
    ['cashier-shifts/policy', (p) => p.cashier.policy()],
    ['ledger/tax-settings', (p) => p.ledger.taxSettings()],
    ['ledger/transaction-codes', (p) => p.ledger.transactionCodes()],
    ['city-ledger/accounts', (p) => p.cityLedger.accounts()],
    ['city-ledger/invoices', (p) => p.cityLedger.invoices()],
    ['city-ledger/payments', (p) => p.cityLedger.payments()],
    ['city-ledger/transfers', (p) => p.cityLedger.transfers()],
    ['city-ledger/write-offs', (p) => p.cityLedger.writeOffs()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const equal = same(canonical(got), canonical(want))
    check(`${name} equals the mock${Array.isArray(got) ? ` (${got.length} rows)` : ''}`, equal, equal ? '' : JSON.stringify(Array.isArray(got) ? got.find((g, i) => !same(canonical(g), canonical(want[i]))) : got))
  }
  // Ids and stamps come from each side's own counters and clock; the rest of a posting must match.
  const posted = ({ id: _id, postedAt: _at, ...rest }) => rest
  const sameShape = async (label, run, pick) => {
    const [got, want] = await both(run)
    const equal = got.e ? got.e === want.e : !want.e && same(canonical(pick(got.v)), canonical(pick(want.v)))
    check(label, equal, equal ? (got.e ?? '') : `api ${got.e ?? JSON.stringify(pick(got.v))} / mock ${want.e ?? JSON.stringify(pick(want.v))}`)
    return got.v
  }
  await sameResult('a charge on a stay not in house is refused like the mock', (p) => p.folio.postCharge('bk-1309', { code: 'MINI', description: 'Water', amount: 20000 }), 'BOOKING_INVALID_STATE')
  await sameShape('a charge with service and PB1 equals the mock', (p) => p.folio.postCharge('bk-1296', { code: 'MINI', description: '2 × Bintang', amount: 121000 }), posted)
  await sameShape('a rebate on a posted night equals the mock', (p) => p.folio.postRebate('bk-1302', { lineId: 'bk-1302-night-1', amount: 100000, reason: 'Pool closed' }), posted)
  await sameResult('a plain check-out with charges open is refused like the mock', (p) => p.booking.checkOut('bk-1296', { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }), 'FOLIO_UNSETTLED')
  await sameResult('a gateway settle of charges alone is refused like the mock', (p) => p.booking.settleAndCheckOut('bk-1296', { details: { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }, method: 'qris', reference: '', attachments: [] }))
  await sameShape('settling in cash checks the stay out like the mock', (p) => p.booking.settleAndCheckOut('bk-1296', { details: { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }, method: 'cash', reference: '', attachments: [] }), (v) => [v.booking.status, v.booking.paidAmount, v.link])
  // The mock leaves the refund permission to the application service (payments/edit); the API checks it.
  const [refund] = await both((p) => p.payment.refund('pay-303', 1000, 'Pool closed', []))
  check('a manager cannot refund (payments/edit)', refund.e === 'FORBIDDEN: Villa manager cannot edit in Payments.', refund.e ?? 'accepted')
  const linked = await sameShape('a QRIS link equals the mock', (p) => p.payment.createLink({ bookingId: 'bk-1309', kind: 'balance', method: 'qris', amount: 1000000, payer: 'Guest' }), (l) => [l.bookingId, l.method, l.amount, l.gatewayFee, l.status])
  const paid = await api.payment.settle(linked.token, 'paid')
  check('the demo gateway pays the link', paid.paymentStatus === 'paid' && paid.link.status === 'paid', `${paid.paymentStatus} ${paid.link.status}`)
  check('the booking reads what the gateway paid', (await api.booking.bookings()).find((b) => b.id === 'bk-1309').paidAmount === 2790000)
  const date = await api.audit.businessDate()
  await sameShape('the night audit equals the mock', (p) => p.audit.run({ date, checks: { arrivals: 0, departures: 0, links: 0, orders: 0, unassigned: 0, cashCount: 0, shiftsOpen: 0 }, noShows: [] }), (a) => [a.date, a.nights, a.roomRevenue, a.stays.map((s) => s.code)])
  await sameResult('a rerun of the audit is refused like the mock', (p) => p.audit.run({ date, checks: {}, noShows: [] }), 'AUDIT_ALREADY_RUN')
  await sameResult('a transfer with nothing left on the room is refused like the mock', (p) => p.cityLedger.transfer('bk-1302', { accountId: 'cl-nusa', instruction: 'room' }), 'CITY_LEDGER_NOTHING')
  await sameShape('an invoice of an agent\'s open transfers equals the mock', (p) => p.cityLedger.issueInvoice('cl-jaya', today), (i) => [i.number, i.gross, i.service, i.pb1, i.commission, i.net, i.dueOn, i.lines.length])
  await sameResult('a write-off past the limit is refused like the mock', (p) => p.cityLedger.writeOff({ accountId: 'cl-consulate', invoiceId: 'cli-1', amount: 600000, reason: 'Bank charges' }), 'WRITE_OFF_LIMIT')
  await sameResult('backdated tax rates are refused like the mock', async (p) => p.ledger.saveTaxSettings({ ...(await p.ledger.taxSettings()), rates: { ...(await p.ledger.taxSettings()).rates[0], effectiveFrom: addDays(today, -3), servicePct: 11 } }), 'TAX_RATES_BACKDATED')
  await sameResult('deactivating ROOM is refused like the mock', (p) => p.ledger.setTransactionCodeActive('tc-room', false), 'CODE_IN_USE')

  // Housekeeping: the board, tasks, settings, linen and laundry equal the mock's; then the same
  // commands give the same tasks or the same refusal.
  for (const [name, read] of [
    ['housekeeping board', (p) => p.maintenance.housekeeping()],
    ['housekeeping/settings', (p) => p.housekeeping.settings()],
    ['housekeeping/tasks', (p) => p.housekeeping.tasks()],
    ['linen/pars', (p) => p.housekeeping.linenPars()],
    ['linen/soiled', (p) => p.housekeeping.linenSoiled()],
    ['laundry/batches', (p) => p.housekeeping.laundryBatches()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const equal = same(canonical(got), canonical(want))
    check(`${name} equals the mock${Array.isArray(got) ? ` (${got.length} rows)` : ''}`, equal, equal ? '' : JSON.stringify(Array.isArray(got) ? got.find((g, i) => !same(canonical(g), canonical(want[i]))) : got))
  }
  const hkTasks = await ref.housekeeping.tasks()
  const deep = hkTasks.find((t) => t.date === today && t.type === 'deep')
  const departure = hkTasks.find((t) => t.date === today && t.type === 'departure' && t.status === 'pending')
  const bag = (await ref.housekeeping.linenSoiled()).find((c) => c.quantity >= 2)
  await sameResult('assigning to an attendant off shift is refused like the mock', (p) => p.housekeeping.assign([deep.id], 'emp-002'), 'NOT_ON_SHIFT')
  await sameResult('a guest answer on a departure is refused like the mock', (p) => p.housekeeping.workTask(departure.id, 'dnd', {}), 'TASK_INVALID_STATE')
  await sameResult('sending more soiled linen than the villa holds is refused like the mock', (p) => p.housekeeping.sendLaundry({ villaId: bag.villaId, vendor: 'Ubud Laundry', sentOn: today, note: '', lines: [{ itemId: bag.itemId, quantity: bag.quantity + 1 }] }), 'LINEN_SHORT')
  await sameResult('a returned batch cannot come back again', (p) => p.housekeeping.returnLaundry('lnb-1', { returnedOn: today, lines: [], cost: 0, method: 'cash', reference: '', attachments: [] }), 'LAUNDRY_INVALID_STATE')
  await sameResult('auto-assign gives the same tasks to the same attendants', (p) => p.housekeeping.autoAssign(today).then((list) => list.map((t) => [t.id, t.attendantId])))
  const [sent, mockSent] = await both((p) => p.housekeeping.sendLaundry({ villaId: bag.villaId, vendor: 'Ubud Laundry', sentOn: today, note: 'Wiring', lines: [{ itemId: bag.itemId, quantity: 2 }] }))
  check('a laundry batch opens as in the mock', sent.v?.number === mockSent.v?.number && sent.v?.status === 'out' && keys(sent.v) === keys(mockSent.v), sent.e ?? sent.v?.number)

  // Messaging: settings and the seeded outbox equal the mock's; sending and refusals follow it.
  const [msgSettings, mockMsgSettings] = await Promise.all([api.messaging.settings(), ref.messaging.settings()])
  check('messages/settings equals the mock', same(canonical(msgSettings), canonical(mockMsgSettings)))
  const fixed = (list) => list.map(({ id, number, bookingId, templateKey, to, channel, language, subject, body, sentBy }) => ({ id, number, bookingId, templateKey, to, channel, language, subject, body, sentBy }))
  const [outbox, mockOutbox] = await Promise.all([api.messaging.messages(), ref.messaging.messages()])
  const sameOutbox = same(canonical(fixed(outbox)), canonical(fixed(mockOutbox)))
  check(`messages equal the mock (${outbox.length} rows)`, sameOutbox, sameOutbox ? '' : JSON.stringify(fixed(outbox).find((m, i) => !same(canonical(m), canonical(fixed(mockOutbox)[i])))))
  const delivered = mockOutbox.find((m) => m.status === 'delivered')
  await sameResult('resending a delivered message is refused like the mock', (p) => p.messaging.resend(delivered.id), 'MESSAGE_NOT_FAILED')
  await sameResult('an empty free message is refused like the mock', (p) => p.messaging.send({ bookingId: delivered.bookingId, channel: 'email', templateKey: null, language: 'en', body: ' ' }), 'VALIDATION_ERROR')
  const [free, mockFree] = await both((p) => p.messaging.send({ bookingId: delivered.bookingId, channel: 'email', templateKey: null, language: 'en', body: 'Hi {guest}, the pool is open again.' }))
  check('a free message renders as in the mock', free.v?.body === mockFree.v?.body && free.v?.number === mockFree.v?.number && keys(free.v) === keys(mockFree.v), free.e ?? free.v?.body)
  const failed = mockOutbox.find((m) => m.status === 'failed')
  const [again, mockAgain] = await both((p) => p.messaging.resend(failed.id))
  check('a failed message goes again as in the mock', again.v?.status === mockAgain.v?.status && again.v?.attempts === mockAgain.v?.attempts, again.e ?? again.v?.status)
  const [forged, mockForged] = await both((p) => p.messaging.invoice('iv-forged'))
  check('a forged e-invoice link is refused like the mock', forged.e?.startsWith('NOT_FOUND:') && forged.e.endsWith(mockForged.e?.split(': ').slice(1).join(': ') ?? '-'), `${forged.e} | mock ${mockForged.e}`)
  const postStay = mockOutbox.find((m) => m.templateKey === 'post_stay')
  try {
    await api.messaging.invoice(postStay.body.match(/invoice\/(\w+)/)[1])
    check('the e-invoice waits for billing', false)
  } catch (e) {
    check('the e-invoice waits for billing (NOT_AVAILABLE until billing renders it)', e.code === 'NOT_AVAILABLE', `${e.code}: ${e.message}`)
  }

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
  check(`site inventory menu equals the mock's, served by services (${inv.menu.length} items)`, same(canonical(inv.menu), canonical(mockInv.menu)))
  console.log(`info site inventory parts other contexts own: team ${inv.team.length}/${mockInv.team.length} (API/mock)`)
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

  // Services: the menu, partners, orders and requests equal the mock's; the same orders and
  // requests on both sides give the same record or the same refusal. History stamps and the
  // request minute read the clock, which the mock takes in the machine's time zone, so those
  // compare apart.
  for (const [name, read] of [
    ['menu-items', (p) => p.orders.menu()],
    ['service-partners', (p) => p.orders.partners()],
    ['service-orders', (p) => p.orders.orders()],
    ['service-requests', (p) => p.service.requests()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const equal = same(canonical(got), canonical(want))
    check(`${name} equals the mock (${got.length} rows)`, equal, equal ? '' : JSON.stringify(got.find((g, i) => !same(canonical(g), canonical(want[i])))))
  }
  const unclocked = (o) => (o && typeof o === 'object' ? { ...o, history: o.history?.map(({ at: _at, ...h }) => h), requestedAt: o.number?.startsWith('RQ-') ? 0 : o.requestedAt, deliveredAt: o.deliveredAt === null ? null : 0 } : o)
  const sameRecord = async (label, run, expectCode) => {
    const [got, want] = await both(run)
    const equal = got.e ? got.e === want.e : !want.e && same(canonical(unclocked(got.v)), canonical(unclocked(want.v)))
    const codeOk = !expectCode || (got.e ?? '').startsWith(`${expectCode}:`)
    check(label, equal && codeOk, equal && codeOk ? (got.e ?? '') : `api ${got.e ?? JSON.stringify(got.v)} / mock ${want.e ?? JSON.stringify(want.v)}`)
    return got.v
  }
  const tomorrow = addDays(today, 1)
  const stays = await ref.booking.bookings()
  const inHouse = stays.find((b) => b.status === 'checked_in' && b.unitId.startsWith('unit-sk-') && b.checkOut > tomorrow)
  const later = stays.find((b) => b.status === 'confirmed' && b.unitId.startsWith('unit-sk-') && b.checkIn > addDays(today, 5))
  const unitCode = (await ref.property.units()).find((u) => u.id === inHouse.unitId).code
  const order = (bookingId, itemId, extra = {}) => ({ bookingId, lines: [{ itemId, quantity: 2 }], note: 'Wiring check', requestedOn: tomorrow, requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '', ...extra })
  const placed = await sameRecord(`a desk order for ${inHouse.code} equals the mock`, (p) => p.orders.place(order(inHouse.id, 'mi-sk-nasi-goreng')))
  await sameRecord('breakfast in the afternoon is refused like the mock', (p) => p.orders.place(order(inHouse.id, 'mi-sk-breakfast-bali', { requestedAt: 15 * 60 })), 'ITEM_UNAVAILABLE')
  await sameRecord(`an order for ${later.code}, not in house, is refused like the mock`, (p) => p.orders.place(order(later.id, 'mi-sk-nasi-goreng')), 'ORDER_NO_STAY')
  const [leadGot, leadWant] = await both((p) => p.orders.place(order(inHouse.id, 'mi-sk-breakfast-floating', { requestedOn: today, requestedAt: 9 * 60 + 59 })))
  check('a floating breakfast without notice is refused like the mock', leadGot.e?.startsWith('ITEM_LEAD_TIME:') && leadWant.e?.startsWith('ITEM_LEAD_TIME:'), `api ${leadGot.e} / mock ${leadWant.e}`)
  await sameRecord('accepting the order equals the mock', (p) => p.orders.transition(placed.id, 'confirmed', ''))
  await sameRecord('a cancellation without a reason is refused like the mock', (p) => p.orders.transition(placed.id, 'cancelled', ''), 'VALIDATION_ERROR')
  await sameRecord('delivering the order equals the mock', (p) => p.orders.transition(placed.id, 'delivered', ''))
  await sameRecord('a delivered order cannot go back to preparing', (p) => p.orders.transition(placed.id, 'preparing', ''), 'ORDER_INVALID_STATE')
  const token = `${unitCode.toLowerCase()}-${(() => {
    let h = 2166136261
    for (const c of `menu:${unitCode}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    return (h >>> 0).toString(36).slice(0, 5)
  })()}`
  await sameRecord(`the QR menu of ${unitCode} equals the mock`, (p) => p.orders.guestMenu(token))
  await sameRecord(`a guest order from the QR card of ${unitCode} equals the mock`, (p) => p.orders.guestPlace(token, { lines: [{ itemId: 'mi-sk-coconut', quantity: 2 }], note: 'By the pool', requestedOn: tomorrow, requestedAt: 16 * 60 }))
  // Billing opens the guest's QRIS link for what the stay's delivered orders still owe.
  const [payGot, payWant] = await both((p) => p.orders.guestPay(token))
  const linkShape = (l) => l && [l.bookingId, l.method, l.amount, l.gatewayFee, l.status]
  check('a guest bill opens the same QRIS link as the mock', !payGot.e && same(linkShape(payGot.v), linkShape(payWant.v)), payGot.e ?? `${JSON.stringify(linkShape(payGot.v))} / mock ${payWant.e ?? JSON.stringify(linkShape(payWant.v))}`)
  const request = await sameRecord('a service request equals the mock', (p) => p.service.create({ unitId: inHouse.unitId, bookingId: inHouse.id, kind: 'towels', priority: 'normal', note: 'Two beach towels', charge: 0 }))
  await sameRecord('assigning the request equals the mock', (p) => p.service.assign(request.id, 'Wayan'))
  await sameRecord('closing the request equals the mock', (p) => p.service.transition(request.id, 'done'))
  await sameRecord('a closed request cannot restart', (p) => p.service.transition(request.id, 'in_progress'), 'REQUEST_INVALID_STATE')
  const { id: bintangId, ...bintang } = (await ref.orders.menu()).find((i) => i.id === 'mi-sk-bintang')
  await sameRecord('a menu price edit equals the mock', (p) => p.orders.updateItem(bintangId, { ...bintang, price: 60_000 }))

  // After the services checks: a minibar check adds an order to the mock's numbering.
  await checkOperations(api, ref)

  await api.access.logout()
  await api.access.login({ email: 'wayan@balivillas.id', password: 'villa123' })
  try {
    await api.orders.place(order(inHouse.id, 'mi-sk-coconut', { lines: [{ itemId: 'mi-sk-coconut', quantity: 1, comp: true }], compReason: 'Welcome drink' }))
    check('staff cannot give items for free', false)
  } catch (e) {
    check('staff cannot give items for free', e.code === 'COMP_FORBIDDEN' && e.message === 'Staff cannot give items for free. Ask a villa manager.', `${e.code}: ${e.message}`)
  }
  check('staff read the Saka orders only', (await api.orders.orders()).every((o) => o.villaId === 'vil-saka'))
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
  // People and payroll: Rama (owner, no scope) reads what the mock holds.
  for (const [name, read] of [
    ['employees', (p) => p.hr.employees()],
    ['shifts', (p) => p.hr.shifts()],
    ['shift-assignments', (p) => p.hr.assignments()],
    ['attendance', (p) => p.hr.attendance()],
    ['leave-requests', (p) => p.hr.leaves()],
    ['overtime-requests', (p) => p.hr.overtime()],
    ['loans', (p) => p.hr.loans()],
    ['announcements', (p) => p.people.announcements()],
    ['kpi-reviews', (p) => p.people.kpis()],
    ['payroll/periods', (p) => p.payroll.periods()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const ok = same(canonical(got), canonical(want))
    check(`${name} equals the mock (${got.length} rows)`, ok, ok ? '' : JSON.stringify(got.find((g, i) => !same(canonical(g), canonical(want[i]))) ?? null))
  }
  const settings = await api.payroll.settings()
  check('payroll settings equal the mock', same(canonical(settings), canonical(await ref.payroll.settings())))
  try {
    await api.hr.requestLeave({ employeeId: 'emp-002', kind: 'annual', from: today, to: today, reason: 'x' })
    check('a leave request without a reason is refused', false)
  } catch (e) {
    check('a leave request without a reason is refused', e.code === 'VALIDATION_ERROR' && e.message === 'Say why.', `${e.code}: ${e.message}`)
  }
  try {
    await api.payroll.createPeriod(`${today.slice(0, 7)}`)
    check('a second payroll for the month is refused', false)
  } catch (e) {
    check('a second payroll for the month is refused', e.code === 'PAYROLL_EXISTS', `${e.code}: ${e.message}`)
  }

  // Finance: Rama (owner, no scope) reads the cash ledger, the books and the cashier shifts the
  // mock holds, then the same entries and refusals on both sides. Finance keeps the id a work order
  // expense or stock purchase gave its cash-out (tx-m241, tx-s241) and numbers it like the mock.
  const [entries, refEntries] = await Promise.all([api.finance.transactions(), ref.finance.transactions()])
  const asked = (list) => list.map((t) => (/^tx-[ms]/.test(t.id) ? { ...t, id: `tx-${Number(t.number.slice(3)) - 2400}` } : t))
  const entriesOk = same(canonical(asked(entries)), canonical(refEntries))
  check(`transactions equal the mock (${entries.length} rows, asked-for ids aside)`, entriesOk, entriesOk ? '' : JSON.stringify(asked(entries).find((g, i) => !same(canonical(g), canonical(refEntries[i]))) ?? null))
  // The mock books the minibar order the operations check delivered; services and billing book it
  // through finance once they run, so the mock may hold that entry and finance not yet.
  const [books, refBooks] = await Promise.all([api.ledger.journals(), ref.ledger.journals()])
  const extra = refBooks.slice(books.length)
  check(`ledger/journals equal the mock (${books.length} rows)`, same(canonical(books), canonical(refBooks.slice(0, books.length))) && extra.every((e) => e.source === 'order'), extra.map((e) => `${e.number} ${e.source}`).join(', '))
  for (const [name, read] of [
    ['cash-accounts', (p) => p.finance.accounts()],
    ['categories', (p) => p.finance.categories()],
    ['reconciliations', (p) => p.finance.reconciliations()],
    ['approval-rules', (p) => p.finance.approvalRules()],
    ['ledger/accounts', (p) => p.ledger.chart()],
    ['ledger/transaction-codes', (p) => p.ledger.transactionCodes()],
    ['ledger/manual-journals', (p) => p.ledger.manualJournals()],
    ['ledger/periods', (p) => p.ledger.periodCloses()],
    ['budgets', (p) => p.budget.budgets()],
    ['cashier-shifts', (p) => p.cashier.shifts()],
    ['cashier-shifts/hand-overs', (p) => p.cashier.handOvers()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const ok = same(canonical(got), canonical(want))
    check(`${name} equals the mock (${got.length} rows)`, ok, ok ? '' : JSON.stringify(got.find((g, i) => !same(canonical(g), canonical(want[i]))) ?? null))
  }
  for (const [name, read] of [
    ['settings/proof-policy', (p) => p.finance.proofPolicy()],
    ['ledger/category-accounts', (p) => p.ledger.categoryAccounts()],
    ['ledger/tax-settings', (p) => p.ledger.taxSettings()],
    ['cashier-shifts/policy', (p) => p.cashier.policy()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    check(`${name} equals the mock`, same(canonical(got), canonical(want)), JSON.stringify(got))
  }
  const cashOut = { accountId: 'cb-ubud', kind: 'cash_out', categoryId: 'cat-util', amount: 2_400_000, date: today, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Wiring check generator service', reference: 'WC-1', attachments: [] }
  await sameResult('a large cash-out without a receipt is refused like the mock', (p) => p.finance.createTransaction(cashOut, true), 'PROOF_REQUIRED')
  const receipt = { id: 'file-wiring', name: 'invoice.pdf', type: 'application/pdf', size: 2048, url: 'https://files.example/invoice.pdf', uploadedBy: 'Rama Wijaya', uploadedAt: `${today}T09:00:00` }
  const entry = await sameResult('a cash-out with its receipt equals the mock', (p) => p.finance.createTransaction({ ...cashOut, attachments: [receipt] }, true))
  await sameResult('the author cannot approve their own entry', (p) => p.finance.transition(entry.id, 'approved', ''), 'APPROVAL_SELF')
  await sameResult('the current month cannot close yet', (p) => p.ledger.closePeriod(today.slice(0, 7), ''), 'PERIOD_NOT_ENDED')
  await sameResult('a manual journal that does not balance is refused', (p) => p.ledger.createManualJournal({ date: today, villaId: null, memo: 'Wiring check accrual', lines: [{ accountId: 'gl-1200', debit: 100, credit: 0 }, { accountId: 'gl-4900', debit: 0, credit: 90 }], attachments: [] }, true), 'JOURNAL_UNBALANCED')
  await sameResult('a manual journal equals the mock', (p) => p.ledger.createManualJournal({ date: today, villaId: null, memo: 'Wiring check accrual', lines: [{ accountId: 'gl-1200', debit: 100, credit: 0 }, { accountId: 'gl-4900', debit: 0, credit: 100 }], attachments: [] }, true))
  await sameResult('an open shift on the Canggu cashbox is refused like the mock', (p) => p.cashier.open({ accountId: 'cb-canggu', count: { notes: {}, coins: 0 }, handOverFrom: null }), 'SHIFT_ALREADY_OPEN')
  await sameResult('a system category stays active', (p) => p.finance.setCategoryActive('cat-payroll', false), 'CATEGORY_SYSTEM')
  await sameResult('a cash GL account cannot take a category', (p) => p.ledger.mapCategory('cat-util', 'gl-cash-bank-bca'), 'LEDGER_ACCOUNT_INVALID')
  await sameResult('the ROOM code stays active', (p) => p.ledger.setTransactionCodeActive('tc-room', false), 'CODE_IN_USE')

  // Employee area: Wayan (staff, EMP-002) reads his own records only.
  await api.access.logout()
  await api.access.login({ email: 'wayan@balivillas.id', password: 'villa123' })
  const mine = await api.hr.employees()
  check('staff read their own employee record only', mine.length === 1 && mine[0].id === 'emp-002', mine.map((e) => e.id).join(','))
  const myLeaves = await api.hr.leaves()
  check('staff read their own leave requests only', myLeaves.every((l) => l.employeeId === 'emp-002'), `${myLeaves.length} rows`)
  const myPeriods = await api.payroll.periods()
  check('staff read their own published payslips only', myPeriods.every((p) => p.lines.every((l) => l.employeeId === 'emp-002') && (p.published || p.lines.length === 0)))
  const pending = (await ref.hr.leaves()).find((l) => l.status === 'pending')
  try {
    await api.hr.decideLeave(pending.id, 'approved', '')
    check('staff cannot approve leave', false)
  } catch (e) {
    check('staff cannot approve leave', e.code === 'FORBIDDEN', `${e.code}: ${e.message}`)
  }
  try {
    await api.payroll.transition(myPeriods[myPeriods.length - 1].id, 'approved', '')
    check('staff cannot approve payroll', false)
  } catch (e) {
    check('staff cannot approve payroll', e.code === 'FORBIDDEN', `${e.code}: ${e.message}`)
  }

  // Owners: the seeded records equal the mock's; the rules refuse as the mock does. Finance is not
  // built yet, so a statement closed now reads its room revenue alone: its figures are info only.
  await api.access.logout()
  await api.access.login({ email: 'ida@balivillas.id', password: 'villa123' })
  await ref.access.login({ email: 'ida@balivillas.id', password: 'villa123' })
  for (const [name, read] of [
    ['villa-owners', (p) => p.owners.owners()],
    ['management-contracts', (p) => p.owners.contracts()],
    ['owner-statements', (p) => p.owners.statements()],
    ['owner-stays', (p) => p.owners.stayRequests()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    const equal = same(canonical(got), canonical(want))
    check(`${name} equals the mock (${got.length} rows)`, equal, equal ? '' : JSON.stringify(got.find((g, i) => !same(canonical(g), canonical(want[i])))))
  }
  const statementOf = async (p, number) => (await p.owners.statements()).find((st) => st.number === number)
  const [krOct, pdOct] = [`OS-${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-KR`, `OS-${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-PD`]
  const lastMonth = krOct.slice(3, 10)
  const earlier = addDays(`${lastMonth}-01`, -40).slice(0, 7)
  await sameResult('closing the running month is refused like the mock', (p) => p.owners.closeStatement({ contractId: 'ct-karang', month: today.slice(0, 7), base: null, stays: [], entries: [], note: '' }), 'STATEMENT_MONTH_OPEN')
  await sameResult('closing a month before a closed one is refused like the mock', (p) => p.owners.closeStatement({ contractId: 'ct-karang', month: earlier, base: null, stays: [], entries: [], note: '' }), 'STATEMENT_ORDER')
  await sameResult('reopening a statement whose payout waits is refused like the mock', async (p) => p.owners.reopenStatement((await statementOf(p, krOct)).id, 'Wrong fee'), 'PAYOUT_OPEN')
  await sameResult('paying a carried shortfall is refused like the mock', async (p) => p.owners.payStatement((await statementOf(p, pdOct)).id, 'bank-bca'), 'PAYOUT_NOTHING')
  const [reopenedApi, reopenedMock] = await both(async (p) => p.owners.reopenStatement((await statementOf(p, pdOct)).id, 'Recheck the costs'))
  check('a statement without a payout reopens', !reopenedApi.e && !reopenedMock.e, reopenedApi.e ?? reopenedMock.e ?? '')
  // The console sends the draft it worked out; the API works the figures out itself.
  const was = reopenedMock.v
  const [closedApi, closedMock] = await Promise.all([
    api.owners.closeStatement({ contractId: 'ct-pandawa', month: lastMonth, base: null, stays: [], entries: [], note: '' }),
    ref.owners.closeStatement({ contractId: 'ct-pandawa', month: lastMonth, base: was.figures, stays: was.stays, entries: was.entries, note: '' }),
  ])
  check('closing again answers the OwnerStatement shape', keys(closedApi) === keys(closedMock) && closedApi.status === 'closed' && closedApi.number === pdOct, keys(closedApi))
  const fig = (x) => `room ${x.figures.roomRevenue}, net ${x.figures.netPayable}, payable ${x.payable}`
  console.log(`info ${pdOct} closed again with finance stubbed: API ${fig(closedApi)} / mock ${fig(closedMock)}`)
  await sameResult('a finance user cannot approve an owner statement', (p) => p.owners.approveStatement((p === api ? closedApi : closedMock).id, ''), 'APPROVAL_ROLE')

  const [uploaded, mockUploaded] = await Promise.all([api, ref].map((p) => p.files.upload({ name: 'receipt.pdf', type: 'application/pdf', size: 9, data: new Blob(['%PDF-1.4\n'], { type: 'application/pdf' }) })))
  check('a file upload answers the Attachment shape', keys(uploaded) === keys(mockUploaded) && uploaded.size === 9 && uploaded.uploadedBy === 'Ida Bagus Rai', keys(uploaded))
  await sameResult('a text file is refused like the mock', (p) => p.files.upload({ name: 'notes.txt', type: 'text/plain', size: 5, data: new Blob(['hello'], { type: 'text/plain' }) }), 'ATTACHMENT_TYPE')

  await api.access.logout()
  await api.access.login({ email: 'hendra@balivillas.id', password: 'villa123' })
  await ref.access.login({ email: 'hendra@balivillas.id', password: 'villa123' })
  for (const [name, read] of [
    ['management-contracts', (p) => p.owners.contracts()],
    ['owner-statements', (p) => p.owners.statements()],
    ['owner-stays', (p) => p.owners.stayRequests()],
  ]) {
    const [got, want] = await Promise.all([read(api), read(ref)])
    check(`a villa owner reads their own ${name} as in the mock (${got.length} rows)`, same(got.map((x) => x.id).sort(), want.map((x) => x.id).sort()), JSON.stringify(got.map((x) => x.id)))
  }
  try {
    await api.booking.bookings()
    check('a villa owner cannot read bookings', false)
  } catch (e) {
    check('a villa owner cannot read bookings', e.code === 'FORBIDDEN', `${e.code}: ${e.message}`)
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
  // A minibar check on a stay in house: the same order lines and the same restock out of the store.
  const stay = (await api.booking.bookings()).find((b) => b.status === 'checked_in')
  const villaId = (await api.property.units()).find((u) => u.id === stay?.unitId)?.villaId
  const links = await api.stock.minibarLinks()
  const menuItem = (await mock.orders.menu()).find((m) => m.villaId === villaId && m.category === 'minibar' && m.active && links.some((l) => l.menuItemId === m.id))
  if (stay && menuItem) {
    const taken = { bookingId: stay.id, lines: [{ menuItemId: menuItem.id, quantity: 1 }], restock: true, note: '' }
    const [order, refOrder] = await Promise.all([api.stock.minibarCheck(taken), mock.stock.minibarCheck(taken)])
    check('a minibar check bills the same delivered order', order.status === 'delivered' && same(canonical(order.lines), canonical(refOrder.lines)) && keys(order) === keys(refOrder), keys(order))
  } else check('a stay in house with a minibar to check', false)
  // Order ids differ by design: services numbers orders, inventory hands out so-mb-N until it runs.
  const plain = (list) => canonical(list.map((m) => ({ ...m, orderId: m.orderId ? 'order' : null })))
  const [moves, refMoves] = await Promise.all([api.stock.movements(), mock.stock.movements()])
  check('movements after the writes equal the mock', same(plain(moves), plain(refMoves)), `${moves.length} vs ${refMoves.length}`)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nThe TypeScript HTTP adapter works against the Go API.')
process.exit(failures ? 1 : 0)

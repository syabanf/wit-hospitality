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
  console.log(`info site inventory parts other contexts own: restrictions ${inv.restrictions.length}/${mockInv.restrictions.length}, menu ${inv.menu.length}/${mockInv.menu.length}, team ${inv.team.length}/${mockInv.team.length} (API/mock)`)
  const [from, to] = [addDays(today, -30), addDays(today, 90)]
  const [holds, mockHolds] = await Promise.all([api.site.holds(from, to), ref.site.holds(from, to)])
  const key = (h) => `${h.unitId} ${h.from} ${h.to} ${h.unitAssigned}`
  const mockKeys = new Set(mockHolds.map(key))
  check(`site holds are among the mock's (${holds.length} blocks of ${mockHolds.length}; stays come with reservation)`, holds.length > 0 && holds.every((h) => mockKeys.has(key(h))))

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

console.log(failures ? `\n${failures} check(s) failed` : '\nThe TypeScript HTTP adapter works against the Go API.')
process.exit(failures ? 1 : 0)

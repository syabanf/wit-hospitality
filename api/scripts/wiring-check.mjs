// Runs the front end's own HTTP adapter (src/infrastructure/http) against a running Go API and
// compares what it returns with the mock adapter, the reference behaviour. Property reads must
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
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
  const both = (run) => Promise.all([run(api), run(ref)].map((p) => p.then((v) => ({ v }), (e) => ({ e: `${e.code}: ${e.message}` }))))
  const sameResult = async (label, run, expectCode) => {
    const [got, want] = await both(run)
    const equal = got.e ? got.e === want.e : !want.e && same(canonical(got.v), canonical(want.v))
    const codeOk = !expectCode || (got.e ?? '').startsWith(`${expectCode}:`)
    check(label, equal && codeOk, equal && codeOk ? (got.e ?? '') : `api ${got.e ?? JSON.stringify(got.v)} / mock ${want.e ?? JSON.stringify(want.v)}`)
    return got.v
  }
  // KR-03 sells at its room type's rate plan: the channel context (live listings) is not in the API yet.
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

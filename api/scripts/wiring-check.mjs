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

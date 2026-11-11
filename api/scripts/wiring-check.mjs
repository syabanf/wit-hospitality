// Runs the front end's own HTTP adapter (src/infrastructure/http) against a running Go API and
// compares what it returns with the mock adapter, the reference behaviour. Property reads must
// match the mock exactly; access reads must match in shape and ids; people and payroll reads must
// match the mock in content (key order aside) for an unscoped reader.
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

  await api.access.logout()
  check('logout ends the session', (await api.access.session()) === null)
})

console.log(failures ? `\n${failures} check(s) failed` : '\nThe TypeScript HTTP adapter works against the Go API.')
process.exit(failures ? 1 : 0)

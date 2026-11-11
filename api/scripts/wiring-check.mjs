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

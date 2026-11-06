import { describe, expect, it } from 'vitest'
import { balance } from '@/domain/finance'
import { netPaid } from '@/domain/payment'
import { buildCatalog } from '@/domain/property'
import { overlaps, typeAvailability } from '@/domain/booking'
import { pettyLow } from '@/domain/finance'
import { overbookedNights, overbookLimit } from '@/domain/overbooking'
import { addDays } from '@/lib/dates'
import { buildState } from '../state'
import { ACCOUNTS, LISTINGS } from './airbnb'
import { BLOCKS, EXTRA_BOOKINGS, expandPlans, parsePlan, UNIT_PLANS } from './bookings'
import { CATEGORIES, TRANSACTIONS } from './finance'
import { GUESTS } from './guests'
import { GROUPS, LOCATIONS, UNITS, VILLAS } from './property'

const catalog = buildCatalog(LOCATIONS, VILLAS, UNITS, GROUPS)
/** The seeded room-type stay that sells Saka standard one past its rooms tonight. */
const OVERBOOKED = 'BK-2011'
const state = buildState('2026-10-05')

describe('seed data', () => {
  it('has twenty units in four locations, each in a real villa and group', () => {
    expect(UNITS).toHaveLength(20)
    expect(LOCATIONS).toHaveLength(4)
    for (const u of UNITS) {
      expect(() => catalog.villa(u.villaId)).not.toThrow()
      if (u.groupId) expect(catalog.group(u.groupId).villaId).toBe(u.villaId)
    }
    expect(new Set(UNITS.map((u) => u.id)).size).toBe(20)
  })

  it('lists each unit on Airbnb at most once, under a real account', () => {
    expect(new Set(LISTINGS.map((l) => l.unitId)).size).toBe(LISTINGS.length)
    for (const l of LISTINGS) {
      expect(ACCOUNTS.some((a) => a.id === l.accountId)).toBe(true)
      expect(() => catalog.unit(l.unitId)).not.toThrow()
    }
  })

  it('gives every room type a rate plan and sells direct-only units from it', () => {
    for (const g of GROUPS) expect(state.ratePlans.filter((p) => p.groupId === g.id), g.id).toHaveLength(1)
    for (const code of ['KR-03', 'SK-08']) {
      const stays = state.bookings.filter((b) => b.unitId === catalog.unitByCode(code).id && b.source === 'direct')
      expect(stays.length, code).toBeGreaterThan(0)
      for (const b of stays) expect(b.listSources?.every((x) => x.kind === 'plan'), b.code).toBe(true)
    }
  })

  it('parses every plan and never overlaps stays inside a unit', () => {
    expect(parsePlan('a4 -1 d3')).toEqual([
      { source: 'airbnb', nights: 4 },
      { source: 'gap', nights: 1 },
      { source: 'direct', nights: 3 },
    ])
    expect(() => parsePlan('x2')).toThrow()
    const stays = expandPlans(UNIT_PLANS)
    expect(stays.length).toBeGreaterThan(300)
    for (const plan of UNIT_PLANS) {
      const mine = stays.filter((s) => s.unitCode === plan.unit).sort((a, b) => a.startOffset - b.startOffset)
      for (let i = 1; i < mine.length; i++) {
        const prev = mine[i - 1]
        const cur = mine[i]
        if (prev && cur) expect(prev.startOffset + prev.nights).toBeLessThanOrEqual(cur.startOffset)
      }
    }
  })

  it('gives today arrivals, departures and in-house stays to show', () => {
    const bookings = state.bookings
    expect(bookings.filter((b) => b.status === 'confirmed' && b.checkIn === state.today).length).toBeGreaterThanOrEqual(3)
    expect(bookings.filter((b) => b.status === 'checked_in' && b.checkOut === state.today).length).toBeGreaterThanOrEqual(3)
    expect(bookings.filter((b) => b.status === 'checked_in').length).toBeGreaterThanOrEqual(6)
    expect(bookings.filter((b) => b.status === 'draft')).toHaveLength(1)
    expect(bookings.filter((b) => b.status === 'cancelled')).toHaveLength(1)
  })

  it('keeps codes unique and every reference real', () => {
    expect(new Set(state.bookings.map((b) => b.code)).size).toBe(state.bookings.length)
    for (const b of state.bookings) {
      expect(GUESTS.some((g) => g.id === b.guestId)).toBe(true)
      expect(() => catalog.unit(b.unitId)).not.toThrow()
      if (b.source === 'airbnb') expect(ACCOUNTS.some((a) => a.id === b.airbnbAccountId)).toBe(true)
      else expect(b.airbnbAccountId).toBeNull()
    }
    for (const e of EXTRA_BOOKINGS) expect(() => catalog.unitByCode(e.unitCode)).not.toThrow()
    for (const k of BLOCKS) expect(() => catalog.unitByCode(k.unitCode)).not.toThrow()
  })

  it('never double-books a unit, blocks included', () => {
    const live = state.bookings.filter((b) => b.unitAssigned && (b.status === 'confirmed' || b.status === 'checked_in'))
    for (const a of live) {
      for (const b of live) {
        if (a.id < b.id && a.unitId === b.unitId) expect(overlaps(a.checkIn, a.checkOut, b.checkIn, b.checkOut), `${a.code} vs ${b.code}`).toBe(false)
      }
      for (const k of state.blocks) if (k.unitId === a.unitId) expect(overlaps(a.checkIn, a.checkOut, k.from, k.to), `${a.code} vs ${k.id}`).toBe(false)
    }
  })

  it('seeds two groups whose stays share the lead guest and one deposit batch', () => {
    expect(state.bookingGroups.map((g) => [g.code, g.billing])).toEqual([
      ['GRP-1001', 'master'],
      ['GRP-1002', 'per_stay'],
    ])
    for (const g of state.bookingGroups) {
      const stays = state.bookings.filter((b) => b.bookingGroupId === g.id)
      expect(stays.length, g.code).toBeGreaterThanOrEqual(2)
      expect(stays.every((b) => b.guestId === g.leadGuestId && b.status === 'confirmed')).toBe(true)
      expect(new Set(state.payments.filter((p) => p.groupId === g.id).map((p) => p.batch))).toEqual(new Set([`GP-${g.code.slice(4)}`]))
    }
  })

  it('maps every transaction to a real account, category and location, with matching kinds', () => {
    expect(new Set(TRANSACTIONS.map((t) => t.seq)).size).toBe(TRANSACTIONS.length)
    for (const t of TRANSACTIONS) {
      const category = CATEGORIES.find((c) => c.id === t.categoryId)
      expect(category, t.description).toBeDefined()
      if (!t.reversalOfSeq) expect(category?.kind).toBe(t.kind)
      expect(state.cashAccounts.some((a) => a.id === t.accountId)).toBe(true)
      expect(() => catalog.location(t.locationId)).not.toThrow()
      if (t.villaId) expect(catalog.villa(t.villaId).locationId).toBe(t.locationId)
      if (t.unitId) expect(catalog.unit(t.unitId).villaId).toBe(t.villaId)
      if (t.bookingId) expect(state.bookings.some((b) => b.id === t.bookingId)).toBe(true)
    }
  })

  it('pairs each reversal with a reversed original and keeps every balance positive', () => {
    const reversals = state.transactions.filter((t) => t.reversalOf)
    expect(reversals).toHaveLength(1)
    for (const r of reversals) {
      const original = state.transactions.find((t) => t.id === r.reversalOf)
      expect(original?.status).toBe('reversed')
      expect(original?.reversedBy).toBe(r.id)
      expect(original?.kind).not.toBe(r.kind)
    }
    for (const a of state.cashAccounts) expect(balance(a, state.transactions)).toBeGreaterThan(0)
  })
})

describe('maintenance seed', () => {
  it('points every asset, plan and work order at real villas, units, employees, vendors and entries', async () => {
    const { ASSETS, PLANS, VENDORS, WORK_ORDERS } = await import('./maintenance')
    const { EMPLOYEES } = await import('./hr')
    const vendorIds = new Set(VENDORS.map((v) => v.id))
    const assetIds = new Set(ASSETS.map((a) => a.id))
    const employeeIds = new Set(EMPLOYEES.map((e) => e.id))
    expect(new Set(ASSETS.map((a) => a.code)).size).toBe(ASSETS.length)
    for (const a of ASSETS) {
      expect(() => catalog.villa(a.villaId)).not.toThrow()
      if (a.unitCode) expect(catalog.unitByCode(a.unitCode).villaId).toBe(a.villaId)
    }
    for (const p of PLANS) {
      expect(() => catalog.villa(p.villaId)).not.toThrow()
      if (p.assetId) expect(assetIds.has(p.assetId)).toBe(true)
      if (p.vendorId) expect(vendorIds.has(p.vendorId)).toBe(true)
      if (p.assigneeId) expect(employeeIds.has(p.assigneeId)).toBe(true)
    }
    expect(new Set(WORK_ORDERS.map((w) => w.status)).size).toBe(7)
    for (const w of WORK_ORDERS) {
      if (w.unitCode) expect(catalog.unitByCode(w.unitCode).villaId, `WO ${w.seq}`).toBe(w.villaId)
      if (w.assetId) expect(assetIds.has(w.assetId), `WO ${w.seq}`).toBe(true)
      if (w.vendorId) expect(vendorIds.has(w.vendorId)).toBe(true)
      if (w.assigneeId) expect(employeeIds.has(w.assigneeId)).toBe(true)
      if (w.planId) expect(PLANS.some((p) => p.id === w.planId)).toBe(true)
      if (w.blockId) expect(BLOCKS.some((k) => k.id === w.blockId)).toBe(true)
      if (w.transactionSeq) expect(TRANSACTIONS.some((t) => t.seq === w.transactionSeq && t.categoryId === 'cat-maint')).toBe(true)
    }
    expect(state.housekeeping.length).toBe(19)
    expect(state.housekeeping.some((h) => h.state !== 'ready')).toBe(true)
  })

  it('backs every paid amount with payments and points every payment at a real booking', () => {
    for (const p of state.payments) expect(state.bookings.some((b) => b.id === p.bookingId), p.number).toBe(true)
    expect(new Set(state.payments.map((p) => p.number)).size).toBe(state.payments.length)
    // A direct stay billed to the city ledger counts the room moved to the account as paid.
    for (const b of state.bookings) {
      if (b.source === 'airbnb') {
        if (b.paymentStatus === 'paid') expect(netPaid(state.payments, b.id), b.code).toBe(b.paidAmount - b.airbnbFee)
      } else expect(netPaid(state.payments, b.id) + state.folioPostings.filter((p) => p.bookingId === b.id && p.kind === 'transfer' && p.part === 'room').reduce((sum, p) => sum + p.amount, 0), b.code).toBe(b.paidAmount)
    }
    for (const l of state.paymentLinks) expect(state.payments.find((p) => p.id === l.paymentId)?.bookingId).toBe(l.bookingId)
    expect(state.paymentLinks.map((l) => l.token)).toContain('demo-qris')
  })

  it('seeds stays waiting for a room inside their room type, and one petty cash per villa', () => {
    const waiting = state.bookings.filter((b) => !b.unitAssigned)
    expect(waiting.map((b) => b.code)).toEqual(['BK-2005', 'BK-2006', 'BK-2007', 'BK-2011'])
    // BK-2011 is the stay sold past Saka's rooms tonight; the walk takes it, so it has no room of its own.
    for (const b of waiting.filter((x) => x.code !== OVERBOOKED)) {
      const group = catalog.unit(b.unitId).groupId ?? ''
      expect(GROUPS.find((g) => g.id === group)?.operatorAssigns, b.code).toBe(true)
      // Without this stay the type still has a room on every night.
      expect(typeAvailability(catalog, group, b.checkIn, b.checkOut, state.bookings, state.blocks, b.id).free, b.code).toBeGreaterThan(0)
    }
    // Whatever day the demo opens on, one room stays free for the whole of each waiting stay.
    for (const today of ['2026-10-05', '2026-10-31', '2026-11-15', '2027-01-20']) {
      const s = buildState(today)
      for (const b of s.bookings.filter((x) => !x.unitAssigned && x.code !== OVERBOOKED)) {
        const group = catalog.unit(b.unitId).groupId ?? ''
        expect(typeAvailability(catalog, group, b.checkIn, b.checkOut, s.bookings, s.blocks, b.id).units.length, `${b.code} on ${today}`).toBeGreaterThan(0)
      }
    }
    const petty = state.cashAccounts.filter((a) => a.kind === 'petty')
    expect(petty.map((a) => a.villaId).sort()).toEqual(VILLAS.map((v) => v.id).sort())
    expect(petty.filter((a) => pettyLow(a, balance(a, state.transactions))).map((a) => a.id)).toEqual(['pc-karang'])
  })

  it('overbooks Saka standard by one tonight only, inside its limit, on a confirmed stay with a deposit', () => {
    for (const today of ['2026-10-05', '2026-10-31', '2026-11-15', '2027-01-20']) {
      const s = buildState(today)
      const cat = s.catalog()
      const nights = cat.groups.flatMap((g) => overbookedNights(cat, g.id, addDays(today, -30), addDays(today, 60), s.bookings, s.blocks))
      expect(nights.map((n) => [n.groupId, n.date, n.over]), today).toEqual([['grp-saka-standard', today, 1]])
      expect(nights[0]?.over ?? 0).toBeLessThanOrEqual(overbookLimit(s.overbooking, 'grp-saka-standard'))
      const b = s.bookings.find((x) => x.code === OVERBOOKED)
      expect(b).toMatchObject({ status: 'confirmed', source: 'direct', unitAssigned: false, checkIn: today, checkOut: addDays(today, 1), paymentStatus: 'partial' })
      expect(s.payments.some((p) => p.bookingId === b?.id && p.kind === 'deposit' && p.status === 'paid')).toBe(true)
    }
  })
})

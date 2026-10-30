import { describe, expect, it } from 'vitest'
import { balance } from '@/domain/finance'
import { buildCatalog } from '@/domain/property'
import { overlaps } from '@/domain/booking'
import { buildState } from '../state'
import { ACCOUNTS, LISTINGS } from './airbnb'
import { BLOCKS, EXTRA_BOOKINGS, expandPlans, parsePlan, UNIT_PLANS } from './bookings'
import { CATEGORIES, TRANSACTIONS } from './finance'
import { GUESTS } from './guests'
import { GROUPS, LOCATIONS, UNITS, VILLAS } from './property'

const catalog = buildCatalog(LOCATIONS, VILLAS, UNITS, GROUPS)
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
    const live = state.bookings.filter((b) => b.status === 'confirmed' || b.status === 'checked_in')
    for (const a of live) {
      for (const b of live) {
        if (a.id < b.id && a.unitId === b.unitId) expect(overlaps(a.checkIn, a.checkOut, b.checkIn, b.checkOut), `${a.code} vs ${b.code}`).toBe(false)
      }
      for (const k of state.blocks) if (k.unitId === a.unitId) expect(overlaps(a.checkIn, a.checkOut, k.from, k.to), `${a.code} vs ${k.id}`).toBe(false)
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
})

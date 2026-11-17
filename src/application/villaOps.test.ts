import { beforeEach, describe, expect, it } from 'vitest'
import { NotFoundError, RuleError } from '@/domain/errors'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-11'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RuleError ? e.code : String(e)))

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await signIn('rama')
})

describe('unit inventory and checks', () => {
  it('seeds the lists, copies a template and refuses a copy with nothing new', async () => {
    const kr = await s.villaOps.unitInventory('unit-kr-02')
    expect(kr.items).toHaveLength(13)
    expect(kr.copyFrom[0]?.sameType).toBe(true)
    const tr4 = await s.villaOps.unitInventory('unit-tr-04')
    expect(tr4.items).toHaveLength(0)
    const copied = await s.villaOps.copyUnitItems('unit-tr-01', 'unit-tr-04')
    expect(copied.map((i) => i.name)).toContain('Bathrobe')
    expect(await code(s.villaOps.copyUnitItems('unit-tr-01', 'unit-tr-04'))).toBe('INVENTORY_COPY_NOTHING')
  })

  it('shows the seeded checks of the Karang stay leaving today, the glass charged on its folio', async () => {
    const leaving = (await ports.booking.bookings()).find((b) => b.unitId === 'unit-kr-01' && b.checkOut === TODAY && b.status === 'checked_in')!
    const stay = await s.villaOps.stayChecks(leaving.id)
    expect(stay.pre?.kind).toBe('pre_arrival')
    const view = await s.villaOps.check(stay.post!.id)
    const flagged = view.diffs.filter((d) => d.flagged).map((d) => d.line.name)
    expect(flagged).toEqual(expect.arrayContaining(['Wine glass', 'Pool towel']))
    expect(view.check.lines.find((l) => l.name === 'Wine glass')?.charge?.amount).toBe(120_000)
    const postings = await ports.folio.postings(leaving.id)
    expect(postings.map((p) => p.code)).toEqual(expect.arrayContaining(['DMG', 'UTIL']))
  })

  it('charges a missing towel once, raises a work order and adjusts the list', async () => {
    const leaving = (await ports.booking.bookings()).find((b) => b.unitId === 'unit-kr-01' && b.checkOut === TODAY && b.status === 'checked_in')!
    const post = (await s.villaOps.stayChecks(leaving.id)).post!
    const towel = post.lines.find((l) => l.name === 'Pool towel')!
    const charged = await s.villaOps.chargeLine(post.id, towel.itemId, { quantity: 1, reason: 'Not returned' })
    expect(charged.lines.find((l) => l.itemId === towel.itemId)?.charge?.amount).toBe(150_000)
    expect(await code(s.villaOps.chargeLine(post.id, towel.itemId, { quantity: 1, reason: 'Not returned' }))).toBe('CHECK_CHARGED')
    expect((await ports.folio.postings(leaving.id)).filter((p) => p.code === 'DMG')).toHaveLength(2)
    const raised = await s.villaOps.raiseWorkOrder(post.id, towel.itemId)
    const wo = raised.lines.find((l) => l.itemId === towel.itemId)?.workOrder
    expect((await ports.maintenance.workOrders()).find((w) => w.id === wo?.id)?.title).toBe('Missing Pool towel in KR-01')
    await s.villaOps.adjustLine(post.id, towel.itemId)
    expect((await s.villaOps.unitInventory('unit-kr-01')).items.find((i) => i.name === 'Pool towel')?.expected).toBe(5)
    const ok = post.lines.find((l) => l.condition === 'ok')!
    expect(await code(s.villaOps.adjustLine(post.id, ok.itemId))).toBe('CHECK_LINE_OK')
  })

  it('records a pre-arrival check on today\'s arrival and refuses a second one', async () => {
    const today = await s.villaOps.villaChecksToday()
    const arrival = today.find((r) => r.kind === 'pre_arrival' && r.hasList)!
    const form = await s.villaOps.checkForm(arrival.booking.unitId, arrival.booking.id, 'pre_arrival')
    const input = { unitId: form.unit.id, bookingId: form.booking.id, kind: 'pre_arrival' as const, lines: form.items.map((i) => ({ itemId: i.id, counted: i.expected, condition: 'ok' as const, note: '' })) }
    const check = await s.villaOps.recordCheck(input)
    expect(check.number).toMatch(/^IC-10\d\d$/)
    expect(await code(s.villaOps.recordCheck(input))).toBe('CHECK_TWICE')
  })

  it('keeps checks to the scope and charges to those who may change a booking', async () => {
    const leaving = (await ports.booking.bookings()).find((b) => b.unitId === 'unit-kr-01' && b.checkOut === TODAY)!
    await signIn('wayan')
    await expect(s.villaOps.stayChecks(leaving.id)).rejects.toBeInstanceOf(NotFoundError)
    await signIn('nia')
    const post = (await ports.villaOps.checks()).find((c) => c.kind === 'post_departure')!
    expect(await code(s.villaOps.chargeLine(post.id, post.lines[0]!.itemId, { quantity: 1, reason: 'Broken' }))).toBe('FORBIDDEN')
  })
})

describe('meters and readings', () => {
  it('lists three months of readings and the owner-paid water on Karang', async () => {
    const u = await s.villaOps.utilities()
    expect(u.meters).toHaveLength(6)
    expect(u.readings.filter((r) => r.meterNumber === 'PDAM-KR' && r.billedTo === 'owner')).toHaveLength(2)
    expect(u.perVilla.find((v) => v.villa.id === 'vil-karang')?.billedGuest).toBeGreaterThan(0)
    expect(u.byKind.electricity.some((v) => v > 0)).toBe(true)
  })

  it('refuses a reading below the last unless the meter was replaced', async () => {
    const reading = { meterId: 'mtr-5', on: TODAY, value: 100, photo: null, purpose: 'monthly' as const, bookingId: null, replacement: false }
    expect(await code(s.villaOps.recordReading(reading))).toBe('READING_BELOW_PREVIOUS')
    const replaced = await s.villaOps.recordReading({ ...reading, replacement: true })
    expect(replaced.consumption).toBe(0)
  })

  it('reads the long-stay meters on the booking page and the setting per villa', async () => {
    const leaving = (await ports.booking.bookings()).find((b) => b.unitId === 'unit-kr-01' && b.checkOut === TODAY)!
    const meters = await s.villaOps.stayMeters(leaving.id)
    expect(meters?.threshold).toBe(5)
    expect(meters?.meters[0]?.checkOut?.billedTo).toBe('guest')
    await s.villaOps.saveUtilitySettings('vil-karang', 28)
    expect(await s.villaOps.stayMeters(leaving.id)).toBeNull()
  })

  it('puts the owner-paid water on the open Karang statement', async () => {
    const contract = (await ports.owners.contracts()).find((c) => c.villaId === 'vil-karang')!
    const view = await s.owners.statement(contract.id, TODAY.slice(0, 7))
    expect(view.utilities.length).toBeGreaterThan(0)
    expect(view.figures?.utilities).toBe(view.utilities.reduce((sum, u) => sum + u.amount, 0))
  })
})

describe('upkeep templates', () => {
  it('applies a template once and generates tasks around the guest', async () => {
    expect(await code(s.villaOps.applyTemplate({ villaId: 'vil-karang', unitId: null, template: 'pool', startOn: TODAY }))).toBe('UPKEEP_APPLIED')
    const plans = await s.villaOps.applyTemplate({ villaId: 'vil-lumbung', unitId: null, template: 'fogging', startOn: TODAY })
    expect(plans).toHaveLength(1)
    const created = await s.maintenance.generateDue(0)
    const fog = created.find((w) => w.upkeep?.key === 'fogging_monthly' && w.villaId === 'vil-karang')
    expect(fog?.upkeep?.notice?.bookingCode).toMatch(/^BK-/)
    const pool = created.find((w) => w.upkeep?.key === 'pool_daily' && w.villaId === 'vil-karang')!
    await s.maintenance.transition(pool.id, 'in_progress', '')
    expect(await code(s.maintenance.transition(pool.id, 'done', ''))).toBe('READINGS_REQUIRED')
    const recorded = await s.villaOps.recordUpkeep(pool.id, { checklist: pool.upkeep!.checklist.map(() => true), readings: { ph: 7.1, chlorine: 2 }, noticeSent: false })
    expect(recorded.upkeep?.readings?.flags).toEqual(['pH low'])
    expect(await code(s.maintenance.transition(pool.id, 'done', ''))).toBe('ok')
  })

  it('sends the fogging notice to the stay once', async () => {
    const fog = (await s.maintenance.generateDue(0)).find((w) => w.upkeep?.notice)!
    const sent = await s.villaOps.notifyStay(fog.id)
    expect(sent.upkeep?.notice?.sentOn).toBe(TODAY)
    expect(await code(s.villaOps.notifyStay(fog.id))).toBe('NOTICE_SENT')
  })
})

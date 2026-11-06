import { beforeEach, describe, expect, it } from 'vitest'
import { DND_ALERT_DAYS, TASK_CHECKLIST } from '@/domain/housekeeping'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-10-30'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const ticks = (type: keyof typeof TASK_CHECKLIST) => TASK_CHECKLIST[type].map((item) => ({ item, ok: true }))
const level = async (villaId: string, code: string) => (await s.housekeeping.linen()).villas.find((v) => v.villa.id === villaId)?.levels.find((l) => l.item.code === code)

beforeEach(() => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
})

describe('housekeeping', () => {
  it('seeds today’s list for every villa with rooms to do, given out to the attendants on shift', async () => {
    const d = await s.housekeeping.day()
    const villas = new Set(d.tasks.map((t) => t.villaId))
    expect([...villas].sort()).toEqual(['vil-karang', 'vil-lumbung', 'vil-saka', 'vil-tirta'])
    expect(d.attendants.length).toBeGreaterThanOrEqual(3)
    for (const t of d.tasks.filter((x) => x.attendantId)) expect(d.attendants.some((a) => a.id === t.attendantId), t.number).toBe(true)
    expect(d.attendants.every((a) => a.credits <= d.settings.dailyQuota)).toBe(true)
    expect(d.tasks.some((t) => t.type === 'deep' && !t.attendantId)).toBe(true)
    expect(d.unassigned).toBeGreaterThan(0)
    expect(d.dnd[0]?.days).toBeGreaterThanOrEqual(DND_ALERT_DAYS)
  })

  it('keeps a week of finished work with times for productivity', async () => {
    const r = await s.reports.run('hk-productivity', { from: '2026-10-23', to: '2026-10-29' })
    expect(r.rows.length).toBeGreaterThanOrEqual(3)
    for (const row of r.rows) {
      expect(Number(row.tasks)).toBeGreaterThan(0)
      expect(Number(row.minutes)).toBeGreaterThan(0)
    }
    const completion = await s.reports.run('hk-completion', { from: '2026-10-23', to: TODAY })
    expect(completion.rows.some((row) => row.date === TODAY && Number(row.open) > 0)).toBe(true)
  })

  it('lets an attendant work only their own rooms; a departure takes the board to cleaning and bags the linen', async () => {
    // A departure while the guest is still in refuses to start.
    const waiting = (await s.housekeeping.day()).tasks.find((t) => t.villaId === 'vil-saka' && t.type === 'departure' && t.status === 'pending' && t.bookingId)
    await signIn('sari')
    if (waiting) await expect(s.housekeeping.work(waiting.id, 'start')).rejects.toMatchObject({ code: 'TASK_INVALID_STATE' })
    await signIn('kadek')
    const vacant = (await s.maintenance.housekeeping()).rows.find((r) => r.place.unit.status === 'active' && r.state === 'ready' && !r.inHouse && !r.departure)
    if (!vacant) throw new Error('no vacant room')
    await s.maintenance.setHousekeeping(vacant.place.unit.id, 'dirty')
    await s.housekeeping.addTask({ unitId: vacant.place.unit.id, date: TODAY, type: 'departure', attendantId: 'emp-003', note: '' })
    await signIn('sari')
    const departure = (await s.housekeeping.myTasks()).mine.find((t) => t.unitId === vacant.place.unit.id)
    if (!departure) throw new Error('the task is not on Sari’s list')
    const villaId = vacant.place.villa.id
    const soiled = (await level(villaId, 'LN-TOWEL'))?.soiled ?? 0
    await s.housekeeping.work(departure.id, 'start')
    expect((await s.maintenance.housekeeping()).rows.find((r) => r.place.unit.id === departure.unitId)?.state).toBe('cleaning')
    await s.housekeeping.work(departure.id, 'pause')
    await s.housekeeping.work(departure.id, 'resume')
    await expect(s.housekeeping.work(departure.id, 'done', { checklist: ticks('departure').slice(1) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const done = await s.housekeeping.work(departure.id, 'done', { checklist: ticks('departure') })
    expect(done.status).toBe('done')
    expect((await s.maintenance.housekeeping()).rows.find((r) => r.place.unit.id === departure.unitId)?.state).toBe('cleaning')
    expect((await level(villaId, 'LN-TOWEL'))?.soiled).toBeGreaterThan(soiled)

    const other = (await s.housekeeping.day()).tasks.find((t) => t.attendantId && t.attendantId !== 'emp-003' && t.status === 'pending')
    if (other) await expect(s.housekeeping.work(other.id, 'start')).rejects.toMatchObject({ code: 'TASK_NOT_YOURS' })
  })

  it('records the guest’s answer on a stayover without touching the board, and opens a work order for a fault', async () => {
    const d = await s.housekeeping.day()
    const stay = d.tasks.find((t) => t.type === 'stayover' && t.status === 'pending')
    expect(stay).toBeDefined()
    if (!stay) return
    const board = (await s.maintenance.housekeeping()).rows.find((r) => r.place.unit.id === stay.unitId)?.state
    await expect(s.housekeeping.work(d.tasks.find((t) => t.type === 'departure' && t.status === 'pending')?.id ?? '', 'dnd')).rejects.toMatchObject({ code: 'TASK_INVALID_STATE' })
    expect((await s.housekeeping.work(stay.id, 'dnd')).status).toBe('dnd')
    expect((await s.maintenance.housekeeping()).rows.find((r) => r.place.unit.id === stay.unitId)?.state).toBe(board)
    const { workOrderId } = await s.housekeeping.reportIssue(stay.id, { category: 'plumbing', title: 'Shower drain blocked', description: '', urgent: true })
    const wo = (await ports.maintenance.workOrders()).find((w) => w.id === workOrderId)
    expect(wo).toMatchObject({ unitId: stay.unitId, priority: 'urgent', status: 'open' })
    const found = await s.housekeeping.noteLostFound(stay.id, 'Phone charger by the bed')
    expect(found.lostFound[0]?.note).toBe('Phone charger by the bed')
    const item = (await ports.lostFound.items()).find((i) => i.id === found.lostFound[0]?.ref)
    expect(item).toMatchObject({ unitId: stay.unitId, bookingId: stay.bookingId, description: 'Phone charger by the bed', status: 'found' })
  })

  it('assigns only to attendants on shift and auto-assign stops at the quota', async () => {
    const d = await s.housekeeping.day()
    const deep = d.tasks.find((t) => t.type === 'deep')
    if (!deep) throw new Error('no deep clean seeded')
    await expect(s.housekeeping.assign([deep.id], 'emp-002')).rejects.toMatchObject({ code: 'NOT_ON_SHIFT' })
    // With a quota of one credit everyone on shift is already full, so nothing new is given out.
    await s.housekeeping.saveSettings({ ...d.settings, dailyQuota: 1 })
    const added = await s.housekeeping.addTask({ unitId: deep.unitId, date: TODAY, type: 'inspection', attendantId: null, note: '' })
    expect(await s.housekeeping.autoAssign(TODAY)).toEqual([])
    const after = await s.housekeeping.day()
    expect(after.tasks.find((t) => t.id === added.id)?.attendantId).toBeNull()
    expect(after.overQuota).toBeGreaterThan(0)
  })

  it('sends soiled linen to the laundry and takes it back, writing off the missing pieces and submitting the bill', async () => {
    const before = await level('vil-tirta', 'LN-TOWEL')
    expect(before?.soiled).toBeGreaterThan(0)
    const towel = before?.itemId ?? ''
    await expect(s.housekeeping.sendLaundry({ villaId: 'vil-tirta', vendor: 'Ubud Laundry', sentOn: TODAY, note: '', lines: [{ itemId: towel, quantity: (before?.soiled ?? 0) + 1 }] })).rejects.toMatchObject({ code: 'LINEN_SHORT' })
    const batch = await s.housekeeping.sendLaundry({ villaId: 'vil-tirta', vendor: 'Ubud Laundry', sentOn: TODAY, note: '', lines: [{ itemId: towel, quantity: 4 }] })
    expect(await level('vil-tirta', 'LN-TOWEL')).toMatchObject({ soiled: (before?.soiled ?? 0) - 4, laundry: 4 })
    const back = await s.housekeeping.returnLaundry(batch.id, { returnedOn: TODAY, lines: [{ itemId: towel, returned: 3, damaged: 0 }], cost: 120_000, method: 'cash', reference: 'UL-1', attachments: [] })
    expect(back.writeOffs).toHaveLength(1)
    const after = await level('vil-tirta', 'LN-TOWEL')
    expect(after).toMatchObject({ laundry: 0, owned: (before?.owned ?? 0) - 1, clean: (before?.clean ?? 0) + 3 })
    const entry = (await ports.finance.transactions()).find((t) => t.id === back.transactionId)
    expect(entry).toMatchObject({ kind: 'cash_out', categoryId: 'cat-house', amount: 120_000, status: 'submitted', origin: 'maintenance' })
    await expect(s.housekeeping.returnLaundry(batch.id, { returnedOn: TODAY, lines: [{ itemId: towel, returned: 4, damaged: 0 }], cost: 0, method: 'cash', reference: '', attachments: [] })).rejects.toMatchObject({ code: 'LAUNDRY_INVALID_STATE' })
  })

  it('seeds the two laundry batches and discards worn linen through a stock write-off', async () => {
    const l = await s.housekeeping.linen()
    expect(l.batches.map((b) => b.status).sort()).toEqual(['out', 'returned'])
    expect(l.batches.find((b) => b.status === 'returned')?.missing).toBe(2)
    expect(l.villas.some((v) => v.flagged > 0)).toBe(true)
    const pillow = await level('vil-saka', 'LN-PILLOW')
    await s.housekeeping.discardLinen({ villaId: 'vil-saka', from: 'clean', reason: 'Torn seams', lines: [{ itemId: pillow?.itemId ?? '', quantity: 2 }] })
    expect(await level('vil-saka', 'LN-PILLOW')).toMatchObject({ owned: (pillow?.owned ?? 0) - 2, discarded: (pillow?.discarded ?? 0) + 2 })
    for (const slug of ['linen-par', 'laundry-batches']) expect((await s.reports.run(slug, { from: '2026-10-01', to: TODAY })).rows.length, slug).toBeGreaterThan(0)
  })
})

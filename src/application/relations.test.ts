import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { ComplaintInput, IncidentInput } from '@/domain/relations'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-11'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const stayId = async (code: string) => (await ports.booking.bookings()).find((b) => b.code === code)!.id
const complaint = (bookingId: string): ComplaintInput => ({ villaId: 'vil-saka', unitId: null, bookingId, guestId: null, category: 'room', severity: 'medium', description: 'The shower runs cold', receivedBy: 'Wayan Sudiarta', receivedAt: `${TODAY}T08:30`, owner: 'Kadek Ariani' })
const credits = async (bookingId: string) => (await ports.folio.postings(bookingId)).filter((p) => p.kind === 'rebate' && p.description.startsWith('Compensation'))

beforeEach(() => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
})

describe('complaints', () => {
  it('seeds four across the statuses, the credit on the folio and one from the stay page', async () => {
    await signIn('rama')
    const { complaints } = await s.complaints.list()
    expect(complaints.map((c) => c.status).sort()).toEqual(['closed', 'in_progress', 'open', 'resolved'])
    expect(complaints.find((c) => c.source === 'stay_page')).toMatchObject({ severity: 'high', status: 'open' })
    const credited = complaints.find((c) => c.compensation?.status === 'posted')!
    expect((await credits(credited.bookingId!)).map((p) => p.amount)).toEqual([150_000])
    const report = await s.reports.run('complaints', { from: addDays(TODAY, -30), to: TODAY })
    expect(report.rows.reduce((n, r) => n + Number(r.complaints), 0)).toBe(4)
  })

  it('posts a credit under the limit at once and keeps a larger one from the desk waiting for a manager', async () => {
    const bookingId = await stayId('BK-1294')
    await signIn('wayan')
    const small = await s.complaints.log(complaint(bookingId))
    expect(small).toMatchObject({ number: 'CP-005', villaId: 'vil-saka', status: 'open' })
    await s.complaints.resolve(small.id, { action: 'Fixed the heater', compensation: { kind: 'folio_credit', amount: 100_000, description: 'Cold shower' } })
    expect((await credits(bookingId)).at(-1)).toMatchObject({ amount: 100_000, code: 'ROOM', postedBy: 'Wayan Sudiarta' })

    const big = await s.complaints.log(complaint(bookingId))
    const waiting = await s.complaints.resolve(big.id, { action: 'Moved them', compensation: { kind: 'folio_credit', amount: 900_000, description: 'Two nights' } })
    expect(waiting.compensation?.status).toBe('pending_approval')
    await expect(s.complaints.decide(big.id, true, '')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await credits(bookingId)).toHaveLength(2)

    await signIn('kadek')
    const approved = await s.complaints.decide(big.id, true, '')
    expect(approved.compensation).toMatchObject({ status: 'posted', decidedBy: 'Kadek Ariani' })
    expect(await credits(bookingId)).toHaveLength(3)
    await expect(s.complaints.decide(big.id, true, '')).rejects.toMatchObject({ code: 'COMPENSATION_INVALID_STATE' })
  })

  it('raises a work order and a housekeeping task in one step and links them', async () => {
    await signIn('kadek')
    const bookingId = await stayId('BK-1294')
    const c = await s.complaints.log(complaint(bookingId))
    const unitId = c.unitId!
    await s.complaints.raiseWorkOrder(c.id, { villaId: c.villaId, unitId, assetId: null, category: 'plumbing', priority: 'high', title: 'Shower runs cold', description: c.description, assigneeId: null, vendorId: null, scheduledOn: null, parts: [], labourCost: 0, vendorCost: 0, beforePhotos: [], afterPhotos: [] })
    const linked = await s.complaints.raiseTask(c.id, { unitId, date: TODAY, type: 'deep', attendantId: null, note: c.description })
    expect(linked.links.map((l) => l.kind)).toEqual(['work_order', 'room_task'])
    expect(linked.timeline.filter((e) => e.kind === 'link')).toHaveLength(2)
  })

  it('moves along the transitions and refuses a close before it is resolved', async () => {
    await signIn('wayan')
    const c = await s.complaints.log(complaint(await stayId('BK-1298')))
    await expect(s.complaints.move(c.id, 'closed', '')).rejects.toMatchObject({ code: 'COMPLAINT_INVALID_STATE', message: `${c.number} is open; it cannot become closed.` })
    await s.complaints.move(c.id, 'in_progress', 'On it')
    await s.complaints.resolve(c.id, { action: 'Swapped rooms', compensation: { kind: 'goodwill', amount: 0, description: 'Fruit basket' } })
    const closed = await s.complaints.move(c.id, 'closed', '')
    expect(closed.status).toBe('closed')
    await expect(s.complaints.note(c.id, 'Later')).rejects.toMatchObject({ code: 'COMPLAINT_INVALID_STATE' })
  })

  it('files the stay page form as an open complaint and a guest action', async () => {
    const b = (await ports.booking.bookings()).find((x) => x.status === 'checked_in' && x.stayToken)!
    const view = await s.stay.complain(b.stayToken!, { category: 'food', description: 'Breakfast came cold' })
    expect(view.bookingCode).toBe(b.code)
    await expect(s.stay.complain(b.stayToken!, { category: 'food', description: 'bad' })).rejects.toMatchObject({ errors: { description: 'Tell us what went wrong.' } })
    const after = (await ports.booking.bookings()).find((x) => x.id === b.id)!
    expect(after.guestActions?.at(-1)).toMatchObject({ kind: 'complaint', summary: 'Told us something went wrong: Food and drinks (CP-005)' })
    const filed = (await ports.relations.complaints()).find((c) => c.number === 'CP-005')!
    expect(filed).toMatchObject({ source: 'stay_page', status: 'open', receivedBy: 'Guest', owner: 'Front desk', bookingId: b.id })
  })
})

describe('incidents', () => {
  const incident = (fields: Partial<IncidentInput> = {}): IncidentInput => ({ kind: 'damage', severity: 'high', villaId: 'vil-saka', unitId: null, area: 'Lobby', occurredAt: `${TODAY}T07:00`, bookingId: null, people: [], description: 'Broken lobby mirror', actions: 'Taped it off', policeCalled: false, doctorCalled: false, policeReport: '', attachments: [], ...fields })

  it('charges guest damage once and needs a manager to sign it off', async () => {
    await signIn('wayan')
    const bookingId = await stayId('BK-1301')
    const i = await s.incidents.log(incident({ bookingId }))
    expect(i).toMatchObject({ number: 'IN-003', status: 'open', unitId: expect.any(String) })
    await s.incidents.charge(i.id, 200_000, 'Mirror')
    await expect(s.incidents.charge(i.id, 200_000, 'Mirror')).rejects.toMatchObject({ code: 'INCIDENT_ALREADY_CHARGED' })
    expect((await ports.folio.postings(bookingId)).filter((p) => p.code === 'DMG').map((p) => p.amount)).toEqual([200_000])
    await expect(s.incidents.close(i.id, 'Replaced')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await signIn('kadek')
    expect((await s.dashboard.attention()).incidents.map((x) => x.number)).toContain('IN-003')
    const closed = await s.incidents.close(i.id, 'Mirror replaced')
    expect(closed.signOff?.by).toBe('Kadek Ariani')
    expect((await s.dashboard.attention()).incidents.map((x) => x.number)).not.toContain('IN-003')
  })

  it('refuses a charge on anything but damage', async () => {
    await signIn('kadek')
    const i = await s.incidents.log(incident({ kind: 'medical', bookingId: await stayId('BK-1301') }))
    await expect(s.incidents.charge(i.id, 100_000, 'Doctor')).rejects.toMatchObject({ code: 'INCIDENT_CHARGE_KIND' })
  })
})

describe('safe boxes', () => {
  it('seeds two boxes in use and warns at check-out until the box is closed', async () => {
    await signIn('rama')
    const { boxes } = await s.safeBoxes.list()
    expect(boxes.filter((b) => b.status === 'in_use')).toHaveLength(2)
    const used = boxes.find((b) => b.rental)!
    const { warnings } = await s.safeBoxes.ofStay(used.rental!.bookingId)
    expect(warnings).toEqual([`Safe box ${used.number} is still open for this stay; close it and take back the key.`])

    await s.safeBoxes.access(used.rental!, { kind: 'take', signature: 'drawn', signatureData: 'data:image/png;base64,AAAA', note: 'Passports out' })
    const closed = await s.safeBoxes.close(used.rental!, { keyReturned: false, keyFee: 250_000, signature: 'paper', signatureData: '', note: '' })
    expect(closed.log.map((e) => e.kind)).toEqual(['open', 'take', 'key_lost', 'close'])
    expect((await ports.folio.postings(used.rental!.bookingId)).find((p) => p.description.startsWith('Lost safe box key'))).toMatchObject({ amount: 250_000, code: 'DMG' })
    expect((await s.safeBoxes.ofStay(used.rental!.bookingId)).warnings).toEqual([])
    expect((await s.safeBoxes.list()).boxes.find((b) => b.id === used.id)?.status).toBe('free')
  })

  it('opens a free box only for a stay in house at that property', async () => {
    await signIn('kadek')
    const { boxes } = await s.safeBoxes.list()
    const free = boxes.find((b) => b.villaId === 'vil-saka' && b.status === 'free')!
    const out = boxes.find((b) => b.status === 'out_of_order')!
    const sakaStay = await stayId('BK-1305')
    await expect(s.safeBoxes.open({ boxId: out.id, bookingId: sakaStay, items: '', keyNumber: 'K', signature: 'paper', signatureData: '' })).rejects.toMatchObject({ code: 'SAFE_BOX_UNAVAILABLE' })
    await expect(s.safeBoxes.open({ boxId: free.id, bookingId: await stayId('BK-1303'), items: '', keyNumber: 'K', signature: 'paper', signatureData: '' })).rejects.toThrow('BK-1303 stays at another villa.')
    const opened = await s.safeBoxes.open({ boxId: free.id, bookingId: sakaStay, items: 'Laptop', keyNumber: 'K-02', signature: 'paper', signatureData: '' })
    expect(opened).toMatchObject({ number: 'SB-003', status: 'open' })
    await expect(s.safeBoxes.save(free.id, { villaId: free.villaId, number: free.number, size: free.size, note: '', outOfOrder: true })).rejects.toMatchObject({ code: 'SAFE_BOX_IN_USE' })
  })
})

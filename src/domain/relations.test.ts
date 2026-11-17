import { describe, expect, it } from 'vitest'
import {
  assertComplaintMove,
  closeRental,
  COMPENSATION_LIMIT,
  moveComplaint,
  resolutionHours,
  resolveComplaint,
  validateCloseBox,
  validateComplaint,
  validateIncident,
  validateIncidentCharge,
  validateOpenBox,
  validateResolve,
  validateSafeBox,
  type BoxRental,
  type Complaint,
  type ComplaintInput,
  type IncidentInput,
} from './relations'

const TODAY = '2026-11-11'
const input: ComplaintInput = { villaId: 'vil-saka', unitId: null, bookingId: 'bk-1', guestId: null, category: 'noise', severity: 'high', description: 'Music next door', receivedBy: 'Wayan', receivedAt: `${TODAY}T09:00`, owner: 'Kadek' }
const complaint = (fields: Partial<Complaint> = {}): Complaint => ({ id: 'cpl-1', number: 'CP-001', villaId: 'vil-saka', unitId: null, bookingId: 'bk-1', guestId: 'g-1', category: 'noise', severity: 'high', description: 'Music', receivedBy: 'Wayan', receivedAt: `${TODAY}T09:00`, owner: 'Kadek', source: 'desk', status: 'open', resolution: null, compensation: null, links: [], timeline: [], ...fields })

describe('complaints', () => {
  it('names each missing field in the API wording', () => {
    expect(validateComplaint(input, TODAY)).toEqual({})
    expect(validateComplaint({ ...input, villaId: '', bookingId: null, description: 'bad', receivedBy: '', owner: 'K', receivedAt: '2026-11-12T08:00' }, TODAY)).toEqual({
      villaId: 'Pick the villa.',
      guestId: 'Pick the guest or the stay.',
      description: 'Write what the guest said.',
      receivedBy: 'Say who received it.',
      receivedAt: 'The time cannot be in the future.',
      owner: 'Name who follows it up.',
    })
  })

  it('moves along the transitions and refuses the rest', () => {
    expect(() => assertComplaintMove(complaint(), 'closed')).toThrow('CP-001 is open; it cannot become closed.')
    expect(() => assertComplaintMove(complaint(), 'resolved')).toThrow('CP-001 is open; it cannot become resolved.')
    assertComplaintMove(complaint(), 'in_progress')
    const c = complaint({ status: 'resolved', resolution: { action: 'Fixed', by: 'K', at: 'x' }, compensation: { kind: 'folio_credit', amount: 900_000, description: 'Night', status: 'pending_approval', decidedBy: null, decidedAt: null } })
    moveComplaint(c, 'in_progress', 'Came back', 'Kadek', `${TODAY}T10:00:00`)
    expect(c).toMatchObject({ status: 'in_progress', resolution: null, compensation: { status: 'rejected', decidedBy: 'Kadek' } })
    expect(c.timeline.at(-1)?.note).toBe('Resolved to in progress: Came back')
  })

  it('posts a credit at once or keeps it waiting, and needs a stay for it', () => {
    const credit = { action: 'Fixed the AC', compensation: { kind: 'folio_credit' as const, amount: COMPENSATION_LIMIT, description: 'A night' } }
    expect(validateResolve(complaint(), { action: 'ok', compensation: { kind: 'folio_credit', amount: 0, description: '' } })).toEqual({ action: 'Say what was done.', 'compensation.amount': 'Enter the credit in whole rupiah.', 'compensation.description': 'Say what the guest gets.' })
    expect(() => validateResolve(complaint({ bookingId: null }), credit)).toThrow("A folio credit needs the guest's stay")
    expect(() => validateResolve(complaint({ status: 'closed' }), credit)).toThrow('CP-001 is closed; it cannot become resolved.')
    const posted = complaint()
    expect(resolveComplaint(posted, credit, true, 'Kadek', `${TODAY}T15:00:00`)).toBe(true)
    expect(posted.compensation).toMatchObject({ status: 'posted', decidedBy: 'Kadek' })
    const waiting = complaint()
    expect(resolveComplaint(waiting, { ...credit, compensation: { ...credit.compensation, amount: COMPENSATION_LIMIT + 1 } }, false, 'Wayan', `${TODAY}T15:00:00`)).toBe(false)
    expect(waiting.timeline.at(-1)?.note).toBe(`Credit of ${COMPENSATION_LIMIT + 1} waits for a manager's approval`)
    expect(resolutionHours(posted)).toBe(6)
  })
})

describe('incidents', () => {
  const incident: IncidentInput = { kind: 'damage', severity: 'medium', villaId: 'vil-saka', unitId: null, area: '', occurredAt: `${TODAY}T08:00`, bookingId: null, people: [{ kind: 'guest', name: 'A', guestId: null, note: '' }], description: 'Glass table cracked', actions: '', policeCalled: false, doctorCalled: false, policeReport: '', attachments: [] }

  it('asks where it happened unless a unit or stay says so', () => {
    expect(validateIncident(incident, TODAY)).toEqual({ area: 'Say where it happened.', 'people.0.name': 'Name the person.' })
    expect(validateIncident({ ...incident, bookingId: 'bk-1', people: [] }, TODAY)).toEqual({})
  })

  it('charges damage once, to a linked stay', () => {
    const base = { number: 'IN-001', status: 'open' as const, kind: 'damage' as const, bookingId: 'bk-1', charge: null }
    expect(validateIncidentCharge(base, { amount: 750_000, reason: 'Table' }, '')).toEqual({})
    expect(() => validateIncidentCharge({ ...base, kind: 'medical' }, { amount: 1, reason: 'abc' }, '')).toThrow('Only damage to property is charged to a guest.')
    expect(() => validateIncidentCharge({ ...base, bookingId: null }, { amount: 1, reason: 'abc' }, '')).toThrow("Link the guest's stay")
    expect(() => validateIncidentCharge({ ...base, charge: { amount: 1, reason: 'x', bookingId: 'bk-1', by: 'K', at: 'x' } }, { amount: 1, reason: 'abc' }, 'BK-1')).toThrow('IN-001 is already charged to BK-1.')
  })
})

describe('safe boxes', () => {
  const box = { number: '3', status: 'free' as const, villaId: 'vil-saka' }
  const stay = { code: 'BK-1', status: 'checked_in', villaId: 'vil-saka' }
  const open = { boxId: 'box-3', bookingId: 'bk-1', items: '', keyNumber: 'K-3', signature: 'paper' as const, signatureData: '' }

  it('numbers boxes once per villa', () => {
    expect(validateSafeBox({ villaId: 'vil-saka', number: '3', size: 'small', note: '', outOfOrder: false }, [{ id: 'b', villaId: 'vil-saka', number: '3', size: 'small', status: 'free', note: '' }], 'Saka')).toEqual({ number: 'Box 3 is already at Saka.' })
  })

  it('opens a free box for a stay in house with a signature and a key', () => {
    expect(validateOpenBox(box, stay, open)).toEqual({})
    expect(() => validateOpenBox({ ...box, status: 'in_use' }, stay, open)).toThrow('Box 3 is in use.')
    expect(() => validateOpenBox(box, { ...stay, status: 'confirmed' }, open)).toThrow('BK-1 is not in house; open a box during the stay.')
    expect(validateOpenBox(box, { ...stay, villaId: 'vil-tirta' }, { ...open, keyNumber: ' ', signature: 'drawn' })).toEqual({ bookingId: 'BK-1 stays at another villa.', keyNumber: 'Enter the key handed to the guest.', signature: 'Have the guest sign, or mark it signed on paper.' })
  })

  it('logs a lost key before the close and charges a fee only for a lost key', () => {
    const r: BoxRental = { id: 'bxr-1', number: 'SB-001', boxId: 'box-3', villaId: 'vil-saka', bookingId: 'bk-1', guestId: 'g-1', items: '', keyNumber: 'K-3', status: 'open', openedAt: 'x', openedBy: 'W', closedAt: null, closedBy: null, keyReturned: null, keyFee: 0, log: [] }
    expect(validateCloseBox(r, { keyReturned: true, keyFee: 100_000, signature: 'paper', signatureData: '', note: '' })).toEqual({ keyFee: 'Charge a fee only for a lost key.' })
    closeRental(r, { keyReturned: false, keyFee: 100_000, signature: 'paper', signatureData: '', note: '' }, 'Wayan', 'now')
    expect(r.log.map((e) => e.kind)).toEqual(['key_lost', 'close'])
    expect(r).toMatchObject({ status: 'closed', keyReturned: false, keyFee: 100_000 })
    expect(() => validateCloseBox(r, { keyReturned: true, keyFee: 0, signature: 'paper', signatureData: '', note: '' })).toThrow('SB-001 is closed.')
  })
})

import { describe, expect, it } from 'vitest'
import { canTransitionService, nextServiceStep, sortRequests, validateServiceRequest, type ServiceRequest } from './roomService'

const req = (over: Partial<ServiceRequest>): ServiceRequest => ({
  id: 'r',
  number: 'RQ-1',
  unitId: 'u1',
  bookingId: null,
  kind: 'towels',
  priority: 'normal',
  note: '',
  charge: 0,
  status: 'open',
  assignee: '',
  requestedOn: '2026-10-05',
  requestedAt: 540,
  doneOn: null,
  transactionId: null,
  ...over,
})

describe('room service rules', () => {
  it('walks open to in progress to done and never back', () => {
    expect(nextServiceStep({ status: 'open' })).toBe('in_progress')
    expect(nextServiceStep({ status: 'in_progress' })).toBe('done')
    expect(nextServiceStep({ status: 'done' })).toBeNull()
    expect(canTransitionService({ status: 'done' }, 'in_progress')).toBe(false)
    expect(canTransitionService({ status: 'open' }, 'done')).toBe(true)
  })

  it('requires a note for "other" and a whole non-negative charge', () => {
    expect(validateServiceRequest({ unitId: '', bookingId: null, kind: 'other', priority: 'normal', note: '', charge: -1 })).toMatchObject({ unitId: expect.any(String), note: expect.any(String), charge: expect.any(String) })
    expect(validateServiceRequest({ unitId: 'u1', bookingId: null, kind: 'towels', priority: 'normal', note: '', charge: 0 })).toEqual({})
  })

  it('puts live work first, urgent before normal, oldest first', () => {
    const list = [
      req({ id: 'done', status: 'done' }),
      req({ id: 'late-open', requestedAt: 600 }),
      req({ id: 'urgent-open', priority: 'urgent', requestedAt: 700 }),
      req({ id: 'doing', status: 'in_progress' }),
    ]
    expect(sortRequests(list).map((r) => r.id)).toEqual(['doing', 'urgent-open', 'late-open', 'done'])
  })
})

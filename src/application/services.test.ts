import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { RuleError } from '@/domain/errors'
import { createServices, ValidationError, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
})

describe('dashboard', () => {
  it('reports revenue, occupancy and targets for the scope', async () => {
    const all = await s.dashboard.executive({ period: '30d' })
    expect(all.revenue.value).toBeGreaterThan(0)
    expect(all.occupancy.value).toBeGreaterThan(0.4)
    expect(all.occupancy.value).toBeLessThanOrEqual(1)
    expect(all.series).toHaveLength(5)
    expect(all.sources.map((x) => x.id)).toContain('direct')
    const canggu = await s.dashboard.executive({ period: '30d', locationId: 'loc-canggu' })
    expect(canggu.revenue.value).toBeLessThan(all.revenue.value)
    expect(canggu.unitCount).toBe(8)
    const direct = await s.dashboard.executive({ period: '30d', source: 'direct' })
    expect(direct.sources.every((x) => x.id === 'direct')).toBe(true)
  })

  it('knows who arrives, leaves and stays today', async () => {
    const ops = await s.dashboard.operational({ period: '7d' })
    expect(ops.arrivals.length).toBeGreaterThanOrEqual(3)
    expect(ops.departures.length).toBeGreaterThanOrEqual(3)
    expect(ops.lateArrivals.map((b) => b.code)).toContain('BK-2002')
    expect(ops.available + ops.inHouse.length + ops.blockedTonight).toBeLessThanOrEqual(ops.units)
  })

  it('sums posted cash and lists what waits for approval', async () => {
    const fin = await s.dashboard.financial({ period: '30d' })
    expect(fin.summary.cashIn).toBeGreaterThan(fin.summary.cashOut)
    expect(fin.pending.count).toBe(4)
    expect(fin.expenses.at(-1)?.label).toBe('Other')
  })
})

describe('bookings', () => {
  it('refuses a double booking and offers an interchangeable unit instead', async () => {
    const avail = await s.booking.availability('unit-sk-05', '2026-10-07', '2026-10-10')
    expect(avail.conflicts.map((c) => c.label)).toEqual(['BK-2001'])
    expect(avail.alternatives.map((u) => u.code)).toEqual(['SK-06'])
    await expect(
      s.booking.create({ guestId: 'g-01', newGuest: null, unitId: 'unit-sk-05', source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: '2026-10-07', checkOut: '2026-10-10', nightlyRate: 1_600_000, notes: '', confirm: true }),
    ).rejects.toMatchObject({ code: 'BOOKING_OVERLAP' })
  })

  it('creates a booking with a new guest, confirms it and walks it to check-out', async () => {
    const created = await s.booking.create({
      guestId: null,
      newGuest: { name: 'Test Guest', email: 'test@example.com', phone: '+62 811 000 111', nationality: 'Indonesia', idType: 'ktp', idNumber: '1', notes: '' },
      unitId: 'unit-sk-03',
      source: 'airbnb',
      airbnbAccountId: 'acc-saka-stays',
      airbnbCode: 'HMTEST01',
      checkIn: '2026-10-07',
      checkOut: '2026-10-09',
      nightlyRate: 1_850_000,
      notes: '',
      confirm: false,
    })
    expect(created.status).toBe('draft')
    expect(created.guestName).toBe('Test Guest')
    expect(created.total).toBe(3_700_000)
    await expect(s.booking.transition(created.id, 'confirmed')).rejects.toBeInstanceOf(RuleError)
    const moved = await s.booking.adjustStay(created.id, '2026-10-20', '2026-10-22')
    const confirmed = await s.booking.transition(moved.id, 'confirmed')
    expect(confirmed.status).toBe('confirmed')
    await expect(s.booking.transition(confirmed.id, 'checked_out')).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
    const inHouse = await s.booking.transition(confirmed.id, 'checked_in')
    expect(inHouse.checkedInOn).toBe(TODAY)
    expect((await s.booking.transition(inHouse.id, 'checked_out')).status).toBe('checked_out')
  })

  it('moves a stay only inside an interchangeable group and records the movement', async () => {
    const detail = await s.booking.detail('bk-2001')
    expect(detail.swapTargets.length).toBeGreaterThan(0)
    const target = detail.swapTargets[0]?.id ?? ''
    const moved = await s.booking.moveUnit('bk-2001', target, 'Guest asked for a quieter unit')
    expect(moved.unitId).toBe(target)
    expect(moved.requestedUnitId).toBe('unit-sk-03')
    expect(moved.movements).toHaveLength(2)
    await expect(s.booking.moveUnit('bk-2001', 'unit-tr-01', 'x')).rejects.toBeInstanceOf(ValidationError)
    await expect(s.booking.moveUnit('bk-2001', 'unit-tr-01', 'wrong villa')).rejects.toMatchObject({ code: 'UNIT_NOT_INTERCHANGEABLE' })
  })

  it('blocks a unit only when it is free and draws the calendar', async () => {
    await expect(s.booking.addBlock({ unitId: 'unit-sk-04', from: TODAY, to: '2026-10-07', reason: 'owner', note: '' })).rejects.toMatchObject({ code: 'BLOCK_OVERLAP' })
    const block = await s.booking.addBlock({ unitId: 'unit-tr-03', from: '2026-10-14', to: '2026-10-16', reason: 'cleaning', note: 'Repaint' })
    const cal = await s.booking.calendar('2026-10-13', 7, { villaId: 'vil-tirta' })
    expect(cal.rows).toHaveLength(4)
    expect(cal.rows.find((r) => r.place.unit.code === 'TR-03')?.spans.some((sp) => sp.id === block.id)).toBe(true)
    await s.booking.removeBlock(block.id)
  })
})

describe('guests and property', () => {
  it('builds a guest profile from the stays', async () => {
    const { guests } = await s.guest.list()
    const withStays = guests.find((g) => g.stays > 0)
    expect(withStays?.spent).toBeGreaterThan(0)
    const detail = await s.guest.detail('g-19')
    expect(detail.bookings.some((b) => b.code === 'BK-2002')).toBe(true)
    await expect(s.guest.detail('nobody')).rejects.toThrow(/No guest/)
    await expect(s.guest.create({ name: 'A', email: 'bad', phone: '', nationality: '', idType: 'passport', idNumber: '', notes: '' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('shows the property tree and refuses to retire a unit with live stays', async () => {
    const overview = await s.property.overview()
    expect(overview.locations.reduce((n, l) => n + l.unitCount, 0)).toBe(20)
    const unit = await s.property.unit('unit-sk-03')
    expect(unit.blocks).toHaveLength(1)
    expect(unit.mates).toHaveLength(7)
    const group = await s.property.setGroupInterchangeable('grp-saka-standard', false)
    expect(group.interchangeable).toBe(false)
    expect((await s.booking.detail('bk-2001')).swapTargets).toEqual([])
  })
})

describe('front desk and room services', () => {
  it('checks a guest in with the deposit booked on the location cashbox, then out with the deposit returned', async () => {
    const arriving = (await s.dashboard.operational({ period: '7d' })).arrivals[0]
    if (!arriving) throw new Error('no arrival to test with')
    await expect(s.booking.checkIn(arriving.id, { idVerified: false, deposit: 500_000, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' })).rejects.toBeInstanceOf(ValidationError)
    const before = (await s.finance.transactions()).list.length
    const inHouse = await s.booking.checkIn(arriving.id, { idVerified: true, deposit: 500_000, keysHanded: true, rulesExplained: true, arrivalTime: '14:05', adults: 2, children: 1, notes: 'Early breakfast' })
    expect(inHouse.status).toBe('checked_in')
    expect(inHouse.arrival?.deposit).toBe(500_000)
    const deposit = (await s.finance.transactions()).list.find((t) => t.bookingId === arriving.id && t.categoryId === 'cat-deposit')
    expect(deposit?.status).toBe('submitted')
    expect(deposit?.location.id).toBe(arriving.place.location.id)
    await expect(s.booking.checkOut(arriving.id, { depositReturned: 900_000, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' })).rejects.toBeInstanceOf(ValidationError)
    const gone = await s.booking.checkOut(arriving.id, { depositReturned: 400_000, extraCharges: 120_000, roomInspected: true, keysReturned: true, notes: 'Minibar' })
    expect(gone.status).toBe('checked_out')
    expect((await s.finance.transactions()).list.length).toBe(before + 3)
  })

  it('creates a request for a guest in house, walks it to done and records the charge', async () => {
    const guest = (await s.service.formOptions()).inHouse[0]
    if (!guest) throw new Error('nobody in house')
    const created = await s.service.create({ unitId: guest.unitId, bookingId: guest.id, kind: 'laundry', priority: 'normal', note: 'Four shirts', charge: 120_000 })
    expect(created.status).toBe('open')
    expect(created.guestName).toBe(guest.guestName)
    await expect(s.service.recordCharge(created.id)).resolves.toMatchObject({ transactionId: expect.any(String) })
    await expect(s.service.recordCharge(created.id)).rejects.toBeInstanceOf(ValidationError)
    const edited = await s.service.update(created.id, { unitId: guest.unitId, bookingId: guest.id, kind: 'laundry', priority: 'urgent', note: 'Four shirts, by 18:00', charge: 150_000 })
    expect(edited.priority).toBe('urgent')
    await s.service.assign(created.id, 'Wayan')
    const started = await s.service.transition(created.id, 'in_progress')
    expect(started.assignee).toBe('Wayan')
    const done = await s.service.transition(created.id, 'done')
    expect(done.doneOn).toBe(TODAY)
    await expect(s.service.transition(created.id, 'in_progress')).rejects.toMatchObject({ code: 'REQUEST_INVALID_STATE' })
    await expect(s.service.update(created.id, { unitId: guest.unitId, bookingId: guest.id, kind: 'towels', priority: 'normal', note: '', charge: 0 })).rejects.toMatchObject({ code: 'REQUEST_INVALID_STATE' })
    const list = await s.service.list()
    expect(list.doneToday).toBeGreaterThanOrEqual(1)
    expect((await s.dashboard.operational({ period: '7d' })).requests.every((r) => r.status !== 'done')).toBe(true)
  })

  it('adds an Airbnb account and a listing, refusing a second listing on the same unit', async () => {
    const account = await s.airbnb.createAccount({ name: 'Nusa Hosts', email: 'host@nusa.id', status: 'active' })
    await expect(s.airbnb.createListing({ accountId: account.id, unitId: 'unit-sk-01', title: 'Duplicate', airbnbId: '123456789', status: 'active' })).rejects.toMatchObject({ errors: { unitId: expect.any(String) } })
    const listing = await s.airbnb.createListing({ accountId: account.id, unitId: 'unit-kr-03', title: 'Karang cliff villa 3', airbnbId: '471100990', status: 'active' })
    expect((await s.property.unit('unit-kr-03')).account?.id).toBe(account.id)
    expect((await s.airbnb.updateListing(listing.id, { accountId: account.id, unitId: 'unit-kr-03', title: 'Karang 3, sunset', airbnbId: '471100990', status: 'paused' })).status).toBe('paused')
  })
})

describe('master data', () => {
  it('adds a villa with its group and unit, then refuses a duplicate unit code', async () => {
    const villa = await s.property.createVilla({ locationId: 'loc-ubud', code: 'ND', name: 'Villa Nusa', description: '', facilities: ['pool'] })
    const group = await s.property.createGroup({ villaId: villa.id, name: 'Nusa rooms', interchangeable: true })
    const unit = await s.property.createUnit({ villaId: villa.id, groupId: group.id, code: 'ND-01', name: 'Nusa 1', bedrooms: 2, nightlyRate: 2_000_000, status: 'active', amenities: [] })
    expect((await s.property.villa(villa.id)).units.map((u) => u.place.unit.code)).toEqual(['ND-01'])
    expect((await s.property.unit(unit.id)).place.group?.name).toBe('Nusa rooms')
    await expect(s.property.createUnit({ villaId: villa.id, groupId: null, code: 'ND-01', name: 'Again', bedrooms: 1, nightlyRate: 1, status: 'active', amenities: [] })).rejects.toMatchObject({ errors: { code: 'ND-01 is already used.' } })
    await expect(s.property.createVilla({ locationId: '', code: 'x', name: '', description: '', facilities: [] })).rejects.toBeInstanceOf(ValidationError)
    const renamed = await s.property.updateUnit(unit.id, { villaId: villa.id, groupId: null, code: 'ND-01', name: 'Nusa suite', bedrooms: 2, nightlyRate: 2_500_000, status: 'maintenance', amenities: [] })
    expect(renamed.name).toBe('Nusa suite')
    await expect(s.property.updateUnit('unit-sk-04', { villaId: 'vil-saka', groupId: 'grp-saka-standard', code: 'SK-04', name: 'Saka 4', bedrooms: 1, nightlyRate: 1_850_000, status: 'inactive', amenities: [] })).rejects.toMatchObject({ code: 'UNIT_IN_USE' })
  })

  it('opens a cash account with its opening balance', async () => {
    await expect(s.finance.createAccount({ name: 'Canggu cashbox', kind: 'cashbox', locationId: 'loc-canggu', openingBalance: 0, openedOn: TODAY })).rejects.toMatchObject({ errors: { name: 'Canggu cashbox already exists.' } })
    await expect(s.finance.createAccount({ name: 'Nusa cashbox', kind: 'cashbox', locationId: null, openingBalance: 0, openedOn: TODAY })).rejects.toBeInstanceOf(ValidationError)
    const account = await s.finance.createAccount({ name: 'Nusa cashbox', kind: 'cashbox', locationId: 'loc-ubud', openingBalance: 2_500_000, openedOn: TODAY })
    expect((await s.finance.account(account.id)).balance).toBe(2_500_000)
    expect((await s.finance.overview()).accounts.some((a) => a.account.id === account.id)).toBe(true)
  })
})

describe('property wizard', () => {
  it('creates a villa with its room types and rooms in one go, or refuses the whole thing', async () => {
    const input = {
      villa: { locationId: 'loc-seminyak', code: 'NS', name: 'Villa Nusa', description: 'Four lofts', facilities: ['pool', 'wifi', 'Yoga deck'] },
      groups: [{ name: 'Loft', interchangeable: true }],
      rooms: [
        { code: 'NS-01', name: 'Loft 1', bedrooms: 1, nightlyRate: 1_500_000, groupIndex: 0, amenities: ['ac', 'kitchen'] },
        { code: 'NS-02', name: 'Loft 2', bedrooms: 1, nightlyRate: 1_500_000, groupIndex: 0, amenities: ['ac'] },
      ],
    }
    await expect(s.property.createProperty({ ...input, rooms: [...input.rooms, { ...input.rooms[0]!, name: 'Dup' }] })).rejects.toMatchObject({ errors: { 'rooms.2.code': 'NS-01 is listed twice.' } })
    await expect(s.property.createProperty({ ...input, rooms: [{ ...input.rooms[0]!, code: 'SK-01' }] })).rejects.toMatchObject({ errors: { 'rooms.0.code': expect.stringMatching(/start with NS-/) } })
    expect((await s.property.overview()).locations.flatMap((l) => l.villas).some((v) => v.villa.code === 'NS')).toBe(false)
    const villa = await s.property.createProperty(input)
    const detail = await s.property.villa(villa.id)
    expect(detail.units.map((u) => u.place.unit.code)).toEqual(['NS-01', 'NS-02'])
    expect(detail.groups[0]?.units).toHaveLength(2)
    expect(detail.villa.facilities).toContain('Yoga deck')
    expect((await s.property.unit('unit-ns-01')).place.unit.amenities).toEqual(['ac', 'kitchen'])
  })
})

describe('demo persistence', () => {
  it('keeps changes in the store and restores them for a new port set on the same day', async () => {
    let saved: Parameters<NonNullable<Parameters<typeof createMockPorts>[2]>['save']>[0] | null = null
    const store = { load: () => saved, save: (state: NonNullable<typeof saved>) => { saved = state } }
    const first = createServices(createMockPorts(fixedClock(TODAY), 0, store))
    const created = await first.finance.createCategory({ name: 'Garden', kind: 'cash_out' })
    await new Promise((r) => setTimeout(r, 5))
    const second = createServices(createMockPorts(fixedClock(TODAY), 0, store))
    expect((await second.finance.categories()).categories.some((c) => c.id === created.id)).toBe(true)
  })
})

describe('finance', () => {
  it('walks an entry to posted and reverses it with a compensating entry', async () => {
    const draft = await s.finance.createTransaction(
      { accountId: 'cb-ubud', kind: 'cash_out', categoryId: 'cat-util', amount: 500_000, date: TODAY, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Gas refill' },
      false,
    )
    expect(draft.status).toBe('draft')
    const before = (await s.finance.account('cb-ubud')).balance
    await s.finance.transition(draft.id, 'submitted')
    await expect(s.finance.transition(draft.id, 'posted')).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' })
    await s.finance.transition(draft.id, 'approved')
    const posted = await s.finance.transition(draft.id, 'posted')
    expect((await s.finance.account('cb-ubud')).balance).toBe(before - 500_000)
    await expect(s.finance.transition(posted.id, 'approved')).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_POSTED' })
    const reversal = await s.finance.reverse(posted.id, 'Charged twice')
    expect(reversal.kind).toBe('cash_in')
    expect(reversal.reversalOf).toBe(posted.id)
    expect((await s.finance.transaction(posted.id)).transaction.status).toBe('reversed')
    expect((await s.finance.account('cb-ubud')).balance).toBe(before)
  })

  it('validates entries and categories before the adapter sees them', async () => {
    await expect(
      s.finance.createTransaction({ accountId: '', kind: 'cash_in', categoryId: 'cat-util', amount: 0, date: '', locationId: '', villaId: null, unitId: null, bookingId: null, description: '' }, true),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(s.finance.createCategory({ name: 'Utilities', kind: 'cash_out' })).rejects.toThrow(/already exists/)
    const created = await s.finance.createCategory({ name: 'Garden', kind: 'cash_out' })
    expect((await s.finance.setCategoryActive(created.id, false)).active).toBe(false)
  })
})

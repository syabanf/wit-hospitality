import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { RuleError } from '@/domain/errors'
import { createServices, ValidationError, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
/** Every seeded login shares the demo password; the suite opens as the owner. */
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
/** A tiny PNG uploaded as the signed-in user. */
const receipt = (name: string) => s.files.upload({ name, type: 'image/png', size: 4, data: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })

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
    // Five seeded entries plus yesterday's spa partner bill on a delivered room service order.
    expect(fin.pending.count).toBe(6)
    expect(fin.expenses.at(-1)?.label).toBe('Other')
  })
})

describe('bookings', () => {
  it('refuses a double booking and offers an interchangeable unit instead', async () => {
    const avail = await s.booking.availability('unit-sk-05', '2026-10-07', '2026-10-10')
    expect(avail.conflicts.map((c) => c.label)).toEqual(['BK-2001'])
    expect(avail.alternatives.map((u) => u.code)).toEqual(['SK-06'])
    await expect(
      s.booking.create({ guestId: 'g-01', newGuest: null, groupId: null, unitId: 'unit-sk-05', source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: '2026-10-07', checkOut: '2026-10-10', channelRate: null, price: { rateOverride: 1_600_000, discount: null, reason: 'Agreed rate' }, notes: '', confirm: true }),
    ).rejects.toMatchObject({ code: 'BOOKING_OVERLAP' })
  })

  it('creates a booking with a new guest, confirms it and walks it to check-out', async () => {
    const created = await s.booking.create({
      guestId: null,
      newGuest: { name: 'Test Guest', email: 'test@example.com', phone: '+62 811 000 111', nationality: 'ID', idType: 'ktp', idNumber: '1', notes: '' },
      groupId: null, unitId: 'unit-sk-03',
      source: 'airbnb',
      airbnbAccountId: 'acc-saka-stays',
      airbnbCode: 'HMTEST01',
      checkIn: '2026-10-07',
      checkOut: '2026-10-09',
      channelRate: 1_850_000, price: null,
      notes: '',
      confirm: false,
    })
    expect(created.status).toBe('draft')
    expect(created.guestName).toBe('Test Guest')
    expect(created.total).toBe(3_700_000)
    await expect(s.booking.transition(created.id, 'confirmed')).rejects.toBeInstanceOf(RuleError)
    const moved = await s.booking.adjustStay(created.id, '2026-10-20', '2026-10-22', 1_850_000)
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
    // Saka sells its room type and still has stays waiting for a room.
    await expect(s.property.setGroupInterchangeable('grp-saka-standard', false)).rejects.toMatchObject({ code: 'ROOMS_TO_ASSIGN' })
    const group = await s.property.setGroupInterchangeable('grp-tirta-pool', false)
    expect(group.interchangeable).toBe(false)
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
    const group = await s.property.createGroup({ villaId: villa.id, name: 'Nusa rooms', interchangeable: true, operatorAssigns: false })
    const { unit, newPlan } = await s.property.createUnit({ villaId: villa.id, groupId: group.id, code: 'ND-01', name: 'Nusa 1', bedrooms: 2, nightlyRate: 2_000_000, status: 'active', amenities: [] })
    expect((await s.property.villa(villa.id)).units.map((u) => u.place.unit.code)).toEqual(['ND-01'])
    expect((await s.property.unit(unit.id)).place.group?.name).toBe('Nusa rooms')
    // The new room type had no plan, so the unit's base price started one.
    expect(newPlan).toMatchObject({ groupId: group.id, weekdayRate: 2_000_000, weekendRate: 2_400_000, seasons: [] })
    expect((await s.property.unit(unit.id)).priceList).toBe('plan')
    const second = await s.property.createUnit({ villaId: villa.id, groupId: group.id, code: 'ND-02', name: 'Nusa 2', bedrooms: 2, nightlyRate: 2_200_000, status: 'active', amenities: [] })
    expect(second.newPlan).toBeNull()
    await expect(s.property.createUnit({ villaId: villa.id, groupId: null, code: 'ND-01', name: 'Again', bedrooms: 1, nightlyRate: 1, status: 'active', amenities: [] })).rejects.toMatchObject({ errors: { code: 'ND-01 is already used.' } })
    await expect(s.property.createVilla({ locationId: '', code: 'x', name: '', description: '', facilities: [] })).rejects.toBeInstanceOf(ValidationError)
    const { unit: renamed } = await s.property.updateUnit(unit.id, { villaId: villa.id, groupId: null, code: 'ND-01', name: 'Nusa suite', bedrooms: 2, nightlyRate: 2_500_000, status: 'maintenance', amenities: [] })
    expect(renamed.name).toBe('Nusa suite')
    await expect(s.property.updateUnit('unit-sk-04', { villaId: 'vil-saka', groupId: 'grp-saka-standard', code: 'SK-04', name: 'Saka 4', bedrooms: 1, nightlyRate: 1_850_000, status: 'inactive', amenities: [] })).rejects.toMatchObject({ code: 'UNIT_IN_USE' })
  })

  it('opens a cash account with its opening balance', async () => {
    await expect(s.finance.createAccount({ name: 'Canggu cashbox', kind: 'cashbox', villaId: null, floatLimit: null, custodianId: null, locationId: 'loc-canggu', openingBalance: 0, openedOn: TODAY })).rejects.toMatchObject({ errors: { name: 'Canggu cashbox already exists.' } })
    await expect(s.finance.createAccount({ name: 'Nusa cashbox', kind: 'cashbox', villaId: null, floatLimit: null, custodianId: null, locationId: null, openingBalance: 0, openedOn: TODAY })).rejects.toBeInstanceOf(ValidationError)
    const account = await s.finance.createAccount({ name: 'Nusa cashbox', kind: 'cashbox', villaId: null, floatLimit: null, custodianId: null, locationId: 'loc-ubud', openingBalance: 2_500_000, openedOn: TODAY })
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

  it('leaves every room type with a rate plan, a room on its own type included, so direct stays sell without a listing', async () => {
    const villa = await s.property.createProperty({
      villa: { locationId: 'loc-ubud', code: 'NS', name: 'Villa Nusa', description: '', facilities: [] },
      groups: [
        { name: 'Loft', interchangeable: true, plan: { weekdayRate: 1_500_000, weekendRate: 1_900_000, seasons: [{ name: 'Peak', from: '12-20', to: '01-05', kind: 'surcharge', value: 25 }] } },
        { name: 'Garden', interchangeable: true },
      ],
      rooms: [
        { code: 'NS-01', name: 'Loft 1', bedrooms: 1, nightlyRate: 1_500_000, groupIndex: 0, amenities: [] },
        { code: 'NS-02', name: 'Garden 1', bedrooms: 1, nightlyRate: 1_200_000, groupIndex: 1, amenities: [] },
        { code: 'NS-03', name: 'Pool house', bedrooms: 3, nightlyRate: 4_000_000, groupIndex: null, amenities: [] },
      ],
    })
    const detail = await s.property.villa(villa.id)
    expect(detail.groups.map((g) => g.group.name)).toEqual(['Loft', 'Garden', 'Pool house'])
    for (const g of detail.groups) expect((await s.property.roomType(g.group.id)).plan, g.group.name).not.toBeNull()
    expect(detail.units.every((u) => u.place.unit.groupId !== null)).toBe(true)
    // 2026-11-19 is a Thursday: one weekday and one weekend night per room.
    const quote = (unitId: string) => s.booking.quote({ unitId, groupId: null, checkIn: '2026-11-19', checkOut: '2026-11-21', source: 'direct', channelRate: null, price: null })
    expect((await quote('unit-ns-01'))?.listRates).toEqual([1_500_000, 1_900_000])
    expect((await quote('unit-ns-02'))?.listRates).toEqual([1_200_000, 1_440_000])
    expect(await quote('unit-ns-03')).toMatchObject({ priceList: 'plan', listRates: [4_000_000, 4_800_000] })
    await expect(s.property.createProperty({ villa: { locationId: 'loc-ubud', code: 'NT', name: 'Villa Nata', description: '', facilities: [] }, groups: [{ name: 'Loft', interchangeable: true, plan: { weekdayRate: 0, weekendRate: 1, seasons: [] } }], rooms: [{ code: 'NT-01', name: 'Loft 1', bedrooms: 1, nightlyRate: 1_500_000, groupIndex: 0, amenities: [] }] })).rejects.toMatchObject({ errors: { 'plans.g0.weekdayRate': expect.any(String) } })
  })
})

describe('demo persistence', () => {
  it('keeps changes in the store and restores them for a new port set on the same day', async () => {
    let saved: Parameters<NonNullable<Parameters<typeof createMockPorts>[2]>['save']>[0] | null = null
    const store = { load: () => saved, save: (state: NonNullable<typeof saved>) => { saved = state } }
    const first = createServices(createMockPorts(fixedClock(TODAY), 0, store))
    const created = await first.finance.createCategory({ name: 'Garden', kind: 'cash_out', villaIds: [] })
    await new Promise((r) => setTimeout(r, 5))
    const second = createServices(createMockPorts(fixedClock(TODAY), 0, store))
    expect((await second.finance.categories()).categories.some((c) => c.id === created.id)).toBe(true)
  })
})

describe('finance', () => {
  it('walks an entry to posted and reverses it with a compensating entry', async () => {
    await signIn('kadek')
    const draft = await s.finance.createTransaction(
      { accountId: 'cb-ubud', kind: 'cash_out', categoryId: 'cat-util', amount: 500_000, date: TODAY, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Gas refill', reference: 'GAS-01', attachments: [await receipt('gas.png')] },
      false,
    )
    expect(draft.status).toBe('draft')
    expect(draft.reference).toBe('GAS-01')
    expect(draft.levels).toEqual(['manager'])
    const before = (await s.finance.account('cb-ubud')).balance
    await s.finance.transition(draft.id, 'submitted')
    await expect(s.finance.transition(draft.id, 'approved')).rejects.toMatchObject({ code: 'APPROVAL_SELF' })
    await signIn('wayan')
    await expect(s.finance.transition(draft.id, 'approved')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('rama')
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
      s.finance.createTransaction({ accountId: '', kind: 'cash_in', categoryId: 'cat-util', amount: 0, date: '', locationId: '', villaId: null, unitId: null, bookingId: null, description: '', reference: '', attachments: [] }, true),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(s.finance.createCategory({ name: 'Utilities', kind: 'cash_out', villaIds: [] })).rejects.toThrow(/already exists/)
    const created = await s.finance.createCategory({ name: 'Garden', kind: 'cash_out', villaIds: [] })
    expect((await s.finance.setCategoryActive(created.id, false)).active).toBe(false)
  })
})

describe('approval chain', () => {
  it('needs every level in order, refuses the author and the wrong role, and lets a rejected entry come back', async () => {
    await signIn('wayan')
    const big = await s.finance.createTransaction(
      { accountId: 'cb-canggu', kind: 'cash_out', categoryId: 'cat-maint', amount: 30_000_000, date: TODAY, locationId: 'loc-canggu', villaId: 'vil-saka', unitId: null, bookingId: null, description: 'Roof repair after the storm', reference: 'QUO-ROOF-1', attachments: [await receipt('quote-roof.png')] },
      true,
    )
    expect(big.levels).toEqual(['manager', 'finance', 'owner'])
    expect(big.nextApprover).toBe('manager')
    await expect(s.finance.transition(big.id, 'approved')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('putu')
    await expect(s.finance.transition(big.id, 'approved')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    const one = await s.finance.transition(big.id, 'approved')
    expect(one.status).toBe('submitted')
    expect(one.approvals).toHaveLength(1)
    expect(one.nextApprover).toBe('finance')
    await expect(s.finance.transition(big.id, 'approved')).rejects.toMatchObject({ code: 'APPROVAL_ROLE' })
    await signIn('ida')
    const two = await s.finance.transition(big.id, 'approved', 'Quote checked')
    expect(two.approvals.map((a) => a.role)).toEqual(['manager', 'finance'])
    await signIn('rama')
    const done = await s.finance.transition(big.id, 'approved')
    expect(done.status).toBe('approved')
    expect(done.history.filter((h) => h.kind === 'approved')).toHaveLength(3)
    const inbox = await s.finance.inbox()
    expect(inbox.mine.some((t) => t.id === big.id)).toBe(true)
    await signIn('ida')
    await expect(s.finance.transition('tx-35', 'rejected', '')).rejects.toBeInstanceOf(ValidationError)
    await signIn('rama')
    const rejected = await s.finance.transition('tx-35', 'rejected', 'Use the marketing budget instead')
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toMatch(/marketing budget/)
    await signIn('ida')
    await expect(s.finance.transition('tx-35', 'submitted')).rejects.toMatchObject({ code: 'PROOF_REQUIRED' })
    await s.finance.attach('tx-35', [await receipt('agency-invoice.png')])
    const back = await s.finance.transition('tx-35', 'submitted')
    expect(back.status).toBe('submitted')
    expect(back.approvals).toEqual([])
    expect(back.history.at(-1)?.kind).toBe('resubmitted')
  })

  it('moves a transfer as one, books an adjustment and reconciles a cashbox', async () => {
    const out = await s.finance.transfer({ fromAccountId: 'bank-bca', toAccountId: 'cb-ubud', amount: 5_000_000, date: TODAY, description: 'Top up Ubud', reference: 'TRF-1' })
    expect(out.kind).toBe('cash_out')
    const detail = await s.finance.transaction(out.id)
    expect(detail.twin?.kind).toBe('cash_in')
    expect(detail.twin?.accountId).toBe('cb-ubud')
    await signIn('kadek')
    await s.finance.transition(out.id, 'approved')
    await signIn('ida')
    await s.finance.transition(out.id, 'approved')
    const twin = (await s.finance.transaction(detail.twin?.id ?? '')).transaction
    expect(twin.status).toBe('approved')
    await expect(s.finance.transfer({ fromAccountId: 'bank-bca', toAccountId: 'bank-bca', amount: 1, date: TODAY, description: 'Loop', reference: '' })).rejects.toBeInstanceOf(ValidationError)
    const adjust = await s.finance.adjust({ accountId: 'cb-seminyak', direction: 'decrease', amount: 20_000, date: TODAY, reason: 'Coins lost in the drawer' })
    expect(adjust.origin).toBe('adjustment')
    expect(adjust.status).toBe('submitted')
    const account = await s.finance.account('cb-seminyak')
    const r = await s.finance.reconcile({ accountId: 'cb-seminyak', date: TODAY, counted: account.balance - 50_000, note: 'Friday count', adjust: true })
    expect(r.difference).toBe(-50_000)
    expect(r.adjustmentId).toBeTruthy()
    expect((await s.finance.account('cb-seminyak')).reconciliations[0]?.id).toBe(r.id)
  })

  it('keeps approval rules editable and picks the most specific one', async () => {
    const { rules } = await s.finance.rules()
    expect(rules).toHaveLength(4)
    const rule = await s.finance.createRule({ name: 'Ubud marketing', kind: 'cash_out', villaId: 'vil-tirta', minAmount: 2_000_000, levels: ['manager', 'management'], active: true })
    await expect(s.finance.createRule({ name: 'Bad', kind: 'all', villaId: null, minAmount: 0, levels: [], active: true })).rejects.toBeInstanceOf(ValidationError)
    const t = (await s.finance.transactions()).list.find((x) => x.id === 'tx-35')
    expect(t?.levels).toEqual(['manager', 'management'])
    const detail = await s.finance.transaction('tx-35')
    expect(detail.rule?.id).toBe(rule.id)
    expect((await s.finance.transaction('tx-33')).rule?.id).toBe('rule-5m')
    await s.finance.deleteRule(rule.id)
    expect((await s.finance.rules()).rules.some((r) => r.id === rule.id)).toBe(false)
  })
})

describe('bookings, payment and no-show', () => {
  it('records payment fields and marks a late guest as a no-show', async () => {
    const paid = await s.booking.setPayment('bk-2002', { paymentStatus: 'paid', paidAmount: (await s.booking.detail('bk-2002')).booking.total, airbnbFee: 0 })
    expect(paid.paymentStatus).toBe('paid')
    await expect(s.booking.setPayment('bk-2002', { paymentStatus: 'paid', paidAmount: 1, airbnbFee: 10 })).rejects.toBeInstanceOf(ValidationError)
    const gone = await s.booking.transition('bk-2002', 'no_show')
    expect(gone.status).toBe('no_show')
    expect((await s.booking.detail('bk-2002')).steps.at(-1)?.state).toBe('late')
    expect((await s.booking.availability('unit-sk-05', '2026-10-04', '2026-10-06')).conflicts.map((c) => c.label)).not.toContain('BK-2002')
    const airbnb = (await s.booking.list()).list.find((b) => b.source === 'airbnb' && b.status === 'checked_in')
    expect(airbnb?.payout).toBe((airbnb?.total ?? 0) - (airbnb?.airbnbFee ?? 0))
  })

  it('narrows everything to the villas a login may see', async () => {
    await signIn('putu')
    const overview = await s.property.overview()
    expect(overview.locations.map((l) => l.location.id)).toEqual(['loc-ubud'])
    expect(overview.locations[0]?.unitCount).toBe(4)
    expect((await s.booking.list()).list.every((b) => b.place.location.id === 'loc-ubud')).toBe(true)
    expect((await s.finance.overview()).accounts.map((a) => a.account.id).sort()).toEqual(['bank-bca', 'cb-ubud', 'pc-tirta'])
    await signIn('wayan')
    expect((await s.hr.employees()).employees.every((e) => e.villaNames.includes('Villa Saka'))).toBe(true)
    await expect(s.finance.transition('tx-33', 'approved')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('HR and payroll', () => {
  it('lists employees with leave balances and walks leave, overtime and loan requests', async () => {
    const { employees } = await s.hr.employees()
    expect(employees).toHaveLength(15)
    const sari = employees.find((e) => e.code === 'EMP-003')
    expect(sari?.leaveLeft).toBe(12 - 4)
    expect(sari?.villaNames).toBe('Villa Saka')
    await expect(s.hr.requestLeave({ employeeId: 'emp-003', kind: 'annual', from: '2026-11-02', to: '2026-11-14', reason: 'Long trip' })).rejects.toMatchObject({ errors: { to: expect.stringMatching(/8 annual leave days/) } })
    const leave = await s.hr.requestLeave({ employeeId: 'emp-003', kind: 'annual', from: '2026-11-02', to: '2026-11-04', reason: 'Family ceremony' })
    expect(leave.days).toBe(3)
    await signIn('nia')
    await expect(s.hr.decideLeave(leave.id, 'rejected', '')).rejects.toBeInstanceOf(ValidationError)
    expect((await s.hr.decideLeave(leave.id, 'approved', 'Covered')).status).toBe('approved')
    expect((await s.hr.employees()).employees.find((e) => e.code === 'EMP-003')?.leaveLeft).toBe(5)
    const ot = await s.hr.requestOvertime({ employeeId: 'emp-002', date: TODAY, hours: 2.5, villaId: 'vil-saka', reason: 'Late arrivals' })
    expect(ot.status).toBe('pending')
    await expect(s.hr.requestOvertime({ employeeId: 'emp-002', date: TODAY, hours: 9, villaId: 'vil-saka', reason: 'x' })).rejects.toBeInstanceOf(ValidationError)
    await signIn('ida')
    await expect(s.hr.requestLoan({ employeeId: 'emp-004', kind: 'loan', amount: 1_000_000, installments: 2, reason: 'Second loan', startMonth: '2026-11' })).rejects.toMatchObject({ errors: { amount: expect.stringMatching(/open loan/) } })
    const loan = await s.hr.requestLoan({ employeeId: 'emp-006', kind: 'advance', amount: 1_000_000, installments: 1, reason: 'School', startMonth: '2026-11' })
    expect((await s.hr.decideLoan(loan.id, 'approved', '')).status).toBe('active')
    const overview = await s.hr.overview()
    expect(overview.employees).toBe(14)
    expect(overview.presentToday + overview.lateToday + overview.absentToday + overview.onLeaveToday).toBeGreaterThan(5)
  })

  it('records attendance against the roster and keeps the shift grid', async () => {
    const roster = await s.hr.roster(TODAY)
    expect(roster.days).toHaveLength(14)
    expect(roster.rows.length).toBeGreaterThan(10)
    await signIn('nia')
    await s.hr.assignShift({ employeeId: 'emp-002', date: TODAY, shiftId: 'sh-morning', villaId: 'vil-saka' })
    const late = await s.hr.recordAttendance({ employeeId: 'emp-002', date: TODAY, status: 'late', clockIn: '07:25', clockOut: '15:00', note: '' })
    expect(late.lateMinutes).toBe(25)
    await expect(s.hr.recordAttendance({ employeeId: 'emp-002', date: '2027-01-01', status: 'present', clockIn: '07:00', clockOut: null, note: '' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const detail = await s.hr.employee('emp-002')
    expect(detail.attendance[0]?.status).toBe('late')
    expect(detail.payslips.length).toBeGreaterThanOrEqual(2)
  })

  it('calculates payroll from salary, overtime, loans and settings, then approves, closes and publishes it', async () => {
    const overview = await s.payroll.overview()
    expect(overview.periods).toHaveLength(3)
    const current = overview.periods[0]
    if (!current) throw new Error('no period')
    expect(current.period.status).toBe('calculated')
    const detail = await s.payroll.period(current.period.id)
    const made = detail.lines.find((l) => l.employeeId === 'emp-004')
    expect(made?.loanDeduction).toBe(1_000_000)
    const september = overview.periods[1]
    expect(september?.period.lines.find((l) => l.employeeId === 'emp-004')?.overtimeHours).toBe(9)
    expect(september?.period.lines.find((l) => l.employeeId === 'emp-004')?.reimbursement).toBe(250_000)
    expect(made?.allocation.map((a) => a.villaId)).toEqual(['vil-saka', 'vil-lumbung'])
    expect(detail.totals.net).toBeGreaterThan(40_000_000)
    expect(detail.byVilla.length).toBeGreaterThanOrEqual(4)
    await signIn('nia')
    const adjusted = await s.payroll.addAdjustment(current.period.id, 'emp-002', { kind: 'bonus', amount: 300_000, reason: 'Guest review of the month' })
    expect(adjusted.lines.find((l) => l.employeeId === 'emp-002')?.bonus).toBe(300_000)
    await expect(s.payroll.transition(current.period.id, 'approved')).rejects.toMatchObject({ code: 'APPROVAL_SELF' })
    await signIn('wayan')
    await expect(s.payroll.transition(current.period.id, 'approved')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('ida')
    expect((await s.payroll.transition(current.period.id, 'approved')).status).toBe('approved')
    await signIn('nia')
    await expect(s.payroll.addAdjustment(current.period.id, 'emp-002', { kind: 'bonus', amount: 1, reason: 'Too late now' })).rejects.toMatchObject({ code: 'PAYROLL_LOCKED' })
    await signIn('ida')
    const bank = (await s.finance.account('bank-bca')).balance
    const closed = await s.payroll.transition(current.period.id, 'closed', '', 'bank-bca')
    expect(closed.status).toBe('closed')
    expect(closed.transactionId).toBeTruthy()
    expect((await s.finance.account('bank-bca')).balance).toBe(bank - periodTotalsNet(closed))
    expect((await s.hr.loans()).rows.find((l) => l.id === 'ln-1')?.repaid).toBe(3_000_000)
    await signIn('nia')
    expect((await s.payroll.publish(current.period.id)).published).toBe(true)
    const slip = await s.payroll.payslip(current.period.id, 'emp-002')
    expect(slip.line.net).toBeGreaterThan(0)
    const next = await s.payroll.createPeriod('2026-11')
    expect(next.status).toBe('draft')
    await expect(s.payroll.createPeriod('2026-11')).rejects.toMatchObject({ code: 'PAYROLL_EXISTS' })
    const settings = await s.payroll.settings()
    await expect(s.payroll.saveSettings({ ...settings, thrMonth: 13 })).rejects.toBeInstanceOf(ValidationError)
  })
})

function periodTotalsNet(p: { lines: ReadonlyArray<{ net: number }> }) {
  return p.lines.reduce((sum, l) => sum + l.net, 0)
}

describe('employee area', () => {
  it('shows the signed-in employee their month, payslips, KPI and notices, and takes requests', async () => {
    await signIn('wayan')
    const home = await s.people.home()
    expect(home.employee?.code).toBe('EMP-002')
    expect(home.payslip?.line?.net).toBeGreaterThan(0)
    expect(home.payslips).toHaveLength(2)
    expect(home.kpi?.score).toBeGreaterThan(80)
    expect(home.announcements.length).toBeGreaterThanOrEqual(4)
    expect(home.shifts).toHaveLength(7)
    const leave = await s.people.requestLeave({ kind: 'permission', from: '2026-10-20', to: '2026-10-20', reason: 'Banjar' })
    expect(leave.employeeId).toBe('emp-002')
    expect((await s.people.cancelRequest('leave', leave.id)).status).toBe('cancelled')
    await signIn('rama')
    expect((await s.people.home()).employee).toBeNull()
  })

  it('publishes announcements and KPI reviews from HR', async () => {
    await signIn('nia')
    const notice = await s.people.createAnnouncement({ title: 'Fire drill on Friday', body: 'Assemble in the car park at 09:00 sharp. Villa managers count their teams.', pinned: true, villaId: null })
    expect((await s.people.announcements()).announcements[0]?.id).toBe(notice.id)
    await expect(s.people.saveKpi(null, { employeeId: 'emp-009', period: '2026-Q4', items: [{ name: 'Rooms', target: 95, actual: 90, weight: 60, unit: '%' }], status: 'draft', note: '' })).rejects.toBeInstanceOf(ValidationError)
    const review = await s.people.saveKpi(null, { employeeId: 'emp-009', period: '2026-Q4', items: [{ name: 'Rooms', target: 95, actual: 90, weight: 60, unit: '%' }, { name: 'Attendance', target: 98, actual: 100, weight: 40, unit: '%' }], status: 'published', note: 'Solid' })
    expect(review.status).toBe('published')
    expect((await s.people.kpis()).rows.find((k) => k.id === review.id)?.score).toBe(98)
    await s.people.deleteAnnouncement(notice.id)
  })
})

describe('access and audit', () => {
  it('signs in and out, refuses wrong passwords and deactivated logins, and changes passwords', async () => {
    await s.access.logout()
    await expect(s.dashboard.attention()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(s.access.login({ email: 'rama@balivillas.id', password: 'nope' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    await expect(s.access.login({ email: 'agus@balivillas.id', password: 'villa123' })).rejects.toMatchObject({ code: 'USER_INACTIVE' })
    const me = await signIn('rama')
    expect(me.role).toBe('owner')
    await expect(s.access.changePassword({ current: 'wrong', next: 'longenough1', confirm: 'longenough1' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    await s.access.changePassword({ current: 'villa123', next: 'longenough1', confirm: 'longenough1' })
    await s.access.logout()
    expect((await s.access.login({ email: 'rama@balivillas.id', password: 'longenough1' })).id).toBe('usr-rama')
  })

  it('manages users and permissions and writes every change to the audit trail', async () => {
    await signIn('admin')
    const user = await s.access.createUser({ name: 'Komang Dewi', email: 'komang@balivillas.id', role: 'staff', status: 'active', locationIds: ['loc-ubud'], villaIds: [], employeeId: 'emp-006' })
    await expect(s.access.createUser({ name: 'Dup', email: 'komang@balivillas.id', role: 'staff', status: 'active', locationIds: [], villaIds: [], employeeId: null })).rejects.toBeInstanceOf(ValidationError)
    await expect(s.access.setUserActive('usr-admin', false)).rejects.toMatchObject({ code: 'ACCESS_SELF' })
    expect((await s.access.setUserActive(user.id, false)).status).toBe('inactive')
    const perms = await s.access.permissions()
    const staff = { ...perms.staff, reports: ['view', 'report'] as const }
    const saved = await s.access.savePermissions('staff', staff)
    expect(saved.staff.reports).toEqual(['view', 'report'])
    await expect(s.access.savePermissions('owner', perms.owner)).rejects.toMatchObject({ code: 'ACCESS_OWNER' })
    const audit = await s.access.audit()
    expect(audit.entries[0]?.action).toBe('update')
    expect(audit.entries.some((e) => e.entity === 'user' && e.entityId === user.id && e.action === 'create')).toBe(true)
    expect(s.access.filterAudit(audit.entries, { action: 'login' }).every((e) => e.action === 'login')).toBe(true)
    await signIn('wayan')
    await expect(s.access.createUser({ name: 'X', email: 'x@balivillas.id', role: 'staff', status: 'active', locationIds: [], villaIds: [], employeeId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('reports', () => {
  it('runs every report with typed columns and totals that add up', async () => {
    const defs = s.reports.list()
    expect(defs.length).toBeGreaterThanOrEqual(20)
    for (const def of defs) {
      const result = await s.reports.run(def.slug, { from: '2026-09-01', to: TODAY })
      expect(result.columns.length).toBeGreaterThan(2)
      for (const row of result.rows) for (const c of result.columns) expect(row, `${def.slug}.${c.key}`).toHaveProperty(c.key)
    }
    const pnl = await s.reports.run('pnl-villa', { from: '2026-09-01', to: TODAY })
    expect(pnl.rows.length).toBeGreaterThanOrEqual(4)
    const saka = pnl.rows.find((r) => r.villa === 'Villa Saka')
    expect(Number(saka?.revenue)).toBeGreaterThan(0)
    expect(Number(saka?.profit)).toBe(Number(saka?.revenue) + Number(saka?.fees) + Number(saka?.other) + Number(saka?.expenses) + Number(saka?.payroll))
    const occ = await s.reports.run('occupancy', { from: '2026-09-01', to: TODAY, villaId: 'vil-tirta' })
    expect(occ.rows).toHaveLength(4)
    const source = await s.reports.run('revenue-source', { from: '2026-09-01', to: TODAY })
    expect(source.rows.map((r) => r.source)).toContain('Direct')
    const payroll = await s.reports.run('payroll-summary', { from: '2026-08-01', to: TODAY })
    expect(payroll.rows).toHaveLength(3)
    await expect(s.reports.run('nope', {})).rejects.toThrow(/No report/)
  })
})

describe('maintenance', () => {
  const job = (over: Partial<Parameters<Services['maintenance']['createWorkOrder']>[0]> = {}) => ({
    villaId: 'vil-tirta',
    unitId: 'unit-tr-03',
    assetId: null,
    category: 'plumbing' as const,
    priority: 'high' as const,
    title: 'Blocked drain in TR-03',
    description: 'Shower drains slowly',
    assigneeId: 'emp-004',
    vendorId: null,
    scheduledOn: null,
    parts: [{ name: 'Drain snake', qty: 1, unitCost: 120_000 }],
    labourCost: 150_000,
    vendorCost: 0,
    beforePhotos: ['drain.jpg'],
    afterPhotos: [],
    ...over,
  })

  it('walks a work order through its lifecycle, blocks the unit while open and trims the block when done', async () => {
    await signIn('kadek')
    await expect(s.maintenance.createWorkOrder(job({ title: 'x' }))).rejects.toBeInstanceOf(ValidationError)
    await expect(s.maintenance.createWorkOrder({ ...job(), unitId: 'unit-sk-04', villaId: 'vil-saka', blockFrom: TODAY, blockTo: '2026-10-07' })).rejects.toMatchObject({ code: 'BLOCK_OVERLAP' })
    const created = await s.maintenance.createWorkOrder({ ...job(), blockFrom: '2026-10-14', blockTo: '2026-10-16' })
    expect(created.status).toBe('open')
    expect(created.total).toBe(270_000)
    expect(created.blockId).toBeTruthy()
    expect((await s.booking.availability('unit-tr-03', '2026-10-14', '2026-10-15')).conflicts[0]?.kind).toBe('block')
    await expect(s.maintenance.transition(created.id, 'verified')).rejects.toMatchObject({ code: 'WORK_ORDER_INVALID_STATE' })
    await expect(s.maintenance.transition(created.id, 'on_hold', '')).rejects.toBeInstanceOf(ValidationError)
    await s.maintenance.transition(created.id, 'in_progress')
    const done = await s.maintenance.transition(created.id, 'done')
    expect(done.finishedOn).toBe(TODAY)
    expect(done.blockId).toBeNull()
    expect((await s.booking.availability('unit-tr-03', '2026-10-14', '2026-10-15')).conflicts).toEqual([])
    await signIn('wayan')
    await expect(s.maintenance.transition(created.id, 'verified')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    expect((await s.maintenance.transition(created.id, 'verified')).verifiedOn).toBe(TODAY)
    expect((await s.maintenance.workOrder(created.id)).steps.every((st) => st.state === 'done' || st.state === 'current')).toBe(true)
  })

  it('books each expense line as its own cash-out on the right account and lets a rejected line come back', async () => {
    await signIn('kadek')
    const detail = await s.maintenance.workOrder('wo-4')
    expect(detail.canAddExpense).toBe(true)
    await expect(s.maintenance.addExpense('wo-4', { kind: 'vendor', description: 'Invoice', payee: 'CoolDown', vendorId: null, amount: 100_000, method: 'bank_transfer', reference: '', receipts: [], paidOn: TODAY })).rejects.toBeInstanceOf(ValidationError)
    const parts = await s.maintenance.addExpense('wo-4', { kind: 'parts', description: 'Capacitor and fuse', payee: 'Toko Listrik Jaya', vendorId: null, amount: 450_000, method: 'cash', reference: 'NOTA-88', receipts: [await receipt('nota-88.png')], paidOn: TODAY })
    const bill = await s.maintenance.addExpense('wo-4', { kind: 'vendor', description: 'Compressor repair', payee: '', vendorId: 'ven-cooldown', amount: 6_200_000, method: 'bank_transfer', reference: 'INV/CD/1031', receipts: [await receipt('inv-cd-1031.png')], paidOn: TODAY })
    expect(bill.expenses).toHaveLength(2)
    const [cashLine, bankLine] = bill.expenses
    const cashTx = (await s.finance.transaction(cashLine?.transactionId ?? '')).transaction
    const bankTx = (await s.finance.transaction(bankLine?.transactionId ?? '')).transaction
    expect(parts.expenses[0]?.line).toBe(1)
    expect(cashTx.account.kind).toBe('cashbox')
    expect(cashTx.locationId).toBe(bill.locationId)
    expect(cashTx.reference).toBe('WO-504 / 1')
    expect(cashTx.origin).toBe('maintenance')
    expect(cashTx.categoryId).toBe('cat-maint')
    expect(cashTx.unitId).toBe('unit-lb-02')
    expect(cashTx.status).toBe('submitted')
    expect(bankTx.accountId).toBe('bank-bca')
    expect(bankTx.levels).toEqual(['manager', 'finance'])
    // Reject the parts line, correct it, resubmit.
    await signIn('rama')
    await s.finance.transition(cashTx.id, 'rejected', 'Attach the shop receipt with the stamp')
    await signIn('kadek')
    const fixed = await s.maintenance.correctExpense('wo-4', cashLine?.id ?? '', { kind: 'parts', description: 'Capacitor and fuse', payee: 'Toko Listrik Jaya', vendorId: null, amount: 430_000, method: 'cash', reference: 'NOTA-88', receipts: [await receipt('nota-88-stamped.png')], paidOn: TODAY })
    const again = (await s.finance.transaction(fixed.expenses[0]?.transactionId ?? '')).transaction
    expect(again.status).toBe('submitted')
    expect(again.amount).toBe(430_000)
    expect(again.history.at(-1)?.kind).toBe('resubmitted')
    await expect(s.maintenance.correctExpense('wo-4', bankLine?.id ?? '', { kind: 'vendor', description: 'Compressor repair', payee: 'CoolDown', vendorId: 'ven-cooldown', amount: 1, method: 'bank_transfer', reference: 'INV-1', receipts: [], paidOn: TODAY })).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' })
    // Approve both through the chain and post: the books move.
    const boxBefore = (await s.finance.account(cashTx.accountId)).balance
    await signIn('rama')
    await s.finance.transition(again.id, 'approved')
    await s.finance.transition(bankTx.id, 'approved')
    await signIn('ida')
    await s.finance.transition(bankTx.id, 'approved')
    await s.finance.transition(again.id, 'posted')
    await s.finance.transition(bankTx.id, 'posted')
    expect((await s.finance.account(cashTx.accountId)).balance).toBe(boxBefore - 430_000)
    const after = (await s.maintenance.workOrder('wo-4')).workOrder
    expect(after.spent.posted).toBe(6_630_000)
    expect((await s.maintenance.vendor('ven-cooldown')).vendor.spend).toBeGreaterThanOrEqual(6_200_000)
    const cost = await s.reports.run('maint-cost', { from: '2026-08-01', to: TODAY })
    expect(cost.rows.find((r) => r.unit === 'LB-02')?.total).toBe(6_630_000)
    const expense = await s.reports.run('expense', { from: TODAY, to: TODAY })
    expect(Number(expense.rows.find((r) => r.category === 'Maintenance')?.amount)).toBeGreaterThanOrEqual(6_630_000)
    const pnl = await s.reports.run('pnl-villa', { from: TODAY, to: TODAY })
    expect(Number(pnl.rows.find((r) => r.villa === 'Villa Lumbung')?.expenses)).toBeLessThanOrEqual(-6_630_000)
  })

  it('generates due preventive jobs once and advances the plan when the job is done', async () => {
    const before = (await s.maintenance.plans()).plans
    expect(before.find((p) => p.id === 'plan-fog-tirta')?.state).toBe('overdue')
    const created = await s.maintenance.generateDue(7)
    const titles = created.map((w) => w.title)
    expect(titles).toContain('Fogging, Villa Tirta')
    expect(titles).toContain('AC service, Villa Saka')
    expect(titles).not.toContain('AC service, Villa Karang')
    expect(titles).not.toContain('Generator service')
    expect(await s.maintenance.generateDue(7)).toEqual([])
    const fog = created.find((w) => w.planId === 'plan-fog-tirta')
    if (!fog) throw new Error('no fogging job')
    expect(fog.priority).toBe('high')
    await s.maintenance.transition(fog.id, 'in_progress')
    await s.maintenance.transition(fog.id, 'done')
    const plan = (await s.maintenance.plans()).plans.find((p) => p.id === 'plan-fog-tirta')
    expect(plan?.lastDoneOn).toBe(TODAY)
    expect(plan?.nextDue).toBe('2026-11-05')
    expect(plan?.state).toBe('later')
  })

  it('keeps the asset and vendor registers with history and spend', async () => {
    const { assets } = await s.maintenance.assets()
    expect(assets.length).toBeGreaterThanOrEqual(25)
    const pump = assets.find((a) => a.code === 'SK-03-PUMP')
    expect(pump?.workOrders).toBe(1)
    // The pump bill is still waiting for approval, so nothing is posted against the asset yet.
    expect(pump?.costToDate).toBe(0)
    await expect(s.maintenance.createAsset({ ...(pump as NonNullable<typeof pump>), code: 'SK-03-PUMP' })).rejects.toBeInstanceOf(ValidationError)
    const cool = (await s.maintenance.vendor('ven-cooldown')).vendor
    expect(cool.workOrders).toBeGreaterThanOrEqual(2)
    expect(cool.spend).toBeGreaterThan(0)
    await expect(s.maintenance.createVendor({ name: 'Cool Down AC Service', trade: 'ac', contact: '', phone: '', email: '', rateNote: '', active: true })).rejects.toBeInstanceOf(ValidationError)
  })

  it('marks a unit dirty on check-out, walks the board and raises a work order from a failed inspection', async () => {
    const leaving = (await s.dashboard.operational({ period: '7d' })).departures[0]
    if (!leaving) throw new Error('nobody leaves today')
    await s.booking.checkOut(leaving.id, { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' })
    const row = () => s.maintenance.housekeeping().then((h) => h.rows.find((r) => r.place.unit.id === leaving.unitId))
    expect((await row())?.state).toBe('dirty')
    await expect(s.maintenance.setHousekeeping(leaving.unitId, 'ready')).rejects.toMatchObject({ code: 'HOUSEKEEPING_INVALID_STATE' })
    await s.maintenance.setHousekeeping(leaving.unitId, 'cleaning')
    const failed = await s.maintenance.inspect(leaving.unitId, [{ item: 'bed', ok: true }, { item: 'damage', ok: false }], true)
    expect(failed.record.state).toBe('dirty')
    expect(failed.workOrder?.source).toBe('inspection')
    expect(failed.workOrder?.category).toBe('structure')
    await s.maintenance.setHousekeeping(leaving.unitId, 'cleaning')
    expect((await s.maintenance.inspect(leaving.unitId, [{ item: 'bed', ok: true }], false)).record.state).toBe('inspected')
    await s.maintenance.setHousekeeping(leaving.unitId, 'ready')
    expect((await row())?.state).toBe('ready')
    const board = await s.maintenance.housekeeping()
    expect(board.rows.find((r) => r.place.unit.code === 'PD-01')?.state).toBe('out_of_order')
    expect((await s.dashboard.operational({ period: '7d' })).notReady.length).toBeGreaterThanOrEqual(1)
  })

  it('shows SK-03 out of order while its pump job holds the unit, and runs every maintenance report', async () => {
    const overview = await s.maintenance.overview()
    expect(overview.open).toBeGreaterThanOrEqual(6)
    expect(overview.overduePlans.map((p) => p.id)).toContain('plan-ac-karang')
    const reports = s.reports.list().filter((r) => r.group === 'maintenance')
    expect(reports).toHaveLength(5)
    for (const def of reports) {
      const result = await s.reports.run(def.slug, { from: '2026-08-01', to: '2026-10-31' })
      for (const r of result.rows) for (const c of result.columns) expect(r, `${def.slug}.${c.key}`).toHaveProperty(c.key)
    }
    const downtime = await s.reports.run('maint-downtime', { from: '2026-10-01', to: '2026-10-31' })
    const sk03 = downtime.rows.find((r) => r.unit === 'SK-03')
    expect(sk03?.nights).toBe(5)
    expect(sk03?.lost).toBe(5 * 1_850_000)
    const cost = await s.reports.run('maint-cost', { from: '2026-08-01', to: TODAY })
    expect(Number(cost.rows.find((r) => r.unit === 'SK-03')?.estimate)).toBeGreaterThanOrEqual(14_850_000)
    expect(Number(cost.rows.find((r) => r.unit === 'SK-03')?.pending)).toBe(14_850_000)
  })
})

describe('payments', () => {
  const nextWeek = (n: number) => ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'][n] ?? '2026-10-12'
  async function freeUnit(from: string, to: string) {
    const opts = await s.booking.formOptions()
    for (const u of opts.catalog.units.filter((x) => x.status === 'active')) {
      const a = await s.booking.availability(u.id, from, to)
      if (a.conflicts.length === 0) return u
    }
    throw new Error('no free unit')
  }

  it('takes a cash deposit with the booking and books a submitted cash-in on the location cashbox', async () => {
    const unit = await freeUnit(nextWeek(0), nextWeek(2))
    const b = await s.booking.create({ guestId: 'g-01', newGuest: null, groupId: null, unitId: unit.id, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: nextWeek(0), checkOut: nextWeek(2), channelRate: null, price: { rateOverride: 2_000_000, discount: null, reason: 'Agreed rate' }, notes: '', confirm: true, payment: { kind: 'deposit', method: 'cash', amount: 1_200_000, reference: '' } })
    expect(b.paymentStatus).toBe('partial')
    expect(b.paidAmount).toBe(1_200_000)
    const inv = await s.payments.invoice(b.id)
    expect(inv.outstanding).toBe(2_800_000)
    const pay = inv.payments[0]
    expect(pay?.status).toBe('paid')
    expect(pay?.transactionStatus).toBe('submitted')
    const tx = (await s.finance.transaction(pay?.transactionId ?? '')).transaction
    expect(tx.account.kind).toBe('cashbox')
    expect(tx.locationId).toBe(b.place.location.id)
    expect(tx.reference).toBe(pay?.number)
    expect(tx.origin).toBe('front_desk')
    await expect(s.payments.record({ bookingId: b.id, kind: 'balance', method: 'bank_transfer', amount: 3_000_000, reference: 'TRF-1', payer: '', note: '' })).rejects.toBeInstanceOf(ValidationError)
    const rest = await s.payments.record({ bookingId: b.id, kind: 'balance', method: 'bank_transfer', amount: 2_800_000, reference: 'TRF-77', payer: '', note: '' })
    expect((await s.finance.transaction(rest.transactionId ?? '')).transaction.accountId).toBe('bank-bca')
    expect((await s.booking.detail(b.id)).booking.paymentStatus).toBe('paid')
  })

  it('pays a QRIS link through the public gateway without a session, with the fee as a cash-out', async () => {
    const unit = await freeUnit(nextWeek(1), nextWeek(3))
    const b = await s.booking.create({ guestId: 'g-02', newGuest: null, groupId: null, unitId: unit.id, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: nextWeek(1), checkOut: nextWeek(3), channelRate: null, price: { rateOverride: 1_500_000, discount: null, reason: 'Agreed rate' }, notes: '', confirm: true, payment: { kind: 'deposit', method: 'qris', amount: 900_000, reference: '' } })
    const link = (await s.payments.invoice(b.id)).links[0]
    if (!link) throw new Error('no link')
    expect(link.status).toBe('pending')
    expect(b.paymentStatus).toBe('unpaid')
    await s.access.logout()
    const view = await s.payments.checkout(link.token)
    expect(view.guestName).toBeTruthy()
    const done = await s.payments.settle(link.token, 'paid')
    expect(done.paymentStatus).toBe('paid')
    await expect(s.payments.settle(link.token, 'paid')).rejects.toMatchObject({ code: 'PAYMENT_INVALID_STATE' })
    await signIn('rama')
    const inv = await s.payments.invoice(b.id)
    expect(inv.paid).toBe(900_000)
    const p = inv.payments[0]
    expect(p?.gatewayFee).toBe(6_300)
    const fee = (await s.finance.transaction(p?.feeTransactionId ?? '')).transaction
    expect(fee.kind).toBe('cash_out')
    expect(fee.categoryId).toBe('cat-fees')
    expect((await s.finance.transaction(p?.transactionId ?? '')).transaction.origin).toBe('payment')
    expect((await s.access.audit()).entries.some((e) => e.userName === 'Payment gateway')).toBe(true)
  })

  it('records failed and expired links and refunds a paid payment', async () => {
    const failed = await s.payments.checkout('demo-failed')
    expect(failed.link.status).toBe('failed')
    expect((await s.payments.checkout('demo-expired')).link.status).toBe('expired')
    await expect(s.payments.settle('demo-expired', 'paid')).rejects.toMatchObject({ code: 'PAYMENT_INVALID_STATE' })
    const card = await s.payments.settle('demo-card', 'failed')
    expect(card.paymentStatus).toBe('failed')
    const paid = (await s.payments.list()).list.find((p) => p.status === 'paid' && p.kind === 'deposit')
    if (!paid) throw new Error('no deposit')
    await expect(s.payments.refund(paid.id, paid.amount + 1, 'Too much')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const refund = await s.payments.refund(paid.id, paid.amount, 'Guest cancelled within the free window')
    expect(refund.kind).toBe('refund')
    expect((await s.finance.transaction(refund.transactionId ?? '')).transaction.kind).toBe('cash_out')
    expect((await s.payments.invoice(paid.bookingId)).paid).toBe(0)
  })

  it('tracks Airbnb payouts, receivables and every payment report', async () => {
    const payouts = await s.payments.payouts()
    expect(payouts.rows.some((r) => r.received > 0)).toBe(true)
    const arriving = payouts.rows.find((r) => r.received === 0 && r.booking.status !== 'cancelled')
    if (arriving) expect(arriving.expected).toBe(arriving.booking.total - arriving.booking.airbnbFee)
    const rec = await s.payments.receivables()
    expect(rec.rows.length).toBeGreaterThan(5)
    expect(rec.rows.every((r) => r.outstanding > 0)).toBe(true)
    const overview = await s.payments.overview()
    expect(overview.pendingLinks.length).toBeGreaterThanOrEqual(3)
    expect(overview.outstanding).toBeGreaterThan(0)
    for (const slug of ['payments-collected', 'receivables-aging', 'airbnb-payouts', 'refunds']) {
      const r = await s.reports.run(slug, { from: '2026-09-01', to: '2026-10-20' })
      expect(r.columns.length).toBeGreaterThan(3)
    }
    expect((await s.reports.run('payments-collected', { from: '2026-09-01', to: TODAY })).rows.length).toBeGreaterThan(3)
  })
})

describe('operating flow', () => {
  async function freeUnit(from: string, to: string) {
    const opts = await s.booking.formOptions()
    for (const u of opts.catalog.units.filter((x) => x.status === 'active')) {
      if ((await s.booking.availability(u.id, from, to)).conflicts.length === 0) return u
    }
    throw new Error('no free unit')
  }
  /** Signs each level as the person the chain names, then posts as finance, and comes back as the owner. */
  async function signAndPost(id: string) {
    for (let i = 0; i < 4; i++) {
      const t = (await s.finance.transaction(id)).transaction
      if (t.status !== 'submitted' || !t.nextApprover) break
      const pick = ({ manager: ['kadek', 'admin'], finance: ['ida', 'admin'], owner: ['rama', 'admin'] } as Record<string, string[]>)[t.nextApprover] ?? ['admin']
      await signIn(pick.find((who) => `usr-${who}` !== t.createdById) ?? 'admin')
      await s.finance.transition(id, 'approved')
    }
    await signIn('ida')
    const posted = await s.finance.transition(id, 'posted')
    await signIn('rama')
    return posted
  }
  const book = async (checkIn: string, checkOut: string, payment: { kind: 'deposit' | 'full'; method: 'qris' | 'cash' | 'bank_transfer'; amount: number; reference: string }) => {
    const unit = await freeUnit(checkIn, checkOut)
    return s.booking.create({ guestId: 'g-03', newGuest: null, groupId: null, unitId: unit.id, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn, checkOut, channelRate: null, price: { rateOverride: 2_000_000, discount: null, reason: 'Agreed rate' }, notes: '', confirm: true, payment })
  }

  it('carries a booking from deposit through a longer stay and the balance into the bank, the reports and back links', async () => {
    const bankBefore = (await s.finance.account('bank-bca')).balance
    const b = await book('2026-11-09', '2026-11-12', { kind: 'deposit', method: 'qris', amount: 1_800_000, reference: '' })
    const link = (await s.payments.invoice(b.id)).links[0]
    if (!link) throw new Error('no link')

    await s.access.logout()
    const withProof = await s.payments.submitProof(link.token, { name: 'bank-app.png', type: 'image/png', size: 4, data: new Blob([new Uint8Array([1, 2, 3, 4])]) })
    expect(withProof.link.proofs[0]?.uploadedBy).toBe('Guest')
    await s.payments.settle(link.token, 'paid')
    await signIn('rama')

    const deposit = (await s.payments.invoice(b.id)).payments.find((p) => p.status === 'paid')
    const cashIn = (await s.finance.transaction(deposit?.transactionId ?? '')).transaction
    expect(cashIn.categoryId).toBe('cat-room')
    expect(cashIn.attachments.map((f) => f.name)).toEqual(['bank-app.png'])
    expect((await s.finance.transactions()).list.some((t) => t.id === cashIn.id && t.kind === 'cash_in')).toBe(true)

    const longer = await s.booking.adjustStay(b.id, '2026-11-09', '2026-11-13')
    expect(longer.total).toBe(8_000_000)
    expect(longer.paymentStatus).toBe('partial')
    const inv = await s.payments.invoice(b.id)
    expect(inv.outstanding).toBe(8_000_000 - 1_800_000)

    const slip = await receipt('transfer-slip.png')
    const balance = await s.payments.record({ bookingId: b.id, kind: 'balance', method: 'bank_transfer', amount: inv.outstanding, reference: 'TRF-2024', payer: b.guestName, note: '', attachments: [slip] })
    expect((await s.booking.detail(b.id)).booking.paymentStatus).toBe('paid')
    const detail = await s.finance.transaction(balance.transactionId ?? '')
    expect(detail.transaction.attachments[0]?.id).toBe(slip.id)
    expect(detail.booking?.id).toBe(b.id)
    expect(detail.source.payment?.number).toBe(balance.number)

    await signIn('kadek')
    expect((await s.finance.inbox()).mine.some((t) => t.id === balance.transactionId)).toBe(true)
    await signIn('rama')
    for (const id of [cashIn.id, deposit?.feeTransactionId, balance.transactionId]) if (id) await signAndPost(id)

    const fee = deposit?.feeTransactionId ? (await s.finance.transaction(deposit.feeTransactionId)).transaction.amount : 0
    expect((await s.finance.account('bank-bca')).balance).toBe(bankBefore + 8_000_000 - fee)
    const income = await s.reports.run('income', { from: TODAY, to: TODAY, villaId: b.place.villa.id })
    expect(Number(income.rows.find((r) => r.category === 'Room revenue')?.amount ?? 0)).toBeGreaterThanOrEqual(8_000_000)
    const ledger = (await s.booking.detail(b.id)).transactions
    expect(ledger.filter((t) => t.status === 'posted').length).toBeGreaterThanOrEqual(2)
  })

  it('offers the overpayment back after a shorter stay or a cheaper unit', async () => {
    const b = await book('2026-11-09', '2026-11-12', { kind: 'full', method: 'cash', amount: 6_000_000, reference: '' })
    const shorter = await s.booking.adjustStay(b.id, '2026-11-09', '2026-11-11')
    expect(shorter.paymentStatus).toBe('paid')
    const inv = await s.payments.invoice(b.id)
    expect(inv.overpaid).toBe(2_000_000)
    const paid = inv.payments[0]
    const refund = await s.payments.refund(paid?.id ?? '', inv.overpaid, 'Left a night early')
    const out = (await s.finance.transaction(refund.transactionId ?? '')).transaction
    expect(out.kind).toBe('cash_out')
    expect(out.status).toBe('submitted')
    expect((await s.payments.invoice(b.id)).overpaid).toBe(0)

    const detail = await s.booking.detail(b.id)
    const target = detail.swapTargets[0]
    if (target) {
      const moved = await s.booking.moveUnit(b.id, target.id, 'Upgrade on request', { rateOverride: 2_500_000, discount: null, reason: 'Upgrade' })
      expect(moved.rate).toBe(2_500_000)
      expect(moved.total).toBe(5_000_000)
      expect(moved.paymentStatus).toBe('partial')
    }
  })

  it('applies the cancellation policy: in time refunds everything, late keeps the deposit, a no-show keeps it all', async () => {
    const early = await book('2026-11-02', '2026-11-04', { kind: 'deposit', method: 'cash', amount: 1_200_000, reference: '' })
    expect((await s.booking.detail(early.id)).ending.cancelled).toEqual({ refund: 1_200_000, retained: 0 })
    await s.booking.transition(early.id, 'cancelled')
    const earlyInv = await s.payments.invoice(early.id)
    expect(earlyInv.paid).toBe(0)
    expect(earlyInv.payments.some((p) => p.kind === 'refund' && p.transactionId)).toBe(true)

    const late = await book('2026-10-12', '2026-10-15', { kind: 'full', method: 'bank_transfer', amount: 6_000_000, reference: 'TRF-9' })
    await s.booking.transition(late.id, 'cancelled')
    const lateInv = await s.payments.invoice(late.id)
    expect(lateInv.paid).toBe(1_800_000)
    const refund = lateInv.payments.find((p) => p.kind === 'refund')
    expect(refund?.amount).toBe(4_200_000)
    expect((await s.finance.transaction(refund?.transactionId ?? '')).transaction.accountId).toBe('bank-bca')

    const gone = await book('2026-10-13', '2026-10-15', { kind: 'deposit', method: 'qris', amount: 1_200_000, reference: '' })
    await s.booking.transition(gone.id, 'cancelled')
    expect((await s.payments.invoice(gone.id)).links.every((l) => l.status === 'cancelled')).toBe(true)
  })

  it('posts work order expenses with their receipts and refuses large ones without proof', async () => {
    await signIn('kadek')
    const input = { kind: 'parts' as const, description: 'Pump seal kit', payee: 'Toko Pompa', vendorId: null, amount: 2_400_000, method: 'cash' as const, reference: 'NOTA-5', receipts: [], paidOn: TODAY }
    await expect(s.maintenance.addExpense('wo-4', input)).rejects.toMatchObject({ code: 'PROOF_REQUIRED' })
    const nota = await receipt('nota-5.png')
    const wo = await s.maintenance.addExpense('wo-4', { ...input, receipts: [nota] })
    const line = wo.expenses.at(-1)
    const entry = await s.finance.transaction(line?.transactionId ?? '')
    expect(entry.transaction.attachments.map((f) => f.id)).toEqual([nota.id])
    expect(entry.transaction.origin).toBe('maintenance')
    expect(entry.source.workOrder?.id).toBe('wo-4')
    await signIn('rama')
    const posted = await signAndPost(entry.transaction.id)
    expect(posted.status).toBe('posted')
    await expect(s.finance.attach(posted.id, [await receipt('late.png')])).rejects.toMatchObject({ code: 'ATTACHMENT_LOCKED' })
    await expect(s.finance.detach(posted.id, nota.id)).rejects.toMatchObject({ code: 'ATTACHMENT_LOCKED' })
    const expense = await s.reports.run('expense', { from: TODAY, to: TODAY })
    expect(Number(expense.rows.find((r) => r.category === 'Maintenance')?.amount ?? 0)).toBeGreaterThanOrEqual(2_400_000)
  })

  it('stores photos and PDFs only, up to 5 MB, and lets finance move the receipt threshold', async () => {
    const big = new Blob([new Uint8Array(1)])
    await expect(s.files.upload({ name: 'notes.txt', type: 'text/plain', size: 10, data: big })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE' })
    await expect(s.files.upload({ name: 'scan.pdf', type: 'application/pdf', size: 6 * 1024 * 1024, data: big })).rejects.toMatchObject({ code: 'ATTACHMENT_SIZE' })
    const pdf = await s.files.upload({ name: 'scan.pdf', type: 'application/pdf', size: 1, data: big })
    expect(pdf.url.startsWith('data:application/pdf;base64,')).toBe(true)
    await s.access.logout()
    await expect(s.files.upload({ name: 'x.png', type: 'image/png', size: 1, data: big })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await signIn('rama')
    await expect(s.finance.saveProofPolicy({ threshold: -1 })).rejects.toBeInstanceOf(ValidationError)
    await s.finance.saveProofPolicy({ threshold: 0 })
    const t = await s.finance.createTransaction({ accountId: 'cb-canggu', kind: 'cash_out', categoryId: 'cat-maint', amount: 9_000_000, date: TODAY, locationId: 'loc-canggu', villaId: 'vil-saka', unitId: null, bookingId: null, description: 'Generator service', reference: '', attachments: [] }, true)
    expect(t.status).toBe('submitted')
  })
})

describe('listing prices, discounts, room types and petty cash', () => {
  const direct = (unitId: string | null, checkIn: string, checkOut: string, extra: Partial<Parameters<Services['booking']['create']>[0]> = {}) =>
    s.booking.create({ guestId: 'g-01', newGuest: null, unitId, groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn, checkOut, channelRate: null, price: null, notes: '', confirm: true, ...extra })

  it('sells a direct stay at the Airbnb listing price, weekend nights included, and one price edit moves both', async () => {
    // Thursday base, Friday and Saturday 15% over.
    const b = await direct('unit-tr-04', '2026-11-19', '2026-11-22')
    expect(b.listRates).toEqual([1_650_000, 1_900_000, 1_900_000])
    expect(b.total).toBe(5_450_000)
    expect(b.priceSetBy).toBeNull()
    const listing = (await s.airbnb.formOptions()).listings.find((l) => l.unitId === 'unit-tr-04')
    if (!listing) throw new Error('no listing')
    await s.airbnb.setListingPrices(listing.id, { baseRate: 1_700_000, dateRates: { '2026-11-26': 2_500_000 } })
    expect((await s.property.unit('unit-tr-04')).place.unit.nightlyRate).toBe(1_700_000)
    const quote = await s.booking.quote({ unitId: 'unit-tr-04', groupId: null, checkIn: '2026-11-25', checkOut: '2026-11-27', source: 'direct', channelRate: null, price: null })
    expect(quote?.listRates).toEqual([1_700_000, 2_500_000])
    // A stay already sold keeps its price.
    expect((await s.booking.detail(b.id)).booking.total).toBe(5_450_000)
    await expect(s.airbnb.setListingPrices(listing.id, { baseRate: 0, dateRates: {} })).rejects.toBeInstanceOf(ValidationError)
  })

  it('lets staff discount inside the limit, needs someone who may approve bookings past it, and reports who gave what', async () => {
    await signIn('wayan')
    const tenPct = { rateOverride: null, discount: { kind: 'percent' as const, value: 20, per: 'stay' as const, reason: 'Friend of the owner' }, reason: '' }
    await expect(direct('unit-sk-02', '2026-11-19', '2026-11-21', { price: tenPct })).rejects.toMatchObject({ code: 'DISCOUNT_LIMIT' })
    const b = await direct('unit-sk-02', '2026-11-19', '2026-11-21', { price: { ...tenPct, discount: { ...tenPct.discount, value: 5, reason: 'Returning guest' } } })
    expect(b.price.list).toBe(3_980_000)
    expect(b.total).toBe(3_781_000)
    expect(b.priceSetBy).toMatchObject({ by: 'Wayan Sudiarta', approvedBy: null })
    await expect(s.booking.setPrice(b.id, { rateOverride: 1_000_000, discount: null, reason: 'Cheaper' })).rejects.toMatchObject({ code: 'DISCOUNT_LIMIT' })

    await signIn('kadek')
    const deeper = await s.booking.setPrice(b.id, tenPct)
    expect(deeper.total).toBe(3_184_000)
    expect(deeper.priceSetBy).toMatchObject({ by: 'Kadek Ariani', approvedBy: 'Kadek Ariani' })
    // The deposit and the balance follow the new total.
    expect((await s.payments.invoice(b.id)).expected).toBe(3_184_000)

    await signIn('rama')
    const report = await s.reports.run('discounts', { from: '2026-11-01', to: '2026-11-30' })
    expect(report.rows).toContainEqual(expect.objectContaining({ villa: 'Villa Saka', by: 'Kadek Ariani', bookings: 1, discount: -796_000, approved: 1 }))
  })

  it('keeps the price Airbnb sold: no staff price, and new nights at the channel price', async () => {
    const b = await s.booking.create({ guestId: 'g-01', newGuest: null, unitId: 'unit-tr-04', groupId: null, source: 'airbnb', airbnbAccountId: 'acc-ubud-retreats', airbnbCode: 'HMFEED01', checkIn: '2026-11-19', checkOut: '2026-11-21', channelRate: 1_500_000, price: null, notes: '', confirm: true })
    expect(b.listRates).toEqual([1_500_000, 1_500_000])
    await expect(s.booking.setPrice(b.id, { rateOverride: 1_000_000, discount: null, reason: 'Try' })).rejects.toMatchObject({ code: 'CHANNEL_PRICE_LOCKED' })
    await expect(s.booking.adjustStay(b.id, '2026-11-19', '2026-11-22')).rejects.toBeInstanceOf(RuleError)
    const longer = await s.booking.adjustStay(b.id, '2026-11-19', '2026-11-22', 1_800_000)
    expect(longer.listRates).toEqual([1_500_000, 1_500_000, 1_800_000])
    expect(longer.total).toBe(4_800_000)
  })

  it('books a room type, never past its rooms, and checks in only after the operator assigns one', async () => {
    const byType = () => direct(null, '2026-11-19', '2026-11-21', { groupId: 'grp-lumbung-loft' })
    const first = await byType()
    expect(first.unitAssigned).toBe(false)
    expect(first.unitCode).toBe('Unassigned')
    expect(first.roomType).toBe('Lumbung lofts')
    await byType()
    await byType()
    const fourth = await byType()
    await expect(byType()).rejects.toMatchObject({ code: 'ROOM_TYPE_FULL' })
    // Every loft is free on its own, but the type is sold out.
    await expect(direct('unit-lb-03', '2026-11-19', '2026-11-21')).rejects.toMatchObject({ code: 'ROOM_TYPE_FULL' })
    await expect(s.booking.transition(first.id, 'checked_in')).rejects.toMatchObject({ code: 'UNIT_UNASSIGNED' })

    const { assignable } = await s.booking.detail(first.id)
    expect(assignable.map((u) => u.code)).toEqual(['LB-01', 'LB-02', 'LB-03', 'LB-04'])
    const placed = await s.booking.assignUnit(first.id, 'unit-lb-02')
    expect(placed.unitAssigned).toBe(true)
    expect(placed.unitCode).toBe('LB-02')
    await expect(s.booking.assignUnit(fourth.id, 'unit-lb-02')).rejects.toMatchObject({ code: 'BOOKING_OVERLAP' })
    await expect(s.booking.assignUnit(fourth.id, 'unit-sk-01')).rejects.toMatchObject({ code: 'UNIT_NOT_INTERCHANGEABLE' })
    expect((await s.booking.assignUnit(first.id, 'unit-lb-04')).unitCode).toBe('LB-04')

    const cal = await s.booking.calendar('2026-11-15', 14, { villaId: 'vil-lumbung' })
    const lanes = cal.rows.filter((r) => r.lane)
    expect(lanes.flatMap((r) => r.spans).map((x) => x.id).sort()).toEqual([fourth.id, ...(await s.booking.list()).list.filter((b) => !b.unitAssigned && b.checkIn === '2026-11-19').map((b) => b.id).filter((id) => id !== fourth.id)].sort())
    expect((await s.dashboard.attention()).toAssign.map((b) => b.code)).toEqual(['BK-2005', 'BK-2006'])
  })

  it('keeps petty cash per villa with receipts, a low alert, a scoped view and a top-up back to the float', async () => {
    const all = await s.finance.pettyCash()
    expect(all.rows.map((r) => r.account.id)).toEqual(['pc-saka', 'pc-tirta', 'pc-lumbung', 'pc-karang', 'pc-pandawa'])
    const karang = all.rows.find((r) => r.account.id === 'pc-karang')
    expect(karang).toMatchObject({ balance: 400_000, low: true, topUp: 1_600_000, custodian: expect.any(String) })
    expect(karang?.source?.id).toBe('cb-uluwatu')
    expect((await s.dashboard.attention()).lowPetty.map((p) => p.account.id)).toEqual(['pc-karang'])

    const spend = { accountId: 'pc-saka', kind: 'cash_out' as const, categoryId: 'cat-house', amount: 120_000, date: TODAY, locationId: 'loc-canggu', villaId: 'vil-saka', unitId: null, bookingId: null, description: 'Dish soap', reference: '', attachments: [] }
    await expect(s.finance.createTransaction(spend, true)).rejects.toMatchObject({ errors: { attachments: 'Attach the receipt: every petty cash spend needs one.' } })
    const withReceipt = await s.finance.createTransaction({ ...spend, attachments: [await receipt('soap.png')] }, true)
    expect(withReceipt.status).toBe('submitted')

    const topUp = await s.finance.transfer({ fromAccountId: 'cb-uluwatu', toAccountId: 'pc-karang', amount: 1_600_000, date: TODAY, description: 'Top up Villa Karang petty cash', reference: '' })
    await signIn('kadek')
    await s.finance.transition(topUp.id, 'approved')
    await signIn('ida')
    await s.finance.transition(topUp.id, 'posted')
    const after = (await s.finance.pettyCash()).rows.find((r) => r.account.id === 'pc-karang')
    expect(after).toMatchObject({ balance: 2_000_000, low: false, topUp: 0 })

    const report = await s.reports.run('petty-cash', { from: '2026-09-01', to: TODAY })
    expect(report.rows).toContainEqual(expect.objectContaining({ villa: 'Villa Karang', topUps: 1_600_000, spent: -1_600_000, closing: 2_000_000, state: 'OK' }))

    await signIn('putu')
    expect((await s.finance.pettyCash()).rows.map((r) => r.account.id)).toEqual(['pc-tirta'])
  })
})

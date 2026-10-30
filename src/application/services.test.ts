import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { RuleError } from '@/domain/errors'
import { createServices, ValidationError, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
/** Every seeded login shares the demo password; the suite opens as the owner. */
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

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
      { accountId: 'cb-ubud', kind: 'cash_out', categoryId: 'cat-util', amount: 500_000, date: TODAY, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Gas refill', reference: 'GAS-01', attachments: ['gas.jpg'] },
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
      { accountId: 'cb-canggu', kind: 'cash_out', categoryId: 'cat-maint', amount: 30_000_000, date: TODAY, locationId: 'loc-canggu', villaId: 'vil-saka', unitId: null, bookingId: null, description: 'Roof repair after the storm', reference: 'QUO-ROOF-1', attachments: [] },
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
    expect((await s.finance.overview()).accounts.map((a) => a.account.id).sort()).toEqual(['bank-bca', 'cb-ubud'])
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
    const parts = await s.maintenance.addExpense('wo-4', { kind: 'parts', description: 'Capacitor and fuse', payee: 'Toko Listrik Jaya', vendorId: null, amount: 450_000, method: 'cash', reference: 'NOTA-88', receipts: ['nota-88.jpg'], paidOn: TODAY })
    const bill = await s.maintenance.addExpense('wo-4', { kind: 'vendor', description: 'Compressor repair', payee: '', vendorId: 'ven-cooldown', amount: 6_200_000, method: 'bank_transfer', reference: 'INV/CD/1031', receipts: [], paidOn: TODAY })
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
    const fixed = await s.maintenance.correctExpense('wo-4', cashLine?.id ?? '', { kind: 'parts', description: 'Capacitor and fuse', payee: 'Toko Listrik Jaya', vendorId: null, amount: 430_000, method: 'cash', reference: 'NOTA-88', receipts: ['nota-88-stamped.jpg'], paidOn: TODAY })
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
    const b = await s.booking.create({ guestId: 'g-01', newGuest: null, unitId: unit.id, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: nextWeek(0), checkOut: nextWeek(2), nightlyRate: 2_000_000, notes: '', confirm: true, payment: { kind: 'deposit', method: 'cash', amount: 1_200_000, reference: '' } })
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
    const b = await s.booking.create({ guestId: 'g-02', newGuest: null, unitId: unit.id, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: nextWeek(1), checkOut: nextWeek(3), nightlyRate: 1_500_000, notes: '', confirm: true, payment: { kind: 'deposit', method: 'qris', amount: 900_000, reference: '' } })
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

describe('finance simulation', () => {
  it('runs booking to revenue and repair to expense end to end, then restores the demo', async () => {
    const { SCENARIOS, emptyContext, actAs } = await import('./simulation')
    const snap = await s.demo.snapshot()
    const bankBefore = (await s.finance.account('bank-bca')).balance
    for (const scenario of SCENARIOS) {
      const ctx = emptyContext()
      for (const step of scenario.steps) {
        await actAs(s, step.actor)
        const out = await step.run(s, ctx)
        expect(out.lines.length, `${scenario.id}/${step.id}`).toBeGreaterThan(0)
      }
      const sum = await scenario.summary(s, ctx)
      expect(sum.trail.length).toBeGreaterThanOrEqual(2)
      expect(sum.trail.every((r) => r.status === 'posted')).toBe(true)
      const bank = sum.balances.find((b) => b.accountId === 'bank-bca')
      const bankMoves = sum.trail.filter((r) => r.account === bank?.account).reduce((t, r) => t + r.amount, 0)
      expect((bank?.after ?? 0) - (bank?.before ?? 0)).toBe(bankMoves)
      if (scenario.id === 'booking') expect(sum.facts.find(([k]) => k === 'Room revenue received today')?.[1]).not.toBe('Rp 0')
      if (scenario.id === 'repair') expect(sum.facts.find(([k]) => k === 'Maintenance expense today')?.[1]).not.toBe('Rp 0')
    }
    await s.demo.restore(snap)
    await signIn('rama')
    expect((await s.finance.account('bank-bca')).balance).toBe(bankBefore)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import type { EnquiryInput } from '@/domain/enquiry'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'
import { menuLines } from './site'

const TODAY = '2026-10-30'
let ports: Ports
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const IN = addDays(TODAY, 20)
const OUT = addDays(TODAY, 23)
const enquiry = (extra: Partial<EnquiryInput> = {}): EnquiryInput => ({
  name: 'Mia Rossi',
  email: 'mia.rossi@example.it',
  whatsapp: '+39 347 220 1188',
  country: 'IT',
  checkIn: IN,
  checkOut: OUT,
  guests: 2,
  villaId: 'vil-karang',
  groupId: 'grp-karang-cliff',
  note: 'Late arrival.',
  ...extra,
})

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await s.access.logout()
})

describe('public site', () => {
  it('reads without a session and carries no guest, booking or money record', async () => {
    const home = await s.site.home()
    expect(home.villas.map((v) => v.name)).toContain('Villa Karang')
    expect(home.villas.find((v) => v.id === 'vil-pandawa')?.open).toBe(false)
    expect(home.villas.find((v) => v.id === 'vil-karang')?.fromPrice).toBeGreaterThan(0)
    const inventory = JSON.stringify(await ports.site.inventory())
    const holds = await ports.site.holds(TODAY, addDays(TODAY, 30))
    for (const key of ['guestId', 'createdBy', 'paidAmount', 'airbnbId', 'accountId', 'partnerId', 'cost', 'phone']) expect(inventory).not.toContain(`"${key}"`)
    expect(inventory).not.toContain('Putri Anjani')
    expect(Object.keys(holds[0] ?? {}).sort()).toEqual(['from', 'to', 'unitAssigned', 'unitId'])
    const villa = await s.site.villa('vil-karang')
    expect(villa.roomTypes[0]?.strip).toHaveLength(14)
    expect(villa.stayNotes).toContain('Arrivals from 20 Dec to 5 Jan stay at least 3 nights.')
  })

  it('quotes and counts free rooms the way the console does for the same dates and unit', async () => {
    const pub = await s.site.availability('vil-saka', IN, OUT, 2)
    const karang = await s.site.availability('vil-karang', IN, OUT, 4)
    await signIn('dian')
    expect(pub.offers.length + karang.offers.length).toBe(2)
    for (const offer of [...pub.offers, ...karang.offers]) {
      const assigns = offer.groupId === 'grp-saka-standard'
      const console = await s.booking.quote({ unitId: assigns ? null : (offer.quote?.unitId ?? null), groupId: offer.groupId, checkIn: IN, checkOut: OUT, source: 'direct', channelRate: null, price: null })
      expect(offer.quote?.total, offer.name).toBeGreaterThan(0)
      expect(offer.quote?.total, offer.name).toBe(console?.tax.total)
      expect(offer.quote?.service).toBe(console?.tax.service)
      expect(offer.quote?.pb1).toBe(console?.tax.pb1)
    }
    const saka = pub.offers.find((o) => o.groupId === 'grp-saka-standard')
    expect(saka?.free).toBe((await s.booking.roomTypeAvailability('grp-saka-standard', IN, OUT))?.free)
    const before = karang.offers[0]?.free ?? 0
    await s.booking.create({ guestId: 'g-01', newGuest: null, unitId: karang.offers[0]?.quote?.unitId ?? null, groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: IN, checkOut: OUT, channelRate: null, price: null, notes: '', confirm: true })
    expect((await s.site.availability('vil-karang', IN, OUT, 4)).offers[0]?.free).toBe(before - 1)
  })

  it('keeps stays that break a rule or overfill a room out of the search, cheapest first', async () => {
    const season = await s.site.availability('vil-karang', '2026-12-21', '2026-12-23', 2)
    expect(season.offers[0]?.rules[0]).toContain('at least 3 nights')
    const found = await s.site.search({ location: '', checkIn: IN, checkOut: OUT, guests: 2 })
    const totals = found.results.map((r) => r.quote?.total ?? 0)
    expect(totals).toEqual([...totals].sort((a, b) => a - b))
    expect(found.results.every((r) => r.free > 0 && r.fits)).toBe(true)
    const party = await s.site.search({ location: 'loc-canggu', checkIn: IN, checkOut: OUT, guests: 3 })
    expect(party.results).toHaveLength(0)
    expect((await s.site.search({ location: '', checkIn: TODAY, checkOut: TODAY, guests: 2 })).problem).toBeTruthy()
  })

  it('counts the home figures and the team from the records, with no names', async () => {
    const home = await s.site.home()
    expect(home.figures).toMatchObject({ villas: 5, locations: 4 })
    const units = (await ports.site.inventory()).units.filter((u) => u.status !== 'inactive')
    expect(home.figures.rooms).toBe(units.length)
    const about = await s.site.about()
    expect(about.people).toBe(14)
    expect(about.team.find((d) => d.department === 'Housekeeping')?.roles).toEqual([{ position: 'Housekeeping', people: 4 }])
    expect(JSON.stringify(about)).not.toContain('Kadek Ariani')
    expect(JSON.stringify(await ports.site.inventory())).not.toContain('basicSalary')
  })

  it('merges the menu across villas at the lowest price', () => {
    const lines = menuLines([
      { id: 'a', villaId: 'v1', category: 'spa', name: 'Massage', description: '', price: 300_000, unit: 'person' },
      { id: 'b', villaId: 'v2', category: 'spa', name: 'Massage', description: '', price: 280_000, unit: 'person' },
    ])
    expect(lines).toEqual([expect.objectContaining({ name: 'Massage', price: 280_000 })])
  })
})

describe('web enquiries', () => {
  it('refuses a request with missing contact, a room type of another villa, or a closed villa', async () => {
    await expect(s.site.enquire(enquiry({ email: 'mia', whatsapp: '12' }))).rejects.toMatchObject({ errors: { email: expect.any(String), whatsapp: expect.any(String) } })
    await expect(s.site.enquire(enquiry({ groupId: 'grp-saka-standard' }))).rejects.toMatchObject({ errors: { groupId: expect.any(String) } })
    await expect(s.site.enquire(enquiry({ checkIn: addDays(TODAY, -2), checkOut: TODAY }))).rejects.toMatchObject({ errors: { checkIn: expect.any(String) } })
    await expect(s.site.enquire(enquiry({ villaId: 'vil-pandawa', groupId: null }))).rejects.toMatchObject({ code: 'SITE_VILLA_CLOSED' })
  })

  it('files a new enquiry the team converts into a booking that links back', async () => {
    const receipt = await s.site.enquire(enquiry())
    expect(receipt).toEqual({ number: 'ENQ-0005', villaName: 'Villa Karang', checkIn: IN, checkOut: OUT })
    await signIn('nia')
    await expect(s.enquiries.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('wayan')
    expect((await s.enquiries.list()).list.every((e) => e.villaId === 'vil-saka')).toBe(true)
    await signIn('dian')
    const { list, counts } = await s.enquiries.list()
    expect(counts.new).toBe(3)
    expect((await s.dashboard.attention()).newEnquiries).toBe(3)
    const mine = list.find((e) => e.number === receipt.number)
    expect(mine).toMatchObject({ status: 'new', villaName: 'Villa Karang', countryName: 'Italy', nights: 3 })
    const prefill = await s.enquiries.prefill(mine?.id ?? '')
    expect(prefill).toMatchObject({ guestId: null, villaId: 'vil-karang', checkIn: IN, checkOut: OUT, guest: { name: 'Mia Rossi', nationality: 'IT' } })
    const unit = (await s.site.availability('vil-karang', IN, OUT, 2)).offers[0]?.quote?.unitId ?? null
    const booking = await s.booking.create({ guestId: null, newGuest: { ...prefill.guest, idType: 'passport', idNumber: '', notes: '' }, unitId: unit, groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: IN, checkOut: OUT, channelRate: null, price: null, notes: prefill.notes, confirm: true })
    await s.enquiries.convert(prefill.enquiryId, booking.id)
    const after = (await s.enquiries.list()).list.find((e) => e.id === prefill.enquiryId)
    expect(after).toMatchObject({ status: 'converted', bookingId: booking.id, bookingCode: booking.code, handledBy: 'Dian Permata' })
    await expect(s.enquiries.convert(prefill.enquiryId, booking.id)).rejects.toMatchObject({ code: 'ENQUIRY_INVALID_STATE' })
    const audit = await s.access.audit()
    expect(audit.entries.some((e) => e.entity === 'enquiry' && e.userName === 'Guest')).toBe(true)
  })

  it('files an owner note with no dates or villa that every enquiry reader sees and nobody books', async () => {
    const owner = enquiry({ topic: 'owner', villaId: '', groupId: null, checkIn: '', checkOut: '', guests: 0, note: 'Three-bedroom villa in Sanur, self-run today.' })
    await expect(s.site.enquire({ ...owner, note: 'Hi' })).rejects.toMatchObject({ errors: { note: expect.any(String) } })
    const receipt = await s.site.enquire(owner)
    expect(receipt.villaName).toBe('')
    await signIn('wayan')
    const seen = (await s.enquiries.list()).list.find((e) => e.number === receipt.number)
    expect(seen).toMatchObject({ topic: 'owner', villaName: '', nights: 0 })
    await expect(s.enquiries.prefill(seen?.id ?? '')).rejects.toMatchObject({ code: 'ENQUIRY_INVALID_STATE' })
  })

  it('needs a reason to close and keeps a converted enquiry where it is', async () => {
    await signIn('dian')
    await expect(s.enquiries.setStatus('enq-1', 'closed', '')).rejects.toMatchObject({ errors: { note: expect.any(String) } })
    expect(await s.enquiries.setStatus('enq-1', 'contacted', 'Called on WhatsApp')).toMatchObject({ status: 'contacted', statusNote: 'Called on WhatsApp' })
    expect(await s.enquiries.setStatus('enq-4', 'contacted', 'Asked again')).toMatchObject({ status: 'contacted' })
  })
})

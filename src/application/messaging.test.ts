import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { checkinTokenFor, dueTimeTriggers, invoiceTokenFor, renderTemplate } from '@/domain/messaging'
import { checkInPrefill, guestFieldsFrom, validatePreCheckIn, type PreCheckInInput } from '@/domain/precheckin'
import { addDays } from '@/lib/dates'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
})

const form = (over: Partial<PreCheckInInput> = {}): PreCheckInInput => ({
  email: 'ana@example.com',
  phone: '+61 412 555 019',
  arrivalTime: '15:00',
  flight: 'jq 37',
  adults: 1,
  children: 0,
  travellers: [{ name: 'Ana Silva', nationality: 'Portugal', documentType: 'passport', documentNumber: 'CB123456', documentExpiry: '2030-01-01', dateOfBirth: '1990-04-02', sex: 'female', entryDate: TODAY, portOfEntry: 'DPS', visaType: 'voa' }],
  idPhotos: [{ id: 'file-x', name: 'passport.jpg', type: 'image/jpeg', size: 1000, url: '', uploadedBy: 'Guest', uploadedAt: `${TODAY}T08:00:00` }],
  rulesName: 'Ana Silva',
  rulesAccepted: true,
  ...over,
})

describe('messaging rules', () => {
  it('fills placeholders and leaves unknown ones for staff to see', () => {
    expect(renderTemplate('Hi {guest}, {amount} for {code} {nope}', { guest: 'Ana', amount: 1_500_000, code: 'BK-1' })).toBe('Hi Ana, Rp 1.500.000 for BK-1 {nope}')
  })

  it('sends pre-arrival from the set day and the reminder on the evening before departure', () => {
    const stay = { status: 'confirmed', checkIn: '2026-10-08', checkOut: '2026-10-10' }
    expect(dueTimeTriggers(stay, '2026-10-04T12:00:00', 3)).toEqual([])
    expect(dueTimeTriggers(stay, '2026-10-05T09:00:00', 3)).toEqual([])
    expect(dueTimeTriggers(stay, '2026-10-05T10:00:00', 3)).toEqual(['pre_arrival'])
    const inHouse = { ...stay, status: 'checked_in' }
    expect(dueTimeTriggers(inHouse, '2026-10-09T17:59:00', 3)).toEqual([])
    expect(dueTimeTriggers(inHouse, '2026-10-09T18:00:00', 3)).toEqual(['checkout_reminder'])
  })

  it('checks every adult’s document and the signature', () => {
    const stay = { checkIn: TODAY, checkOut: addDays(TODAY, 3) }
    expect(validatePreCheckIn(form(), stay)).toEqual({})
    const errors = validatePreCheckIn(form({ adults: 2, rulesAccepted: false, travellers: [{ ...form().travellers[0]!, documentExpiry: addDays(TODAY, 1), visaType: 'none' }] }), stay)
    expect(Object.keys(errors).sort()).toEqual(['rulesAccepted', 'travellers', 'travellers.0.documentExpiry', 'travellers.0.visaType'])
  })

  it('maps the lead traveller onto the guest and prefills the check-in once verified', () => {
    expect(guestFieldsFrom(form(), { email: 'old@example.com' })).toEqual({ nationality: 'Portugal', idType: 'passport', idNumber: 'CB123456', email: 'ana@example.com', phone: '+61 412 555 019' })
    expect(checkInPrefill({ ...form(), status: 'submitted' })).toEqual({})
    expect(checkInPrefill({ ...form(), status: 'verified' })).toMatchObject({ idVerified: true, arrivalTime: '15:00', adults: 1 })
  })
})

describe('guest messages', () => {
  it('seeds a history for recent and upcoming stays with one failed message', async () => {
    const { list } = await s.messaging.list()
    expect(list.length).toBeGreaterThan(20)
    for (const key of ['booking_confirmed', 'payment_received', 'pre_arrival', 'welcome', 'checkout_reminder', 'post_stay'] as const) expect(list.some((m) => m.templateKey === key), key).toBe(true)
    expect(list.filter((m) => m.status === 'failed')).toHaveLength(1)
  })

  it('confirms a booking, sends a template and a free message, and resends a failed one', async () => {
    await signIn('dian')
    const options = await s.booking.formOptions()
    const guest = options.guests[0]!
    const draft = await s.booking.create({ guestId: guest.id, newGuest: null, unitId: 'unit-kr-01', groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: addDays(TODAY, 40), checkOut: addDays(TODAY, 43), channelRate: null, price: null, notes: '', confirm: false })
    expect((await s.messaging.forBooking(draft.id)).messages).toHaveLength(0)
    await s.booking.transition(draft.id, 'confirmed')
    const stay = await s.messaging.forBooking(draft.id)
    expect(stay.messages.map((m) => m.templateKey)).toEqual(['booking_confirmed'])
    expect(stay.messages[0]?.body).toContain(draft.code)

    const sent = await s.messaging.send({ bookingId: draft.id, channel: 'whatsapp', templateKey: 'pre_arrival', language: 'id', body: '' })
    expect(sent.body).toContain(checkinTokenFor(draft.id))
    expect(sent.sentBy).toBe('Dian Permata')
    await expect(s.messaging.send({ bookingId: draft.id, channel: 'email', templateKey: null, language: 'en', body: ' ' })).rejects.toMatchObject({ errors: { body: 'Write the message.' } })
    const free = await s.messaging.send({ bookingId: draft.id, channel: 'email', templateKey: null, language: 'en', body: 'Hi {guest}, the pool is open again.' })
    expect(free.body).toBe(`Hi ${guest.name.split(' ')[0]}, the pool is open again.`)

    await expect(s.messaging.resend(free.id)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FAILED' })
    const failed = (await s.messaging.list()).list.find((m) => m.status === 'failed')!
    const again = await s.messaging.resend(failed.id)
    expect(again.status).toBe('queued')
    expect(again.attempts).toBe(2)
  })

  it('lets reservation read but not change templates, and turns a trigger off', async () => {
    await signIn('kadek')
    const { settings } = await s.messaging.settings()
    const off = { ...settings, templates: settings.templates.map((t) => (t.key === 'booking_confirmed' ? { ...t, enabled: false } : t)) }
    await s.messaging.saveSettings(off)
    const options = await s.booking.formOptions()
    const b = await s.booking.create({ guestId: options.guests[1]!.id, newGuest: null, unitId: 'unit-kr-02', groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: addDays(TODAY, 50), checkOut: addDays(TODAY, 52), channelRate: null, price: null, notes: '', confirm: true })
    expect((await s.messaging.forBooking(b.id)).messages).toHaveLength(0)
    await signIn('ida')
    await expect(s.messaging.send({ bookingId: b.id, channel: 'email', templateKey: null, language: 'en', body: 'Hello there' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('serves the stay invoice behind the e-invoice link without a session', async () => {
    const { list } = await s.messaging.list()
    const post = list.find((m) => m.templateKey === 'post_stay')!
    await s.access.logout()
    const inv = await s.messaging.invoice(invoiceTokenFor(post.bookingId))
    expect(inv.booking.id).toBe(post.bookingId)
    expect(inv.lines.length).toBeGreaterThan(0)
    await expect(s.messaging.invoice('iv-forged')).rejects.toThrow()
  })
})

describe('online check-in', () => {
  it('seeds two submitted arrivals and one verified', async () => {
    const { rows } = await s.precheckin.arrivals()
    expect(rows.filter((r) => r.status === 'submitted')).toHaveLength(2)
    expect(rows.filter((r) => r.status === 'verified')).toHaveLength(1)
    expect(rows.filter((r) => r.status === 'submitted').every((r) => r.booking.checkIn === TODAY)).toBe(true)
  })

  it('takes the guest’s form, locks it once the desk verifies, and copies the data onto the guest and stay', async () => {
    const { rows } = await s.precheckin.arrivals()
    const row = rows.find((r) => r.status === 'not_started' && r.booking.source === 'direct' && r.booking.checkIn >= TODAY)!
    const token = checkinTokenFor(row.booking.id)
    await s.access.logout()
    const page = await s.precheckin.guest(token)
    expect(page.status).toBe('not_started')
    await expect(s.precheckin.submit(token, form({ rulesAccepted: false }))).rejects.toMatchObject({ errors: { rulesAccepted: 'Accept the house rules.' } })
    const sent = await s.precheckin.submit(token, form({ adults: 1, children: 2 }))
    expect(sent.status).toBe('submitted')
    if (sent.balance > 0) {
      const link = await s.precheckin.payBalance(token, 'qris')
      expect(link.amount).toBe(sent.balance)
      expect((await s.precheckin.payBalance(token, 'qris')).token).toBe(link.token)
    }

    await signIn('kadek')
    const verified = await s.precheckin.verify(row.booking.id)
    expect(verified.verifiedBy).toBe('Kadek Ariani')
    await expect(s.precheckin.verify(row.booking.id)).rejects.toMatchObject({ code: 'PRECHECKIN_VERIFIED' })
    const detail = await s.booking.detail(row.booking.id)
    expect(detail.booking.guest.idNumber).toBe('CB123456')
    expect(detail.booking.partySize).toEqual({ adults: 1, children: 2 })
    await expect(s.precheckin.submit(token, form())).rejects.toMatchObject({ code: 'PRECHECKIN_LOCKED' })
  })

  it('refuses to verify before the guest sent anything, and closes the link after check-out', async () => {
    await signIn('kadek')
    const { rows } = await s.precheckin.arrivals()
    const fresh = rows.find((r) => r.status === 'not_started')!
    await expect(s.precheckin.verify(fresh.booking.id)).rejects.toMatchObject({ code: 'PRECHECKIN_NOT_SUBMITTED' })
    const gone = (await s.booking.list()).list.find((b) => b.status === 'checked_out')!
    await expect(s.precheckin.guest(checkinTokenFor(gone.id))).rejects.toMatchObject({ code: 'PRECHECKIN_LINK_EXPIRED' })
  })

  it('sends the welcome at check-in', async () => {
    await signIn('kadek')
    const { rows } = await s.precheckin.arrivals()
    const today = rows.find((r) => r.booking.checkIn === TODAY && r.booking.unitAssigned)!
    await s.booking.checkIn(today.booking.id, { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' })
    const { messages } = await s.messaging.forBooking(today.booking.id)
    expect(messages.some((m) => m.templateKey === 'welcome')).toBe(true)
  })
})

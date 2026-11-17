import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import {
  departureOf,
  validateIssueKey,
  validateOutcome,
  validateRegistrationCard,
  validateReturnFee,
  validateWakeUp,
  wakeUpOverdue,
  type IssueKeyInput,
  type StayKey,
  type WakeUpCall,
  type WakeUpInput,
  type WakeUpOutcome,
} from '@/domain/frontDesk'
import { CANCELLATION_TEXT, unitKindOf, type Catalog, type Villa } from '@/domain/property'
import { HOUSE_RULES } from '@/domain/precheckin'
import { money } from '@/lib/format'
import { addDays, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { BookingView } from './views'

interface World {
  cat: Catalog
  bookings: Booking[]
  describe: (b: Booking) => BookingView
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  check: (errors: Record<string, string | undefined>) => void
  world: () => Promise<World>
}

/** The deposit terms in the guest's words. */
export function depositTerms(v: Pick<Villa, 'depositKind' | 'depositValue' | 'depositOnCheckIn'>): string {
  const booking = v.depositKind === 'percent' ? `${v.depositValue}% of the stay is due on booking.` : v.depositKind === 'fixed' ? `${money(v.depositValue)} is due on booking.` : 'No deposit is due on booking.'
  return `${booking} ${v.depositOnCheckIn ? 'A refundable security deposit is held at check-in.' : 'No security deposit is held at check-in.'}`
}

const houseRules = (v: Pick<Villa, 'houseRules'>) => (v.houseRules.trim() ? v.houseRules.split('\n').map((r) => r.trim()).filter(Boolean) : [...HOUSE_RULES])
const signature = (png: Blob) => ({ name: 'signature.png', type: 'image/png', size: png.size, data: png })

export interface KeyRow {
  key: StayKey
  bookingId: string
  code: string
  guestName: string
  unitCode: string
  /** When the key last changed: closed, else issued. */
  at: string
}

export interface WakeUpRow {
  call: WakeUpCall
  bookingId: string
  code: string
  guestName: string
  unitCode: string
  villaName: string
  overdue: boolean
  /** "No answer at 06:05" after a missed try, for the retry. */
  lastTry: string | null
}

/** The registration card, early check-in, keys and wake-up calls; see front-desk-sop-contract.md. */
export function createFrontDeskServices({ ports, today, allow, check, world }: Deps) {
  const now = () => ports.clock.time?.() ?? new Date().toTimeString().slice(0, 5)
  async function stay(id: string) {
    const w = await world()
    return { w, b: w.describe(findById(w.bookings, id, 'booking')) }
  }
  const described = async (b: Booking) => (await world()).describe(b)

  return {
    /** What the printed card shows, with the terms in the guest's words. */
    async card(id: string) {
      const { b } = await stay(id)
      const v = b.place.villa
      return {
        booking: b,
        today: today(),
        required: v.requireRegistrationCard,
        houseRules: houseRules(v),
        cancellation: CANCELLATION_TEXT[v.cancellationPolicy],
        deposit: depositTerms(v),
        party: b.arrival ? { adults: b.arrival.adults, children: b.arrival.children } : (b.partySize ?? null),
      }
    },
    /** The desk takes the signature drawn on screen: the PNG goes to the files context first. */
    async signOnScreen(id: string, png: Blob) {
      await allow('booking', 'edit')
      const file = await ports.files.upload(signature(png))
      return described(await ports.frontDesk.signCard(id, { method: 'screen', signature: file }))
    },
    async signOnPaper(id: string, cardNumber: string) {
      await allow('booking', 'edit')
      check(validateRegistrationCard({ method: 'paper', cardNumber }))
      return described(await ports.frontDesk.signCard(id, { method: 'paper', cardNumber }))
    },
    /** The guest signs on the online check-in or the stay page; the token is the credential. */
    async guestSignOnStay(token: string, png: Blob) {
      return ports.stay.signCard(token, await ports.files.upload(signature(png)))
    },
    async guestSignOnCheckin(token: string, png: Blob) {
      return ports.precheckin.signCard(token, await ports.files.upload(signature(png)))
    },

    /** The guest books a call from the stay page; the port answers the page with each field's problem. */
    guestBookWakeUp: (token: string, input: WakeUpInput) => ports.stay.bookWakeUp(token, input),

    /** What early check-in would cost and whether the departing guest leaves room for it. */
    async earlyTerms(id: string) {
      const { w, b } = await stay(id)
      const v = b.place.villa
      return { fee: v.earlyCheckinFee, checkInTime: v.checkInTime, kind: unitKindOf(w.cat, b.unitId), departure: departureOf(b, w.bookings, v.checkOutTime) }
    },
    async earlyCheckin(id: string, from: string) {
      await allow('booking', 'edit')
      const r = await ports.frontDesk.earlyCheckin(id, from)
      return { booking: await described(r.booking), charge: r.charge }
    },

    async issueKey(id: string, input: IssueKeyInput) {
      await allow('booking', 'edit')
      const { b } = await stay(id)
      check(validateIssueKey(input, b))
      return described(await ports.frontDesk.issueKey(id, input))
    },
    async returnKey(id: string, keyId: string, returned: boolean, fee?: number) {
      await allow('booking', 'edit')
      check(validateReturnFee(fee))
      return described(await ports.frontDesk.returnKey(id, keyId, returned, fee))
    },
    /** Keys out now and every key handed out, newest first, for the properties in scope. */
    async keyLog(villaId?: string) {
      const w = await world()
      const villas = w.cat.villas
      const villa = villas.find((v) => v.id === villaId) ?? villas[0]
      if (!villa) throw new RuleError('NOT_FOUND', 'No property is in your scope.')
      const rows: KeyRow[] = w.bookings
        .filter((b) => b.keys?.length && w.cat.unit(b.unitId).villaId === villa.id)
        .flatMap((b) => {
          const v = w.describe(b)
          return (b.keys ?? []).map((key) => ({ key, bookingId: b.id, code: b.code, guestName: v.guestName, unitCode: v.unitCode, at: key.closedAt ?? key.issuedAt }))
        })
        .sort((a, b) => b.at.localeCompare(a.at))
      return { villa, villas, out: rows.filter((r) => r.key.status === 'out'), history: rows }
    },

    async bookWakeUp(id: string, input: WakeUpInput) {
      await allow('booking', 'edit')
      const { b } = await stay(id)
      check(validateWakeUp(input, b, today()))
      return described(await ports.frontDesk.bookWakeUp(id, input))
    },
    async wakeUpOutcome(id: string, callId: string, outcome: WakeUpOutcome) {
      await allow('booking', 'edit')
      check(validateOutcome(outcome))
      return described(await ports.frontDesk.wakeUpOutcome(id, callId, outcome))
    },
    /**
     * Pending calls of stays in house that ring on `date`, by time; on today the ones a past morning missed come
     * first and every call whose time has passed reads overdue.
     */
    async wakeUpCalls(date: IsoDate = today()) {
      const w = await world()
      const isToday = date === today()
      const time = now()
      const rows: WakeUpRow[] = w.bookings
        .filter((b) => b.status === 'checked_in')
        .flatMap((b) => {
          const v = w.describe(b)
          return (b.wakeUpCalls ?? [])
            .filter((c) => c.status === 'pending' && (c.date === date || (isToday && c.date < date)))
            .map((call) => {
              const last = call.log.at(-1)
              return {
                call,
                bookingId: b.id,
                code: b.code,
                guestName: v.guestName,
                unitCode: v.unitCode,
                villaName: v.place.villa.name,
                overdue: isToday && wakeUpOverdue(call, date, time),
                lastTry: last?.outcome === 'no_answer' && last.date === call.date ? `No answer at ${last.at.slice(11, 16)}` : null,
              }
            })
        })
        .sort((a, b) => a.call.date.localeCompare(b.call.date) || a.call.time.localeCompare(b.call.time))
      return { date, today: today(), tomorrow: addDays(today(), 1), rows }
    },
  }
}

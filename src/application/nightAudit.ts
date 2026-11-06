import type { Action, Module, User } from '@/domain/access'
import { unassigned, type Booking } from '@/domain/booking'
import { RuleError } from '@/domain/errors'
import { AUDIT_CHECK_HINT, AUDIT_CHECK_LABEL, AUDIT_CHECKS, auditProblem, nightsAmount, nightsToPost, type AuditCheck, type AuditCheckKey } from '@/domain/nightAudit'
import { isOpenOrder } from '@/domain/serviceOrder'
import { addDays, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { BookingView } from './views'

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ can: (module: Module, action: Action) => boolean }>
  world: () => Promise<{ bookings: Booking[]; views: BookingView[] }>
  /** The existing no-show path: links closed and the cancellation policy applied. */
  markNoShow: (id: string) => Promise<unknown>
}

/** The night audit: the checklist before the close, the close itself and the history, by business date. */
export function createNightAudit({ ports, today, allow, access, world, markNoShow }: Deps) {
  /** What still needs the desk before the day closes, each item linked to where it is handled. */
  async function checks(date: IsoDate): Promise<AuditCheck[]> {
    const [w, links, orders, accounts, counts] = await Promise.all([world(), ports.payment.links(), ports.orders.orders(), ports.finance.accounts(), ports.finance.reconciliations()])
    const stay = (b: BookingView) => ({ label: `${b.code} · ${b.guestName} · ${b.unitCode}`, to: `/bookings/${b.id}` })
    const code = (id: string) => w.views.find((b) => b.id === id)?.code ?? ''
    const items: Record<AuditCheckKey, AuditCheck['items']> = {
      arrivals: w.views.filter((b) => b.status === 'confirmed' && b.checkIn <= date).map(stay),
      departures: w.views.filter((b) => b.status === 'checked_in' && b.checkOut <= date).map(stay),
      links: links.filter((l) => l.status === 'pending' && w.bookings.some((b) => b.id === l.bookingId)).map((l) => ({ label: `${code(l.bookingId)} · ${l.method.replace('_', ' ')} link for Rp ${l.amount.toLocaleString('id-ID')}`, to: `/bookings/${l.bookingId}` })),
      orders: orders.filter((o) => isOpenOrder(o) && o.requestedOn <= date && w.bookings.some((b) => b.id === o.bookingId)).map((o) => ({ label: `${o.number} for ${code(o.bookingId)}, ${o.status}`, to: `/services/orders/${o.id}` })),
      unassigned: unassigned(w.views).filter((b) => b.status === 'confirmed' && b.checkIn <= addDays(date, 1)).map(stay),
      cashCount: accounts.filter((a) => a.kind === 'cashbox' && !counts.some((r) => r.accountId === a.id && r.date === date)).map((a) => ({ label: a.name, to: `/finance/accounts/${a.id}` })),
    }
    return AUDIT_CHECKS.map((key) => ({ key, label: AUDIT_CHECK_LABEL[key], hint: AUDIT_CHECK_HINT[key], items: items[key] }))
  }

  return {
    /** The business date, apart from the calendar date, for the header and the phone. */
    businessDate: () => ports.audit.businessDate(),

    /** The checklist for the open business date, what the audit will post, and every audit run, newest first. */
    async overview() {
      await allow('booking', 'view')
      const [a, date, audits, w] = await Promise.all([access(), ports.audit.businessDate(), ports.audit.audits(), world()])
      const tonight = w.views.flatMap((b) => {
        const nights = nightsToPost(b, date)
        return nights.length ? [{ booking: b, nights: nights.length, amount: nightsAmount(b, nights) }] : []
      })
      return {
        businessDate: date,
        today: today(),
        checks: await checks(date),
        tonight,
        audits: [...audits].reverse(),
        problem: auditProblem(date, date, today(), audits),
        canRun: a.can('booking', 'post'),
      }
    },

    /**
     * Closes the business date: arrivals that never came go through the no-show path, then the port
     * posts the night to every stay in house and rolls the date. A rerun of a closed date is refused
     * before anything changes.
     */
    async run() {
      await allow('booking', 'post')
      const [date, audits] = await Promise.all([ports.audit.businessDate(), ports.audit.audits()])
      const problem = auditProblem(date, date, today(), audits)
      if (problem) throw new RuleError(problem.code, problem.message)
      const list = await checks(date)
      const arrivals = (await world()).views.filter((b) => b.status === 'confirmed' && b.checkIn <= date)
      for (const b of arrivals) await markNoShow(b.id)
      const counts = Object.fromEntries(list.map((c) => [c.key, c.items.length])) as Record<AuditCheckKey, number>
      return ports.audit.run({ date, checks: counts, noShows: arrivals.map((b) => b.code) })
    },
  }
}

export type NightAuditServices = ReturnType<typeof createNightAudit>

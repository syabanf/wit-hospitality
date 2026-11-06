import type { Booking } from '@/domain/booking'
import { invoiceFigures, invoiceNumber, oldestFirst, transferParts, type BillingInstruction, type CityLedgerAccount, type CityLedgerInvoice, type CityLedgerInvoiceLine, type CityLedgerPayment } from '@/domain/cityLedger'
import { guestFolio, type FolioPosting } from '@/domain/folio'
import type { Transaction } from '@/domain/finance'
import type { Payment } from '@/domain/payment'
import type { Catalog } from '@/domain/property'
import type { ServiceOrder } from '@/domain/serviceOrder'
import type { TaxSettings } from '@/domain/tax'
import { CITY_LEDGER_CODE } from '@/domain/transactionCode'
import { addDays, type IsoDate } from '@/lib/dates'

type AccountSeed = Omit<CityLedgerAccount, 'createdOn'> & { instruction: BillingInstruction; createdDaysAgo: number }

/** Two Bali companies and two travel agents; Jaya Wisata sits close to its credit limit, set in the seed below. */
export const CITY_LEDGER_ACCOUNTS: readonly AccountSeed[] = [
  { id: 'cl-nusa', code: 'CL-001', name: 'PT Nusa Retreats Indonesia', kind: 'company', contact: 'Made Sudarsana', billingEmail: 'finance@nusaretreats.co.id', phone: '+62 361 473 120', address: 'Jl. Raya Ubud 88, Ubud, Gianyar, Bali 80571', npwp: '02.418.773.5-906.000', creditLimit: 250_000_000, termsDays: 30, commissionPct: 0, active: true, villaIds: [], instruction: 'all', createdDaysAgo: 400 },
  { id: 'cl-consulate', code: 'CL-002', name: 'Consulate Liaison Office Bali', kind: 'company', contact: 'Anna Lindqvist', billingEmail: 'admin@consulate-liaison.example', phone: '+62 361 288 045', address: 'Jl. Raya Puputan 40, Renon, Denpasar, Bali 80235', npwp: '', creditLimit: 120_000_000, termsDays: 14, commissionPct: 0, active: true, villaIds: [], instruction: 'room', createdDaysAgo: 380 },
  { id: 'cl-southern', code: 'CL-003', name: 'Southern Cross Island Holidays Pty Ltd', kind: 'travel_agent', contact: 'Liam Turner', billingEmail: 'accounts@southerncrossholidays.example', phone: '+61 2 9011 4420', address: 'Level 4, 120 Pitt Street, Sydney NSW 2000, Australia', npwp: '', creditLimit: 300_000_000, termsDays: 45, commissionPct: 15, active: true, villaIds: [], instruction: 'room_breakfast', createdDaysAgo: 360 },
  { id: 'cl-jaya', code: 'CL-004', name: 'PT Jaya Wisata Nusantara', kind: 'travel_agent', contact: 'Rina Hartono', billingEmail: 'billing@jayawisata.example', phone: '+62 21 5790 3344', address: 'Jl. Jend. Sudirman Kav. 52, Jakarta Selatan 12190', npwp: '01.902.554.1-012.000', creditLimit: 60_000_000, termsDays: 21, commissionPct: 10, active: true, villaIds: [], instruction: 'room_breakfast', createdDaysAgo: 200 },
]

/**
 * Which checked-out stays each account took, by check-out day: the Consulate's oldest stays went on
 * an invoice now past 45 days overdue, Nusa's and Southern Cross's on last month's run (Nusa paid it,
 * Southern Cross paid half), and every account has recent stays waiting for the next run.
 */
const PLAN: ReadonlyArray<{ accountId: string; from: number; to: number; take: number; invoice?: { issued: number; paid?: { on: number; share: number } } }> = [
  { accountId: 'cl-consulate', from: -78, to: -63, take: 2, invoice: { issued: -62 } },
  { accountId: 'cl-nusa', from: -61, to: -37, take: 3, invoice: { issued: -35, paid: { on: -9, share: 1 } } },
  { accountId: 'cl-southern', from: -61, to: -37, take: 3, invoice: { issued: -35, paid: { on: -6, share: 0.5 } } },
  { accountId: 'cl-jaya', from: -34, to: -1, take: 3 },
  { accountId: 'cl-nusa', from: -34, to: -1, take: 1 },
  { accountId: 'cl-consulate', from: -34, to: -1, take: 1 },
]

interface Deps {
  today: IsoDate
  catalog: Catalog
  bookings: Booking[]
  payments: Payment[]
  orders: readonly ServiceOrder[]
  folioPostings: FolioPosting[]
  tax: TaxSettings
  guestName: (guestId: string) => string
  signer: { desk: string; deskId: string; finance: string }
  entry: (fields: Pick<Transaction, 'accountId' | 'kind' | 'categoryId' | 'amount' | 'date' | 'locationId' | 'villaId' | 'unitId' | 'bookingId' | 'description' | 'reference' | 'origin'>, posted: boolean) => Transaction
}

/**
 * Stays billed to the city ledger over the last two months. The guest paid nothing at the desk, so
 * their seeded payments go and the folio's room moves to the account at check-out; invoices, the
 * agent commission and the payments follow.
 */
export function seedCityLedger(d: Deps) {
  const day = (offset: number) => addDays(d.today, offset)
  const accounts: CityLedgerAccount[] = CITY_LEDGER_ACCOUNTS.map(({ instruction: _instruction, createdDaysAgo, ...a }) => ({ ...a, villaIds: [...a.villaIds], createdOn: day(-createdDaysAgo) }))
  const taken = new Set<string>()
  // Direct stays of their own, gone, with no room service to settle apart.
  const candidates = d.bookings
    .filter((b) => b.source === 'direct' && b.status === 'checked_out' && b.checkedOutOn && !b.bookingGroupId && !d.orders.some((o) => o.bookingId === b.id))
    .sort((a, b) => (a.checkedOutOn ?? '').localeCompare(b.checkedOutOn ?? '') || a.code.localeCompare(b.code))
  const invoices: CityLedgerInvoice[] = []
  const payments: CityLedgerPayment[] = []
  let posting = 0

  for (const plan of PLAN) {
    const seed = CITY_LEDGER_ACCOUNTS.find((a) => a.id === plan.accountId)
    const account = accounts.find((a) => a.id === plan.accountId)
    if (!seed || !account) continue
    // Spread over the window rather than the first few days of it.
    const pool = candidates.filter((b) => !taken.has(b.id) && (b.checkedOutOn ?? '') >= day(plan.from) && (b.checkedOutOn ?? '') <= day(plan.to))
    const stays = [...new Set(Array.from({ length: Math.min(plan.take, pool.length) }, (_, i) => pool[Math.floor((i * pool.length) / plan.take)]))].filter((b): b is Booking => b !== undefined)
    const transfers = stays.flatMap((b) => {
      taken.add(b.id)
      b.cityLedger = { accountId: account.id, instruction: seed.instruction, override: null }
      // The company paid instead of the guest.
      for (let i = d.payments.length - 1; i >= 0; i--) if (d.payments[i]?.bookingId === b.id) d.payments.splice(i, 1)
      const on = b.checkedOutOn ?? b.checkOut
      const f = guestFolio({ booking: b, payments: d.payments, orders: d.orders, postings: d.folioPostings, tax: d.tax })
      return transferParts(f, d.orders, seed.instruction).map((part) => {
        posting += 1
        const p: FolioPosting = { id: `fp-cl-${posting}`, bookingId: b.id, kind: 'transfer', code: CITY_LEDGER_CODE, description: `Transfer to city ledger ${account.code} ${account.name}`, amount: part.amount, date: on, part: part.part, lineId: null, orderId: part.orderId, postedBy: d.signer.desk, postedById: d.signer.deskId, postedAt: `${on}T10:55:00`, approvedBy: null, transactionId: null, cityLedger: { accountId: account.id, instruction: seed.instruction, service: part.service, pb1: part.pb1 } }
        d.folioPostings.push(p)
        return p
      })
    })
    if (!plan.invoice || transfers.length === 0) continue
    const issuedOn = day(plan.invoice.issued)
    const lines: CityLedgerInvoiceLine[] = stays.map((b) => {
      const mine = transfers.filter((p) => p.bookingId === b.id)
      return { postingIds: mine.map((p) => p.id), bookingId: b.id, code: b.code, guest: d.guestName(b.guestId), villa: d.catalog.place(b.unitId).villa.name, checkIn: b.checkIn, checkOut: b.checkOut, covers: seed.instruction, gross: mine.reduce((s, p) => s + p.amount, 0), service: mine.reduce((s, p) => s + (p.cityLedger?.service ?? 0), 0), pb1: mine.reduce((s, p) => s + (p.cityLedger?.pb1 ?? 0), 0) }
    })
    const inv: CityLedgerInvoice = { id: `cli-${invoices.length + 1}`, number: invoiceNumber(issuedOn, invoices), accountId: account.id, issuedOn, dueOn: addDays(issuedOn, account.termsDays), lines, ...invoiceFigures(lines, account.commissionPct), messageId: null, sentAt: `${issuedOn}T09:00:00`, journalId: null, issuedBy: d.signer.finance }
    invoices.push(inv)
    const paid = plan.invoice.paid
    if (!paid) continue
    const amount = Math.round((inv.net * paid.share) / 1000) * 1000
    const date = day(paid.on)
    const reference = `TRF-${inv.number}`
    const t = d.entry({ accountId: 'bank-bca', kind: 'cash_in', categoryId: 'cat-city-ledger', amount, date, locationId: 'loc-canggu', villaId: null, unitId: null, bookingId: null, description: `City ledger payment from ${account.name}`, reference, origin: 'payment' }, true)
    payments.push({ id: `clp-${payments.length + 1}`, number: `CLP-${String(payments.length + 1).padStart(4, '0')}`, accountId: account.id, date, method: 'bank_transfer', amount, reference, note: '', allocations: oldestFirst(amount, [{ invoiceId: inv.id, open: inv.net }]), transactionId: t.id, createdBy: d.signer.finance })
  }

  // Jaya Wisata has used about 92% of its line: what it owes now sets the limit.
  const jaya = accounts.find((a) => a.id === 'cl-jaya')
  const owed = d.folioPostings.filter((p) => p.cityLedger?.accountId === 'cl-jaya').reduce((s, p) => s + p.amount, 0)
  if (jaya && owed > 0) jaya.creditLimit = Math.ceil(owed / 0.92 / 1_000_000) * 1_000_000
  return { accounts, invoices, payments }
}

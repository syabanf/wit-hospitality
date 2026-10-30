import { depositAmount } from '@/domain/payment'
import { addDays, type IsoDate } from '@/lib/dates'
import type { Services } from './services'

/**
 * Guided walk-throughs for the demo: each step calls the real use cases as the person who
 * would do it in the villa, so every rupiah lands in the books the way it would in production.
 * Runs on demo data only; the page restores the snapshot taken before the first step.
 */

export interface SimLink {
  label: string
  to: string
}

export interface StepResult {
  lines: readonly string[]
  links: readonly SimLink[]
}

export interface SimStep {
  id: string
  title: string
  /** The demo login that performs the step; null for the payment gateway. */
  actor: string | null
  actorLabel: string
  run: (s: Services, ctx: SimContext) => Promise<StepResult>
}

export interface TrailEntry {
  step: string
  transactionId: string
}

/** What the steps share: ids they create, the money trail and the balances taken first. */
export interface SimContext {
  ids: Record<string, string>
  numbers: Record<string, number>
  trail: TrailEntry[]
  balancesBefore: Record<string, number>
}

export interface TrailRow {
  step: string
  number: string
  transactionId: string
  account: string
  amount: number
  status: string
}

export interface BalanceRow {
  accountId: string
  account: string
  before: number
  after: number
}

export interface SimSummary {
  trail: readonly TrailRow[]
  balances: readonly BalanceRow[]
  facts: ReadonlyArray<readonly [string, string]>
  links: readonly SimLink[]
}

export interface Scenario {
  id: 'booking' | 'repair'
  title: string
  blurb: string
  steps: readonly SimStep[]
  summary: (s: Services, ctx: SimContext) => Promise<SimSummary>
}

export const emptyContext = (): SimContext => ({ ids: {}, numbers: {}, trail: [], balancesBefore: {} })

const PASSWORD = 'villa123'
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`

/** Signs in as the step's person; the gateway step runs with no session at all. */
export async function actAs(s: Services, actor: string | null) {
  if (actor === null) {
    await s.access.logout()
    return
  }
  await s.access.login({ email: `${actor}@balivillas.id`, password: PASSWORD })
}

async function balances(s: Services) {
  const o = await s.finance.overview()
  return Object.fromEntries(o.accounts.map((a) => [a.account.id, a.balance]))
}

/** An active unit with nothing on it for these nights. */
async function freeUnit(s: Services, from: IsoDate, to: IsoDate, prefer?: (code: string) => boolean) {
  const opts = await s.booking.formOptions()
  const units = opts.catalog.units.filter((u) => u.status === 'active')
  const ordered = prefer ? [...units.filter((u) => prefer(u.code)), ...units.filter((u) => !prefer(u.code))] : units
  for (const u of ordered) {
    const a = await s.booking.availability(u.id, from, to)
    if (a.conflicts.length === 0) return u
  }
  throw new Error('No unit is free for the simulation dates.')
}

async function txLine(s: Services, id: string) {
  const t = (await s.finance.transaction(id)).transaction
  return `${t.number} ${t.kind === 'cash_in' ? 'cash-in' : 'cash-out'} ${rp(t.amount)} on ${t.accountName}: ${t.status}`
}

async function trailRows(s: Services, ctx: SimContext): Promise<TrailRow[]> {
  const rows: TrailRow[] = []
  for (const e of ctx.trail) {
    const t = (await s.finance.transaction(e.transactionId)).transaction
    rows.push({ step: e.step, number: t.number, transactionId: t.id, account: t.accountName, amount: t.kind === 'cash_in' ? t.amount : -t.amount, status: t.status })
  }
  return rows
}

async function balanceRows(s: Services, ctx: SimContext, accountIds: readonly string[]): Promise<BalanceRow[]> {
  const o = await s.finance.overview()
  return accountIds.map((id) => {
    const a = o.accounts.find((x) => x.account.id === id)
    return { accountId: id, account: a?.account.name ?? id, before: ctx.balancesBefore[id] ?? 0, after: a?.balance ?? 0 }
  })
}

/** Signs every level still open on an entry, as the people the chain names, then posts it as finance. */
async function approveAndPost(s: Services, transactionId: string, signers: Record<string, string>) {
  const signed: string[] = []
  for (let guard = 0; guard < 4; guard++) {
    await actAs(s, 'rama')
    const t = (await s.finance.transaction(transactionId)).transaction
    if (t.status !== 'submitted' || !t.nextApprover) break
    const who = signers[t.nextApprover] ?? 'rama'
    await actAs(s, who)
    await s.finance.transition(transactionId, 'approved', 'Simulation')
    signed.push(`${who} signed as ${t.nextApprover}`)
  }
  await actAs(s, 'ida')
  await s.finance.transition(transactionId, 'posted')
  return signed
}

const bookingScenario: Scenario = {
  id: 'booking',
  title: 'Booking to revenue',
  blurb: 'A direct booking with a QRIS deposit: the guest pays on the gateway, finance approves and posts, and the money shows in the bank and the villa P&L.',
  steps: [
    {
      id: 'before',
      title: 'Read the balances before',
      actor: 'rama',
      actorLabel: 'Rama Wijaya, owner',
      async run(s, ctx) {
        ctx.balancesBefore = await balances(s)
        return { lines: [`Bank ${rp(ctx.balancesBefore['bank-bca'] ?? 0)}`, `${Object.keys(ctx.balancesBefore).length} accounts read`], links: [{ label: 'Cashbox', to: '/finance' }] }
      },
    },
    {
      id: 'book',
      title: 'Book a direct stay next week with a QRIS deposit',
      actor: 'kadek',
      actorLabel: 'Kadek Ariani, villa manager',
      async run(s, ctx) {
        const today = s.clock.today()
        const from = addDays(today, 7)
        const to = addDays(today, 10)
        const unit = await freeUnit(s, from, to, (code) => code.startsWith('TR') || code.startsWith('LB'))
        const rate = Math.round((unit.nightlyRate * 0.9) / 10_000) * 10_000
        const policy = await s.payments.policy()
        const deposit = depositAmount(rate * 3, policy)
        const b = await s.booking.create({ guestId: 'g-14', newGuest: null, unitId: unit.id, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: from, checkOut: to, nightlyRate: rate, notes: 'Created by the finance simulation', confirm: true, payment: { kind: 'deposit', method: 'qris', amount: deposit, reference: '' } })
        const link = (await s.payments.invoice(b.id)).links.find((l) => l.status === 'pending')
        if (!link) throw new Error('The booking has no payment link.')
        ctx.ids.booking = b.id
        ctx.ids.token = link.token
        ctx.ids.unit = unit.id
        ctx.ids.villa = b.place.villa.id
        ctx.ids.from = from
        ctx.ids.to = to
        ctx.numbers.deposit = deposit
        return { lines: [`${b.code} for ${b.guestName} in ${b.unitCode}, ${b.nights} nights, ${rp(b.total)}`, `QRIS link for the ${policy.depositPct}% deposit: ${rp(deposit)}`], links: [{ label: b.code, to: `/bookings/${b.id}` }, { label: 'Guest payment page', to: `/pay/${link.token}` }] }
      },
    },
    {
      id: 'pay',
      title: 'Guest pays on the gateway',
      actor: null,
      actorLabel: 'Payment gateway, no sign-in',
      async run(s, ctx) {
        const done = await s.payments.settle(ctx.ids.token ?? '', 'paid')
        await actAs(s, 'rama')
        const inv = await s.payments.invoice(ctx.ids.booking ?? '')
        const p = inv.payments.find((x) => x.status === 'paid' && x.method === 'qris')
        if (!p?.transactionId) throw new Error('The payment did not reach the ledger.')
        ctx.ids.cashIn = p.transactionId
        ctx.trail.push({ step: 'Guest deposit', transactionId: p.transactionId })
        if (p.feeTransactionId) {
          ctx.ids.fee = p.feeTransactionId
          ctx.trail.push({ step: 'QRIS fee', transactionId: p.feeTransactionId })
        }
        return { lines: [`${done.paymentNumber} paid ${rp(done.link.amount)}`, await txLine(s, p.transactionId), ...(p.feeTransactionId ? [await txLine(s, p.feeTransactionId)] : [])], links: [{ label: 'Cash-in entry', to: `/finance/transactions/${p.transactionId}` }] }
      },
    },
    {
      id: 'approve',
      title: 'Approve and post the deposit and the fee',
      actor: 'ida',
      actorLabel: 'Kadek signs, Ida posts',
      async run(s, ctx) {
        const lines: string[] = []
        for (const id of [ctx.ids.cashIn, ctx.ids.fee].filter((x): x is string => Boolean(x))) {
          const signed = await approveAndPost(s, id, { manager: 'kadek', finance: 'ida', owner: 'rama' })
          lines.push(`${signed.join(', ')}; ${await txLine(s, id)}`)
        }
        return { lines, links: [{ label: 'Approvals', to: '/approvals' }] }
      },
    },
  ],
  async summary(s, ctx) {
    await actAs(s, 'rama')
    const inv = await s.payments.invoice(ctx.ids.booking ?? '')
    const box = (await s.finance.overview()).accounts.find((a) => a.account.kind === 'cashbox' && a.account.locationId === inv.booking.place.location.id)
    const today = s.clock.today()
    const income = await s.reports.run('income', { from: today, to: today, villaId: ctx.ids.villa })
    const pnl = await s.reports.run('pnl-villa', { from: ctx.ids.from ?? today, to: addDays(ctx.ids.to ?? today, -1), villaId: ctx.ids.villa })
    const room = income.rows.find((r) => r.category === 'Room revenue')
    return {
      trail: await trailRows(s, ctx),
      balances: await balanceRows(s, ctx, ['bank-bca', ...(box ? [box.account.id] : [])]),
      facts: [
        ['Invoice', `${rp(inv.expected)} total, ${rp(inv.paid)} paid, ${rp(inv.outstanding)} outstanding by ${inv.dueOn}`],
        ['Room revenue received today', rp(Number(room?.amount ?? 0))],
        ['Villa P&L, stay nights', `revenue ${rp(Number(pnl.rows[0]?.revenue ?? 0))}, profit ${rp(Number(pnl.rows[0]?.profit ?? 0))}`],
      ],
      links: [
        { label: 'Booking', to: `/bookings/${ctx.ids.booking}` },
        { label: 'Invoice', to: `/bookings/${ctx.ids.booking}/invoice` },
        { label: 'Income report', to: `/reports/income?from=${today}&to=${today}` },
        { label: 'Villa P&L', to: `/reports/pnl-villa?villa=${ctx.ids.villa}` },
      ],
    }
  },
}

const repairScenario: Scenario = {
  id: 'repair',
  title: 'Repair to expense',
  blurb: 'An AC that stops cooling: the job blocks the unit, parts are paid in cash and the vendor by bank, both climb the approval chain, post, and land in the expense report and the villa P&L.',
  steps: [
    {
      id: 'before',
      title: 'Read the balances before',
      actor: 'rama',
      actorLabel: 'Rama Wijaya, owner',
      async run(s, ctx) {
        ctx.balancesBefore = await balances(s)
        return { lines: [`Bank ${rp(ctx.balancesBefore['bank-bca'] ?? 0)}`], links: [{ label: 'Cashbox', to: '/finance' }] }
      },
    },
    {
      id: 'report',
      title: 'Report an urgent job: AC not cooling',
      actor: 'kadek',
      actorLabel: 'Kadek Ariani, villa manager',
      async run(s, ctx) {
        const today = s.clock.today()
        const unit = await freeUnit(s, addDays(today, 1), addDays(today, 3), (code) => code.startsWith('LB') || code.startsWith('TR'))
        const opts = await s.maintenance.formOptions()
        const villaId = opts.catalog.unit(unit.id).villaId
        const asset = opts.assets.find((a) => a.unitId === unit.id && a.category === 'ac')
        const wo = await s.maintenance.createWorkOrder({ villaId, unitId: unit.id, assetId: asset?.id ?? null, category: 'ac', priority: 'urgent', title: `AC not cooling in ${unit.code}`, description: 'Room stays at 28 degrees with the AC on full. Compressor clicks and stops.', assigneeId: null, vendorId: 'ven-cooldown', scheduledOn: null, parts: [{ name: 'Run capacitor', qty: 1, unitCost: 350_000 }, { name: 'Refrigerant R32, 1 kg', qty: 1, unitCost: 300_000 }], labourCost: 0, vendorCost: 7_800_000, beforePhotos: ['ac-thermometer.jpg'], afterPhotos: [] })
        ctx.ids.workOrder = wo.id
        ctx.ids.unit = unit.id
        ctx.ids.villa = villaId
        return { lines: [`${wo.number} in ${wo.unitCode}, ${wo.villaName}, urgent`, `Estimate ${rp(wo.total)}`], links: [{ label: wo.number, to: `/maintenance/work-orders/${wo.id}` }] }
      },
    },
    {
      id: 'block',
      title: 'Block the unit and start the work',
      actor: 'kadek',
      actorLabel: 'Kadek Ariani, villa manager',
      async run(s, ctx) {
        const today = s.clock.today()
        await s.maintenance.setBlock(ctx.ids.workOrder ?? '', addDays(today, 1), addDays(today, 3))
        const wo = await s.maintenance.transition(ctx.ids.workOrder ?? '', 'in_progress')
        return { lines: [`${wo.unitCode} blocked for 2 nights from tomorrow`, `${wo.number} is in progress`], links: [{ label: 'Calendar', to: '/calendar' }] }
      },
    },
    {
      id: 'expenses',
      title: 'Pay the parts in cash and the vendor by bank',
      actor: 'kadek',
      actorLabel: 'Kadek Ariani, villa manager',
      async run(s, ctx) {
        const today = s.clock.today()
        const id = ctx.ids.workOrder ?? ''
        await s.maintenance.addExpense(id, { kind: 'parts', description: 'Run capacitor and 1 kg R32', payee: 'Toko Listrik Jaya', vendorId: null, amount: 650_000, method: 'cash', reference: 'NOTA-2210', receipts: ['nota-2210.jpg'], paidOn: today })
        const wo = await s.maintenance.addExpense(id, { kind: 'vendor', description: 'Compressor diagnosis and repair', payee: '', vendorId: 'ven-cooldown', amount: 7_800_000, method: 'bank_transfer', reference: 'INV/CD/2210', receipts: ['inv-cd-2210.pdf'], paidOn: today })
        const [parts, vendor] = wo.expenses.slice(-2)
        if (!parts || !vendor) throw new Error('The expenses did not save.')
        ctx.ids.partsTx = parts.transactionId
        ctx.ids.vendorTx = vendor.transactionId
        ctx.trail.push({ step: 'Parts, cash', transactionId: parts.transactionId }, { step: 'Vendor invoice, bank', transactionId: vendor.transactionId })
        return { lines: [await txLine(s, parts.transactionId), await txLine(s, vendor.transactionId)], links: [{ label: wo.number, to: `/maintenance/work-orders/${wo.id}` }] }
      },
    },
    {
      id: 'approve',
      title: 'Approve through the chain and post',
      actor: 'ida',
      actorLabel: 'Rama signs for the manager, Ida signs and posts',
      async run(s, ctx) {
        const lines: string[] = []
        for (const id of [ctx.ids.partsTx, ctx.ids.vendorTx].filter((x): x is string => Boolean(x))) {
          // Kadek recorded both, so the owner signs the manager level; finance signs its own.
          const signed = await approveAndPost(s, id, { manager: 'rama', finance: 'ida', owner: 'rama' })
          lines.push(`${signed.join(', ')}; ${await txLine(s, id)}`)
        }
        return { lines, links: [{ label: 'Approvals', to: '/approvals' }] }
      },
    },
    {
      id: 'close',
      title: 'Finish, verify and release the unit',
      actor: 'kadek',
      actorLabel: 'Kadek Ariani, villa manager',
      async run(s, ctx) {
        const id = ctx.ids.workOrder ?? ''
        await s.maintenance.transition(id, 'done')
        await s.maintenance.transition(id, 'verified')
        await s.maintenance.setBlock(id, null, null)
        const wo = (await s.maintenance.workOrder(id)).workOrder
        return { lines: [`${wo.number} verified, block released`, `Posted ${rp(wo.spent.posted)} against an estimate of ${rp(wo.total)}`], links: [{ label: wo.number, to: `/maintenance/work-orders/${wo.id}` }] }
      },
    },
  ],
  async summary(s, ctx) {
    await actAs(s, 'rama')
    const today = s.clock.today()
    const villa = ctx.ids.villa
    const expense = await s.reports.run('expense', { from: today, to: today, villaId: villa })
    const pnl = await s.reports.run('pnl-villa', { from: today, to: today, villaId: villa })
    const cost = await s.reports.run('maint-cost', { from: today, to: today, villaId: villa })
    const wo = (await s.maintenance.workOrder(ctx.ids.workOrder ?? '')).workOrder
    const box = (await s.finance.overview()).accounts.find((a) => a.account.kind === 'cashbox' && a.account.locationId === wo.locationId)
    const unitCode = wo.unitCode
    return {
      trail: await trailRows(s, ctx),
      balances: await balanceRows(s, ctx, ['bank-bca', ...(box ? [box.account.id] : [])]),
      facts: [
        ['Maintenance expense today', rp(Number(expense.rows.find((r) => r.category === 'Maintenance')?.amount ?? 0))],
        ['Villa P&L expenses today', rp(Math.abs(Number(pnl.rows[0]?.expenses ?? 0)))],
        ['Maintenance cost report', `${unitCode}: ${rp(Number(cost.rows.find((r) => r.unit === unitCode)?.total ?? 0))} posted`],
      ],
      links: [
        { label: 'Work order', to: `/maintenance/work-orders/${ctx.ids.workOrder}` },
        { label: 'Expense report', to: `/reports/expense?from=${today}&to=${today}` },
        { label: 'Villa P&L', to: `/reports/pnl-villa?villa=${villa}&from=${today}&to=${today}` },
        { label: 'Maintenance cost', to: `/reports/maint-cost?from=${today}&to=${today}` },
      ],
    }
  },
}

export const SCENARIOS: readonly Scenario[] = [bookingScenario, repairScenario]

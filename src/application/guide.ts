import { DEFAULT_PERMISSIONS, ROLES, can, type Action, type AuditAction, type Module, type Role } from '@/domain/access'
import { BOOKING_STATUS_LABEL, TRANSITIONS as BOOKING_TRANSITIONS } from '@/domain/booking'
import { TRANSACTION_STATUS_LABEL, TRANSACTION_TRANSITIONS, type TransactionKind, type TransactionOrigin } from '@/domain/finance'
import { REQUEST_STATUS_LABEL, REQUEST_TRANSITIONS } from '@/domain/hr'
import { HOUSEKEEPING_LABEL, HOUSEKEEPING_TRANSITIONS, WORK_ORDER_STATUS_LABEL, WORK_ORDER_TRANSITIONS } from '@/domain/maintenance'
import { PAYMENT_STATUS_LABEL, type PaymentStatus } from '@/domain/payment'
import { PAYROLL_STATUS_LABEL, PAYROLL_TRANSITIONS } from '@/domain/payroll'
import { ORDER_STATUS_LABEL, ORDER_TRANSITIONS } from '@/domain/serviceOrder'
import { REPORTS, REPORT_GROUP_LABEL, REPORT_GROUPS } from './reports'

/** Who takes a step: a role, the guest on the checkout page, or the console on its own. */
export type GuideActor = Role | 'guest' | 'system'
export const ACTOR_LABEL: Record<Exclude<GuideActor, Role>, string> = { guest: 'Guest', system: 'Console' }

export interface GuideFeature {
  title: string
  does: string
  /** The permission it needs in the entry's module; the roles shown come from the live matrix. */
  action: Action
  /** Rules the console enforces, in plain words. */
  rules?: readonly string[]
  to: string
  /** Set while the feature is still being built. */
  building?: true
}

export interface GuideBranch {
  label: string
  detail: string
  tone: 'danger' | 'warning' | 'info'
  to?: string
}

export interface LedgerEffect {
  kind: TransactionKind
  account: string
  /** Category id with its name, checked against the seed. */
  categoryId: string
  category: string
  origin: TransactionOrigin
  status: string
}

/** What a step does under the hood. */
export interface StepSystem {
  /** `group.method` on the services object. */
  useCase: string
  records?: ReadonlyArray<{ record: string; change: string }>
  ledger?: readonly LedgerEffect[]
  approval?: string
  audit?: { action: AuditAction; entity: string }
  refusals?: ReadonlyArray<{ code: string; when: string }>
  reports?: readonly string[]
  tiles?: readonly string[]
}

export interface GuideStep {
  title: string
  actor: GuideActor
  detail: string
  to?: string
  branches?: readonly GuideBranch[]
  system?: StepSystem
}

export interface GuideFlow {
  id: string
  title: string
  summary: string
  steps: readonly GuideStep[]
}

export interface GuideEntry {
  slug: string
  title: string
  /** The permission module behind the entry. */
  module: Module
  purpose: string
  to: string
  features: readonly GuideFeature[]
  flows: readonly string[]
}

const FORBIDDEN = { code: 'FORBIDDEN', when: 'the role lacks the permission, or the villa is outside the person’s scope' }
const SELF = { code: 'APPROVAL_SELF', when: 'the author tries to sign their own entry, or signs twice' }
const ROLE_LEVEL = { code: 'APPROVAL_ROLE', when: 'the next level needs another role' }
const STD_APPROVAL = 'Standard entries: villa manager. Expenses from Rp 5 jt: villa manager then Finance. From Rp 25 jt: villa manager, Finance, Owner. Villa Karang expenses from Rp 1 jt: villa manager then Finance.'
const ROOM_IN = (account: string, origin: TransactionOrigin): LedgerEffect => ({ kind: 'cash_in', account, categoryId: 'cat-room', category: 'Room revenue', origin, status: 'Submitted' })
const FEE_OUT: LedgerEffect = { kind: 'cash_out', account: 'Bank', categoryId: 'cat-fees', category: 'Payment fees', origin: 'payment', status: 'Submitted' }

const BOOKING_FLOW: GuideFlow = {
  id: 'booking-payment',
  title: 'Booking to posted income',
  summary: 'A direct booking takes a deposit, the guest pays, and the money reaches the books once Finance posts it.',
  steps: [
    {
      title: 'Create the booking',
      actor: 'reservation',
      detail: 'Pick dates and a unit from live availability; the console refuses overlapping nights.',
      to: '/bookings/new',
      system: {
        useCase: 'booking.create',
        records: [{ record: 'Booking', change: 'new, Confirmed, payment Unpaid' }],
        audit: { action: 'create', entity: 'booking' },
        refusals: [{ code: 'BOOKING_OVERLAP', when: 'another stay or block holds one of the nights' }, { code: 'UNIT_UNAVAILABLE', when: 'the unit is inactive' }, FORBIDDEN],
        reports: ['bookings', 'occupancy'],
        tiles: ['Occupancy', 'Arrivals today'],
      },
    },
    {
      title: 'Take the deposit',
      actor: 'reservation',
      detail: 'Choose later, deposit at the policy percent or full. Cash and transfer are recorded at once; QRIS, VA and card create a payment link.',
      to: '/bookings/new',
      system: {
        useCase: 'payments.createLink',
        records: [{ record: 'Payment', change: 'new, Pending' }, { record: 'Payment link', change: 'new, Pending with an expiry' }],
        audit: { action: 'create', entity: 'payment' },
        refusals: [{ code: 'PAYMENT_OVERPAID', when: 'the amount is more than the balance due' }, { code: 'VALIDATION_ERROR', when: 'cash or transfer is sent through a link' }],
        reports: ['receivables-aging'],
      },
    },
    {
      title: 'Guest pays the link',
      actor: 'guest',
      detail: 'The guest opens the checkout, pays and gets a receipt; no sign-in.',
      to: '/pay/demo-qris',
      branches: [
        { label: 'Payment failed', detail: 'The link closes as failed; the desk sends a new one from the booking.', tone: 'danger', to: '/pay/demo-failed' },
        { label: 'Link expired', detail: 'The desk sends a new link from the booking.', tone: 'warning', to: '/pay/demo-expired' },
      ],
      system: {
        useCase: 'payments.settle',
        records: [{ record: 'Payment', change: 'Pending to Paid' }, { record: 'Booking', change: 'payment Unpaid to Partly paid or Paid' }],
        ledger: [ROOM_IN('Bank', 'payment'), FEE_OUT],
        audit: { action: 'status', entity: 'payment' },
        refusals: [{ code: 'PAYMENT_INVALID_STATE', when: 'the link already paid, failed, expired or was cancelled' }, { code: 'PAYMENT_OVERPAID', when: 'the booking is already paid' }],
        reports: ['payments-collected', 'receivables-aging'],
      },
    },
    {
      title: 'Cash-in lands for approval',
      actor: 'system',
      detail: 'Each payment creates a submitted cash-in in the right account and category, plus a cash-out for the gateway fee.',
      to: '/finance/cash-in',
      system: { useCase: 'finance.inbox', records: [{ record: 'Transaction', change: 'new, Submitted' }], approval: STD_APPROVAL, tiles: ['Approvals waiting'] },
    },
    {
      title: 'Approve',
      actor: 'manager',
      detail: 'The approval rule for the amount decides how many signatures it needs.',
      to: '/approvals',
      branches: [{ label: 'Rejected', detail: 'The author corrects the entry and submits it again.', tone: 'danger', to: '/approvals' }],
      system: {
        useCase: 'finance.transition',
        records: [{ record: 'Transaction', change: 'Submitted to Approved once every level signed, or Rejected' }],
        approval: STD_APPROVAL,
        audit: { action: 'approve', entity: 'transaction' },
        refusals: [SELF, ROLE_LEVEL, { code: 'VALIDATION_ERROR', when: 'a rejection has no reason' }],
        reports: ['approvals'],
      },
    },
    {
      title: 'Post',
      actor: 'finance',
      detail: 'Posting moves the balance. A posted entry never changes; mistakes are reversed.',
      to: '/finance/transactions',
      system: {
        useCase: 'finance.transition',
        records: [{ record: 'Transaction', change: 'Approved to Posted' }],
        audit: { action: 'status', entity: 'transaction' },
        refusals: [{ code: 'TRANSACTION_INVALID_STATE', when: 'the entry is not approved yet' }, FORBIDDEN],
        reports: ['cash-entries', 'cash-flow', 'income', 'pnl-villa'],
        tiles: ['Cash balance', 'Revenue'],
      },
    },
    {
      title: 'Income shows in the reports',
      actor: 'owner',
      detail: 'Cashbox, profit and loss and the owner statement include the posted amount.',
      to: '/owner',
      system: { useCase: 'reports.run', reports: ['pnl-portfolio', 'revenue-source'], tiles: ['Net income', 'Operating margin'] },
    },
  ],
}

const BOOKING_CHANGE_FLOW: GuideFlow = {
  id: 'booking-change',
  title: 'Booking change to balance or refund',
  summary: 'Every change to a stay recalculates what the guest owes, and the payment status follows.',
  steps: [
    {
      title: 'Change the stay',
      actor: 'reservation',
      detail: 'Extend or shorten the dates, or swap to an interchangeable unit. The move is kept in the unit history.',
      to: '/bookings',
      system: {
        useCase: 'booking.adjustStay',
        records: [{ record: 'Booking', change: 'new dates and total' }, { record: 'Unit movement', change: 'added on a swap' }],
        audit: { action: 'update', entity: 'booking' },
        refusals: [{ code: 'BOOKING_OVERLAP', when: 'the new nights clash' }, { code: 'UNIT_NOT_INTERCHANGEABLE', when: 'the target unit is outside the group' }, { code: 'BOOKING_INVALID_STATE', when: 'the stay is over' }],
        reports: ['unit-movement', 'occupancy'],
      },
    },
    {
      title: 'Reprice a direct stay',
      actor: 'manager',
      detail: 'Give a staff rate or a discount with a reason. New nights take the Airbnb listing price; channel stays keep what the channel sold.',
      to: '/bookings',
      branches: [{ label: 'Past the limit', detail: 'A price further under the listing than the policy allows needs someone who may approve bookings.', tone: 'warning', to: '/payments/settings' }],
      system: {
        useCase: 'booking.setPrice',
        records: [{ record: 'Booking', change: 'staff rate or discount, who priced it and who allowed it' }],
        audit: { action: 'update', entity: 'booking' },
        refusals: [{ code: 'DISCOUNT_LIMIT', when: 'the price goes past the discount limit and the person may not approve bookings' }, { code: 'CHANNEL_PRICE_LOCKED', when: 'the stay came from Airbnb or another channel' }],
        reports: ['discounts'],
      },
    },
    {
      title: 'Balance recalculates',
      actor: 'system',
      detail: 'Total, balance due, payment status and the invoice update together.',
      to: '/bookings',
      system: { useCase: 'payments.invoice', records: [{ record: 'Booking', change: 'payment status from the sum of paid payments' }], reports: ['receivables-aging'], tiles: ['Receivables'] },
    },
    {
      title: 'Settle the difference',
      actor: 'reservation',
      detail: 'Collect the balance at the desk or send a new link.',
      to: '/payments/receivables',
      branches: [
        { label: 'Overpaid', detail: 'A shorter stay leaves credit; refund it from the payment that brought the money in.', tone: 'info', to: '/payments/list' },
        { label: 'Cancelled', detail: 'The payment policy decides between a refund and keeping the deposit as revenue.', tone: 'warning', to: '/payments/settings' },
        { label: 'No-show', detail: 'The deposit stays as revenue under the policy.', tone: 'danger', to: '/bookings' },
      ],
      system: {
        useCase: 'payments.record',
        records: [{ record: 'Payment', change: 'new, Paid' }],
        ledger: [ROOM_IN('Location cashbox for cash, bank for transfer', 'front_desk')],
        audit: { action: 'create', entity: 'payment' },
        refusals: [{ code: 'PAYMENT_OVERPAID', when: 'the amount is more than the balance due' }],
        reports: ['payments-collected'],
      },
    },
    {
      title: 'Ledger follows',
      actor: 'system',
      detail: 'Refunds post a cash-out, kept deposits stay as posted income, both through approval.',
      to: '/finance/transactions',
      system: {
        useCase: 'payments.refund',
        records: [{ record: 'Payment (refund)', change: 'new, Paid' }, { record: 'Original payment', change: 'Paid to Refunded once fully returned' }],
        ledger: [{ kind: 'cash_out', account: 'Cashbox for cash, bank otherwise', categoryId: 'cat-other', category: 'Other', origin: 'payment', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'create', entity: 'payment' },
        refusals: [{ code: 'PAYMENT_INVALID_STATE', when: 'the payment was never paid, or is itself a refund' }],
        reports: ['refunds', 'cash-entries'],
      },
    },
  ],
}

const AIRBNB_FLOW: GuideFlow = {
  id: 'airbnb-payout',
  title: 'Airbnb booking to matched payout',
  summary: 'Airbnb collects from the guest and pays the host; the console expects the payout and matches it against the bank.',
  steps: [
    {
      title: 'Enter the Airbnb booking',
      actor: 'reservation',
      detail: 'Record the reservation on its listing with the Airbnb fee.',
      to: '/airbnb',
      system: { useCase: 'booking.create', records: [{ record: 'Booking', change: 'new, source Airbnb, with fee' }], audit: { action: 'create', entity: 'booking' }, refusals: [{ code: 'BOOKING_OVERLAP', when: 'the nights clash' }], reports: ['revenue-listing', 'revenue-account'] },
    },
    { title: 'Payout expected', actor: 'system', detail: 'The payout amount is the room total less the fee, due the day after arrival.', to: '/payments/payouts', system: { useCase: 'payments.payouts', reports: ['airbnb-payouts'] } },
    {
      title: 'Match the bank credit',
      actor: 'finance',
      detail: 'Mark the payout received when it shows in the bank; it lands as a cash-in under Airbnb.',
      to: '/payments/payouts',
      branches: [{ label: 'Payout late', detail: 'It stays in the overdue list until Finance matches it.', tone: 'warning', to: '/payments/payouts' }],
      system: {
        useCase: 'payments.record',
        records: [{ record: 'Payment (Airbnb payout)', change: 'new, Paid' }, { record: 'Booking', change: 'payment Paid' }],
        ledger: [{ kind: 'cash_in', account: 'Bank', categoryId: 'cat-airbnb', category: 'Airbnb payout', origin: 'payment', status: 'Submitted' }],
        audit: { action: 'create', entity: 'payment' },
        reports: ['airbnb-payouts', 'payments-collected'],
      },
    },
    { title: 'Approve and post', actor: 'finance', detail: 'The cash-in goes through the approval chain like any other entry.', to: '/approvals', system: { useCase: 'finance.transition', approval: STD_APPROVAL, audit: { action: 'approve', entity: 'transaction' }, refusals: [SELF], reports: ['income', 'revenue-source'] } },
  ],
}

const REPAIR_FLOW: GuideFlow = {
  id: 'work-order-expense',
  title: 'Work order to posted expense',
  summary: 'Each cost on a job is its own cash-out with a receipt, signed by the chain its amount needs.',
  steps: [
    {
      title: 'Report the job',
      actor: 'staff',
      detail: 'Open a work order on a unit or an asset. An open urgent job can block the unit.',
      to: '/maintenance/work-orders/new',
      system: { useCase: 'maintenance.createWorkOrder', records: [{ record: 'Work order', change: 'new, Open' }], audit: { action: 'create', entity: 'work-order' }, tiles: ['Urgent jobs open'] },
    },
    {
      title: 'Assign and work',
      actor: 'manager',
      detail: 'Assign staff or a vendor, add before and after photos.',
      to: '/maintenance/work-orders',
      system: {
        useCase: 'maintenance.transition',
        records: [{ record: 'Work order', change: 'Open to Scheduled or In progress' }, { record: 'Unit', change: 'Maintenance while blocked' }],
        audit: { action: 'status', entity: 'work-order' },
        refusals: [{ code: 'WORK_ORDER_INVALID_STATE', when: 'the move is not allowed from the current status' }, { code: 'BLOCK_OVERLAP', when: 'a block would cover a guest’s nights' }],
        reports: ['maint-downtime'],
      },
    },
    {
      title: 'Record expense lines',
      actor: 'manager',
      detail: 'Parts, vendor invoices and labour paid outside payroll, each with its receipt attached.',
      to: '/maintenance/work-orders',
      system: {
        useCase: 'maintenance.addExpense',
        records: [{ record: 'Expense line', change: 'new, with its own transaction' }],
        ledger: [{ kind: 'cash_out', account: 'Location cashbox for cash, BCA bank for transfer', categoryId: 'cat-maint', category: 'Maintenance', origin: 'maintenance', status: 'Submitted' }],
        approval: STD_APPROVAL,
        refusals: [{ code: 'WORK_ORDER_INVALID_STATE', when: 'the job has not started or is closed' }, { code: 'PROOF_REQUIRED', when: 'the amount is above the proof threshold and no receipt is attached' }],
        reports: ['maint-cost'],
      },
    },
    {
      title: 'Approve',
      actor: 'manager',
      detail: 'Bigger bills need more levels, for example the villa manager and then Finance.',
      to: '/approvals',
      branches: [{ label: 'Rejected', detail: 'Correct the line and submit it again.', tone: 'danger', to: '/approvals' }],
      system: { useCase: 'finance.transition', records: [{ record: 'Transaction', change: 'Submitted to Approved or Rejected' }], approval: STD_APPROVAL, audit: { action: 'approve', entity: 'transaction' }, refusals: [SELF, ROLE_LEVEL], reports: ['approvals'] },
    },
    {
      title: 'Post the cash-out',
      actor: 'finance',
      detail: 'Posted lines count in asset cost, vendor spend and the maintenance cost report.',
      to: '/finance/cash-out',
      system: { useCase: 'finance.transition', records: [{ record: 'Transaction', change: 'Approved to Posted' }], audit: { action: 'status', entity: 'transaction' }, reports: ['expense', 'maint-cost', 'pnl-villa'], tiles: ['Cash balance'] },
    },
  ],
}

const APPROVAL_FLOW: GuideFlow = {
  id: 'approval-chain',
  title: 'Approval chain by amount',
  summary: 'The most specific rule for the kind, villa and amount decides who signs, level by level.',
  steps: [
    {
      title: 'Submit',
      actor: 'staff',
      detail: 'The author submits an entry with its reference and proof.',
      to: '/finance/transactions/new',
      system: { useCase: 'finance.createTransaction', records: [{ record: 'Transaction', change: 'Draft to Submitted' }], audit: { action: 'create', entity: 'transaction' }, refusals: [FORBIDDEN, { code: 'PROOF_REQUIRED', when: 'a cash-out above the threshold has no receipt' }] },
    },
    { title: 'Match the rule', actor: 'system', detail: 'The console picks the rule for the kind, villa and amount.', to: '/master/approval-rules', system: { useCase: 'finance.rules', approval: STD_APPROVAL } },
    { title: 'Level 1: villa manager', actor: 'manager', detail: 'The author never signs their own entry.', to: '/approvals', system: { useCase: 'finance.transition', audit: { action: 'approve', entity: 'transaction' }, refusals: [SELF, ROLE_LEVEL] } },
    { title: 'Level 2: finance', actor: 'finance', detail: 'Each level waits for the one before it.', to: '/approvals', system: { useCase: 'finance.transition', audit: { action: 'approve', entity: 'transaction' }, refusals: [ROLE_LEVEL] } },
    {
      title: 'Level 3: owner',
      actor: 'owner',
      detail: 'Only the largest amounts reach the owner.',
      to: '/approvals',
      branches: [{ label: 'Rejected at any level', detail: 'The note goes back to the author, who corrects and resubmits.', tone: 'danger', to: '/approvals' }],
      system: { useCase: 'finance.transition', records: [{ record: 'Transaction', change: 'Submitted to Approved, or Rejected to Submitted on resubmit' }], audit: { action: 'reject', entity: 'transaction' }, refusals: [ROLE_LEVEL, { code: 'VALIDATION_ERROR', when: 'a rejection has no reason' }] },
    },
    { title: 'Post', actor: 'finance', detail: 'The fully signed entry is posted and the balance moves.', to: '/finance/transactions', system: { useCase: 'finance.transition', records: [{ record: 'Transaction', change: 'Approved to Posted' }], refusals: [{ code: 'TRANSACTION_ALREADY_POSTED', when: 'someone tries to edit a posted entry' }], reports: ['approvals', 'cash-flow'] } },
  ],
}

const PAYROLL_FLOW: GuideFlow = {
  id: 'payroll',
  title: 'Payroll from calculation to payslips',
  summary: 'One period a month, calculated from attendance, overtime and loans, closed into a single bank entry.',
  steps: [
    {
      title: 'Calculate',
      actor: 'hr',
      detail: 'Salary, allowances, overtime, service charge, deductions, BPJS and PPh 21 per employee.',
      to: '/payroll',
      system: { useCase: 'payroll.calculate', records: [{ record: 'Payroll period', change: 'Draft to Calculated' }], audit: { action: 'status', entity: 'payroll' }, refusals: [{ code: 'PAYROLL_EXISTS', when: 'the month already has a payroll' }, { code: 'PAYROLL_LOCKED', when: 'the period is approved or closed' }], reports: ['payroll-summary'] },
    },
    { title: 'Adjust', actor: 'hr', detail: 'Bonuses or corrections, each with a reason.', to: '/payroll', system: { useCase: 'payroll.addAdjustment', audit: { action: 'update', entity: 'payroll' }, refusals: [{ code: 'PAYROLL_LOCKED', when: 'the period is approved or closed' }] } },
    {
      title: 'Approve',
      actor: 'finance',
      detail: 'The person who calculated the payroll cannot approve it.',
      to: '/payroll',
      branches: [{ label: 'Reopen', detail: 'Reopening needs a reason and unlocks the payslips.', tone: 'warning', to: '/payroll' }],
      system: { useCase: 'payroll.transition', records: [{ record: 'Payroll period', change: 'Calculated to Approved, or back to Draft' }], audit: { action: 'status', entity: 'payroll' }, refusals: [{ code: 'APPROVAL_SELF', when: 'the calculator approves their own payroll' }, { code: 'PAYROLL_INVALID_STATE', when: 'the move is not allowed' }] },
    },
    {
      title: 'Close',
      actor: 'finance',
      detail: 'Closing posts the salary bank entry and books loan repayments.',
      to: '/finance/transactions',
      system: {
        useCase: 'payroll.transition',
        records: [{ record: 'Payroll period', change: 'Approved to Closed' }, { record: 'Loan', change: 'balance reduced by the instalment' }],
        ledger: [{ kind: 'cash_out', account: 'The account picked at closing', categoryId: 'cat-payroll', category: 'Salaries and payroll', origin: 'payroll', status: 'Posted at once' }],
        audit: { action: 'status', entity: 'payroll' },
        reports: ['payroll-summary', 'payroll-villa', 'payroll-location', 'pnl-villa'],
        tiles: ['Payroll', 'Cash balance'],
      },
    },
    {
      title: 'Pay statutory',
      actor: 'finance',
      detail: 'One cash-out per office for the BPJS and PPh 21 the closed period owes, through the approval chain.',
      to: '/payroll',
      system: { useCase: 'payroll.payStatutory', approval: STD_APPROVAL, refusals: [{ code: 'STATUTORY_PAID', when: 'both remittances are already recorded' }], reports: ['balance-sheet'] },
    },
    { title: 'Publish payslips', actor: 'hr', detail: 'Employees see their payslip in their own area.', to: '/me/payslips', system: { useCase: 'payroll.publish', refusals: [{ code: 'PAYROLL_INVALID_STATE', when: 'the payroll is not closed' }] } },
  ],
}

const LEAVE_FLOW: GuideFlow = {
  id: 'leave-overtime',
  title: 'Leave and overtime into payroll',
  summary: 'Requests start in the employee area and end as lines on the payslip.',
  steps: [
    { title: 'Request', actor: 'staff', detail: 'Leave, overtime or a loan from My area.', to: '/me/requests', system: { useCase: 'people.requestLeave', records: [{ record: 'Leave request', change: 'new, Pending' }], audit: { action: 'create', entity: 'leave' } } },
    {
      title: 'Approve',
      actor: 'manager',
      detail: 'The villa manager or HR decides.',
      to: '/hr/leave',
      branches: [{ label: 'Rejected', detail: 'The reason shows in the employee’s list.', tone: 'danger', to: '/me' }],
      system: { useCase: 'hr.decideLeave', records: [{ record: 'Leave request', change: 'Pending to Approved or Rejected' }], refusals: [{ code: 'REQUEST_INVALID_STATE', when: 'the request was already decided' }, { code: 'VALIDATION_ERROR', when: 'a rejection has no reason' }], reports: ['leave', 'overtime'] },
    },
    { title: 'Counted in payroll', actor: 'system', detail: 'Approved overtime adds pay, unpaid leave deducts, loan instalments come off.', to: '/payroll', system: { useCase: 'payroll.calculate', reports: ['payroll-summary', 'attendance'] } },
  ],
}

const PREVENTIVE_FLOW: GuideFlow = {
  id: 'preventive',
  title: 'Preventive plan to work order',
  summary: 'Recurring care opens its own jobs so nothing waits for a breakdown.',
  steps: [
    { title: 'Plan', actor: 'manager', detail: 'Set the task, the unit or asset and how often.', to: '/maintenance/preventive', system: { useCase: 'maintenance.createPlan', audit: { action: 'create', entity: 'plan' }, reports: ['maint-preventive'] } },
    { title: 'Due', actor: 'system', detail: 'When a plan comes due it opens a work order.', to: '/maintenance/work-orders', system: { useCase: 'maintenance.generateDue', records: [{ record: 'Work order', change: 'new, Open, linked to the plan' }], audit: { action: 'create', entity: 'work-order' } } },
    { title: 'Work and close', actor: 'staff', detail: 'The job follows the work order flow, expenses included.', to: '/maintenance/work-orders', system: { useCase: 'maintenance.transition', records: [{ record: 'Work order', change: 'In progress to Done to Verified' }], reports: ['maint-resolution'] } },
  ],
}

const HOUSEKEEPING_FLOW: GuideFlow = {
  id: 'housekeeping',
  title: 'Housekeeping from dirty to ready',
  summary: 'Each unit moves through the board in order and only an inspection makes it ready.',
  steps: [
    { title: 'Dirty', actor: 'system', detail: 'Check-out marks the unit dirty.', to: '/housekeeping', system: { useCase: 'booking.checkOut', records: [{ record: 'Booking', change: 'Checked in to Checked out' }, { record: 'Housekeeping', change: 'to Dirty' }], audit: { action: 'status', entity: 'booking' } } },
    { title: 'Cleaning', actor: 'staff', detail: 'Housekeeping starts the clean from the board or the phone.', to: '/m/housekeeping', system: { useCase: 'maintenance.setHousekeeping', records: [{ record: 'Housekeeping', change: 'Dirty to Cleaning' }], audit: { action: 'status', entity: 'housekeeping' }, refusals: [{ code: 'HOUSEKEEPING_INVALID_STATE', when: 'the unit tries to skip a stage' }] } },
    {
      title: 'Inspect',
      actor: 'manager',
      detail: 'The checklist decides; a unit cannot skip a stage.',
      to: '/housekeeping',
      branches: [{ label: 'Fails inspection', detail: 'Back to dirty with the failed items.', tone: 'danger', to: '/housekeeping' }],
      system: { useCase: 'maintenance.inspect', records: [{ record: 'Housekeeping', change: 'Cleaning to Inspected, or back to Dirty' }], audit: { action: 'status', entity: 'housekeeping' }, refusals: [{ code: 'HOUSEKEEPING_INVALID_STATE', when: 'the unit is not cleaned yet' }] },
    },
    { title: 'Ready', actor: 'system', detail: 'The unit is free to sell again.', to: '/calendar', system: { useCase: 'maintenance.setHousekeeping', records: [{ record: 'Housekeeping', change: 'Inspected to Ready' }], tiles: ['Cleaning'] } },
  ],
}

const ACCESS_FLOW: GuideFlow = {
  id: 'access',
  title: 'User and role to scoped access',
  summary: 'A login gets a role, the role gets permissions, and villa scope limits what the person sees.',
  steps: [
    { title: 'Create the user', actor: 'admin', detail: 'Name, email, role and an optional link to the employee record.', to: '/access/users', system: { useCase: 'access.createUser', records: [{ record: 'User', change: 'new, Active' }], audit: { action: 'create', entity: 'user' }, refusals: [{ code: 'VALIDATION_ERROR', when: 'the email already has a login' }] } },
    { title: 'Set the scope', actor: 'admin', detail: 'Limit the login to locations or villas; empty means all.', to: '/access/users', system: { useCase: 'access.updateUser', audit: { action: 'update', entity: 'user' }, refusals: [{ code: 'ACCESS_SELF', when: 'someone changes their own role or deactivates themselves' }] } },
    { title: 'Tune the role', actor: 'owner', detail: 'The matrix sets each action per module. Only the owner changes the owner’s permissions.', to: '/access/roles', system: { useCase: 'access.savePermissions', audit: { action: 'update', entity: 'permissions' }, refusals: [{ code: 'ACCESS_OWNER', when: 'someone else edits the owner row' }] } },
    { title: 'Every action is logged', actor: 'system', detail: 'The audit trail keeps before and after values, refusals included.', to: '/access/audit', system: { useCase: 'access.audit', audit: { action: 'denied', entity: 'session' } } },
  ],
}

const ROOM_TYPE_FLOW: GuideFlow = {
  id: 'room-type',
  title: 'Room type booking to an assigned room',
  summary: 'In villas with identical rooms the guest books the type; the front desk picks the room before check-in.',
  steps: [
    {
      title: 'Book the room type',
      actor: 'reservation',
      detail: 'Pick the villa and its room type instead of a unit. The stay shows as Unassigned on the bookings list and in its own calendar lane.',
      to: '/bookings/new',
      system: {
        useCase: 'booking.create',
        records: [{ record: 'Booking', change: 'new, no room yet' }],
        audit: { action: 'create', entity: 'booking' },
        refusals: [{ code: 'ROOM_TYPE_FULL', when: 'every room of the type is taken on one of the nights, stays still waiting for a room included' }],
        reports: ['bookings'],
      },
    },
    {
      title: 'Assign the room',
      actor: 'manager',
      detail: 'Pick one of the rooms free for every night; the bell lists stays arriving within two weeks without one. The room can change until check-in.',
      to: '/calendar',
      system: {
        useCase: 'booking.assignUnit',
        records: [{ record: 'Booking', change: 'room set; direct stays repriced from that room’s listing for new nights only' }],
        audit: { action: 'update', entity: 'booking' },
        refusals: [{ code: 'BOOKING_OVERLAP', when: 'the room is held on one of the nights' }, { code: 'UNIT_NOT_INTERCHANGEABLE', when: 'the room is of another type' }, { code: 'BOOKING_INVALID_STATE', when: 'the guest has checked in' }],
        tiles: ['Needs attention'],
      },
    },
    {
      title: 'Check in',
      actor: 'staff',
      detail: 'The front desk checks the guest into the assigned room.',
      to: '/m',
      system: { useCase: 'booking.checkIn', records: [{ record: 'Booking', change: 'Confirmed to Checked in' }], audit: { action: 'status', entity: 'booking' }, refusals: [{ code: 'UNIT_UNASSIGNED', when: 'no room is assigned yet' }] },
    },
  ],
}

const GROUP_FLOW: GuideFlow = {
  id: 'group-booking',
  title: 'Group booking from one form to the last check-out',
  summary: 'Several units for one party: booked all or nothing, one deposit for the group, checked in together, and billed to a master folio or stay by stay.',
  steps: [
    {
      title: 'Book the group',
      actor: 'reservation',
      detail: 'One form: the lead guest, shared dates with per-unit changes, units or room types with their party, a staff price per stay and an optional group discount on every stay. Every unit is checked first; one clash refuses the whole group and names the unit.',
      to: '/bookings/groups/new',
      system: {
        useCase: 'groups.create',
        records: [{ record: 'Group', change: 'new, GRP code, billing master or per stay' }, { record: 'Booking', change: 'one per unit, in the lead guest’s name, pointing at the group' }],
        audit: { action: 'create', entity: 'booking-group' },
        refusals: [{ code: 'GROUP_UNAVAILABLE', when: 'any unit or room type is taken on one of its nights, by another stay or by an earlier stay of the same group' }, { code: 'DISCOUNT_LIMIT', when: 'the group discount or a stay’s price passes the discount limit and the person may not approve bookings' }],
        reports: ['group-bookings', 'bookings'],
      },
    },
    {
      title: 'Take the group deposit',
      actor: 'reservation',
      detail: 'One payment for the group, by cash, transfer or a payment link. It splits over the stays in arrival order, each up to what it owes, and lands as one cash-in for approval.',
      to: '/bookings/groups',
      system: {
        useCase: 'groups.pay',
        records: [{ record: 'Payment', change: 'one share per stay, all with the same batch' }],
        ledger: [ROOM_IN('Cashbox for cash, bank otherwise', 'front_desk')],
        audit: { action: 'create', entity: 'booking-group' },
        refusals: [{ code: 'VALIDATION_ERROR', when: 'the amount is more than the group still owes, or a transfer has no reference' }],
        reports: ['group-bookings', 'payments-collected'],
      },
    },
    {
      title: 'Check the group in',
      actor: 'staff',
      detail: 'One check-in for every stay arriving today, each with its own party. Stays booked by room type need their room first.',
      to: '/bookings/groups',
      system: {
        useCase: 'groups.checkIn',
        records: [{ record: 'Booking', change: 'Confirmed to Checked in, for each arriving stay' }],
        audit: { action: 'status', entity: 'booking' },
        refusals: [{ code: 'UNIT_UNASSIGNED', when: 'an arriving stay still waits for its room' }, { code: 'GROUP_NOTHING_ARRIVING', when: 'no stay of the group arrives today' }],
      },
    },
    {
      title: 'Check each stay out',
      actor: 'staff',
      detail: 'On a master folio, each stay settles its own room service and charges and leaves; the last one leaves once the master folio is paid. Billed per stay, each stay settles its whole folio as usual.',
      to: '/bookings',
      branches: [{ label: 'Master folio open', detail: 'Take the balance on the group page, then check the last stay out.', tone: 'warning', to: '/bookings/groups' }],
      system: {
        useCase: 'booking.settleAndCheckOut',
        records: [{ record: 'Booking', change: 'Checked in to Checked out' }],
        audit: { action: 'status', entity: 'booking' },
        refusals: [{ code: 'GROUP_MASTER_OPEN', when: 'the last stay of a master-billed group leaves while the master folio has a balance' }],
        reports: ['group-bookings'],
      },
    },
  ],
}

const PETTY_FLOW: GuideFlow = {
  id: 'petty-cash',
  title: 'Villa petty cash',
  summary: 'Each villa keeps a float with one custodian; spends carry a receipt, top-ups come from the cashbox or the bank, and counts keep it honest.',
  steps: [
    {
      title: 'Spend with a receipt',
      actor: 'staff',
      detail: 'Record the spend on the villa’s petty cash with a photo of the receipt, on the desk or the phone.',
      to: '/finance/petty-cash',
      system: {
        useCase: 'finance.createTransaction',
        ledger: [{ kind: 'cash_out', account: 'Villa petty cash', categoryId: 'cat-house', category: 'Housekeeping supplies', origin: 'manual', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'create', entity: 'transaction' },
        refusals: [{ code: 'PROOF_REQUIRED', when: 'a petty cash spend has no receipt while the receipt rule is on' }, FORBIDDEN],
        reports: ['petty-cash', 'expense'],
      },
    },
    {
      title: 'Running low',
      actor: 'system',
      detail: 'Under a quarter of the float, the box shows as low on the petty cash page and in the bell.',
      to: '/finance/petty-cash',
      system: { useCase: 'dashboard.attention', tiles: ['Needs attention'], reports: ['petty-cash'] },
    },
    {
      title: 'Top up to the float',
      actor: 'manager',
      detail: 'A transfer from the location cashbox or the bank brings the box back to its float, through approval like any entry.',
      to: '/finance/transfer',
      system: {
        useCase: 'finance.transfer',
        ledger: [
          { kind: 'cash_out', account: 'Location cashbox or bank', categoryId: 'cat-transfer-out', category: 'Transfer out', origin: 'transfer', status: 'Submitted' },
          { kind: 'cash_in', account: 'Villa petty cash', categoryId: 'cat-transfer-in', category: 'Transfer in', origin: 'transfer', status: 'Submitted' },
        ],
        approval: STD_APPROVAL,
        reports: ['petty-cash', 'cash-flow'],
      },
    },
    {
      title: 'Count the box',
      actor: 'manager',
      detail: 'Count the cash against the book balance; a difference can go for approval as an adjustment.',
      to: '/finance/petty-cash',
      system: { useCase: 'finance.reconcile', records: [{ record: 'Reconciliation', change: 'new, with the difference' }], reports: ['petty-cash'] },
    },
  ],
}

const ROOM_SERVICE_FLOW: GuideFlow = {
  id: 'room-service',
  title: 'Room service to posted income',
  summary: 'A guest orders from the room’s QR card or the desk orders for them; delivery puts it on the bill, paying books the income per category, and a partner’s share goes out as a cash-out.',
  steps: [
    {
      title: 'Order from the room or the desk',
      actor: 'guest',
      detail: 'The QR card opens the room’s menu for the guest staying there; the desk can order for any stay in house or arriving within three days.',
      to: '/services/orders/new',
      branches: [
        { label: 'Not in house', detail: 'Nobody staying or arriving soon: ordering is closed.', tone: 'warning' },
        { label: 'Outside its hours', detail: 'Breakfast after 10:30 or a tour without a day’s notice is refused.', tone: 'warning' },
      ],
      system: {
        useCase: 'orders.place',
        records: [{ record: 'Service order', change: 'new, New, with menu prices copied onto its lines' }],
        audit: { action: 'create', entity: 'service-order' },
        refusals: [
          { code: 'ORDER_NO_STAY', when: 'the stay is not in house or arriving within three days, or the time is after check-out' },
          { code: 'ITEM_UNAVAILABLE', when: 'the item is off the menu or not served at that time' },
          { code: 'ITEM_LEAD_TIME', when: 'the time leaves the kitchen or partner less notice than the item needs' },
          { code: 'COMP_FORBIDDEN', when: 'someone without the Give free permission puts an item on the house' },
          { code: 'DISCOUNT_LIMIT', when: 'the discount passes the policy limit and the person may not approve bookings' },
        ],
        tiles: ['Room service', 'Needs attention'],
      },
    },
    {
      title: 'Accept, prepare, deliver',
      actor: 'staff',
      detail: 'The team works the order on the board or the phone. Over 30 minutes past the requested time it shows as late.',
      to: '/services/orders',
      branches: [{ label: 'Cancelled', detail: 'Cancelling needs a reason; nothing is billed.', tone: 'danger' }],
      system: {
        useCase: 'orders.transition',
        records: [{ record: 'Service order', change: 'New -> Accepted -> Preparing -> Delivered' }],
        audit: { action: 'status', entity: 'service-order' },
        refusals: [{ code: 'ORDER_INVALID_STATE', when: 'the order is already delivered or cancelled' }],
        reports: ['rs-delivery'],
      },
    },
    {
      title: 'Partner bills its share',
      actor: 'system',
      detail: 'Delivering an order with spa, tours or transfers books what each partner charges as a cash-out from the bank, waiting for approval.',
      to: '/services/catalog',
      system: {
        useCase: 'orders.transition',
        ledger: [{ kind: 'cash_out', account: 'Bank', categoryId: 'cat-svc-partner', category: 'Service partner costs', origin: 'room_service', status: 'Submitted' }],
        approval: STD_APPROVAL,
        reports: ['rs-partners', 'expense', 'pnl-villa'],
      },
    },
    {
      title: 'On the guest’s bill',
      actor: 'system',
      detail: 'Delivered orders show on the booking and the invoice apart from the room. Check-out waits until they are paid.',
      to: '/bookings',
      system: {
        useCase: 'orders.forStay',
        records: [{ record: 'Booking bill', change: 'room service charged and still owed' }],
        refusals: [{ code: 'SERVICE_UNPAID', when: 'the guest checks out with delivered room service unpaid' }],
      },
    },
    {
      title: 'Take the payment',
      actor: 'staff',
      detail: 'Cash or transfer at the desk, or a QRIS, VA or card link the guest can also start from their menu page.',
      to: '/services/orders',
      branches: [{ label: 'Link fails or expires', detail: 'The orders go back to unpaid; send a new link.', tone: 'warning' }],
      system: {
        useCase: 'orders.pay',
        records: [{ record: 'Payment', change: 'new, Paid now or Pending on a link, settling the chosen orders' }],
        ledger: [{ kind: 'cash_in', account: 'Cashbox for cash, bank otherwise', categoryId: 'cat-svc-fnb', category: 'Room service food and drinks', origin: 'front_desk', status: 'Submitted' }, FEE_OUT],
        audit: { action: 'create', entity: 'payment' },
        refusals: [{ code: 'ORDER_NOT_BILLABLE', when: 'an order is not delivered yet, already paid, or has a link open' }],
        reports: ['rs-revenue', 'payments-collected'],
      },
    },
    {
      title: 'Or settle everything at check-out',
      actor: 'staff',
      detail: 'At departure the desk takes the room balance, unpaid orders and departure charges in one payment and the stay closes in the same step. A link closes it when the guest pays.',
      to: '/bookings',
      branches: [{ label: 'Link still open', detail: 'Check-out waits for the guest; cancel the link to take the bill another way.', tone: 'warning' }],
      system: {
        useCase: 'booking.settleAndCheckOut',
        records: [
          { record: 'Payment', change: 'one per part: room balance, room service; Paid now or Pending on one link' },
          { record: 'Booking', change: 'Checked in to Checked out, all or nothing' },
          { record: 'Housekeeping', change: 'to Dirty' },
        ],
        ledger: [ROOM_IN('Cashbox for cash, bank otherwise', 'front_desk'), { kind: 'cash_in', account: 'Cashbox for cash, bank otherwise', categoryId: 'cat-svc-fnb', category: 'Room service food and drinks', origin: 'front_desk', status: 'Submitted' }, { kind: 'cash_in', account: 'Cashbox for cash, bank otherwise', categoryId: 'cat-extra', category: 'Extra services', origin: 'front_desk', status: 'Submitted' }, FEE_OUT],
        audit: { action: 'status', entity: 'booking' },
        refusals: [
          { code: 'SETTLEMENT_PENDING', when: 'a check-out link or an order link is still waiting for the guest' },
          { code: 'SERVICE_UNPAID', when: 'staff try a plain check-out with room service unpaid' },
        ],
        reports: ['payments-collected', 'rs-revenue', 'income'],
      },
    },
    {
      title: 'Approve and post the income',
      actor: 'finance',
      detail: 'Each category lands as its own cash-in, so food, laundry, transport, spa and tours show apart in the cash reports. Posted, the money pays the stay’s receivable; the books took the revenue when the order was delivered.',
      to: '/approvals',
      system: {
        useCase: 'finance.transition',
        records: [{ record: 'Transaction', change: 'Submitted -> Approved -> Posted' }],
        approval: STD_APPROVAL,
        audit: { action: 'approve', entity: 'transaction' },
        refusals: [SELF, ROLE_LEVEL],
        reports: ['income', 'pnl-villa', 'rs-revenue', 'rs-items'],
        tiles: ['Owner revenue mix'],
      },
    },
  ],
}

const RATE_PLAN_FLOW: GuideFlow = {
  id: 'rate-plan',
  title: 'Rate plan for units without a listing',
  summary: 'A unit with a live Airbnb listing sells direct at the listing. One without sells at its room type’s rate plan, and the price of every night names its source.',
  steps: [
    {
      title: 'Create the property',
      actor: 'admin',
      detail: 'The New property wizard has a Rates step: every room type, and every room sold on its own type, gets weekday and weekend rates prefilled from the base price with weekends about 20% higher. Seasons are optional.',
      to: '/property/new',
      system: {
        useCase: 'property.createProperty',
        records: [{ record: 'Villa', change: 'new' }, { record: 'Room type', change: 'one per type, and one for each room on its own' }, { record: 'Unit', change: 'new' }, { record: 'Rate plan', change: 'one per room type' }],
        audit: { action: 'create', entity: 'villa' },
        refusals: [FORBIDDEN, { code: 'VALIDATION_ERROR', when: 'a room code is taken or listed twice, or a plan has no weekday or weekend rate' }],
      },
    },
    {
      title: 'Add a unit to a room type',
      actor: 'admin',
      detail: 'A unit that joins a room type without a plan, from master data or the villa page, starts the plan from its base price. The toast says so and links to the plan.',
      to: '/master/units',
      system: {
        useCase: 'property.createUnit',
        records: [{ record: 'Unit', change: 'new' }, { record: 'Rate plan', change: 'new when the room type had none' }],
        audit: { action: 'create', entity: 'rate_plan' },
        refusals: [FORBIDDEN, { code: 'VALIDATION_ERROR', when: 'the unit code is taken or the group is in another villa' }],
      },
    },
    {
      title: 'Set the rate plan',
      actor: 'manager',
      detail: 'On the room type page: a weekday rate, a weekend rate for Friday and Saturday nights, and seasons that come back every year at a fixed price or a surcharge. Where two seasons overlap, the shorter one prices the night.',
      to: '/property',
      system: {
        useCase: 'property.saveRatePlan',
        records: [{ record: 'Rate plan', change: 'created or replaced for the room type' }],
        audit: { action: 'update', entity: 'rate_plan' },
        refusals: [FORBIDDEN, { code: 'VALIDATION_ERROR', when: 'a rate is missing, a season has no name, a date that does not exist, or a surcharge past 300%' }],
      },
    },
    {
      title: 'Quote a direct stay',
      actor: 'reservation',
      detail: 'The new booking shows each night with its price and source: Airbnb listing, or the rate plan with the weekday, weekend or season that set it. Staff rate and discount work as on any direct stay.',
      to: '/bookings/new',
      branches: [{ label: 'No price list', detail: 'Older data only: a unit with no live listing and no rate plan cannot be sold direct. The quote, the unit page and the room type page show Set a rate plan.', tone: 'danger', to: '/property' }],
      system: {
        useCase: 'booking.quote',
        records: [{ record: 'Booking', change: 'list price and source per night, kept when the plan changes later' }],
        refusals: [{ code: 'NO_PRICE', when: 'the unit has no live Airbnb listing and its room type has no rate plan' }],
      },
    },
  ],
}

const BOOKS_FLOW: GuideFlow = {
  id: 'books',
  title: 'Cash ledger to financial statements',
  summary: 'Staff record cash entries as before; posting writes the double-entry journal, and finance closes each month.',
  steps: [
    {
      title: 'Post a cash entry',
      actor: 'finance',
      detail: 'Posting a fully signed entry writes its journal: the cash account against the account its category books to. A transfer writes one entry for both halves; a reversal writes the reversing entry. Room money linked to a stay books to Guest deposits until the stay checks out and to its receivable after; money for room service and charges pays the stay’s receivable at once; a partner bill pays the partner payable down.',
      to: '/finance/transactions',
      system: {
        useCase: 'finance.transition',
        records: [{ record: 'Transaction', change: 'Approved to Posted' }, { record: 'Journal entry', change: 'new, never edited' }],
        refusals: [{ code: 'PERIOD_CLOSED', when: 'the entry is dated in a closed month' }, { code: 'JOURNAL_UNBALANCED', when: 'debits and credits would differ' }],
        reports: ['general-journal', 'trial-balance'],
      },
    },
    {
      title: 'Close payroll',
      actor: 'finance',
      detail: 'The salary payment writes one journal: wages and employer BPJS against the bank, BPJS payable, PPh 21 payable and employee loans.',
      to: '/payroll',
      system: { useCase: 'payroll.transition', records: [{ record: 'Journal entry', change: 'new, source Payroll' }], refusals: [{ code: 'PERIOD_CLOSED', when: 'today falls in a closed month' }], reports: ['income-statement', 'balance-sheet'] },
    },
    {
      title: 'Deliver room service',
      actor: 'staff',
      detail: 'Delivery books the order’s charge, net of items on the house and the discount, on the stay’s receivable with one revenue line per transaction code (food on FNB, minibar on MINI, a massage on SPA), each on its code’s account, and any partner cost against Payables to service partners, one line per partner. An order on the house books no revenue. The partner bill pays the payable down once posted.',
      to: '/services/orders',
      system: { useCase: 'orders.transition', records: [{ record: 'Journal entry', change: 'new, source Room service' }], audit: { action: 'status', entity: 'service-order' }, refusals: [{ code: 'PERIOD_CLOSED', when: 'today falls in a closed month' }], reports: ['partner-balances', 'rs-partners', 'revenue-codes', 'income-statement'] },
    },
    {
      title: 'Post a folio charge',
      actor: 'staff',
      detail: 'A charge on the folio books on its transaction code’s account and the stay’s receivable the day it posts: minibar on 4220, late check-out on room revenue, damage on other income.',
      to: '/bookings',
      system: { useCase: 'booking.postCharge', records: [{ record: 'Journal entry', change: 'new, source Folio charge' }], audit: { action: 'create', entity: 'folio' }, refusals: [{ code: 'PERIOD_CLOSED', when: 'today falls in a closed month' }, { code: 'VALIDATION_ERROR', when: 'the code is not an active charge code' }], reports: ['stay-receivables', 'revenue-codes', 'income-statement'] },
    },
    {
      title: 'Map the transaction codes',
      actor: 'finance',
      detail: 'Each charge code books to one revenue account. Finance adds a code, points it at another account or retires it on the Transaction codes page; postings from then on follow, posted journals stay.',
      to: '/accounting/transaction-codes',
      system: {
        useCase: 'accounting.saveTransactionCode',
        audit: { action: 'update', entity: 'transaction-code' },
        refusals: [{ code: 'VALIDATION_ERROR', when: 'the code is taken, malformed or has no revenue account' }, { code: 'CODE_IN_USE', when: 'someone retires ROOM or a payment code' }],
        reports: ['revenue-codes', 'income-statement'],
      },
    },
    {
      title: 'Check the stay out',
      actor: 'manager',
      detail: 'Check-out bills the room on the stay’s receivable: room revenue net of the discount, Airbnb’s fee as a cost on an Airbnb stay. Departure charges book as other income the same day. The deposits held move onto the receivable, and the money taken at check-out settles it to zero.',
      to: '/bookings',
      system: { useCase: 'booking.settleAndCheckOut', records: [{ record: 'Journal entry', change: 'new, source Guest folio' }], audit: { action: 'status', entity: 'booking' }, refusals: [{ code: 'PERIOD_CLOSED', when: 'today falls in a closed month' }], reports: ['stay-receivables', 'income-statement'] },
    },
    {
      title: 'Pay the statutory payables',
      actor: 'finance',
      detail: 'Pay statutory on a closed payroll submits one cash-out per office for the BPJS and PPh 21 it owes; posting them pays the payables down.',
      to: '/payroll',
      system: {
        useCase: 'payroll.payStatutory',
        ledger: [
          { kind: 'cash_out', account: 'The account picked, the bank by default', categoryId: 'cat-bpjs', category: 'BPJS remittance', origin: 'payroll', status: 'Submitted' },
          { kind: 'cash_out', account: 'The account picked, the bank by default', categoryId: 'cat-pph21', category: 'PPh 21 remittance', origin: 'payroll', status: 'Submitted' },
        ],
        approval: STD_APPROVAL,
        refusals: [{ code: 'PAYROLL_INVALID_STATE', when: 'the payroll is not closed' }, { code: 'STATUTORY_PAID', when: 'both remittances are already recorded' }],
        reports: ['balance-sheet', 'trial-balance'],
      },
    },
    {
      title: 'Map categories',
      actor: 'finance',
      detail: 'Each category that is not guest folio money (expenses, owner money, transfers) books to one ledger account; a change applies to entries posted from then on. Guest revenue categories follow their transaction code.',
      to: '/finance/categories',
      system: { useCase: 'accounting.mapCategory', audit: { action: 'update', entity: 'category' }, refusals: [{ code: 'LEDGER_ACCOUNT_INVALID', when: 'the account is a cash account or not in the chart' }, { code: 'CATEGORY_FOLLOWS_CODE', when: 'the category carries guest revenue, whose account comes from its transaction code' }] },
    },
    {
      title: 'Write a manual journal',
      actor: 'finance',
      detail: 'Accruals and corrections with no cash entry behind them, balanced, with a memo and evidence. Cash accounts stay out.',
      to: '/accounting/manual/new',
      system: {
        useCase: 'accounting.createManualJournal',
        records: [{ record: 'Manual journal', change: 'new, Draft or Submitted' }],
        audit: { action: 'create', entity: 'manual-journal' },
        refusals: [{ code: 'JOURNAL_UNBALANCED', when: 'debits and credits differ' }, { code: 'VALIDATION_ERROR', when: 'a line has no account, a cash account, or the memo is missing' }],
      },
    },
    {
      title: 'Sign and post the journal',
      actor: 'manager',
      detail: 'The journal signs like a cash-out of its total under the approval rules, from the approval inbox like a cash entry, then finance posts it. It counts in the pending badge for whoever signs next.',
      to: '/approvals',
      system: { useCase: 'accounting.transitionManualJournal', approval: STD_APPROVAL, audit: { action: 'approve', entity: 'manual-journal' }, refusals: [SELF, ROLE_LEVEL, { code: 'PERIOD_CLOSED', when: 'the journal is dated in a closed month' }] },
    },
    {
      title: 'Close the month',
      actor: 'finance',
      detail: 'Once a month has ended and nothing dated in it waits for approval, finance closes it. Reopening needs a reason.',
      to: '/accounting/periods',
      branches: [{ label: 'Reopen', detail: 'A reason reopens the month for late postings.', tone: 'warning', to: '/accounting/periods' }],
      system: {
        useCase: 'accounting.closePeriod',
        audit: { action: 'status', entity: 'period' },
        refusals: [{ code: 'PERIOD_NOT_ENDED', when: 'the month is the current one or later' }, { code: 'PERIOD_PENDING', when: 'entries dated in the month still wait for approval or posting' }, { code: 'PERIOD_OPEN', when: 'a reopen targets a month that is not closed' }],
        reports: ['trial-balance', 'income-statement', 'balance-sheet'],
      },
    },
  ],
}

const FOLIO_FLOW: GuideFlow = {
  id: 'guest-folio',
  title: 'Guest folio to check-out',
  summary: 'Every debit and credit of a stay on one folio: nights, discount, room service, charges, rebates, payments and refunds, each on its transaction code. Check-out takes its balance and offers the refund of a credit.',
  steps: [
    {
      title: 'Post a charge',
      actor: 'staff',
      detail: 'Minibar, damage, late check-out or anything else the guest owes goes on the folio of a stay in house, with what was charged.',
      to: '/bookings',
      system: {
        useCase: 'booking.postCharge',
        records: [{ record: 'Folio posting', change: 'new charge, open until check-out' }],
        audit: { action: 'create', entity: 'folio' },
        refusals: [{ code: 'BOOKING_INVALID_STATE', when: 'the guest is not in house' }, { code: 'SETTLEMENT_PENDING', when: 'a check-out link already waits for the guest' }, FORBIDDEN],
      },
    },
    {
      title: 'Correct a line with a rebate',
      actor: 'manager',
      detail: 'A rebate with a reason on one posted line (a night, room service on one code, a charge), posted as a negative charge on that line’s code: Dr the code’s revenue account, Cr the stay’s receivable. Past the discount limit share of the line, only someone who may approve bookings gives it.',
      to: '/bookings',
      system: {
        useCase: 'booking.postRebate',
        records: [{ record: 'Folio posting', change: 'new rebate on the line’s code, the approver named past the limit' }, { record: 'Journal entry', change: 'new, source Folio charge' }],
        audit: { action: 'create', entity: 'folio' },
        refusals: [{ code: 'ALLOWANCE_LIMIT', when: 'the rebates pass the discount limit share of the line and the person may not approve bookings' }, { code: 'VALIDATION_ERROR', when: 'the line cannot take a rebate, the amount is more than is left on it, or there is no reason' }],
        reports: ['revenue-codes', 'stay-receivables'],
      },
    },
    {
      title: 'Void a delivery made by mistake',
      actor: 'staff',
      detail: 'On the business day of the delivery, a void takes an unpaid order off the folio, reverses its revenue and partner costs, withdraws the partner bills and puts minibar stock back in the store. Once the business day closes, only a rebate corrects it.',
      to: '/services/orders',
      system: {
        useCase: 'orders.transition',
        records: [{ record: 'Order', change: 'Delivered to Voided' }, { record: 'Journal entry', change: 'new, the delivery turned around' }, { record: 'Stock movement', change: 'minibar sale back into the store' }],
        audit: { action: 'status', entity: 'service-order' },
        refusals: [{ code: 'VOID_DAY_CLOSED', when: 'the delivery happened on a business day already closed' }, { code: 'ORDER_VOID_PAID', when: 'the order is paid, on a link, rebated, or a partner bill is already paid' }],
        reports: ['revenue-codes'],
      },
    },
    {
      title: 'Refund a credit',
      actor: 'finance',
      detail: 'A rebate after payment, or an overpayment, leaves the folio in credit and shows Refund due. The refund names the payment the money came in on; its line debits the folio and its cash-out pays back the receivable for order and charge money, or Guest deposits for room money held before the stay is billed. The cash-out signs through the approval chain.',
      to: '/bookings',
      system: {
        useCase: 'booking.refund',
        records: [{ record: 'Payment', change: 'new refund linked to the original' }, { record: 'Transaction', change: 'new cash-out, Submitted' }],
        ledger: [{ kind: 'cash_out', account: 'Cashbox for cash, bank otherwise', categoryId: 'cat-other', category: 'Other', origin: 'front_desk', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'create', entity: 'payment' },
        refusals: [{ code: 'REFUND_EXCEEDS_CREDIT', when: 'the amount is more than the credit in that payment’s part of the bill' }, FORBIDDEN],
        reports: ['refunds', 'stay-receivables'],
      },
    },
    {
      title: 'Settle the folio at check-out',
      actor: 'staff',
      detail: 'The check-out bill is the folio balance: room, unpaid orders, open charges less their rebates, and departure charges. The charges land as one cash-in for approval.',
      to: '/bookings',
      system: {
        useCase: 'booking.settleAndCheckOut',
        records: [{ record: 'Folio posting', change: 'open to paid, linked to its cash-in' }, { record: 'Booking', change: 'Checked in to Checked out' }],
        ledger: [{ kind: 'cash_in', account: 'Cashbox for cash, bank otherwise', categoryId: 'cat-extra', category: 'Extra services', origin: 'front_desk', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'status', entity: 'booking' },
        refusals: [{ code: 'FOLIO_UNSETTLED', when: 'staff try a plain check-out while the folio still has a balance' }, { code: 'SETTLEMENT_PENDING', when: 'a check-out link is still waiting for the guest' }],
        reports: ['income'],
      },
    },
  ],
}

const STOCK_SHORT = { code: 'STOCK_SHORT', when: 'more would leave the villa store than it holds' }
const STOCK_FLOW: GuideFlow = {
  id: 'stock',
  title: 'Villa store from purchase to minibar bill',
  summary: 'Goods come in through a purchase that Finance approves, leave on turnovers, minibar checks and sales, and a count keeps the shelf honest.',
  steps: [
    {
      title: 'Receive a purchase',
      actor: 'manager',
      detail: 'Enter what arrived with the price paid and the receipt. On hand rises and the average cost, replayed from the movements in date order, takes in the price paid; the purchase goes for approval like any cash-out. The goods physically arrived, so they stay on hand while the cash-out waits and after a rejection.',
      to: '/stock?tab=receipts',
      system: {
        useCase: 'stock.receive',
        records: [{ record: 'Stock receipt', change: 'new' }, { record: 'Stock movement', change: 'one Receipt per item' }, { record: 'Stock item', change: 'average cost replayed' }],
        ledger: [{ kind: 'cash_out', account: 'Location cashbox for cash, BCA bank for transfer', categoryId: 'cat-minibar', category: 'Minibar stock', origin: 'stock', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'create', entity: 'stock-receipt' },
        refusals: [{ code: 'PROOF_REQUIRED', when: 'the purchase is above the proof threshold without a receipt' }, FORBIDDEN],
        reports: ['stock-on-hand', 'stock-movements'],
      },
    },
    {
      title: 'Fix a rejected purchase',
      actor: 'manager',
      detail: 'The receipt shows the rejection note. Its author or a manager corrects quantities, unit costs, payment method and receipt; the same cash-out goes back to the first approval level, and the corrected lines replace the old ones in the movements, so the average cost replays as if the receipt had come in right.',
      to: '/stock?tab=receipts',
      branches: [
        { label: 'Cancel instead', detail: 'The goods leave the store again at the price they came in, the average cost replays without the receipt, and the cash-out stays rejected for good. Refused, naming the day, when the store would run below zero without it.', tone: 'danger', to: '/stock?tab=receipts' },
      ],
      system: {
        useCase: 'stock.correctReceipt',
        records: [{ record: 'Stock receipt', change: 'lines, method and receipt replaced, or Cancelled' }, { record: 'Stock movement', change: 'receipt lines replaced, or one reversing Receipt per item' }, { record: 'Stock item', change: 'average cost replayed' }, { record: 'Transaction', change: 'Rejected to Submitted, or stays Rejected' }],
        approval: STD_APPROVAL,
        audit: { action: 'update', entity: 'stock-receipt' },
        refusals: [{ code: 'TRANSACTION_INVALID_STATE', when: 'the cash-out is not rejected, or the receipt was cancelled' }, STOCK_SHORT, { code: 'PROOF_REQUIRED', when: 'the corrected purchase is above the proof threshold without a receipt' }, FORBIDDEN],
        reports: ['stock-on-hand', 'stock-movements'],
      },
    },
    {
      title: 'Release a unit after turnover',
      actor: 'staff',
      detail: 'Marking the unit ready issues its room type’s amenity kit from the villa store.',
      to: '/housekeeping',
      branches: [{ label: 'Store short', detail: 'The unit is still released; the board note names what was missing and the item shows as low stock.', tone: 'warning', to: '/stock' }],
      system: { useCase: 'maintenance.setHousekeeping', records: [{ record: 'Housekeeping', change: 'Inspected to Ready' }, { record: 'Stock movement', change: 'one Issue per kit item' }], audit: { action: 'status', entity: 'housekeeping' }, reports: ['amenity-consumption'] },
    },
    {
      title: 'Check the minibar',
      actor: 'staff',
      detail: 'On a stay, enter what the guest took. The console delivers a minibar order on the stay and restocks the minibar to par from the store.',
      to: '/m',
      system: {
        useCase: 'stock.minibarCheck',
        records: [{ record: 'Room service order', change: 'new, Delivered, on the guest’s bill' }, { record: 'Stock movement', change: 'one Issue per item restocked' }],
        audit: { action: 'create', entity: 'service-order' },
        refusals: [STOCK_SHORT, { code: 'ORDER_NO_STAY', when: 'the guest is not in house' }],
        reports: ['minibar-sales', 'rs-revenue'],
      },
    },
    {
      title: 'Bill it at check-out',
      actor: 'staff',
      detail: 'The minibar order settles with the rest of room service, on its own or in the check-out payment.',
      to: '/bookings',
      system: { useCase: 'booking.settleAndCheckOut', records: [{ record: 'Payment', change: 'Paid now or Pending on one link' }], audit: { action: 'status', entity: 'booking' }, refusals: [{ code: 'SETTLEMENT_PENDING', when: 'a link is still waiting for the guest' }], reports: ['minibar-sales'] },
    },
    {
      title: 'Count the store',
      actor: 'manager',
      detail: 'Count the shelf; each difference posts as a count adjustment in the counter’s name, with its value.',
      to: '/stock?tab=counts',
      system: { useCase: 'stock.count', records: [{ record: 'Stock count', change: 'new' }, { record: 'Stock movement', change: 'one Count adjustment per difference' }], audit: { action: 'create', entity: 'stock-count' }, refusals: [{ code: 'VALIDATION_ERROR', when: 'a count is missing or negative' }], reports: ['stock-movements', 'stock-on-hand'] },
    },
    {
      title: 'Issue, transfer or write off',
      actor: 'manager',
      detail: 'Send stock to a unit or another villa store, or write it off with the reason.',
      to: '/stock?tab=movements',
      system: { useCase: 'stock.move', records: [{ record: 'Stock movement', change: 'Issue, Transfer (both stores) or Write-off' }], audit: { action: 'create', entity: 'stock-movement' }, refusals: [STOCK_SHORT], reports: ['stock-movements'] },
    },
  ],
}

export const GUIDE_FLOWS: readonly GuideFlow[] = [BOOKING_FLOW, BOOKING_CHANGE_FLOW, ROOM_TYPE_FLOW, RATE_PLAN_FLOW, AIRBNB_FLOW, REPAIR_FLOW, ROOM_SERVICE_FLOW, APPROVAL_FLOW, BOOKS_FLOW, PAYROLL_FLOW, LEAVE_FLOW, PREVENTIVE_FLOW, HOUSEKEEPING_FLOW, PETTY_FLOW, ACCESS_FLOW, FOLIO_FLOW, GROUP_FLOW, STOCK_FLOW]

const RULE = {
  overlap: 'Two stays never share a night on one unit.',
  scope: 'People see only the villas in their scope.',
  posted: 'Posted entries never change; reverse them instead.',
  self: 'The author of an entry cannot approve it.',
  levels: 'Each approval level waits for the one before it.',
  proof: 'Cash-outs above the proof threshold need a receipt before submit.',
  discount: 'A direct stay priced further under the listing than the policy limit needs someone who may approve bookings.',
  channel: 'Airbnb stays keep the price the channel sold; their rate and discounts are locked.',
  attachments: 'Images or PDF only, with a size and count limit; receipts lock once the entry posts.',
}

const CONNECTED: GuideFeature = { title: 'Connected operations', does: 'Booking changes, payments, refunds and job costs create their ledger entries on their own, and each record links to the others.', action: 'view', to: '/finance/transactions' }
const ATTACHMENTS: GuideFeature = { title: 'Proof attachments', does: 'Upload receipts, invoices and transfer proof as images or PDF, preview them, and show them to approvers.', action: 'create', rules: [RULE.attachments, RULE.proof], to: '/finance/transactions/new' }


export const GUIDE: readonly GuideEntry[] = [
  {
    slug: 'dashboard',
    title: 'Dashboard',
    module: 'dashboard',
    purpose: 'Revenue, occupancy, cash and what needs attention today, filtered by period and place.',
    to: '/',
    flows: [],
    features: [
      { title: 'Executive view', does: 'Revenue, occupancy, ADR, cash balance and payroll with their change against the last period.', action: 'view', to: '/' },
      { title: 'Operational view', does: 'Arrivals, departures, cleaning, open jobs and requests waiting.', action: 'view', to: '/' },
      { title: 'Filters', does: 'Period, location, villa, unit, source and a custom date range; cards or tables.', action: 'view', rules: [RULE.scope], to: '/' },
    ],
  },
  {
    slug: 'owner',
    title: 'Owner performance',
    module: 'reports',
    purpose: 'Net income, margin and villa ranking for the owner, with a printable monthly statement.',
    to: '/owner',
    flows: ['booking-payment'],
    features: [
      { title: 'Performance', does: 'Net income, revenue, margin, occupancy, ADR and RevPAR with the change against a chosen period.', action: 'view', to: '/owner' },
      { title: 'Villa detail', does: 'One villa’s units, six months of profit and loss, top costs, maintenance and payroll.', action: 'view', to: '/owner' },
      { title: 'Owner statement', does: 'A monthly statement per villa or for the portfolio, printable and exported to CSV.', action: 'report', to: '/owner/statement' },
    ],
  },
  {
    slug: 'property',
    title: 'Property',
    module: 'property',
    purpose: 'Locations, villas, room types and units with their status, facilities and blocks.',
    to: '/property',
    flows: ['rate-plan'],
    features: [
      { title: 'New property wizard', does: 'Six steps from the villa to room types, rooms, rate plans and facilities.', action: 'create', rules: ['Every room type leaves the wizard with a rate plan.'], to: '/property/new' },
      { title: 'Unit status', does: 'Active, cleaning, maintenance or inactive.', action: 'edit', rules: ['A unit with confirmed stays cannot be deactivated.'], to: '/property' },
      { title: 'Unit blocks', does: 'Take a unit off sale for a period.', action: 'edit', rules: ['A block cannot cover nights a guest holds.'], to: '/property' },
      { title: 'Sell a room type', does: 'For identical rooms, guests book the type and the operator assigns the room.', action: 'edit', rules: ['Only interchangeable rooms can sell as a type.', 'It cannot be switched off while stays wait for a room.'], to: '/property' },
      { title: 'Rate plan', does: 'The fallback price list of a room type: weekday and weekend rates and yearly seasons. Units without a live Airbnb listing sell direct at it.', action: 'edit', rules: ['A live Airbnb listing always prices direct stays first.', 'Stays already booked keep their price.', 'A room type without a plan starts one from the base price of the first unit added to it.', 'A unit with neither cannot be sold direct.'], to: '/property' },
    ],
  },
  {
    slug: 'airbnb',
    title: 'Airbnb',
    module: 'airbnb',
    purpose: 'Host accounts, one listing per unit and manual Airbnb booking entry with fee and payout.',
    to: '/airbnb',
    flows: ['airbnb-payout'],
    features: [
      { title: 'Host accounts', does: 'Each account with its listings, bookings and revenue.', action: 'view', to: '/airbnb' },
      { title: 'Listing price calendar', does: 'The base price, shared with the unit, and per-night prices for weekends and the high season. Direct stays sell at these prices.', action: 'edit', rules: ['Stays already booked keep the price they were sold at.'], to: '/airbnb' },
      { title: 'Airbnb booking entry', does: 'Record a reservation with the price Airbnb sold and its fee; the payout follows.', action: 'create', rules: [RULE.overlap, RULE.channel], to: '/bookings/new' },
    ],
  },
  {
    slug: 'booking',
    title: 'Booking',
    module: 'booking',
    purpose: 'Direct and Airbnb bookings with live availability, changes, payments and history.',
    to: '/bookings',
    flows: ['booking-payment', 'booking-change', 'room-type', 'guest-folio', 'group-booking'],
    features: [
      { title: 'New booking', does: 'Live availability with interchangeable alternatives and payment at booking.', action: 'create', rules: [RULE.overlap], to: '/bookings/new' },
      { title: 'Price from the Airbnb listing', does: 'A direct stay sells at the listing price per night, or at the room type’s rate plan when the unit has no live listing; staff can give a rate or a discount with a reason.', action: 'edit', rules: [RULE.discount, RULE.channel], to: '/bookings/new' },
      { title: 'Room type and room assignment', does: 'In villas with identical rooms the guest books the type and the front desk assigns the room before check-in.', action: 'edit', rules: ['Rooms of a type never sell past their count on any night.', 'Check-in needs an assigned room.'], to: '/calendar' },
      { title: 'Group bookings', does: 'Several units for one party on one form, all or nothing, with a lead guest, one deposit, group check-in and a master folio or a bill per stay.', action: 'create', rules: [RULE.overlap, 'One unit taken refuses the whole group.', 'On a master folio the last stay leaves only once the group has paid its rooms.', RULE.discount], to: '/bookings/groups' },
      { title: 'Calendar', does: 'Every unit across a free date range, pinned to today.', action: 'view', to: '/calendar' },
      { title: 'Unit swap and stay change', does: 'Move a guest to an interchangeable unit or change the dates, with history and actor.', action: 'edit', rules: ['Only interchangeable units can swap.', 'A finished stay is final.'], to: '/bookings' },
      { title: 'Lifecycle', does: 'Confirmed, checked in, checked out, cancelled or no-show.', action: 'edit', to: '/bookings' },
      { title: 'Invoice', does: 'Printable invoice with payments and balance.', action: 'view', to: '/bookings' },
      { title: 'Guest folio', does: 'Every debit and credit of the stay with a running balance, filtered by kind and printable. Staff post charges on a code and rebates on a posted line; a credit shows Refund due and goes back against its payment; check-out takes the folio balance.', action: 'edit', rules: ['Rebates past the discount limit share of the line need someone who may approve bookings.', 'A delivery is voided only on its business day; later a rebate corrects it.', 'A plain check-out is refused while the folio has a balance.'], to: '/bookings' },
      { title: 'Settle and check out', does: 'The check-out takes the room balance, unpaid room service and departure charges in one payment, then closes the stay; a QRIS, VA or card link closes it when the guest pays.', action: 'edit', rules: ['Airbnb stays settle only what the villa sold; Airbnb pays the room out.', 'A plain check-out is refused while room service is unpaid or a check-out link waits.'], to: '/bookings' },
      CONNECTED,
    ],
  },
  {
    slug: 'guest',
    title: 'Guest',
    module: 'guest',
    purpose: 'Guest profiles, stay history and the check-in and check-out checklists.',
    to: '/guests',
    flows: [],
    features: [
      { title: 'Profiles', does: 'Contact details and every stay.', action: 'view', to: '/guests' },
      { title: 'Check-in and check-out', does: 'Checklists with deposit and departure charges, also on the phone.', action: 'edit', to: '/m' },
    ],
  },
  {
    slug: 'services',
    title: 'Room services',
    module: 'services',
    purpose: 'A menu per villa that guests order from their room or the desk orders for them; delivered orders go on the bill and into the books.',
    to: '/services/orders',
    flows: ['room-service'],
    features: [
      { title: 'Service menu', does: 'Food, breakfast, laundry, transfers, spa, tours, extras per villa, with price, unit, serving hours, notice and photo.', action: 'catalog', rules: ['Only people with Edit menu change prices and items.'], to: '/services/catalog' },
      { title: 'Service partners', does: 'Spa therapists, drivers and tour operators with what they bill per item, so each item shows its margin.', action: 'catalog', to: '/services/catalog' },
      { title: 'Desk orders', does: 'Order for a stay in house or arriving within three days, with notes, an urgent flag and a discount.', action: 'create', rules: ['A discount past the policy limit needs someone who may approve bookings.'], to: '/services/orders/new' },
      { title: 'On the house', does: 'Give items free with a reason; the guest pays nothing and the partner is still paid.', action: 'comp', rules: ['Needs the Give free permission.'], to: '/services/orders/new' },
      { title: 'Guest ordering by QR', does: 'A printed card per room opens that room’s menu for whoever stays; the guest orders, follows the status and pays by QRIS.', action: 'view', rules: ['Items only at their serving hours and with their notice.'], to: '/services/qr' },
      { title: 'Order board', does: 'New, accepted, preparing and delivered columns, late orders flagged after 30 minutes, on the desk and the phone.', action: 'edit', to: '/services/orders' },
      { title: 'Guest bill', does: 'Delivered orders show on the booking and the invoice; check-out waits until they are paid.', action: 'view', to: '/services/orders' },
      { title: 'Into the books', does: 'Payments book income per category for approval; partner bills go out as cash-outs on delivery.', action: 'view', rules: [RULE.posted, RULE.self], to: '/finance/transactions' },
      { title: 'Requests', does: 'Free requests such as towels, cleaning and repairs on their own board.', action: 'view', rules: ['A closed request can no longer change.'], to: '/services' },
    ],
  },
  {
    slug: 'maintenance',
    title: 'Maintenance',
    module: 'maintenance',
    purpose: 'Work orders, preventive plans, assets and vendors, with every cost through approval.',
    to: '/maintenance',
    flows: ['work-order-expense', 'preventive'],
    features: [
      { title: 'Work orders', does: 'Jobs on units or assets with photos, assignment and an optional unit block.', action: 'create', to: '/maintenance/work-orders' },
      { title: 'Expense lines', does: 'Parts, vendor invoices and labour, each a cash-out through approval.', action: 'submit', rules: [RULE.self, RULE.proof], to: '/maintenance/work-orders' },
      { title: 'Preventive plans', does: 'Recurring care that opens jobs when due.', action: 'edit', to: '/maintenance/preventive' },
      { title: 'Assets and vendors', does: 'Warranty, repair cost to date and vendor spend.', action: 'view', to: '/maintenance/assets' },
      ATTACHMENTS,
    ],
  },
  {
    slug: 'housekeeping',
    title: 'Housekeeping',
    module: 'maintenance',
    purpose: 'The board that takes each unit from dirty to ready, with an inspection checklist.',
    to: '/housekeeping',
    flows: ['housekeeping'],
    features: [
      { title: 'Board', does: 'Dirty, cleaning, inspection and ready columns per location.', action: 'view', to: '/housekeeping' },
      { title: 'Inspection', does: 'A checklist decides whether the unit is ready.', action: 'edit', rules: ['A unit moves one stage at a time.'], to: '/housekeeping' },
      { title: 'Phone board', does: 'Housekeeping updates units from the front desk app.', action: 'edit', to: '/m/housekeeping' },
    ],
  },
  {
    slug: 'payments',
    title: 'Payments',
    module: 'payments',
    purpose: 'Deposits, balances, payment links, Airbnb payouts and refunds, each landing as a cash-in.',
    to: '/payments',
    flows: ['booking-payment', 'booking-change', 'airbnb-payout'],
    features: [
      { title: 'Desk payments', does: 'Cash and bank transfer recorded at once.', action: 'create', rules: ['A booking cannot be paid beyond its total.'], to: '/payments/list' },
      { title: 'Payment links', does: 'QRIS, virtual account and card through a guest checkout with an expiry.', action: 'create', to: '/pay/demo-qris' },
      { title: 'Receivables', does: 'Balances due, aged by days.', action: 'view', to: '/payments/receivables' },
      { title: 'Airbnb payouts', does: 'Expected payouts matched against the bank.', action: 'edit', to: '/payments/payouts' },
      { title: 'Refunds', does: 'Money back from the payment that brought it in.', action: 'submit', rules: ['Only paid money goes back, and a refund cannot be refunded.'], to: '/payments/list' },
      { title: 'Payment policy', does: 'Deposit percent, link expiry and gateway fees.', action: 'edit', to: '/payments/settings' },
      ATTACHMENTS,
    ],
  },
  {
    slug: 'finance',
    title: 'Finance',
    module: 'finance',
    purpose: 'Cashboxes and bank, cash in and out, transfers, adjustments, reconciliation and posting.',
    to: '/finance',
    flows: ['booking-payment', 'work-order-expense', 'approval-chain', 'petty-cash'],
    features: [
      { title: 'Cash in and cash out', does: 'Entries with category, reference and proof.', action: 'create', rules: [RULE.scope, RULE.posted], to: '/finance/transactions/new' },
      { title: 'Cash transfer', does: 'Two linked entries move money between accounts.', action: 'create', to: '/finance/transfer' },
      { title: 'Petty cash per villa', does: 'A float per villa with its custodian, spends with receipts, top-ups through approval, counts and a low-balance alert.', action: 'create', rules: ['Every petty cash spend needs a receipt while the receipt rule is on.', RULE.scope], to: '/finance/petty-cash' },
      { title: 'Posting and reversal', does: 'Posting moves the balance; a reversal cancels a posted entry.', action: 'post', rules: [RULE.posted], to: '/finance/transactions' },
      { title: 'Categories', does: 'Categories per villa; system categories stay active.', action: 'edit', to: '/finance/categories' },
      CONNECTED,
      ATTACHMENTS,
    ],
  },
  {
    slug: 'accounting',
    title: 'Accounting',
    module: 'finance',
    purpose: 'Double-entry books behind the cash ledger: chart of accounts, journals, general ledger, statements and month closing.',
    to: '/accounting',
    flows: ['books'],
    features: [
      { title: 'Chart of accounts', does: 'One account per cashbox, bank and petty cash, plus receivables, deposits, payables, BPJS and PPh 21, equity, room revenue, room service revenue per department (4210 to 4270), other income and expenses.', action: 'view', to: '/accounting' },
      { title: 'Transaction codes', does: 'Every folio line carries a code (ROOM, FNB, MINI, LDRY, TRNS, SPA, TOUR, XTRA, LATE, DMG, and a code per payment method). A charge code names the revenue account its lines book to; finance adds, edits and retires codes, with revenue by code and department in the reports.', action: 'edit', rules: ['A new account applies to postings from then on; posted journals stay.', 'ROOM and the payment codes stay active.', 'Guest revenue categories follow their code; the Categories page maps the rest.'], to: '/accounting/transaction-codes' },
      { title: 'Automatic journals', does: 'Posting, reversal, transfers, adjustments, cash counts, payroll close, check-out, folio charges and room service delivery write balanced entries with a link to their record.', action: 'view', rules: ['Journals are never edited; corrections go through the reversal of the cash entry.', 'Debits always equal credits.'], to: '/accounting/journals' },
      { title: 'General ledger', does: 'Each account’s lines with a running balance, by range and villa.', action: 'view', to: '/accounting/ledger' },
      { title: 'Statements', does: 'Trial balance, income statement and balance sheet by period and villa, with CSV through the reports.', action: 'report', to: '/accounting/balance-sheet' },
      { title: 'Receivables and partner payables', does: 'Room money waits on Guest deposits until check-out bills the room on the stay’s receivable; delivered orders and folio charges bill it as they happen; delivered partner costs wait on the partner payable until the bill is paid. Balances per stay and per partner.', action: 'report', rules: ['A settled stay ends with its receivable at zero.'], to: '/reports/stay-receivables' },
      { title: 'Manual journals', does: 'Balanced adjusting entries with memo and evidence through the approval chain, signed from the approval inbox.', action: 'create', rules: ['Cash and bank accounts move through cash entries only.', RULE.self], to: '/accounting/manual' },
      { title: 'Period close', does: 'Close an ended month so nothing posts into it; reopen with a reason.', action: 'post', rules: ['A month closes only when nothing dated in it waits for approval.'], to: '/accounting/periods' },
    ],
  },
  {
    slug: 'approval',
    title: 'Approval',
    module: 'approval',
    purpose: 'Rules by kind, villa and amount with multi-level chains and an inbox per role.',
    to: '/approvals',
    flows: ['approval-chain'],
    features: [
      { title: 'Inbox', does: 'Cash entries and manual journals that wait for your signature, with proof and history.', action: 'approve', rules: [RULE.self, RULE.levels], to: '/approvals' },
      { title: 'Reject with a note', does: 'The author corrects and resubmits.', action: 'approve', rules: ['A rejection needs a reason.'], to: '/approvals' },
      { title: 'Approval rules', does: 'Levels per kind, villa and amount; the most specific rule wins.', action: 'edit', to: '/master/approval-rules' },
    ],
  },
  {
    slug: 'hr',
    title: 'HR',
    module: 'hr',
    purpose: 'Employees, roster, attendance, leave, overtime, loans, KPI and announcements.',
    to: '/hr',
    flows: ['leave-overtime'],
    features: [
      { title: 'Employees', does: 'Records with villa allocation.', action: 'create', to: '/hr/employees' },
      { title: 'Roster and attendance', does: 'Shifts per day and the attendance against them.', action: 'edit', to: '/hr/roster' },
      { title: 'Leave and overtime', does: 'Requests with approval.', action: 'approve', rules: ['A decided request can no longer change.'], to: '/hr/leave' },
      { title: 'Loans and advances', does: 'Instalments come off payroll.', action: 'approve', to: '/hr/loans' },
      { title: 'KPI and announcements', does: 'Quarterly reviews and notices to staff.', action: 'edit', to: '/hr/kpi' },
    ],
  },
  {
    slug: 'payroll',
    title: 'Payroll',
    module: 'payroll',
    purpose: 'Monthly periods from salary to PPh 21, closed into one bank entry with payslips.',
    to: '/payroll',
    flows: ['payroll', 'leave-overtime'],
    features: [
      { title: 'Calculate a period', does: 'Every component per employee.', action: 'create', rules: ['One payroll per month.'], to: '/payroll' },
      { title: 'Approve and close', does: 'Closing posts the bank entry and loan repayments.', action: 'approve', rules: ['The person who calculated it cannot approve it.', 'A closed payroll reopens only with a reason.'], to: '/payroll' },
      { title: 'Settings', does: 'BPJS, tax, service charge and overtime rates.', action: 'edit', to: '/payroll/settings' },
    ],
  },
  {
    slug: 'me',
    title: 'Employee area',
    module: 'me',
    purpose: 'Each employee’s attendance, shifts, leave balance, requests, payslips and KPI.',
    to: '/me',
    flows: ['leave-overtime'],
    features: [
      { title: 'Home', does: 'Today’s shift, attendance, leave balance and the latest payslip.', action: 'view', to: '/me' },
      { title: 'Requests', does: 'Leave, overtime and loans.', action: 'create', to: '/me/requests' },
      { title: 'Payslips', does: 'Published payslips to view and print.', action: 'view', to: '/me/payslips' },
    ],
  },
  {
    slug: 'reports',
    title: 'Reports',
    module: 'reports',
    purpose: `${REPORTS.length} management reports with date, scope and status filters and CSV export.`,
    to: '/reports',
    flows: [],
    features: REPORT_GROUPS.map((g) => {
      const mine = REPORTS.filter((r) => r.group === g)
      return { title: `${REPORT_GROUP_LABEL[g]} reports`, does: `${mine.length} reports: ${mine.map((r) => r.title).join(', ')}.`, action: 'report' as const, to: `/reports?group=${g}` }
    }),
  },
  {
    slug: 'access',
    title: 'Access and security',
    module: 'access',
    purpose: 'Sign-in, users, the role matrix, villa scope and the audit trail.',
    to: '/access/users',
    flows: ['access'],
    features: [
      { title: 'Users', does: 'Logins with role, scope and status.', action: 'create', rules: ['You cannot change your own role or deactivate yourself.'], to: '/access/users' },
      { title: 'Roles and permissions', does: 'Each action per module per role.', action: 'edit', rules: ['Only the owner changes the owner’s permissions.'], to: '/access/roles' },
      { title: 'Audit trail', does: 'Who did what, with before and after values.', action: 'view', to: '/access/audit' },
    ],
  },
  {
    slug: 'master',
    title: 'Master data',
    module: 'master',
    purpose: 'One page per reference table, from locations to shifts.',
    to: '/master',
    flows: [],
    features: [
      { title: 'Reference tables', does: 'Locations, villas, room types, units, accounts, listings, cash accounts and categories.', action: 'edit', to: '/master' },
      { title: 'Approval rules and shifts', does: 'The chains and the shift times the other modules use.', action: 'edit', to: '/master/approval-rules' },
    ],
  },
  {
    slug: 'stock',
    title: 'Stock',
    module: 'maintenance',
    purpose: 'Minibar goods, guest amenities and linen per villa store, with purchases through approval.',
    to: '/stock',
    flows: ['stock'],
    features: [
      { title: 'Villa stores', does: 'On hand and value per villa, from every movement, with low items flagged.', action: 'view', to: '/stock' },
      { title: 'Receipts', does: 'Purchases booked in with the price paid; each is a cash-out through approval, and each receipt shows its status and any rejection note.', action: 'submit', rules: [RULE.proof, RULE.self, 'Goods stay on hand while the cash-out waits or is rejected.'], to: '/stock?tab=receipts' },
      { title: 'Fix a rejected purchase', does: 'Correct the lines and receipt and resubmit the same cash-out, or cancel the purchase and take the goods back out.', action: 'submit', rules: ['Only the author or a manager.', 'Nothing already used can be taken back.'], to: '/stock?tab=receipts' },
      { title: 'Issue, transfer, write-off', does: 'Stock to a unit or another store, or written off with a reason.', action: 'edit', rules: ['Nothing leaves a store it is not in.'], to: '/stock?tab=movements' },
      { title: 'Counts', does: 'Shelf counts post the variance as adjustments, with its value.', action: 'edit', to: '/stock?tab=counts' },
      { title: 'Amenity kits', does: 'What each room type gets when it is released after turnover.', action: 'edit', rules: ['A short store warns and never blocks housekeeping.'], to: '/stock?tab=kits' },
      { title: 'Minibar check', does: 'What the guest took becomes a delivered minibar order on the stay.', action: 'view', to: '/m' },
    ],
  },
  {
    slug: 'front-desk',
    title: 'Front desk app',
    module: 'dashboard',
    purpose: 'The phone app for today’s arrivals, free nights, services, cashbox and housekeeping.',
    to: '/m',
    flows: ['housekeeping'],
    features: [
      { title: 'Today', does: 'Arrivals and departures with check-in and check-out.', action: 'view', to: '/m' },
      { title: 'Free nights', does: 'Availability across units.', action: 'view', to: '/m/availability' },
      { title: 'Cashbox', does: 'Desk cash in and out.', action: 'view', to: '/m/cash' },
      { title: 'Payments and jobs', does: 'Payments, work orders and the housekeeping board.', action: 'view', to: '/m/payments' },
    ],
  },
]

export const guideEntry = (slug: string) => GUIDE.find((e) => e.slug === slug)
export const guideFlow = (id: string) => GUIDE_FLOWS.find((f) => f.id === id)

/** Roles the default matrix lets take the action in the module. */
export const rolesFor = (module: Module, action: Action) => ROLES.filter((r) => can(DEFAULT_PERMISSIONS, r, module, action))

/** Every link the guide shows, for the route check. */
export const guideLinks = () => [
  ...GUIDE.flatMap((e) => [e.to, ...e.features.map((f) => f.to)]),
  ...GUIDE_FLOWS.flatMap((f) => f.steps.flatMap((s) => [s.to, ...(s.branches ?? []).map((b) => b.to)])),
].filter((to): to is string => Boolean(to))

/** What one module hands to another; the system map draws these. */
export interface GuideConnection {
  from: string
  to: string
  carries: string
  flows: readonly string[]
}

export const GUIDE_CONNECTIONS: readonly GuideConnection[] = [
  { from: 'property', to: 'booking', carries: 'Units, room types and blocks decide what can be sold; some room types sell by type with the room assigned later.', flows: ['booking-payment', 'room-type'] },
  { from: 'airbnb', to: 'booking', carries: 'Airbnb reservations with the price Airbnb sold and its fee, and the listing price every direct stay starts from.', flows: ['airbnb-payout', 'booking-change'] },
  { from: 'booking', to: 'payments', carries: 'Totals, deposits and balances due; every change recalculates them.', flows: ['booking-payment', 'booking-change'] },
  { from: 'payments', to: 'finance', carries: 'Each paid payment, payout and refund as a submitted entry, plus gateway fees.', flows: ['booking-payment', 'booking-change', 'airbnb-payout'] },
  { from: 'services', to: 'finance', carries: 'Paid room service as income per category, and partner bills as cash-outs.', flows: ['room-service'] },
  { from: 'services', to: 'booking', carries: 'Delivered orders on the guest’s bill; check-out waits for them.', flows: ['room-service'] },
  { from: 'maintenance', to: 'finance', carries: 'Work order expense lines as cash-outs with receipts.', flows: ['work-order-expense'] },
  { from: 'booking', to: 'housekeeping', carries: 'Check-outs mark units dirty.', flows: ['housekeeping'] },
  { from: 'housekeeping', to: 'booking', carries: 'Ready units return to sale.', flows: ['housekeeping'] },
  { from: 'maintenance', to: 'property', carries: 'Open jobs block units.', flows: ['work-order-expense', 'preventive'] },
  { from: 'stock', to: 'finance', carries: 'Stock purchases as cash-outs with receipts.', flows: ['stock'] },
  { from: 'housekeeping', to: 'stock', carries: 'Released units take their amenity kit from the villa store.', flows: ['stock'] },
  { from: 'stock', to: 'services', carries: 'Minibar checks as delivered orders on the guest’s bill.', flows: ['stock'] },
  { from: 'me', to: 'hr', carries: 'Leave, overtime and loan requests.', flows: ['leave-overtime'] },
  { from: 'hr', to: 'payroll', carries: 'Attendance, approved overtime, unpaid leave and loan instalments.', flows: ['leave-overtime', 'payroll'] },
  { from: 'payroll', to: 'finance', carries: 'The closed period as one posted salary entry.', flows: ['payroll'] },
  { from: 'finance', to: 'approval', carries: 'Submitted entries waiting for the signatures their rule needs.', flows: ['approval-chain'] },
  { from: 'approval', to: 'finance', carries: 'Approved entries ready to post, rejected ones back to the author.', flows: ['approval-chain'] },
  { from: 'finance', to: 'accounting', carries: 'Each posted entry, transfer and adjustment as a balanced journal entry.', flows: ['books'] },
  { from: 'payroll', to: 'accounting', carries: 'The closed payroll as wages against cash and the BPJS and PPh 21 payables, which the statutory remittances pay down.', flows: ['books', 'payroll'] },
  { from: 'booking', to: 'accounting', carries: 'Check-out bills the folio on the stay’s receivable and moves the deposits held onto it.', flows: ['books'] },
  { from: 'services', to: 'accounting', carries: 'Delivered partner costs on the partner payables.', flows: ['books'] },
  { from: 'accounting', to: 'approval', carries: 'Submitted manual journals waiting for the signatures their total needs.', flows: ['books', 'approval-chain'] },
  { from: 'accounting', to: 'reports', carries: 'Trial balance, income statement, balance sheet and the general journal.', flows: ['books'] },
  { from: 'finance', to: 'reports', carries: 'Posted entries feed cash, income, expense and profit and loss.', flows: ['booking-payment', 'work-order-expense'] },
  { from: 'reports', to: 'owner', carries: 'Net income, margin and villa ranking.', flows: ['booking-payment'] },
  { from: 'finance', to: 'dashboard', carries: 'Cash balance and revenue tiles, and petty cash running low.', flows: ['petty-cash'] },
  { from: 'access', to: 'dashboard', carries: 'Role and villa scope limit every page and use case.', flows: ['access'] },
]

/** A record's lifecycle; transitions come from the domain tables where they exist. */
export interface StateMachine {
  id: string
  record: string
  states: ReadonlyArray<{ id: string; label: string }>
  transitions: ReadonlyArray<{ from: string; to: string; via?: string }>
}

function machine<S extends string>(id: string, record: string, labels: Record<S, string>, table: Record<S, readonly S[]>, extra: StateMachine['transitions'] = []): StateMachine {
  const ids = Object.keys(table) as S[]
  return {
    id,
    record,
    states: ids.map((s) => ({ id: s, label: labels[s] })),
    transitions: [...ids.flatMap((from) => table[from].map((to) => ({ from, to: to as string }))), ...extra],
  }
}

/** Payments have no domain table; these are the moves the gateway, the desk and refunds make. */
const PAYMENT_MOVES: Record<PaymentStatus, readonly PaymentStatus[]> = { pending: ['paid', 'failed', 'expired', 'cancelled'], paid: ['refunded'], failed: [], expired: [], refunded: [], cancelled: [] }

export const STATE_MACHINES: readonly StateMachine[] = [
  machine('booking', 'Booking', BOOKING_STATUS_LABEL, BOOKING_TRANSITIONS),
  machine('payment', 'Payment', PAYMENT_STATUS_LABEL, PAYMENT_MOVES),
  machine('transaction', 'Transaction', TRANSACTION_STATUS_LABEL, TRANSACTION_TRANSITIONS, [{ from: 'posted', to: 'reversed', via: 'Reverse' }]),
  machine('work-order', 'Work order', WORK_ORDER_STATUS_LABEL, WORK_ORDER_TRANSITIONS),
  machine('service-order', 'Room service order', ORDER_STATUS_LABEL, ORDER_TRANSITIONS),
  machine('payroll', 'Payroll period', PAYROLL_STATUS_LABEL, PAYROLL_TRANSITIONS),
  machine('leave', 'Leave request', REQUEST_STATUS_LABEL, REQUEST_TRANSITIONS),
  machine('housekeeping', 'Housekeeping', HOUSEKEEPING_LABEL, HOUSEKEEPING_TRANSITIONS),
]

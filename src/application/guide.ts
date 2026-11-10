import { DEFAULT_PERMISSIONS, ROLES, can, type Action, type AuditAction, type Module, type Role } from '@/domain/access'
import { BOOKING_STATUS_LABEL, TRANSITIONS as BOOKING_TRANSITIONS } from '@/domain/booking'
import { TRANSACTION_STATUS_LABEL, TRANSACTION_TRANSITIONS, type TransactionKind, type TransactionOrigin } from '@/domain/finance'
import { REQUEST_STATUS_LABEL, REQUEST_TRANSITIONS } from '@/domain/hr'
import { SHIFT_STATUS_LABEL, SHIFT_TRANSITIONS } from '@/domain/cashier'
import { TASK_STATUS_LABEL, TASK_TRANSITIONS } from '@/domain/housekeeping'
import { HOUSEKEEPING_LABEL, HOUSEKEEPING_TRANSITIONS, WORK_ORDER_STATUS_LABEL, WORK_ORDER_TRANSITIONS } from '@/domain/maintenance'
import { LOST_STATUS_LABEL, LOST_TRANSITIONS } from '@/domain/lostFound'
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
      detail: 'Pick one of the rooms free for every night; the bell lists stays arriving within two weeks without one. The room can change until check-in. A restriction set on that room alone, such as a stop sell, shows in the form and refuses a direct stay unless a villa manager sells past it with a reason, kept on the booking.',
      to: '/calendar',
      system: {
        useCase: 'booking.assignUnit',
        records: [{ record: 'Booking', change: 'room set; direct stays repriced from that room’s listing for new nights only; restriction note added on an override or a channel warning' }],
        audit: { action: 'update', entity: 'booking' },
        refusals: [{ code: 'BOOKING_OVERLAP', when: 'the room is held on one of the nights' }, { code: 'UNIT_NOT_INTERCHANGEABLE', when: 'the room is of another type' }, { code: 'BOOKING_INVALID_STATE', when: 'the guest has checked in' }, { code: 'RESTRICTION_VIOLATED', when: 'a direct stay meets a rule set on that room and no override was given' }, { code: 'RESTRICTION_OVERRIDE_FORBIDDEN', when: 'someone who neither approves bookings nor manages a villa asks to sell past it' }],
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
        refusals: [
          { code: 'GROUP_UNAVAILABLE', when: 'any unit or room type is taken on one of its nights, by another stay or by an earlier stay of the same group' },
          { code: 'DISCOUNT_LIMIT', when: 'the group discount or a stay’s price passes the discount limit and the person may not approve bookings' },
          { code: 'RESTRICTION_VIOLATED', when: 'a stay breaks a stay restriction and no override was given' },
          { code: 'GUEST_BLACKLISTED', when: 'the lead guest is blacklisted and no override reason is given' },
        ],
        reports: ['group-bookings', 'bookings'],
      },
    },
    {
      title: 'Add a stay to the group',
      actor: 'reservation',
      detail: 'Add a unit to a group with a stay still to come. The form lists any stay restriction the new stay breaks; a villa manager may sell past it with a reason, and a blacklisted lead needs the manager’s reason again.',
      to: '/bookings/groups',
      system: {
        useCase: 'groups.addStay',
        records: [{ record: 'Booking', change: 'new, pointing at the group, with the restriction note on an override' }],
        audit: { action: 'update', entity: 'booking-group' },
        refusals: [{ code: 'GROUP_UNAVAILABLE', when: 'the unit is taken on one of the nights' }, { code: 'RESTRICTION_VIOLATED', when: 'the stay breaks a stay restriction and no override was given' }, { code: 'RESTRICTION_OVERRIDE_FORBIDDEN', when: 'someone who neither approves bookings nor manages a villa asks to sell past it' }, { code: 'GUEST_BLACKLISTED', when: 'the lead guest is blacklisted and no override reason is given' }],
        reports: ['group-bookings'],
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

const OVERRIDE = { code: 'RESTRICTION_OVERRIDE_FORBIDDEN', when: 'someone who neither approves bookings nor manages a villa asks to sell past a restriction' }

const RESTRICTION_FLOW: GuideFlow = {
  id: 'stay-restrictions',
  title: 'Stay restrictions',
  summary: 'Minimum and maximum stay, closed to arrival or departure and stop sell per room type or unit. New direct stays and changes meet them; a manager can sell past them with a reason; Airbnb stays come in with a warning.',
  steps: [
    {
      title: 'Set restrictions on a room type',
      actor: 'manager',
      detail: 'On the room type page: a rule, a range that comes back every year or runs once, optional days of the week, and one unit or the whole type.',
      to: '/property',
      system: {
        useCase: 'stayRules.save',
        records: [{ record: 'Restriction', change: 'new or changed; stays already booked keep their dates' }],
        audit: { action: 'create', entity: 'restriction' },
        refusals: [FORBIDDEN, { code: 'VALIDATION_ERROR', when: 'the nights are missing, a date does not exist, the range ends before it starts, or the unit is not a room of the type' }],
      },
    },
    {
      title: 'Bulk edit a season',
      actor: 'manager',
      detail: 'On Stay restrictions: one rule over a date range and days of the week for several room types at once, all or nothing.',
      to: '/property/restrictions',
      system: { useCase: 'stayRules.bulk', records: [{ record: 'Restriction', change: 'one per room type picked' }], audit: { action: 'create', entity: 'restriction' }, refusals: [FORBIDDEN, { code: 'VALIDATION_ERROR', when: 'no room type is picked' }] },
    },
    {
      title: 'See the rules while booking',
      actor: 'reservation',
      detail: 'The new booking shows three weeks of dates with Closed, CTA, CTD and Min marks, and lists every rule the stay breaks before saving.',
      to: '/bookings/new',
      system: { useCase: 'stayRules.check', records: [{ record: 'Booking', change: 'none yet; the check reads the restrictions' }] },
    },
    {
      title: 'Book or sell past them',
      actor: 'manager',
      detail: 'A direct stay, a change of dates, a group, a stay added to a group or a room assigned under its own rule that breaks a rule is refused with the rules listed. A villa manager, or anyone who approves bookings, may sell past them with a reason; the booking keeps the override. Airbnb stays are never refused and carry a warning badge.',
      to: '/bookings/new',
      branches: [{ label: 'Guest in house leaves early', detail: 'A shorter stay for a guest already checked in is never held to the minimum.', tone: 'info' }],
      system: {
        useCase: 'booking.create',
        records: [{ record: 'Booking', change: 'restriction note: override with reason, or channel warning' }],
        audit: { action: 'update', entity: 'booking' },
        refusals: [{ code: 'RESTRICTION_VIOLATED', when: 'the stay breaks a stop sell, CTA, CTD, minimum or maximum stay and no override was given' }, OVERRIDE],
        reports: ['restriction-overrides'],
      },
    },
  ],
}

const WALK_FLOW: GuideFlow = {
  id: 'overbooking-walk',
  title: 'Overbooking and walking a guest',
  summary: 'A room type that sells by type may take a set number of stays a night past its rooms. When a night is still overbooked on the arrival day, the desk walks a guest and the cost goes for approval.',
  steps: [
    {
      title: 'Set the overbooking policy',
      actor: 'manager',
      detail: 'On the room type page: stays a night the type may sell past its rooms, 0 by default. Rooms sold one by one never overbook.',
      to: '/property/restrictions',
      system: { useCase: 'stayRules.setOverbooking', records: [{ record: 'Overbooking policy', change: 'limit per room type' }], audit: { action: 'update', entity: 'overbooking' }, refusals: [FORBIDDEN, { code: 'OVERBOOK_ROOM_BY_ROOM', when: 'the room type sells room by room' }] },
    },
    {
      title: 'Sell past the rooms',
      actor: 'reservation',
      detail: 'Room-type stays keep selling until the night holds the rooms plus the policy. The calendar marks the night Overbooked on the room type row, and the dashboard and the bell raise it.',
      to: '/calendar',
      system: { useCase: 'booking.create', records: [{ record: 'Booking', change: 'new, waiting for a room' }], refusals: [{ code: 'ROOM_TYPE_FULL', when: 'the night already holds the rooms plus the policy' }], tiles: ['Overbooked'] },
    },
    {
      title: 'Walk a guest',
      actor: 'staff',
      detail: 'On the arrival day the booking page offers Walk guest: move them to a free unit of another villa or room type, or send them to an outside property and cancel the stay with everything paid given back. Record the cost, the compensation and the reason.',
      to: '/bookings',
      system: {
        useCase: 'stayRules.walk',
        records: [{ record: 'Walk', change: 'new' }, { record: 'Booking', change: 'moved to the new unit, or Cancelled with a full refund' }],
        ledger: [{ kind: 'cash_out', account: 'Cashbox or bank', categoryId: 'cat-relocation', category: 'Guest relocation', origin: 'front_desk', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'create', entity: 'walk' },
        refusals: [{ code: 'WALK_NOT_ALLOWED', when: 'the stay is not a confirmed arrival for today' }, { code: 'WALK_NOT_OVERBOOKED', when: 'the room type is not overbooked tonight' }, { code: 'PROOF_REQUIRED', when: 'the cost is above the proof threshold without a receipt' }],
        reports: ['guest-walks'],
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
      detail: 'Posting a fully signed entry writes its journal: the cash account against the account its category books to. A transfer writes one entry for both halves; a reversal writes the reversing entry. Room money linked to a stay books to Guest deposits until its room is first billed (the first night audit, or check-out) and to its receivable after; money for room service and charges pays the stay’s receivable at once; a partner bill pays the partner payable down.',
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
      detail: 'The night audit bills the room night by night. Check-out bills only the nights no audit reached (a same-day check-out after the last audit), Airbnb’s fee as a cost taken off the receivable on an Airbnb stay, and any deposits still held. Departure charges book on the DMG code the same day; the money taken at check-out settles the receivable to zero.',
      to: '/bookings',
      system: { useCase: 'booking.settleAndCheckOut', records: [{ record: 'Journal entry', change: 'new, source Guest folio' }], audit: { action: 'status', entity: 'booking' }, refusals: [{ code: 'PERIOD_CLOSED', when: 'today falls in a closed month' }], reports: ['stay-receivables', 'income-statement'] },
    },
    {
      title: 'Bill the room at the night audit',
      actor: 'manager',
      detail: 'Each night audit posts that night’s room for every stay in house: Dr the stay’s receivable, Cr the ROOM code’s account, at the night’s list or staff rate less its share of the discount (an Airbnb stay at the channel price). The first night moves the deposits held onto the receivable; room money after it pays the receivable directly. A rate change on posted nights books the difference.',
      to: '/night-audit',
      system: { useCase: 'nightAudit.run', records: [{ record: 'Journal entry', change: 'new, source Night audit, one per stay' }], audit: { action: 'create', entity: 'night-audit' }, refusals: [{ code: 'PERIOD_CLOSED', when: 'the business date falls in a closed month' }], reports: ['stay-receivables', 'revenue-codes', 'income-statement'] },
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

const NIGHT_AUDIT_FLOW: GuideFlow = {
  id: 'night-audit',
  title: 'Night audit',
  summary: 'The close of the business day: the checklist, no-shows, tonight’s room on every stay in house, and the business date rolled forward.',
  steps: [
    {
      title: 'Work the checklist',
      actor: 'reservation',
      detail: 'Arrivals not checked in, departures not checked out, payment links still open, orders not delivered, room-type stays without a room and cashboxes not counted, each with a link to where it is handled. The phone shows the same list read-only.',
      to: '/night-audit',
      system: { useCase: 'nightAudit.overview', refusals: [FORBIDDEN] },
    },
    {
      title: 'Run the audit',
      actor: 'manager',
      detail: 'Arrivals still not checked in go through the no-show path (links closed, the policy keeps what was paid). Every stay in house gets tonight’s room on its folio and receivable on the ROOM code, a late check-in catching up the nights it missed, and a master-billed group’s nights on its master folio. The business date moves a day forward.',
      to: '/night-audit',
      system: {
        useCase: 'nightAudit.run',
        records: [{ record: 'Booking', change: 'Confirmed to No show for arrivals that never came; nights posted' }, { record: 'Night audit', change: 'new, with its checks, no-shows and nights' }, { record: 'Journal entry', change: 'new, source Night audit, per stay' }],
        audit: { action: 'create', entity: 'night-audit' },
        refusals: [{ code: 'AUDIT_ALREADY_RUN', when: 'the business date has already closed' }, { code: 'AUDIT_TOO_EARLY', when: 'the business date is still ahead of the calendar' }, { code: 'AUDIT_DATE', when: 'the date asked is not the open business date' }, { code: 'PERIOD_CLOSED', when: 'the business date falls in a closed month' }, FORBIDDEN],
        reports: ['revenue-codes', 'stay-receivables'],
      },
    },
    {
      title: 'Check out on posted nights',
      actor: 'staff',
      detail: 'The folio shows audited nights as posted and the rest as a forecast; the settle panel shows the posted balance and the estimate at check-out. Check-out posts the nights no audit reached and settles the whole bill. A stay cannot be shortened below its posted nights.',
      to: '/bookings',
      system: { useCase: 'booking.settleAndCheckOut', records: [{ record: 'Journal entry', change: 'new, source Guest folio, the nights left' }], refusals: [{ code: 'NIGHT_POSTED', when: 'a date change would drop a night the audit already posted' }], reports: ['stay-receivables'] },
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

/** What the public APOA sources confirm about the export, checked 2026-11-06; the sources sit next to APOA_COLUMNS in the guest domain. */
const APOA_ORDER =
  'Columns: full name, sex, place of birth, date of birth, nationality, document type, document number, document expiry, visa type, date of entry, port of entry, address in Indonesia, check-in date, planned check-out, room. No public source shows an APOA upload template, so this order is an approximation: confirm it against the template in your APOA account before uploading. The APOA user guide for hotels (v1.0.0, September 2025, jogja.imigrasi.go.id) and the APOA site (apoa.imigrasi.go.id), checked 6 November 2026, confirm name, sex, date of birth, nationality, passport number and passport expiry on the entry form, with check-in and check-out dates stamped by APOA. Place of birth, document type, visa type, date and port of entry, address and room appear in neither.'

const FOREIGN_FLOW: GuideFlow = {
  id: 'foreign-guests',
  title: 'Foreign guest registration to the Immigration report',
  summary: 'Every foreign adult on a stay is registered with the fields Immigration asks for, checks in on a valid document and is reported through APOA within 24 hours.',
  steps: [
    {
      title: 'Register the lead guest',
      actor: 'reservation',
      detail: 'On the guest profile: nationality, passport or stay permit (KITAS, KITAP; KTP for Indonesians) with number and expiry, date and place of birth, sex, date and port of entry, visa type and the address in Indonesia, which defaults to the villa.',
      to: '/guests',
      system: { useCase: 'guest.update', records: [{ record: 'Guest', change: 'document and entry fields' }], audit: { action: 'update', entity: 'guest' }, refusals: [{ code: 'VALIDATION_ERROR', when: 'the nationality is not picked or a date is malformed' }] },
    },
    {
      title: 'Add the companions',
      actor: 'staff',
      detail: 'At check-in the desk adds everyone else on the stay with the same fields. Children are listed; only adults go to Immigration.',
      to: '/bookings',
      system: { useCase: 'guest.addCompanion', records: [{ record: 'Stay companion', change: 'new, on the booking' }], audit: { action: 'create', entity: 'companion' }, refusals: [{ code: 'BOOKING_INVALID_STATE', when: 'the stay is already closed' }] },
    },
    {
      title: 'Check in',
      actor: 'staff',
      detail: 'Check-in reads the lead guest and each adult companion. Any foreign adult missing an APOA field, or holding an expired document, stops it with the names and the fields. Fewer adults registered than on the booking only warns in Who stays and on the audit trail; check-in goes ahead.',
      to: '/m',
      system: {
        useCase: 'booking.checkIn',
        records: [{ record: 'Booking', change: 'Confirmed to Checked in; the 24-hour report clock starts at the arrival time' }],
        audit: { action: 'status', entity: 'booking' },
        refusals: [
          { code: 'FOREIGN_DATA_MISSING', when: 'a foreign adult lacks document, birth, sex, entry or visa details' },
          { code: 'DOCUMENT_EXPIRED', when: 'a foreign adult’s passport or permit expired before today' },
        ],
      },
    },
    {
      title: 'Report to Immigration',
      actor: 'reservation',
      detail: `Foreign guests per day and villa list everyone who checked in or is in house. Export the day for the APOA upload, upload it, then mark the guests reported with the APOA receipt number. ${APOA_ORDER}`,
      to: '/guests/foreign',
      branches: [{ label: 'Past 24 hours', detail: 'A foreign guest in house more than 24 hours after check-in and not reported shows in the bell until someone marks them reported.', tone: 'warning', to: '/guests/foreign' }],
      system: {
        useCase: 'guest.markReported',
        records: [{ record: 'Foreign report', change: 'new per person, with who reported and when' }],
        audit: { action: 'create', entity: 'foreign-report' },
        refusals: [{ code: 'ALREADY_REPORTED', when: 'everyone picked is already reported on that stay' }, { code: 'BOOKING_INVALID_STATE', when: 'the stay has not checked in' }],
        reports: ['foreign-guests'],
        tiles: ['Not yet reported', 'Overdue'],
      },
    },
  ],
}

const GUEST_PROFILE_FLOW: GuideFlow = {
  id: 'guest-profile',
  title: 'Guest profile, blacklist and merge',
  summary: 'Preferences and VIP level warn the desk before arrival; a blacklisted guest needs a manager to book; duplicate profiles merge into one.',
  steps: [
    {
      title: 'Keep preferences and VIP level',
      actor: 'reservation',
      detail: 'Pillow, bed setup, dietary needs, allergies, room location and celebrations, a VIP level from 1 to 3 with the reason, and tags. Bookings and check-in show a banner for VIP, allergies and blacklist.',
      to: '/guests',
      system: { useCase: 'guest.update', records: [{ record: 'Guest', change: 'preferences, VIP level and tags' }], audit: { action: 'update', entity: 'guest' }, refusals: [{ code: 'VALIDATION_ERROR', when: 'a VIP level has no reason' }] },
    },
    {
      title: 'Blacklist a guest',
      actor: 'manager',
      detail: 'Someone who may approve in the guest module sets the blacklist with a reason, or lifts it. The profile keeps who set it and when.',
      to: '/guests',
      system: { useCase: 'guest.setBlacklist', records: [{ record: 'Guest', change: 'blacklist reason, set by and date' }], audit: { action: 'status', entity: 'guest' }, refusals: [FORBIDDEN] },
    },
    {
      title: 'Book a blacklisted guest',
      actor: 'manager',
      detail: 'A new booking or group for a blacklisted guest is refused. A villa manager may book them anyway with a reason; the override goes on the audit trail of each stay.',
      to: '/bookings/new',
      system: { useCase: 'booking.create', records: [{ record: 'Booking', change: 'new, the override in the audit trail' }], audit: { action: 'approve', entity: 'guest' }, refusals: [{ code: 'GUEST_BLACKLISTED', when: 'the guest is blacklisted and no override reason is given' }, FORBIDDEN] },
    },
    {
      title: 'Merge duplicates',
      actor: 'manager',
      detail: 'The guest list flags profiles sharing an email, phone or document number. Merging keeps one profile, fills its blanks from the other, and moves the stays with their orders and payments, the groups and lost items.',
      to: '/guests',
      system: { useCase: 'guest.merge', records: [{ record: 'Booking', change: 'guest moved to the kept profile' }, { record: 'Guest', change: 'the duplicate deleted' }], audit: { action: 'update', entity: 'guest' }, refusals: [FORBIDDEN] },
    },
  ],
}

const LOST_FOUND_FLOW: GuideFlow = {
  id: 'lost-found',
  title: 'Lost and found',
  summary: 'Staff log a find with a photo on the phone; the desk stores it, contacts the guest and returns it, or after the holding period disposes of or donates it.',
  steps: [
    {
      title: 'Log the find',
      actor: 'staff',
      detail: 'Villa, unit, where it was, what it is and a photo, linked to the guest or stay when known.',
      to: '/m/lost-found',
      system: { useCase: 'lostFound.create', records: [{ record: 'Lost item', change: 'new, Found' }], audit: { action: 'create', entity: 'lost-item' }, refusals: [{ code: 'VALIDATION_ERROR', when: 'the villa, place or description is missing, or the day is in the future' }] },
    },
    {
      title: 'Store it and contact the guest',
      actor: 'reservation',
      detail: 'Note the shelf it sits on, then tell the owner.',
      to: '/lost-found',
      system: { useCase: 'lostFound.move', records: [{ record: 'Lost item', change: 'Found to Stored or Guest contacted' }], audit: { action: 'status', entity: 'lost-item' } },
    },
    {
      title: 'Return it',
      actor: 'reservation',
      detail: 'Picked up in person, or sent by courier with the tracking number.',
      to: '/lost-found',
      system: { useCase: 'lostFound.move', records: [{ record: 'Lost item', change: 'Returned, with how and to whom' }], audit: { action: 'status', entity: 'lost-item' }, refusals: [{ code: 'LOST_ITEM_INVALID_STATE', when: 'the receiver, courier or tracking number is missing, or the item is closed' }] },
    },
    {
      title: 'Dispose of or donate',
      actor: 'manager',
      detail: 'Unclaimed items wait out the holding period, 90 days unless Settings says otherwise.',
      to: '/settings',
      system: { useCase: 'lostFound.move', records: [{ record: 'Lost item', change: 'Disposed or Donated' }], audit: { action: 'status', entity: 'lost-item' }, refusals: [{ code: 'LOST_ITEM_INVALID_STATE', when: 'the holding period has not passed' }] },
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

const NOT_YOURS = { code: 'TASK_NOT_YOURS', when: 'an attendant works a room on someone else’s list' }
const TASK_STATE = { code: 'TASK_INVALID_STATE', when: 'the task is not in a state for that step, or the guest has not checked out yet' }
const ROOM_ATTENDANT_FLOW: GuideFlow = {
  id: 'room-attendant',
  title: 'Room attendants from plan to inspection',
  summary: 'The supervisor plans the day and gives rooms out by credits; each attendant works their own list on the phone and the inspection still releases the room.',
  steps: [
    {
      title: 'Plan the day',
      actor: 'manager',
      detail: 'A departure clean for every check-out and dirty room, stayover service for every stay in house, a turndown when the settings ask for it. Deep cleans and inspections are added by hand. Each task takes its credits and standard minutes from the settings.',
      to: '/housekeeping?tab=assign',
      system: { useCase: 'housekeeping.planDay', records: [{ record: 'Housekeeping task', change: 'new, To do' }], audit: { action: 'create', entity: 'housekeeping-task' }, refusals: [FORBIDDEN], reports: ['hk-completion'] },
    },
    {
      title: 'Auto-assign',
      actor: 'manager',
      detail: 'Villas with the most work go first. A villa goes whole to the attendant on shift who serves it with the most room under the daily quota (8 credits by default); when it does not fit, the run carries on with the next attendant with room, in unit order. Nobody passes the quota.',
      to: '/housekeeping?tab=assign',
      branches: [
        { label: 'Left unassigned', detail: 'Tasks nobody on shift can take show in the Unassigned column for the supervisor.', tone: 'warning', to: '/housekeeping?tab=assign' },
        { label: 'Over quota', detail: 'A hand reassignment may pass the quota; the attendant’s credits turn red.', tone: 'warning', to: '/housekeeping?tab=assign' },
      ],
      system: { useCase: 'housekeeping.autoAssign', records: [{ record: 'Housekeeping task', change: 'attendant set' }], audit: { action: 'update', entity: 'housekeeping-task' }, refusals: [FORBIDDEN] },
    },
    {
      title: 'Reassign',
      actor: 'manager',
      detail: 'Drag a card onto another attendant, or pick the attendant on the card.',
      to: '/housekeeping?tab=assign',
      system: { useCase: 'housekeeping.assign', records: [{ record: 'Housekeeping task', change: 'attendant changed' }], audit: { action: 'update', entity: 'housekeeping-task' }, refusals: [{ code: 'NOT_ON_SHIFT', when: 'the attendant has no shift that day on the roster, or is on leave' }, TASK_STATE] },
    },
    {
      title: 'Work the room',
      actor: 'staff',
      detail: 'The attendant starts, pauses and finishes each room from My rooms on the phone, ticking the checklist. Starting a departure clean moves a dirty room to cleaning; finishing it bags the room’s linen set as soiled. Stayover service leaves the board alone.',
      to: '/m/rooms',
      branches: [
        { label: 'Do not disturb or refused', detail: 'A stayover closes for the day with the guest’s answer; three days of do not disturb in a row raise an alert on the assignments page and the phone.', tone: 'info', to: '/m/rooms' },
      ],
      system: { useCase: 'housekeeping.work', records: [{ record: 'Housekeeping task', change: 'To do to In progress to Done' }, { record: 'Housekeeping', change: 'Dirty to Cleaning on a departure' }, { record: 'Linen', change: 'room set to soiled on a departure' }], audit: { action: 'status', entity: 'housekeeping-task' }, refusals: [NOT_YOURS, TASK_STATE, { code: 'VALIDATION_ERROR', when: 'a checklist line is not ticked' }], reports: ['hk-productivity', 'hk-completion'] },
    },
    {
      title: 'Report a fault or a find',
      actor: 'staff',
      detail: 'A fault opens a work order on the unit through the maintenance path; a find is noted on the task, or linked to the lost and found record when there is one.',
      to: '/m/rooms',
      system: { useCase: 'housekeeping.reportIssue', records: [{ record: 'Work order', change: 'new, Open, from the inspection source' }, { record: 'Housekeeping task', change: 'work order linked' }], audit: { action: 'create', entity: 'work-order' }, refusals: [NOT_YOURS] },
    },
    {
      title: 'Inspect and release',
      actor: 'manager',
      detail: 'The supervisor inspects the cleaned room against the checklist on the board and releases it.',
      to: '/housekeeping',
      system: { useCase: 'maintenance.inspect', records: [{ record: 'Housekeeping', change: 'Cleaning to Inspected, or back to Dirty' }], audit: { action: 'status', entity: 'housekeeping' } },
    },
  ],
}

const LINEN_FLOW: GuideFlow = {
  id: 'linen-laundry',
  title: 'Linen from the room to the laundry and back',
  summary: 'Each villa keeps its linen at a par per room type; departure cleans fill the soiled bags, a laundry batch takes them out and brings them back clean, and losses come off the villa store.',
  steps: [
    {
      title: 'Set the par',
      actor: 'manager',
      detail: 'Per room type, the pieces one room holds and how many sets per room (three by default). The linen items come from the stock catalogue; buying linen is a stock receipt.',
      to: '/housekeeping?tab=linen',
      system: { useCase: 'housekeeping.saveLinenPar', records: [{ record: 'Linen par', change: 'set' }], audit: { action: 'update', entity: 'linen-par' }, reports: ['linen-par'] },
    },
    {
      title: 'Send soiled linen out',
      actor: 'manager',
      detail: 'Count the soiled bags into a batch for the laundry vendor. The pieces move from soiled to at laundry.',
      to: '/housekeeping?tab=linen',
      system: { useCase: 'housekeeping.sendLaundry', records: [{ record: 'Laundry batch', change: 'new, At laundry' }, { record: 'Linen', change: 'soiled to at laundry' }], audit: { action: 'create', entity: 'laundry-batch' }, refusals: [{ code: 'LINEN_SHORT', when: 'the villa holds fewer soiled pieces' }], reports: ['laundry-batches'] },
    },
    {
      title: 'Record the return',
      actor: 'manager',
      detail: 'Count what came back clean and what came back damaged; the rest is missing. Missing and damaged pieces are written off the villa store, and the vendor’s bill goes for approval as a cash-out.',
      to: '/housekeeping?tab=linen',
      branches: [{ label: 'Pieces missing', detail: 'The batch and the linen report show the loss per villa; the store write-off names the batch.', tone: 'danger', to: '/reports/laundry-batches' }],
      system: {
        useCase: 'housekeeping.returnLaundry',
        records: [{ record: 'Laundry batch', change: 'At laundry to Returned' }, { record: 'Stock movement', change: 'one Write-off per item lost' }, { record: 'Transaction', change: 'new cash-out, Submitted' }],
        ledger: [{ kind: 'cash_out', account: 'Location cashbox for cash, BCA bank for transfer', categoryId: 'cat-house', category: 'Housekeeping supplies', origin: 'maintenance', status: 'Submitted' }],
        approval: STD_APPROVAL,
        audit: { action: 'update', entity: 'laundry-batch' },
        refusals: [{ code: 'LAUNDRY_INVALID_STATE', when: 'the batch already came back' }, { code: 'PROOF_REQUIRED', when: 'the bill is above the proof threshold without the invoice' }, STOCK_SHORT],
        reports: ['laundry-batches', 'linen-par'],
      },
    },
    {
      title: 'Discard worn linen',
      actor: 'manager',
      detail: 'Torn or stained pieces leave the soiled bags or the clean store and are written off the villa store with the reason.',
      to: '/housekeeping?tab=linen',
      system: { useCase: 'housekeeping.discardLinen', records: [{ record: 'Stock movement', change: 'one Write-off per item' }], audit: { action: 'create', entity: 'linen-discard' }, refusals: [{ code: 'LINEN_SHORT', when: 'the soiled bags hold fewer pieces' }, STOCK_SHORT], reports: ['linen-par', 'stock-movements'] },
    },
  ],
}

const REVENUE_FLOW: GuideFlow = {
  id: 'revenue',
  title: 'Revenue figures, pace and budget',
  summary: 'The console reads occupancy, ADR and RevPAR off the stays and blocks, projects the coming months from the pace, and sets each villa’s budget beside the actual.',
  steps: [
    {
      title: 'Read the revenue dashboard',
      actor: 'owner',
      detail: 'Pick the period, location, villa and source. Tiles show occupancy, ADR, RevPAR and room revenue with their change; the statistics table adds rooms available and sold, average stay, lead time, cancellations and no-shows, with last year where the records reach back that far.',
      to: '/revenue',
      branches: [{ label: 'Before the records start', detail: 'A comparison period with no stays on record reads No data; the console never estimates it.', tone: 'info' }],
      system: { useCase: 'revenue.dashboard', refusals: [FORBIDDEN], reports: ['rm-daily', 'rm-monthly'], tiles: ['Occupancy', 'ADR', 'RevPAR', 'Room revenue'] },
    },
    {
      title: 'Check the pace',
      actor: 'manager',
      detail: 'For this month and the next five, room nights on the books against what the month before held at the same lead, and the month-end forecast from the trailing pickup.',
      to: '/revenue',
      system: { useCase: 'revenue.dashboard', reports: ['rm-pace'] },
    },
    {
      title: 'Set the budget',
      actor: 'finance',
      detail: 'Per villa and year: room nights, ADR, other revenue and expenses per month. Copy from last year, or type the year totals and spread them evenly, then adjust month by month.',
      to: '/revenue/budget',
      branches: [{ label: 'Nothing to copy', detail: 'Without a budget or stays for last year the copy leaves the figures as they are.', tone: 'info', to: '/revenue/budget' }],
      system: {
        useCase: 'revenue.saveBudget',
        records: [{ record: 'Budget', change: 'new or replaced for the villa and year' }],
        refusals: [{ code: 'VALIDATION_ERROR', when: 'a figure is negative or not whole, or a month is missing' }, FORBIDDEN],
        reports: ['rm-budget'],
      },
    },
    {
      title: 'Compare with the actual',
      actor: 'owner',
      detail: 'Each month shows the actual beside the budget: room nights and room revenue from the stays, other revenue and expenses from posted entries. Green helps profit, red hurts it.',
      to: '/revenue/budget',
      system: { useCase: 'revenue.budget', reports: ['rm-budget', 'pnl-villa'] },
    },
  ],
}

const MESSAGING_FLOW: GuideFlow = {
  id: 'guest-messaging',
  title: 'Guest messages',
  summary: 'The console writes to the guest at each step of the stay on WhatsApp or email, in English or Indonesian, and staff send their own from the booking.',
  steps: [
    {
      title: 'Triggers send on their own',
      actor: 'system',
      detail: 'Confirming a booking, sending a payment link, receiving a payment, checking in and checking out each queue a message. The pre-arrival message goes at 10:00 a set number of days before arrival (3 by default) with the online check-in link, and the checkout reminder at 18:00 the evening before departure. Each template can be switched off in settings.',
      to: '/messages/settings',
      system: {
        useCase: 'messaging.list',
        records: [{ record: 'Message', change: 'new, Queued, then Sent and Delivered as the provider answers' }],
        refusals: [FORBIDDEN],
      },
    },
    {
      title: 'Send a template or a free message',
      actor: 'reservation',
      detail: 'From the booking, pick a template or write your own words with placeholders such as {guest} and {checkIn}; the language follows the guest’s nationality unless you pick another.',
      to: '/bookings',
      system: {
        useCase: 'messaging.send',
        records: [{ record: 'Message', change: 'new, Queued in the staff member’s name, or Failed when the guest has no number or address' }],
        audit: { action: 'create', entity: 'message' },
        refusals: [{ code: 'VALIDATION_ERROR', when: 'a free message is empty' }, FORBIDDEN],
      },
    },
    {
      title: 'Resend a failed message',
      actor: 'staff',
      detail: 'A failed message shows the provider’s answer. Fix the guest’s number or address on the profile, then resend from the booking or the Messages page.',
      to: '/messages?status=failed',
      system: {
        useCase: 'messaging.resend',
        records: [{ record: 'Message', change: 'Failed to Queued, one more attempt, to the current contact' }],
        audit: { action: 'update', entity: 'message' },
        refusals: [{ code: 'MESSAGE_NOT_FAILED', when: 'the message did not fail' }, FORBIDDEN],
      },
    },
    {
      title: 'Guest opens the e-invoice',
      actor: 'guest',
      detail: 'The thank-you message after check-out carries a signed link to the stay invoice and a review request. No sign-in.',
      to: '/messages',
      system: { useCase: 'messaging.invoice', records: [{ record: 'Invoice', change: 'read only, the same invoice the console prints' }] },
    },
  ],
}

const PRECHECKIN_FLOW: GuideFlow = {
  id: 'online-checkin',
  title: 'Online check-in',
  summary: 'The guest confirms details, gives every adult’s ID and signs the house rules before arrival; the front desk verifies it against the ID and checks in from a prefilled form.',
  steps: [
    {
      title: 'Guest fills in the form',
      actor: 'guest',
      detail: 'From the pre-arrival message or a link the desk copied: contact, arrival time and flight, party size, each adult’s document (foreign guests add entry date, port and visa), an ID photo and the house rules signed with a typed name.',
      to: '/checkins',
      branches: [{ label: 'Pay the balance', detail: 'The guest can open a QRIS, VA or card link for what the stay still owes.', tone: 'info' }],
      system: {
        useCase: 'precheckin.submit',
        records: [{ record: 'Pre-check-in', change: 'new or updated, Submitted' }],
        audit: { action: 'create', entity: 'precheckin' },
        refusals: [{ code: 'VALIDATION_ERROR', when: 'a field is missing, or the passport expires before check-out' }, { code: 'PRECHECKIN_LOCKED', when: 'the desk verified it or the guest is checked in' }, { code: 'PRECHECKIN_LINK_EXPIRED', when: 'the stay is over or called off' }],
      },
    },
    {
      title: 'Pay the balance online',
      actor: 'guest',
      detail: 'Optional: a payment link for the room balance; an open one is reused.',
      to: '/checkins',
      system: { useCase: 'precheckin.payBalance', records: [{ record: 'Payment link', change: 'new, Pending' }], refusals: [{ code: 'PAYMENT_OVERPAID', when: 'nothing is left to pay' }] },
    },
    {
      title: 'Verify against the ID',
      actor: 'staff',
      detail: 'On today’s arrivals, desktop or phone, the desk compares what the guest sent with the document. Verify copies nationality, document and contact onto the guest, registers every other traveller as a stay companion with their document, birth and entry data (a document number already on the stay updates that companion), sets the party size on the stay, and names who verified.',
      to: '/m',
      system: {
        useCase: 'precheckin.verify',
        records: [{ record: 'Pre-check-in', change: 'Submitted to Verified' }, { record: 'Guest', change: 'nationality, ID type and number, email and phone' }, { record: 'Stay companion', change: 'new or updated for each other traveller, matched by document number' }, { record: 'Booking', change: 'party size' }],
        audit: { action: 'status', entity: 'precheckin' },
        refusals: [{ code: 'PRECHECKIN_NOT_SUBMITTED', when: 'the guest has not sent it' }, { code: 'PRECHECKIN_VERIFIED', when: 'someone verified it already' }, FORBIDDEN],
      },
    },
    {
      title: 'Check in from the prefilled form',
      actor: 'staff',
      detail: 'The check-in form starts with the ID ticked, the house rules accepted, the arrival time, the party and the flight in the notes.',
      to: '/bookings',
      system: { useCase: 'booking.checkIn', records: [{ record: 'Booking', change: 'Confirmed to Checked in; the welcome message goes out' }], audit: { action: 'status', entity: 'booking' } },
    },
  ],
}

const TAX_FLOW: GuideFlow = {
  id: 'tax',
  title: 'Service charge and PB1',
  summary: 'Finance sets the service charge and PB1 (Pajak Hotel) rates; every taxable folio line carries both, the books hold them on their payables, payroll shares out the service charge and finance pays PB1 to the regency each month.',
  steps: [
    {
      title: 'Set the rates',
      actor: 'finance',
      detail: 'Service 10% and PB1 10% by default, PB1 on the amount plus service (the "++" convention). ROOM, LATE, FNB, MINI, SPA and XTRA carry both; LDRY carries PB1 only; TRNS, TOUR and DMG carry neither, being partner services resold and damage. New rates start today or later, so a posting already made keeps its rates. Direct prices and rate plans read net by default: service and PB1 go on top. Airbnb prices always read inclusive, since Airbnb collects and the operator remits. Menu prices read inclusive.',
      to: '/accounting/tax',
      system: { useCase: 'accounting.saveTaxSettings', audit: { action: 'update', entity: 'tax-settings' }, refusals: [{ code: 'TAX_RATES_BACKDATED', when: 'new rates start before today' }, { code: 'VALIDATION_ERROR', when: 'a rate is outside 0 to 25% or a regency is blank' }, { code: 'PERIOD_CLOSED', when: 'the start date falls in a closed month' }] },
    },
    {
      title: 'Quote with tax',
      actor: 'reservation',
      detail: 'The quote on a new booking says "Prices exclude 10% service and 10% PB1" and adds them for a net price, or says they are included. The booking total, the deposit percent, the balance and payment link amounts all read the total with them; the checkout page, the invoice and the phone show the same line.',
      to: '/bookings/new',
      system: { useCase: 'booking.quote', records: [{ record: 'Booking', change: 'price mode set from the settings: net for direct, inclusive for Airbnb' }] },
    },
    {
      title: 'Post service and PB1 on the folio',
      actor: 'manager',
      detail: 'Every taxable posting (a night at the audit, a delivered order, a folio charge, a night billed at check-out) writes its service line on SVC and its PB1 line on PB1 after it, rounded to whole rupiah half up. Rp 1,000,000 net: service 100,000, PB1 110,000 on 1,100,000, total 1,210,000. An inclusive price splits the other way. A rebate takes back its share of both. The books: Dr receivable, Cr revenue for the net, Cr Service charge payable (2400), Cr PB1 payable (2330). Stays and room money from before the console read inclusive, so their totals and the cash stay as they were; that money already sits in the opening books, so only what the console billed reaches the payables.',
      to: '/night-audit',
      system: { useCase: 'nightAudit.run', records: [{ record: 'Journal entry', change: 'net on the code’s account, service on 2400, PB1 on 2330' }], refusals: [{ code: 'PERIOD_CLOSED', when: 'the business date falls in a closed month' }], reports: ['service-villa', 'pb1-regency', 'trial-balance'] },
    },
    {
      title: 'Share out the service charge',
      actor: 'hr',
      detail: 'Calculating payroll reads the month’s Service charge payable as the pool and splits the paid-out share (100% by default) evenly between eligible staff, rounded down to Rp 1,000. Closing payroll debits Service charge payable for what it paid out instead of wages.',
      to: '/payroll',
      system: { useCase: 'payroll.calculate', records: [{ record: 'Payroll period', change: 'service charge pool from 2400' }], reports: ['service-villa', 'payroll-summary'] },
    },
    {
      title: 'Pay PB1 to the regency',
      actor: 'finance',
      detail: 'Once a month is closed, Pay PB1 on the Tax and service page submits one cash-out per regency (Badung, Gianyar, by the villa location) for the PB1 the month billed; posting it pays PB1 payable down.',
      to: '/accounting/tax',
      system: {
        useCase: 'accounting.payPb1',
        ledger: [{ kind: 'cash_out', account: 'The account picked, the bank by default', categoryId: 'cat-pb1', category: 'PB1 remittance', origin: 'manual', status: 'Submitted' }],
        approval: STD_APPROVAL,
        refusals: [{ code: 'PERIOD_OPEN', when: 'the month is not closed yet' }, { code: 'PB1_PAID', when: 'every regency already has its remittance' }],
        reports: ['pb1-regency', 'balance-sheet'],
      },
    },
  ],
}

const SHIFT_FLOW: GuideFlow = {
  id: 'cashier-shift',
  title: 'Cashier shift',
  summary: 'A front desk cashier opens a shift on a counted float, the desk’s money lands on it, and it closes on a counted drawer; a difference goes to the books through the cash count, and the drawer passes to the next cashier or to the bank.',
  steps: [
    {
      title: 'Open the shift',
      actor: 'staff',
      detail: 'Pick the location cashbox and count the float note by note, or take over the last closed drawer and accept its count as the float. A cashier off today’s roster needs a manager to open it.',
      to: '/m/shift',
      system: {
        useCase: 'cashier.open',
        records: [{ record: 'Cashier shift', change: 'new, Open, with the counted float' }, { record: 'Hand-over', change: 'new when the float comes from the last shift' }],
        audit: { action: 'create', entity: 'cashier-shift' },
        refusals: [{ code: 'SHIFT_ALREADY_OPEN', when: 'the cashbox already has a shift open' }, { code: 'SHIFT_NOT_ROSTERED', when: 'the cashier is not on today’s roster and is not a manager' }, { code: 'SHIFT_HANDOVER_INVALID', when: 'the drawer taken over is not a counted shift on this cashbox' }, { code: 'SHIFT_HANDED_OVER', when: 'that drawer was already handed over' }, FORBIDDEN],
      },
    },
    {
      title: 'Work the desk',
      actor: 'staff',
      detail: 'Every cash entry on the cashbox while the shift is open carries the shift: desk payments, refunds, petty cash top-ups from the box, cash in and out. QRIS, card and transfer payments taken at the desk show per method on the shift; a guest paying online does not.',
      to: '/finance/shifts',
      system: {
        useCase: 'payments.record',
        records: [{ record: 'Transaction', change: 'stamped with the shift when it is on the cashbox' }, { record: 'Payment', change: 'stamped with the shift open at the stay’s cashbox' }],
        ledger: [ROOM_IN('Location cashbox', 'front_desk')],
        approval: STD_APPROVAL,
        reports: ['cashier-shifts'],
      },
    },
    {
      title: 'Count and close',
      actor: 'staff',
      detail: 'Count the drawer note by note. The console shows the float plus cash in less cash out, the count and the difference, with the totals per method. Within the tolerance (Rp 10.000 by default) the shift closes and the difference posts as a cash count; past it the cashier gives a reason and the shift waits for a sign-off.',
      to: '/m/shift',
      system: {
        useCase: 'cashier.close',
        records: [{ record: 'Cashier shift', change: 'Open to Closed, or Awaiting sign-off past the tolerance' }, { record: 'Reconciliation', change: 'new, with the shift’s expected cash, count and difference' }],
        ledger: [{ kind: 'cash_out', account: 'Location cashbox', categoryId: 'cat-adjust-out', category: 'Balance adjustment', origin: 'reconciliation', status: 'Submitted' }],
        audit: { action: 'status', entity: 'cashier-shift' },
        refusals: [{ code: 'SHIFT_NOT_OPEN', when: 'the shift is already closed' }, { code: 'SHIFT_REASON_REQUIRED', when: 'the difference is past the tolerance and no reason is given' }, { code: 'SHIFT_NOT_YOURS', when: 'someone else’s drawer, without the right to sign off' }],
        reports: ['cashier-shifts', 'cashier-over-short'],
      },
    },
    {
      title: 'Sign off the difference',
      actor: 'manager',
      detail: 'A manager or finance approver other than the cashier signs the difference; the cash count then posts it as an adjustment for approval.',
      to: '/finance/shifts?status=awaiting_signoff',
      system: {
        useCase: 'cashier.signOff',
        records: [{ record: 'Cashier shift', change: 'Awaiting sign-off to Closed' }],
        audit: { action: 'approve', entity: 'cashier-shift' },
        refusals: [{ code: 'SHIFT_SELF_SIGNOFF', when: 'the cashier tries to sign their own drawer' }, { code: 'SHIFT_NOT_AWAITING', when: 'the shift does not wait for a sign-off' }, { code: 'SHIFT_SIGNOFF_DENIED', when: 'the person is neither a manager nor a finance approver' }, FORBIDDEN],
        reports: ['cashier-over-short'],
      },
    },
    {
      title: 'Hand over or drop',
      actor: 'staff',
      detail: 'The next cashier opens by accepting the count as their float, which records the hand-over. Or the cash goes to the safe or the bank as a cash transfer, and what stays is the next float.',
      to: '/finance/shifts',
      system: {
        useCase: 'cashier.drop',
        ledger: [
          { kind: 'cash_out', account: 'Location cashbox', categoryId: 'cat-transfer-out', category: 'Transfer out', origin: 'transfer', status: 'Submitted' },
          { kind: 'cash_in', account: 'Bank', categoryId: 'cat-transfer-in', category: 'Transfer in', origin: 'transfer', status: 'Submitted' },
        ],
        approval: STD_APPROVAL,
        audit: { action: 'update', entity: 'cashier-shift' },
        refusals: [{ code: 'SHIFT_NOT_CLOSED', when: 'the drawer has not been counted' }, { code: 'SHIFT_ALREADY_DROPPED', when: 'the cash already left once' }, { code: 'SHIFT_HANDED_OVER', when: 'the drawer went to the next cashier' }],
        reports: ['cash-flow'],
      },
    },
    {
      title: 'Close the day',
      actor: 'system',
      detail: 'The night audit counts a cashbox as counted when its shift closed on that business date, and lists the shifts still open.',
      to: '/night-audit',
      system: { useCase: 'nightAudit.overview' },
    },
  ],
}

const OWNER_FLOW: GuideFlow = {
  id: 'owner-statement',
  title: 'Owner statement to payout',
  summary: 'Each month a contract villa gets a statement from the books; finance closes it, the Owner approves it, and the owner is paid from the bank through the approval chain.',
  steps: [
    {
      title: 'Read the month',
      actor: 'finance',
      detail: 'After the month ends, open the villa’s statement: room revenue night by night, other revenue, the costs the contract charges, GOP, management fee, FF&E reserve and owner stays, each figure opening to its stays and entries.',
      to: '/villa-owners/statements',
      system: { useCase: 'owners.statement', reports: ['pnl-villa', 'owner-statements'] },
    },
    {
      title: 'Close the statement',
      actor: 'finance',
      detail: 'Closing keeps the figures and the lines behind them, deducts any shortfall brought forward from an earlier month, and writes the close journal on the last day of the month. Months close in order.',
      to: '/villa-owners/statements',
      system: {
        useCase: 'owners.close',
        records: [
          { record: 'Owner statement', change: 'new, Closed, with brought forward and net payable after carry forward' },
          { record: 'Journal entry', change: 'Dr 5900 Owner share of villa results (GOP); Cr 4800 Management fee income, Cr 4900 Other income (owner stays), Cr 2510 FF&E reserve, Cr 2500 Payable to villa owners (a negative net debits 2500 and waits there for a later month)' },
          { record: 'Journal entry', change: 'top-up contract with a negative payable: Dr 1220 Receivable from villa owners, Cr 2500 Payable to villa owners' },
        ],
        audit: { action: 'status', entity: 'owner-statement' },
        refusals: [
          { code: 'STATEMENT_MONTH_OPEN', when: 'the month has not ended' },
          { code: 'STATEMENT_CLOSED', when: 'the contract’s month is already closed' },
          { code: 'STATEMENT_ORDER', when: 'a later month of the contract is already closed' },
          { code: 'STATEMENT_PENDING', when: 'an entry of the villa dated in the month still waits for approval or posting' },
          { code: 'CONTRACT_NOT_ACTIVE', when: 'the contract does not run in the month' },
          { code: 'STATEMENT_MISMATCH', when: 'the stays and entries do not add up to the figures' },
          { code: 'PERIOD_CLOSED', when: 'the books for the month are closed' },
          FORBIDDEN,
        ],
        reports: ['owner-statements', 'income-statement'],
      },
    },
    {
      title: 'Approve',
      actor: 'owner',
      detail: 'The Owner checks and approves the statement; from then on the villa owner sees it in the portal.',
      to: '/villa-owners/statements',
      system: {
        useCase: 'owners.approve',
        records: [{ record: 'Owner statement', change: 'Closed to Approved' }],
        audit: { action: 'approve', entity: 'owner-statement' },
        refusals: [{ code: 'APPROVAL_ROLE', when: 'someone other than the Owner approves' }, { code: 'APPROVAL_SELF', when: 'the person who closed it approves' }, { code: 'STATEMENT_INVALID_STATE', when: 'it is already approved' }],
      },
    },
    {
      title: 'Pay the owner',
      actor: 'finance',
      detail: 'Submit the net payable after carry forward as a cash-out from the bank; it signs through the approval chain and posting it pays the owner and clears what the villa owes them. A negative month pays nothing and carries forward; on a top-up contract this asks the owner for the shortfall as a cash-in instead.',
      to: '/villa-owners/statements',
      system: {
        useCase: 'owners.pay',
        ledger: [
          { kind: 'cash_out', account: 'Bank', categoryId: 'cat-owner-payout', category: 'Owner payout', origin: 'owner_payout', status: 'Submitted' },
          { kind: 'cash_in', account: 'Bank', categoryId: 'cat-owner-topup', category: 'Owner top-up', origin: 'owner_payout', status: 'Submitted' },
        ],
        approval: STD_APPROVAL,
        audit: { action: 'status', entity: 'owner-statement' },
        refusals: [{ code: 'STATEMENT_NOT_APPROVED', when: 'the Owner has not approved it' }, { code: 'PAYOUT_NOTHING', when: 'the month leaves nothing to pay or carries a shortfall forward' }, { code: 'PAYOUT_OPEN', when: 'a payout is already being approved or paid' }],
        reports: ['owner-payouts'],
      },
    },
    {
      title: 'Reopen a statement',
      actor: 'finance',
      detail: 'A closed statement that nothing paid yet reopens with a reason, so a correction flows into it and the months after; its close journal is reversed on the same month end. Only the contract’s latest statement reopens.',
      to: '/villa-owners/statements',
      system: {
        useCase: 'owners.reopen',
        records: [{ record: 'Owner statement', change: 'Closed or Approved to open' }, { record: 'Journal entry', change: 'the close entry reversed, dated the month end' }],
        audit: { action: 'status', entity: 'owner-statement' },
        refusals: [
          { code: 'VALIDATION_ERROR', when: 'no reason is given' },
          { code: 'STATEMENT_ORDER', when: 'a later month of the contract is closed' },
          { code: 'PAYOUT_OPEN', when: 'its payout or top-up waits for approval' },
          { code: 'STATEMENT_PAID', when: 'its payout or top-up posted' },
          { code: 'PERIOD_CLOSED', when: 'the books for the month are closed' },
          FORBIDDEN,
        ],
        reports: ['owner-statements'],
      },
    },
  ],
}

const OWNER_STAY_FLOW: GuideFlow = {
  id: 'owner-stay',
  title: 'Owner stay',
  summary: 'A villa owner asks for dates in the portal; the operator picks a unit and the stay becomes an owner block, priced on the next statement.',
  steps: [
    {
      title: 'Ask for dates',
      actor: 'investor',
      detail: 'In the portal, pick the villa and the dates; the contract’s owner nights a year cap what can be asked.',
      to: '/portal/stays',
      system: {
        useCase: 'portal.requestStay',
        records: [{ record: 'Owner stay request', change: 'new, Pending' }],
        audit: { action: 'create', entity: 'owner-stay' },
        refusals: [{ code: 'OWNER_NIGHTS_EXCEEDED', when: 'the year’s owner nights would run out' }, { code: 'OWNER_STAY_DATES', when: 'the dates are past, reversed or outside the contract' }, FORBIDDEN],
      },
    },
    {
      title: 'Approve and hold a unit',
      actor: 'manager',
      detail: 'Pick a free unit of the villa; the stay blocks it as an owner stay, or decline with a reason.',
      to: '/villa-owners',
      system: {
        useCase: 'owners.decideStay',
        records: [{ record: 'Owner stay request', change: 'Pending to Approved or Declined' }, { record: 'Unit block', change: 'new, Owner stay' }],
        audit: { action: 'approve', entity: 'owner-stay' },
        refusals: [{ code: 'BOOKING_OVERLAP', when: 'a stay or block holds the unit' }, { code: 'OWNER_STAY_DECIDED', when: 'it was already decided' }],
        reports: ['occupancy'],
      },
    },
  ],
}

const CITY_LEDGER_FLOW: GuideFlow = {
  id: 'city-ledger',
  title: 'City ledger: bill a company or agent after the stay',
  summary: 'A direct stay or group booked to a company or travel agent moves its bill to the account at check-out; finance invoices the open items, takes the payment through approval and chases what is overdue.',
  steps: [
    {
      title: 'Book to the account',
      actor: 'reservation',
      detail: 'On a new direct booking or group, pick the company or agent and what it pays: all charges, room only, or room and breakfast. The rest stays with the guest.',
      to: '/bookings/new',
      branches: [{ label: 'Over the credit limit', detail: 'The booking is refused unless finance or a villa manager books it with a reason, kept on the booking and in the audit trail.', tone: 'warning' }],
      system: {
        useCase: 'booking.create',
        records: [{ record: 'Booking', change: 'new, carries the account and the billing instruction' }],
        audit: { action: 'update', entity: 'city-ledger-account' },
        refusals: [{ code: 'CREDIT_LIMIT', when: 'the account’s balance, its stays still to transfer and this stay pass the credit limit, without an override' }, { code: 'CITY_LEDGER_INACTIVE', when: 'the account is closed for new business' }, { code: 'CITY_LEDGER_VILLA', when: 'the account may not book that villa' }, { code: 'CITY_LEDGER_CHANNEL', when: 'the stay is an Airbnb booking' }],
      },
    },
    {
      title: 'Change who pays',
      actor: 'reservation',
      detail: 'Until the stay checks out, the Bill to card on the booking or the group sets, changes or removes the account and what it pays, under the same checks as at booking. Transfers already posted stay on the account they went to.',
      to: '/bookings',
      branches: [{ label: 'Group', detail: 'The group card bills every stay not yet checked out that carries no account of its own.', tone: 'info' }],
      system: {
        useCase: 'cityLedger.setBilling',
        records: [{ record: 'Booking or group', change: 'carries the new account and billing instruction, or none' }],
        audit: { action: 'update', entity: 'booking' },
        refusals: [{ code: 'BOOKING_INVALID_STATE', when: 'the stay, or every stay of the group, has checked out or gone' }, { code: 'CREDIT_LIMIT', when: 'a new account would pass its credit limit, without an override' }, { code: 'CITY_LEDGER_INACTIVE', when: 'the account is closed for new business' }, { code: 'CITY_LEDGER_VILLA', when: 'the account may not book that villa' }, { code: 'CITY_LEDGER_CHANNEL', when: 'the stay is an Airbnb booking' }, FORBIDDEN],
        reports: ['cl-aging'],
      },
    },
    {
      title: 'Transfer at check-out',
      actor: 'staff',
      detail: 'On the folio or the check-out form, transfer the balance or the part the instruction covers. The folio gets a credit line Transfer to city ledger and check-out settles only what is left with the guest.',
      to: '/bookings',
      branches: [{ label: 'Master-billed group', detail: 'The group page transfers the master folio: every stay’s room nights at once.', tone: 'info' }],
      system: {
        useCase: 'cityLedger.transfer',
        records: [{ record: 'Folio posting', change: 'new, kind transfer on code CL per part of the bill' }, { record: 'Journal entry', change: 'Dr 1210 City ledger receivable; Cr 1200 Accounts receivable, guests (per stay)' }],
        audit: { action: 'create', entity: 'city-ledger' },
        refusals: [{ code: 'CITY_LEDGER_NOTHING', when: 'nothing under the instruction is left to move' }, { code: 'SETTLEMENT_PENDING', when: 'a check-out link waits for the guest' }, { code: 'GROUP_NOT_MASTER', when: 'a group bills each stay on its own' }, { code: 'PERIOD_CLOSED', when: 'the books for today are closed' }, FORBIDDEN],
        reports: ['stay-receivables', 'cl-aging'],
      },
    },
    {
      title: 'Issue the invoice',
      actor: 'finance',
      detail: 'Monthly or on demand, invoice the account’s open transfers up to a date. Service and PB1 print as the folio billed them; the due date follows the terms. A travel agent’s invoice shows gross, less commission, net due.',
      to: '/city-ledger',
      system: {
        useCase: 'cityLedger.issueInvoice',
        records: [{ record: 'City ledger invoice', change: 'new, CL-YYYY-MM-NNN' }, { record: 'Journal entry', change: 'for an agent: Dr 6750 Agent commission; Cr 1210 City ledger receivable' }],
        audit: { action: 'create', entity: 'city-ledger-invoice' },
        refusals: [{ code: 'CITY_LEDGER_NOTHING', when: 'no transfer up to the date is left to invoice' }, { code: 'PERIOD_CLOSED', when: 'the books for today are closed' }],
        reports: ['cl-invoices', 'cl-commission'],
      },
    },
    {
      title: 'Email it',
      actor: 'finance',
      detail: 'Send the invoice to the billing email with the City ledger invoice template; it goes through the guest messaging outbox.',
      to: '/city-ledger',
      system: { useCase: 'cityLedger.sendInvoice', records: [{ record: 'Message', change: 'new, Queued, template City ledger invoice' }], audit: { action: 'update', entity: 'city-ledger-invoice' } },
    },
    {
      title: 'Record the payment',
      actor: 'finance',
      detail: 'Record what the account sent and spread it over its invoices, oldest first or picked. A partial payment leaves the invoice open; what is left over stays as credit on the account.',
      to: '/city-ledger',
      system: {
        useCase: 'cityLedger.recordPayment',
        ledger: [{ kind: 'cash_in', account: 'Bank or cashbox', categoryId: 'cat-city-ledger', category: 'City ledger payment', origin: 'payment', status: 'Submitted' }],
        records: [{ record: 'City ledger payment', change: 'new, counts once its cash-in posts' }, { record: 'Journal entry', change: 'on posting: Dr cash; Cr 1210 City ledger receivable' }],
        approval: STD_APPROVAL,
        audit: { action: 'create', entity: 'city-ledger-payment' },
        refusals: [{ code: 'VALIDATION_ERROR', when: 'an invoice picked takes more than it has open, or the money lands in the wrong kind of account' }],
        reports: ['cl-payments', 'cl-aging'],
      },
    },
    {
      title: 'Write off a small balance',
      actor: 'finance',
      detail: 'A remainder the account will not pay goes off with a reason, as a manual journal that signs through the approval chain.',
      to: '/city-ledger',
      system: {
        useCase: 'cityLedger.writeOff',
        records: [{ record: 'Manual journal', change: 'new, Submitted: Dr 6950 Bad debt expense; Cr 1210 City ledger receivable' }],
        approval: 'Signs like a cash-out of its amount; the author cannot sign.',
        audit: { action: 'create', entity: 'city-ledger-write-off' },
        refusals: [{ code: 'WRITE_OFF_LIMIT', when: 'the amount is over Rp 500.000' }, SELF],
      },
    },
  ],
}

export const GUIDE_FLOWS: readonly GuideFlow[] = [BOOKING_FLOW, BOOKING_CHANGE_FLOW, ROOM_TYPE_FLOW, RATE_PLAN_FLOW, AIRBNB_FLOW, REPAIR_FLOW, ROOM_SERVICE_FLOW, APPROVAL_FLOW, BOOKS_FLOW, PAYROLL_FLOW, LEAVE_FLOW, PREVENTIVE_FLOW, HOUSEKEEPING_FLOW, ROOM_ATTENDANT_FLOW, LINEN_FLOW, PETTY_FLOW, ACCESS_FLOW, FOLIO_FLOW, NIGHT_AUDIT_FLOW, GROUP_FLOW, STOCK_FLOW, REVENUE_FLOW, MESSAGING_FLOW, PRECHECKIN_FLOW, RESTRICTION_FLOW, WALK_FLOW, FOREIGN_FLOW, GUEST_PROFILE_FLOW, LOST_FOUND_FLOW, SHIFT_FLOW, OWNER_FLOW, OWNER_STAY_FLOW, TAX_FLOW, CITY_LEDGER_FLOW]

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
    flows: ['rate-plan', 'stay-restrictions', 'overbooking-walk'],
    features: [
      { title: 'New property wizard', does: 'Six steps from the villa to room types, rooms, rate plans and facilities.', action: 'create', rules: ['Every room type leaves the wizard with a rate plan.'], to: '/property/new' },
      { title: 'Unit status', does: 'Active, cleaning, maintenance or inactive.', action: 'edit', rules: ['A unit with confirmed stays cannot be deactivated.'], to: '/property' },
      { title: 'Unit blocks', does: 'Take a unit off sale for a period.', action: 'edit', rules: ['A block cannot cover nights a guest holds.'], to: '/property' },
      { title: 'Sell a room type', does: 'For identical rooms, guests book the type and the operator assigns the room.', action: 'edit', rules: ['Only interchangeable rooms can sell as a type.', 'It cannot be switched off while stays wait for a room.'], to: '/property' },
      { title: 'Stay restrictions', does: 'Minimum and maximum stay, minimum stay through, closed to arrival or departure and stop sell per room type or unit, yearly or one-off, with days of the week; a bulk editor sets one rule on several room types.', action: 'edit', rules: ['New direct stays, changes and groups that break a rule are refused unless a villa manager overrides with a reason.', 'Airbnb stays are kept with a warning.', 'Stays already booked keep their dates.'], to: '/property/restrictions' },
      { title: 'Overbooking policy', does: 'Stays a night a room type that sells by type may take past its rooms.', action: 'edit', rules: ['Rooms sold one by one never overbook.'], to: '/property/restrictions' },
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
    flows: ['booking-payment', 'booking-change', 'room-type', 'guest-folio', 'night-audit', 'group-booking', 'guest-messaging', 'online-checkin', 'stay-restrictions', 'overbooking-walk'],
    features: [
      { title: 'New booking', does: 'Live availability with interchangeable alternatives and payment at booking.', action: 'create', rules: [RULE.overlap], to: '/bookings/new' },
      { title: 'Price from the Airbnb listing', does: 'A direct stay sells at the listing price per night, or at the room type’s rate plan when the unit has no live listing; staff can give a rate or a discount with a reason.', action: 'edit', rules: [RULE.discount, RULE.channel], to: '/bookings/new' },
      { title: 'Room type and room assignment', does: 'In villas with identical rooms the guest books the type and the front desk assigns the room before check-in.', action: 'edit', rules: ['Rooms of a type never sell past their count on any night.', 'Check-in needs an assigned room.'], to: '/calendar' },
      { title: 'Group bookings', does: 'Several units for one party on one form, all or nothing, with a lead guest, one deposit, group check-in and a master folio or a bill per stay.', action: 'create', rules: [RULE.overlap, 'One unit taken refuses the whole group.', 'On a master folio the last stay leaves only once the group has paid its rooms.', RULE.discount], to: '/bookings/groups' },
      { title: 'Calendar', does: 'Every unit across a free date range, pinned to today, with stop sell, CTA, CTD and Overbooked marks per room type.', action: 'view', to: '/calendar' },
      { title: 'Walk a guest', does: 'On an overbooked arrival day, move a guest to another villa or an outside property, with the cost through approval and a report of walks.', action: 'edit', rules: ['Only a confirmed arrival for today on an overbooked night.', 'An outside walk cancels the stay and gives back everything paid.'], to: '/bookings' },
      { title: 'Guest messages', does: 'WhatsApp and email in English and Indonesian: automatic confirmation, payment link, receipt, pre-arrival, welcome with WiFi and house rules, checkout reminder and thank you with the e-invoice; templates and free messages from the booking, a log per stay and per guest, resend on failure.', action: 'edit', rules: ['Each trigger sends once per stay and only while its template is on.', 'Sending goes through the provider port; the demo simulates delivery, and a WhatsApp gateway (Fonnte, Qontak or WhatsApp Cloud API) plugs in there.'], to: '/messages' },
      { title: 'Message templates', does: 'Switch each trigger on or off, set its channel, edit both languages, the pre-arrival lead time and the WiFi per villa.', action: 'edit', to: '/messages/settings' },
      { title: 'Online check-in', does: 'The guest sends contact, arrival, every adult’s ID, an ID photo and the signed house rules before arrival, and can pay the balance; the desk verifies it and the check-in form is prefilled.', action: 'edit', rules: ['The link closes once the stay is over.', 'A verified check-in is locked for the guest.'], to: '/checkins' },
      { title: 'Unit swap and stay change', does: 'Move a guest to an interchangeable unit or change the dates, with history and actor.', action: 'edit', rules: ['Only interchangeable units can swap.', 'A finished stay is final.'], to: '/bookings' },
      { title: 'Lifecycle', does: 'Confirmed, checked in, checked out, cancelled or no-show.', action: 'edit', to: '/bookings' },
      { title: 'Invoice', does: 'Printable invoice with payments and balance.', action: 'view', to: '/bookings' },
      { title: 'Guest folio', does: 'Every debit and credit of the stay with a running balance, filtered by kind and printable. Staff post charges on a code and rebates on a posted line; a credit shows Refund due and goes back against its payment; check-out takes the folio balance.', action: 'edit', rules: ['Rebates past the discount limit share of the line need someone who may approve bookings.', 'A delivery is voided only on its business day; later a rebate corrects it.', 'A plain check-out is refused while the folio has a balance.'], to: '/bookings' },
      { title: 'Night audit', does: 'Closes the business date, shown in the header apart from the calendar date: a checklist with links (arrivals, departures, open links, orders, unassigned rooms, cash counts), no-shows for arrivals that never came, each in-house night posted on the ROOM code, and the date rolled forward. Future nights show on the folio as a forecast outside the balance.', action: 'post', rules: ['A business date closes once.', 'A stay keeps at least the nights already posted.', 'The phone shows the checklist read-only; the console runs it.'], to: '/night-audit' },
      { title: 'Settle and check out', does: 'The check-out takes the room balance, unpaid room service and departure charges in one payment, then closes the stay; a QRIS, VA or card link closes it when the guest pays.', action: 'edit', rules: ['Airbnb stays settle only what the villa sold; Airbnb pays the room out.', 'A plain check-out is refused while room service is unpaid or a check-out link waits.'], to: '/bookings' },
      CONNECTED,
    ],
  },
  {
    slug: 'guest',
    title: 'Guest',
    module: 'guest',
    purpose: 'Guest profiles with preferences and VIP level, foreign guest registration and the Immigration report, the check-in and check-out checklists, and lost and found.',
    to: '/guests',
    flows: ['foreign-guests', 'guest-profile', 'lost-found'],
    features: [
      { title: 'Profiles', does: 'Contact details, lifetime nights, revenue and last stay, preferences, VIP level, tags and every stay. Filter by VIP, nationality, blacklist and returning guests.', action: 'view', to: '/guests' },
      { title: 'Foreign guest registration', does: 'Nationality, passport or stay permit with expiry, birth, sex, entry date and port, visa type and address in Indonesia for the lead guest and each companion.', action: 'edit', rules: ['Check-in needs every APOA field for each foreign adult on the stay.', 'An expired passport or permit is refused.'], to: '/guests' },
      { title: 'Foreign guests for Immigration', does: 'Everyone foreign who checked in or is in house per day and villa, marked reported with who and when, and exported for the APOA upload.', action: 'view', rules: ['Report within 24 hours of check-in; the bell lists those past it.', APOA_ORDER], to: '/guests/foreign' },
      { title: 'Blacklist', does: 'A reason, who set it and when. Booking the guest needs a manager’s override with a reason.', action: 'approve', rules: ['Only someone who may approve in the guest module sets or lifts it.'], to: '/guests' },
      { title: 'Merge duplicates', does: 'Profiles sharing an email, phone or document number merge into one, with their stays, orders and payments.', action: 'approve', to: '/guests' },
      { title: 'Check-in and check-out', does: 'Checklists with deposit and departure charges, also on the phone. A banner shows VIP level, allergies and blacklist.', action: 'edit', to: '/m' },
      { title: 'Lost and found', does: 'Finds with a photo, linked to a guest or stay, stored, returned by hand or courier, or disposed of after the holding period. Staff log finds from the phone.', action: 'create', rules: ['Holding period 90 days by default, set in Settings.'], to: '/lost-found' },
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
    purpose: 'The board that takes each unit from dirty to ready, the room attendants’ daily lists, and linen with the laundry.',
    to: '/housekeeping',
    flows: ['housekeeping', 'room-attendant', 'linen-laundry'],
    features: [
      { title: 'Board', does: 'Dirty, cleaning, inspection and ready columns per location.', action: 'view', to: '/housekeeping' },
      { title: 'Inspection', does: 'A checklist decides whether the unit is ready.', action: 'edit', rules: ['A unit moves one stage at a time.'], to: '/housekeeping' },
      { title: 'Room attendant assignment', does: 'Plan the day’s departure, stayover, turndown, deep clean and inspection tasks, auto-assign them by villa and credits to the attendants on shift, and drag to reassign.', action: 'edit', rules: ['Auto-assign never passes the daily quota; unassigned tasks and attendants over quota are flagged.', 'Only attendants the roster has on shift that day.'], to: '/housekeeping?tab=assign' },
      { title: 'My rooms', does: 'Attendants start, pause and finish their own rooms with the checklist, record do not disturb, report faults and finds.', action: 'submit', rules: ['An attendant works only their own list.', 'Three days of do not disturb raise an alert.'], to: '/m/rooms' },
      { title: 'Quota and standards', does: 'The daily credit quota and each task type’s credits and standard minutes.', action: 'edit', to: '/housekeeping?tab=assign' },
      { title: 'Linen and laundry', does: 'Linen per villa in rooms, clean, soiled, at laundry and discarded against the par; laundry batches out and back with losses written off.', action: 'edit', rules: ['Laundry bills are cash-outs through approval.', 'Discards and losses are stock write-offs.'], to: '/housekeeping?tab=linen' },
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
    flows: ['booking-payment', 'work-order-expense', 'approval-chain', 'petty-cash', 'cashier-shift'],
    features: [
      { title: 'Cash in and cash out', does: 'Entries with category, reference and proof.', action: 'create', rules: [RULE.scope, RULE.posted], to: '/finance/transactions/new' },
      { title: 'Cash transfer', does: 'Two linked entries move money between accounts.', action: 'create', to: '/finance/transfer' },
      { title: 'Cashier shifts', does: 'Open and closed front desk shifts per cashbox with their float, cash in and out, count and difference, a printable shift report and the drawer tolerance.', action: 'view', rules: ['One open shift per cashbox.', 'A difference past the tolerance needs a reason and a manager’s sign-off.', 'Desk cashiers open and close their own shift with the payments create permission.'], to: '/finance/shifts' },
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
    flows: ['books', 'tax'],
    features: [
      { title: 'Chart of accounts', does: 'One account per cashbox, bank and petty cash, plus receivables, deposits, payables, BPJS and PPh 21, equity, room revenue, room service revenue per department (4210 to 4270), other income and expenses.', action: 'view', to: '/accounting' },
      { title: 'Transaction codes', does: 'Every folio line carries a code (ROOM, FNB, MINI, LDRY, TRNS, SPA, TOUR, XTRA, LATE, DMG, and a code per payment method). A charge code names the revenue account its lines book to; finance adds, edits and retires codes, with revenue by code and department in the reports.', action: 'edit', rules: ['A new account applies to postings from then on; posted journals stay.', 'ROOM and the payment codes stay active.', 'Guest revenue categories follow their code; the Categories page maps the rest.'], to: '/accounting/transaction-codes' },
      {
        title: 'Tax and service',
        does: 'Service charge and PB1 rates by effective date, the codes that carry each, whether PB1 applies on the amount plus service, how direct prices read (net by default, Airbnb always inclusive), the regency of each location, and Pay PB1 for a closed month. Folio and invoice show subtotal, service, PB1 and total; the books hold service on 2400 and PB1 on 2330.',
        action: 'edit',
        rules: ['New rates start today or later; earlier postings keep theirs.', 'Amounts round to whole rupiah, half up; an inclusive price leaves the rounding on PB1.', 'Stays and room money from before the console read inclusive, so what was paid stays the bill.', 'Menu prices include service and PB1; a desk charge reads in its stay’s price mode.', 'Departure charges post on DMG without tax.'],
        to: '/accounting/tax',
      },
      { title: 'Automatic journals', does: 'Posting, reversal, transfers, adjustments, cash counts, payroll close, check-out, folio charges and room service delivery write balanced entries with a link to their record.', action: 'view', rules: ['Journals are never edited; corrections go through the reversal of the cash entry.', 'Debits always equal credits.'], to: '/accounting/journals' },
      { title: 'General ledger', does: 'Each account’s lines with a running balance, by range and villa.', action: 'view', to: '/accounting/ledger' },
      { title: 'Statements', does: 'Trial balance, income statement and balance sheet by period and villa, with CSV through the reports.', action: 'report', to: '/accounting/balance-sheet' },
      { title: 'Receivables and partner payables', does: 'Room money waits on Guest deposits until the first night audit bills the room on the stay’s receivable, night by night, with check-out billing what no audit reached; delivered orders and folio charges bill it as they happen; delivered partner costs wait on the partner payable until the bill is paid. Balances per stay and per partner.', action: 'report', rules: ['A settled stay ends with its receivable at zero.'], to: '/reports/stay-receivables' },
      { title: 'Manual journals', does: 'Balanced adjusting entries with memo and evidence through the approval chain, signed from the approval inbox.', action: 'create', rules: ['Cash and bank accounts move through cash entries only.', RULE.self], to: '/accounting/manual' },
      { title: 'Period close', does: 'Close an ended month so nothing posts into it; reopen with a reason.', action: 'post', rules: ['A month closes only when nothing dated in it waits for approval.'], to: '/accounting/periods' },
    ],
  },
  {
    slug: 'villa-owners',
    title: 'Villa owners',
    module: 'finance',
    purpose: 'Villas that investors own and hand to the operator under a management contract: monthly owner statements, payouts and owner stays. It sits in Finance because closing posts a journal and paying is a bank cash-out, the work of the people who post money.',
    to: '/villa-owners',
    flows: ['owner-statement', 'owner-stay'],
    features: [
      { title: 'Owners and contracts', does: 'Each owner with contact, payout bank account and NPWP; a contract per villa with the fee basis (room revenue, gross revenue or GOP), a fixed monthly fee, which costs the owner bears, owner nights and their price, the FF&E reserve and the payout day.', action: 'post', rules: ['One contract per villa on any date.', 'Saka and Tirta have no contract: they are the operator’s own.'], to: '/villa-owners' },
      { title: 'Monthly statement', does: 'Room revenue, other revenue, charged costs, GOP, management fee, reserve, owner stays and net payable, from the same villa P&L as the owner reports, each figure opening to its stays and entries; printable to PDF.', action: 'view', to: '/villa-owners/statements' },
      { title: 'Close, approve, pay', does: 'Finance closes an ended month, the Owner approves it, finance submits the payout from the bank through the approval chain.', action: 'post', rules: ['The person who closes cannot approve.', 'Revenue and costs of an owned villa stay in the operator’s books, since the operator collects and pays for the owner. Closing moves the owner’s share of the villa result out of the operator’s profit (Dr 5900 Owner share of villa results, Cr 2500 Payable to villa owners), books the fee as 4800 Management fee income, and the payout debits 2500.'], to: '/villa-owners/statements' },
      { title: 'Carry forward and reopen', does: 'A month below zero pays nothing: the next statement shows it brought forward and pays only the net payable after carry forward. A top-up contract asks the owner for it instead. Finance reopens an unpaid statement with a reason.', action: 'post', rules: ['A carried shortfall stays on 2500 as a debit until a later month covers it.', 'A top-up moves the shortfall to 1220 Receivable from villa owners until the owner’s cash-in posts.', 'Only the contract’s latest statement reopens, and reopening reverses its close journal.'], to: '/villa-owners/statements' },
      { title: 'Owner stays', does: 'Requests from the portal, approved onto a free unit as an owner block.', action: 'view', to: '/villa-owners' },
    ],
  },
  {
    slug: 'city-ledger',
    title: 'City ledger',
    module: 'finance',
    purpose: 'Companies and travel agents billed after the stay: the desk moves the bill off the guest folio onto the account, and finance invoices, collects and chases it.',
    to: '/city-ledger',
    flows: ['city-ledger'],
    features: [
      { title: 'Accounts', does: 'Each company or agent with contact, billing email, address, NPWP, credit limit, payment terms, an agent’s commission and the villas it may book; the list shows balance, overdue and credit used.', action: 'view', to: '/city-ledger' },
      { title: 'Billing on the booking', does: 'A direct booking or group carries the account and what it pays; the rest stays with the guest.', action: 'view', rules: ['Past the credit limit, only finance or a villa manager books it, with a reason.'], to: '/bookings/new' },
      { title: 'Transfer at the desk', does: 'The folio card and the check-out form move the balance, or the part the instruction covers, to the account; check-out then settles only the rest.', action: 'view', rules: ['The transfer needs booking edit.', 'The stay’s guest receivable still ends at zero.'], to: '/bookings' },
      { title: 'Invoices and payments', does: 'Invoices numbered CL-YYYY-MM-NNN with the tax as billed, the agent commission, an email through the outbox, payments through the cash-in approval chain spread over invoices, credit kept on the account.', action: 'create', to: '/city-ledger' },
      { title: 'Ledger, aging and statement', does: 'Every transfer, commission, payment and write-off with a running balance, aging by days past due, and a printable statement of account.', action: 'view', to: '/city-ledger' },
    ],
  },
  {
    slug: 'portal',
    title: 'Owner portal',
    module: 'portal',
    purpose: 'Where a villa owner signs in to follow their own villas: performance, a calendar without guest details, statements, payouts, owner stays and the contract. Nothing operational and no other villa shows.',
    to: '/portal',
    flows: ['owner-stay'],
    features: [
      { title: 'Performance', does: 'Occupancy, ADR, RevPAR and room revenue of the owner’s villas against a comparison period, six months of revenue and the nights already booked.', action: 'view', rules: ['Scoped to the villas the owner holds a contract for.'], to: '/portal' },
      { title: 'Calendar', does: 'Guest stays by source, owner stays and closed nights on the owner’s units; guest names stay hidden.', action: 'view', to: '/portal/calendar' },
      { title: 'Statements and payouts', does: 'Approved statements with download and print, and where each payout stands.', action: 'view', to: '/portal/statements' },
      { title: 'Owner stays', does: 'Ask for dates within the yearly allowance and follow the operator’s answer.', action: 'create', to: '/portal/stays' },
      { title: 'Documents', does: 'The management contract and the payout details on file.', action: 'view', to: '/portal/documents' },
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
    slug: 'revenue',
    title: 'Revenue management',
    module: 'reports',
    purpose: 'Occupancy, ADR, RevPAR, pace, forecast and budget against actual per villa, location and portfolio.',
    to: '/revenue',
    flows: ['revenue'],
    features: [
      { title: 'Revenue dashboard', does: 'KPI tiles with their change, core statistics against the comparison and last year, a 12-month trend, pace for six months, the source mix and villas ranked by RevPAR.', action: 'view', rules: [RULE.scope, 'Rooms available are unit nights less blocked nights.', 'Room revenue comes from the stays night by night, never from the journals.'], to: '/revenue' },
      { title: 'Pace and forecast', does: 'On the books per month, against the month before at the same lead, and a month-end forecast from the trailing pickup.', action: 'view', to: '/revenue' },
      { title: 'Budget', does: 'Room nights, ADR, other revenue and expenses per villa and month, copied from last year or spread evenly from year totals.', action: 'report', rules: ['Saving needs Report in Reports and Edit in Finance.', RULE.scope], to: '/revenue/budget' },
      { title: 'Revenue reports', does: 'Daily statistics, monthly statistics by villa, pace and budget against actual, each with CSV export.', action: 'report', to: '/reports?group=revenue' },
    ],
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
    flows: ['housekeeping', 'cashier-shift'],
    features: [
      { title: 'Today', does: 'Arrivals with their online check-in status and a verify action, departures, check-in and check-out.', action: 'view', to: '/m' },
      { title: 'Free nights', does: 'Availability across units.', action: 'view', to: '/m/availability' },
      { title: 'Cashbox', does: 'Desk cash in and out.', action: 'view', to: '/m/cash' },
      { title: 'My shift', does: 'Open a cashier shift on a counted float, watch the running totals, close it on a counted drawer.', action: 'view', to: '/m/shift' },
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
  { from: 'booking', to: 'city-ledger', carries: 'Stays booked to a company or agent, and the transfers the desk makes at check-out.', flows: ['city-ledger'] },
  { from: 'city-ledger', to: 'accounting', carries: 'Transfers move the bill from 1200 to 1210; agent commission, payments and write-offs pay 1210 down.', flows: ['city-ledger'] },
  { from: 'villa-owners', to: 'accounting', carries: 'Each closed owner statement writes its close journal; the payout clears Payable to villa owners.', flows: ['owner-statement'] },
  { from: 'villa-owners', to: 'portal', carries: 'Approved statements, payouts and owner stay decisions show to the villa owner.', flows: ['owner-statement', 'owner-stay'] },
  { from: 'property', to: 'booking', carries: 'Units, room types and blocks decide what can be sold; some room types sell by type with the room assigned later.', flows: ['booking-payment', 'room-type'] },
  { from: 'airbnb', to: 'booking', carries: 'Airbnb reservations with the price Airbnb sold and its fee, and the listing price every direct stay starts from.', flows: ['airbnb-payout', 'booking-change'] },
  { from: 'booking', to: 'guest', carries: 'Verified online check-ins copy nationality, ID and contact onto the guest profile; every message shows on the guest.', flows: ['online-checkin', 'guest-messaging'] },
  { from: 'payments', to: 'booking', carries: 'Payment links and payments received send the guest a message.', flows: ['guest-messaging'] },
  { from: 'booking', to: 'payments', carries: 'Totals, deposits and balances due; every change recalculates them.', flows: ['booking-payment', 'booking-change'] },
  { from: 'payments', to: 'finance', carries: 'Each paid payment, payout and refund as a submitted entry, plus gateway fees.', flows: ['booking-payment', 'booking-change', 'airbnb-payout'] },
  { from: 'services', to: 'finance', carries: 'Paid room service as income per category, and partner bills as cash-outs.', flows: ['room-service'] },
  { from: 'services', to: 'booking', carries: 'Delivered orders on the guest’s bill; check-out waits for them.', flows: ['room-service'] },
  { from: 'guest', to: 'booking', carries: 'A blacklist refuses new bookings without a manager’s override; missing Immigration fields refuse check-in.', flows: ['guest-profile', 'foreign-guests'] },
  { from: 'maintenance', to: 'finance', carries: 'Work order expense lines as cash-outs with receipts.', flows: ['work-order-expense'] },
  { from: 'booking', to: 'finance', carries: 'The cost of walking a guest as a Guest relocation cash-out for approval.', flows: ['overbooking-walk'] },
  { from: 'booking', to: 'housekeeping', carries: 'Check-outs mark units dirty.', flows: ['housekeeping'] },
  { from: 'housekeeping', to: 'booking', carries: 'Ready units return to sale.', flows: ['housekeeping'] },
  { from: 'maintenance', to: 'property', carries: 'Open jobs block units.', flows: ['work-order-expense', 'preventive'] },
  { from: 'stock', to: 'finance', carries: 'Stock purchases as cash-outs with receipts.', flows: ['stock'] },
  { from: 'housekeeping', to: 'stock', carries: 'Released units take their amenity kit from the villa store; discarded and lost linen is written off it.', flows: ['stock', 'linen-laundry'] },
  { from: 'hr', to: 'housekeeping', carries: 'The roster says which room attendants are on shift for auto-assign.', flows: ['room-attendant'] },
  { from: 'housekeeping', to: 'maintenance', carries: 'Faults attendants find in rooms open work orders.', flows: ['room-attendant'] },
  { from: 'housekeeping', to: 'finance', carries: 'Laundry bills as cash-outs through approval.', flows: ['linen-laundry'] },
  { from: 'stock', to: 'services', carries: 'Minibar checks as delivered orders on the guest’s bill.', flows: ['stock'] },
  { from: 'me', to: 'hr', carries: 'Leave, overtime and loan requests.', flows: ['leave-overtime'] },
  { from: 'hr', to: 'payroll', carries: 'Attendance, approved overtime, unpaid leave and loan instalments.', flows: ['leave-overtime', 'payroll'] },
  { from: 'payroll', to: 'finance', carries: 'The closed period as one posted salary entry.', flows: ['payroll'] },
  { from: 'finance', to: 'approval', carries: 'Submitted entries waiting for the signatures their rule needs.', flows: ['approval-chain'] },
  { from: 'approval', to: 'finance', carries: 'Approved entries ready to post, rejected ones back to the author.', flows: ['approval-chain'] },
  { from: 'finance', to: 'accounting', carries: 'Each posted entry, transfer and adjustment as a balanced journal entry.', flows: ['books'] },
  { from: 'payroll', to: 'accounting', carries: 'The closed payroll as wages against cash and the BPJS and PPh 21 payables, which the statutory remittances pay down.', flows: ['books', 'payroll'] },
  { from: 'accounting', to: 'payroll', carries: 'Service charge payable for the month as the payroll service charge pool; closing payroll debits it for what it paid out.', flows: ['tax'] },
  { from: 'booking', to: 'accounting', carries: 'The night audit bills each night on the stay’s receivable and moves the deposits held onto it; check-out bills the rest.', flows: ['books', 'night-audit'] },
  { from: 'services', to: 'accounting', carries: 'Delivered partner costs on the partner payables.', flows: ['books'] },
  { from: 'accounting', to: 'approval', carries: 'Submitted manual journals waiting for the signatures their total needs.', flows: ['books', 'approval-chain'] },
  { from: 'accounting', to: 'reports', carries: 'Trial balance, income statement, balance sheet and the general journal.', flows: ['books'] },
  { from: 'finance', to: 'reports', carries: 'Posted entries feed cash, income, expense and profit and loss.', flows: ['booking-payment', 'work-order-expense'] },
  { from: 'reports', to: 'owner', carries: 'Net income, margin and villa ranking.', flows: ['booking-payment'] },
  { from: 'booking', to: 'revenue', carries: 'Stays and blocks become rooms sold and available, ADR, RevPAR, pace and the forecast.', flows: ['revenue'] },
  { from: 'finance', to: 'revenue', carries: 'Posted other income and expenses meet the budget.', flows: ['revenue'] },
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
  machine('cashier-shift', 'Cashier shift', SHIFT_STATUS_LABEL, SHIFT_TRANSITIONS),
  machine('lost-item', 'Lost item', LOST_STATUS_LABEL, LOST_TRANSITIONS),
  machine('room-task', 'Housekeeping task', TASK_STATUS_LABEL, TASK_TRANSITIONS),
]

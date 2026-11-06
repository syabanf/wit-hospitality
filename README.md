# Bali Villa Console

Operations console, finance back office, HR and payroll, employee area and front-desk phone app for a villa operator with 20 units across 4 locations in Bali. Built in the WIT UI style, version 2: one Vite + React 19 + Tailwind 4 app in clean architecture, light theme by default with a dark theme from the same tokens.

## Modules

- Dashboard: executive (revenue, occupancy, ADR, cash, payroll), operational and financial views with period, location, villa, unit, source and custom date filters; cards or tables.
- Property: locations, villas, room types, units with status (active, cleaning, maintenance, inactive), facilities and amenities, a five-step New property wizard, unit blocks. A room type of identical rooms can sell by type: guests book the type and the operator assigns the room. Each room type carries a rate plan (weekday, weekend for Friday and Saturday nights, seasons at a fixed price or a surcharge) that prices direct stays on units without a live Airbnb listing.
- Airbnb: host accounts, one listing per unit, manual Airbnb booking entry with the price Airbnb sold, fee, payout and payment status, account report. Each listing carries the one price list: a base price shared with the unit and per-night prices (weekends and the high season seeded higher) on a price calendar.
- Booking: direct and Airbnb bookings, live availability with interchangeable alternatives, calendar, overlap refusal, unit swap with history and actor, stay adjustment, lifecycle with no-show, notes, payment tracking, a guest folio per stay with every debit and credit (nights, discount, room service, posted charges, allowances, payments) that the check-out settles in one payment, and group bookings of several units with all-or-nothing availability, one group deposit and per-stay or master billing. A direct stay sells at the Airbnb listing price per night, or at the room type's rate plan when the unit has no live listing; staff can override the rate or give a percent or rupiah discount with a reason, and going past the discount limit (10% by default, on the payment policy) needs someone who may approve bookings. Airbnb stays keep the price the channel sold, extra nights included. Stays booked against a room type show as Unassigned in the list, in their own calendar lane and in the bell until the front desk assigns a room; check-in needs one, and the type never sells past its rooms on any night.
- Guest: profiles, stay history, check-in and check-out checklists with deposit and departure charges.
- Room services: a menu per villa (food, breakfast, laundry, transfers, spa, tours, extras) with hours, notice, photos and service partners with their cost; orders from the desk or from the guest through a QR card per room at `/order/:token`; an order board on the desk and the phone with late orders flagged; delivered orders on the guest's bill, check-out held until they are paid, payment by cash, transfer or a QRIS, VA or card link, income booked per category and partner bills as cash-outs, all through approval; items on the house with permission; four room service reports. Free requests (towels, cleaning, repairs) keep their own board.
- Maintenance: work orders apart from guest requests (parts, labour and vendor estimate, before and after photos, unit block while open, itemised expenses where each parts purchase, vendor invoice or labour payment is its own cash-out from the cashbox or the bank through the approval chain, with correction and resubmit after a rejection), preventive plans that open jobs when due, an asset register with warranty and repair cost, vendors with spend, a housekeeping board from dirty to ready with an inspection checklist, and five maintenance reports.
- Payments: deposit or full payment taken with a booking, cash and bank transfer recorded at the desk, QRIS, virtual account and card through a payment link with a guest checkout at `/pay/:token` (demo gateway buttons simulate success or failure), Airbnb payouts matched against the bank, refunds, receivables aging, printable invoices, gateway fees, and a payment policy. Every payment lands as a cash-in for approval. Changing the stay reprices it: a longer stay or a dearer unit raises the balance, a shorter one offers the overpayment back as a refund. Cancelling applies the policy (the deposit back when cancelled early enough, kept as room revenue otherwise) and a no-show keeps what was paid; both close open payment links.
- Receipts and evidence: photos and PDFs up to 5 MB, picked, dropped or photographed on the phone, on cash entries, work order expenses, desk payments, refunds and the guest checkout (transfer receipt). They travel to the ledger entry, approvers see them in the inbox, and they lock once the entry is posted. Cash-outs from a set amount (Rp 1.000.000 by default, on the Categories page) need one before approval.
- Record flow: booking, payment, cash entry, work order, payroll period and leave or overtime requests show where they sit in their flow, each step linking to the record it leads to.
- Finance: cashboxes and bank, cash in and out with reference and attachments, cash transfer between accounts, balance adjustment, cash count reconciliation, categories per villa, posting and reversal. Petty cash per villa with a float, a custodian, spends that always carry a receipt, top-ups back to the float through approval, counts, a low-balance alert, and a villa manager's view limited to their villa.
- Accounting: a chart of accounts with each category and cash account mapped to a ledger account, a journal written on every posting, reversal, transfer, adjustment, cash count and payroll close, manual adjusting journals through approval, general ledger, trial balance, income statement and balance sheet by villa, and month close.
- Stock: items for the minibar, amenities and linen, a store per villa with on hand and average cost, purchases that become cash-outs for approval, an amenity kit per room type issued on each turnover, minibar checks that bill the guest through room service, transfers, write-offs, counts with variance, low stock alerts and four stock reports.
- Approval: configurable rules by kind, villa and amount with multi-level chains (Villa manager, Finance, Owner), approve or reject with a note, resubmit, approval history, an inbox per role, separation between author and approver.
- HR: employees with villa allocation, shift roster, attendance, leave and overtime with approval, employee loans and salary advances, KPI reviews, announcements.
- Payroll: monthly periods calculated from salary, allowances, overtime, service charge, THR, bonus, reimbursement, late and absence deductions, loan instalments, BPJS and a simplified PPh 21; adjustments with reasons; approve, close (posts the bank entry and books loan repayments), reopen with a reason, publish payslips; configurable settings.
- Employee area: home with attendance, shifts, leave balance, latest payslip, KPI and announcements; leave, overtime and loan requests; payslips.
- Reports: management reports (cash, cash flow, income, expense, profit and loss by villa, location and portfolio, approvals, revenue by source, account and listing, discounts given by villa and by person, petty cash by villa, occupancy, bookings, unit movements, guest history, payroll summary, by villa and by location, attendance, leave, overtime) with date, scope and status filters and CSV export for Excel.
- Access and security: sign-in, users, roles with a permission matrix per module and action, villa and location scoping, audit trail with before and after values, posted entries never edited.
- Master data: one page per reference table, approval rules and shifts included.
- Guide at `/guide`: every module with its features, the roles allowed by the permission matrix and the rules it enforces, each flow as numbered steps with its system detail (use case, records and status changes, ledger entries, approval levels, audit, refusals, reports), a module connection map and the lifecycle of each main record.
- Front desk app at `/m`: today, free nights, room services, cashbox and villa petty cash, my area.

## Run

```bash
pnpm install
pnpm dev
```

The app runs on in-memory sample data that it keeps in the browser for the day; reset it from Settings. Sign in with any of the demo logins listed on the sign-in page (password `villa123`): owner, villa manager, finance, HR, reservation, staff and administrator. `/login?as=wayan&next=/me` signs in as a seeded user directly. Set `VITE_API_URL` to the Go API base (for example `https://host/api/v1`) to run against the backend.

## Checks

```bash
pnpm check
```

Runs the TypeScript build, oxlint and Vitest (domain rules, use cases over the mock adapters, seed integrity, the architecture rule).

## Layout

```
src/lib             pure helpers
src/domain          types, labels and rules, no React
src/application     ports, use cases and the report registry
src/infrastructure  mock adapters (seed data, rules, persistence, sessions, audit) and the HTTP adapter
src/presentation    UI kit, charts, hooks, layouts, feature pages
src/app             composition root and router
```

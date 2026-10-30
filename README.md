# Bali Villa Console

Operations console, finance back office, HR and payroll, employee area and front-desk phone app for a villa operator with 20 units across 4 locations in Bali. Built in the WIT UI style, version 2: one Vite + React 19 + Tailwind 4 app in clean architecture, light theme by default with a dark theme from the same tokens.

## Modules

- Dashboard: executive (revenue, occupancy, ADR, cash, payroll), operational and financial views with period, location, villa, unit, source and custom date filters; cards or tables.
- Property: locations, villas, room types, units with status (active, cleaning, maintenance, inactive), facilities and amenities, a five-step New property wizard, unit blocks.
- Airbnb: host accounts, one listing per unit, manual Airbnb booking entry with fee, payout and payment status, account report.
- Booking: direct and Airbnb bookings, live availability with interchangeable alternatives, calendar, overlap refusal, unit swap with history and actor, stay adjustment, lifecycle with no-show, notes, payment tracking.
- Guest: profiles, stay history, check-in and check-out checklists with deposit and departure charges.
- Room services: requests per unit on a kanban board, assignment, charges recorded to the cashbox.
- Maintenance: work orders apart from guest requests (parts, labour, vendor cost, before and after photos, unit block while open, cost recorded as a cash-out through the approval chain), preventive plans that open jobs when due, an asset register with warranty and repair cost, vendors with spend, a housekeeping board from dirty to ready with an inspection checklist, and five maintenance reports.
- Finance: cashboxes and bank, cash in and out with reference and attachments, cash transfer between accounts, balance adjustment, cash count reconciliation, categories per villa, posting and reversal.
- Approval: configurable rules by kind, villa and amount with multi-level chains (Villa manager, Finance, Owner), approve or reject with a note, resubmit, approval history, an inbox per role, separation between author and approver.
- HR: employees with villa allocation, shift roster, attendance, leave and overtime with approval, employee loans and salary advances, KPI reviews, announcements.
- Payroll: monthly periods calculated from salary, allowances, overtime, service charge, THR, bonus, reimbursement, late and absence deductions, loan instalments, BPJS and a simplified PPh 21; adjustments with reasons; approve, close (posts the bank entry and books loan repayments), reopen with a reason, publish payslips; configurable settings.
- Employee area: home with attendance, shifts, leave balance, latest payslip, KPI and announcements; leave, overtime and loan requests; payslips.
- Reports: 21 management reports (cash, cash flow, income, expense, profit and loss by villa, location and portfolio, approvals, revenue by source, account and listing, occupancy, bookings, unit movements, guest history, payroll summary, by villa and by location, attendance, leave, overtime) with date, scope and status filters and CSV export for Excel.
- Access and security: sign-in, users, roles with a permission matrix per module and action, villa and location scoping, audit trail with before and after values, posted entries never edited.
- Master data: one page per reference table, approval rules and shifts included.
- Front desk app at `/m`: today, free nights, room services, cashbox, my area.

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

# Bali Villa Console

Operations console and front-desk phone app for a villa operator with 20 units across 4 locations in Bali. Built in the WIT UI style, version 2: one Vite + React 19 + Tailwind 4 app in clean architecture, light theme by default with a dark theme from the same tokens.

## Modules

- Dashboard: executive, operational and financial views with period, location, villa, unit, source and custom date filters; cards or tables.
- Property: locations, villas, room types, units, facilities and amenities, a five-step New property wizard, unit blocks.
- Airbnb: host accounts, one listing per unit, manual Airbnb booking entry, source tracking.
- Booking: direct and Airbnb bookings, live availability with interchangeable alternatives, calendar, overlap refusal, unit swap, stay adjustment, lifecycle.
- Guest: profiles, stay history, check-in and check-out checklists with deposit and departure charges.
- Room services: requests per unit on a kanban board, assignment, charges recorded to the cashbox.
- Finance: cashboxes and bank, cash in and out, approvals, posting and reversal, categories.
- Master data: one page per reference table.
- Front desk app at `/m`: today, free nights, room services, cashbox.

## Run

```bash
pnpm install
pnpm dev
```

The app runs on in-memory sample data that it keeps in the browser for the day; reset it from Settings. Set `VITE_API_URL` to the Go API base (for example `https://host/api/v1`) to run against the backend.

## Checks

```bash
pnpm check
```

Runs the TypeScript build, oxlint and Vitest (domain rules, use cases over the mock adapters, seed integrity, the architecture rule).

## Layout

```
src/lib             pure helpers
src/domain          types, labels and rules, no React
src/application     ports and use cases
src/infrastructure  mock adapters (seed data, rules, persistence) and the HTTP adapter
src/presentation    UI kit, charts, hooks, layouts, feature pages
src/app             composition root and router
```

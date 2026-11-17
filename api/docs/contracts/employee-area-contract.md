# Employee area: clock, shift swaps and leave balance (frontend and Go API)

> Design record: the contract the console and the people context build against. The code is the source of truth (`src/domain/selfService.ts`, `api/internal/people/domain/selfservice.go`); this file explains why the fields and codes look the way they do.

Every call acts in the signed-in employee's name (`user.employeeId` in the session). A login without an employee record gets `NO_EMPLOYEE_RECORD` on the clock and a field error on a swap. Dates are IsoDate in the business time zone, times "HH:MM".

## Clock: POST /api/v1/attendance/clock-in, POST /api/v1/attendance/clock-out
- Body: clock-in `{ reason, geo: { lat, lng } | null }`, clock-out `{ geo }`. The console asks the browser for a position for up to five seconds and sends null without one. A missing position never blocks the clock.
- The server stamps the time (`clock.Now()` in `BUSINESS_TZ`; the mock uses its clock's `time()`). The browser never sends a time.
- One attendance row per employee per day (the existing unique `(employee_id, key)`). A clock-in writes `status` present or late, `lateMinutes` from the shift start (`lateMinutes`, no grace period: the codebase had none), `source: "self"`, `note` the reason, `clockInGeo`.
- Clock-out closes today's open row, or yesterday's when that shift ends past midnight (`end < start`), and writes `clockOut` and `clockOutGeo`.
- Refusals, same code and message on both sides:
  - `CLOCK_ALREADY_IN` "You already clocked in at 07:02."
  - `CLOCK_ALREADY_OUT` "You already clocked out at 15:04."
  - `CLOCK_ON_LEAVE` "You are on leave today." (approved leave covers the day, or HR marked it leave)
  - `CLOCK_DAY_RECORDED` "HR recorded today as absent. Ask HR to correct it." (a row HR wrote that is not a day off)
  - `CLOCK_NOT_ROSTERED` "You are not on the roster today. Say why you are clocking in." (no shift and a reason under 3 characters)
  - `CLOCK_NOT_IN` "Clock in first."
- HR's `PUT /attendance` still wins. On a row the employee clocked it keeps `source: "self"` and the positions and sets `corrected: true`; the console shows "Corrected by HR".

### Attendance fields added
`source: "manual" | "self"`, `corrected: boolean`, `clockInGeo` and `clockOutGeo`: `{ lat, lng, villaId | null, distanceMeters | null, place: "villa" | "away" | "unknown" }` or null. Migration `people 00002_self_service` writes `source: "manual"` and nulls into existing rows. The fields ride the existing `people.attendance.recorded.v1` payload (additive), so payroll's `rm_attendance` copy, a JSON document behind a versioned upsert, takes them with the next event; payroll reads none of them, so no catch-up is needed for its copy.

### At the villa or away
- `stampGeo` measures the haversine distance (rounded metres) to the villa the roster names that day, else to every villa the person works at, and keeps the nearest. Within `radiusMeters` it reads "villa", past it "away", and "unknown" when no villa has a position.
- Villa positions are property's `lat`/`lng`. People's `rm_villas` copy gains `lat`, `lng` columns; the villa projection fills them, and a row at the same version without a position takes the replayed one, so the start-up snapshot catch-up (`villa.updated` is already in `copiedEvents`) fills a database seeded before the migration.
- `GET /attendance/settings` (any signed-in user) and `PUT /attendance/settings` (hr/edit): `{ radiusMeters }`, 20 to 5000, default 200, field error "The radius is 20 to 5000 whole metres." Stored in `people.settings` under id `attendance`.

## Team: GET /api/v1/team-shifts
The signed-in employee and every active coworker who shares a villa: `{ id, name, position, villaIds, assignments }`, assignments from today for 14 days (`TEAM_DAYS`). No salary, contact or bank fields, so a staff role reads it without hr/view. A login without an employee record reads `[]`.

## Shift swaps: GET/POST /api/v1/shift-swaps, POST /api/v1/shift-swaps/{id}/{accept|decline|cancel|approve|reject}
- Record `ShiftSwap`: `id` (sw-N), `number` (SW-500+N), `villaId`, `requesterId`, `requesterName`, `date`, `shiftId`, `counterpartId`, `counterpartName`, `counterDate | null`, `counterShiftId | null`, `note`, `status`, `requestedOn`, `respondedOn`, `decidedOn`, `decidedBy`, `decisionNote`.
- Offer `{ date, counterpartId, counterDate | null, note }`: hand the shift on `date` to the coworker, or take the coworker's shift on `counterDate` in exchange (same day or another day).
- Status: offered → accepted (coworker) → approved or rejected (hr/edit, the role that edits the roster); offered → declined (coworker); offered or accepted → cancelled (requester). A rejection needs a reason ("Say why.").
- The rules run on the offer, again on accept and on approval, against the roster as it stands:
  - `SWAP_PAST_SHIFT` the shift is today or earlier
  - `SWAP_NO_SHIFT` the person has no shift that day
  - `SWAP_NOT_COWORKER` the coworker does not work at the shift's villa (or works another villa that day)
  - `SWAP_ON_LEAVE` the person taking a shift is on approved leave that day
  - `SWAP_DOUBLE_SHIFT` the swap would give someone two shifts on one day
  - `SWAP_OPEN_EXISTS` another open swap already covers one of the shifts
  - `SWAP_NOT_ACCEPTED` approve or reject before the coworker accepted
  - `SWAP_INVALID_STATE` the swap already ended
  - `FORBIDDEN` someone other than the coworker answers, someone other than the requester cancels, or a role without hr/edit decides
- Approval writes the two (or four) roster cells through the same path as `PUT /shift-assignments`, each with its `people.shift_assignment.saved.v1` event, and saves the swap with `people.shift_swap.saved.v1` (no consumer yet).
- `GET /shift-swaps`: with hr/view or payroll/view every swap at a villa in scope, else the swaps the employee offered or was offered.
- The console shows open swaps on Home and Team shifts (Accept, Decline, Cancel swap) and on HR's roster page (Approve, Reject).

## Leave balance per kind
- Entitlement per year: annual from the employee's `annualLeaveDays`, sick 12, permission 6, unpaid no limit. No carry-over.
- `used` counts approved days and `pending` pending days of requests that start in the year; `left = max(0, entitlement - used - pending)`. Pending days count so two requests cannot both spend the same days.
- A request past `left` of a limited kind is refused with `LEAVE_BALANCE_EXCEEDED` and a message naming the days: "Only 6 annual leave days are left.", "Only 1 sick leave day is left.", "No permission days are left." This replaces the earlier annual-only field error on `to`.
- The console computes the balances from the leave list (`leaveBalances`) for the Leave page and HR's employee page; the API checks the same rule in `RequestLeave`.

## Seed
Two swaps at Villa Saka (SW-501 offered from Sari to Wayan as a same-day trade, SW-502 accepted and waiting for HR), and self clock-ins with positions for this month's worked days, today's morning shift still clocked in. `SEED_VERSION` 24; fixtures from `node api/scripts/export-seed.mjs 2026-11-11`.

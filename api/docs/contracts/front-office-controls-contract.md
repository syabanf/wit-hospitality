# Front office controls: room discrepancies, card holds and the log book

> Design record: the contract the frontend and the Go API were built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on hotel-desk-contract.md. Money in whole rupiah, dates IsoDate, stamps local date-times as the rest of the API writes them (`clock.Stamp`, the mock's `clockNow()`). Three controls from the standard front office SOPs: housekeeping's room report against the front office, a card pre-authorization as the security deposit, and the desk's shift log.

## Owners and why

| Record | Context | Why there |
|---|---|---|
| Room checks and their discrepancies | housekeeping | Housekeeping walks the rooms and records what it found; it already keeps a copy of the stays (`housekeeping.stays`) and the catalog, so it can compare at the moment of the check without a call. |
| Night audit block on open discrepancies | billing (asks housekeeping) | Billing runs the night audit. It asks housekeeping in process (split mode: an internal route) for the count of open discrepancies, the way it asks people about the roster. |
| Card pre-authorizations | billing | The hold is a payment instrument on the stay's folio; a capture is a card payment and lands through billing's payment facts. The demo gateway that settles payment links is in billing too. |
| Log book | billing | Billing owns the desk's day already: the business date, the night audit and the cashier shifts. A cashier's shift close writes its handover entry in the same transaction. No new context: the log book is small and lives beside the cashier shifts. |

Migrations: housekeeping `00008_room_checks.sql` (the room checks and the `persons` column on the stays copy), billing `00008_front_office.sql` (`pre_auths` and `log_entries`, record tables like the others).

Permissions reuse existing modules, so `src/domain/access.ts` and the rbac snapshot gain nothing: recording a room check needs maintenance/edit (housekeeping), resolving a discrepancy booking/edit, card holds payments/create, the log book booking/view to read and booking/edit to write. Closing the day over open discrepancies takes the restriction override rule (`mayOverrideRestrictions`): a villa manager, or a role with booking/approve.

## 1. Room discrepancy report (housekeeping)

```
FoundStatus       = "occupied" | "vacant" | "out_of_order"
DiscrepancyKind   = "sleep" | "skip" | "persons"
DiscrepancyAction = "checked_out" | "checked_in" | "housekeeping_error" | "guest_out"

RoomCheck {
  id: string                 // "rc-<date>-<unitId>": one check per room per day
  unitId, villaId: string
  date: IsoDate
  found: FoundStatus
  persons: number | null     // guests housekeeping saw, occupied only; null when not counted
  note: string
  checkedBy: string
  checkedAt: string          // stamp
  frontOffice: "occupied" | "vacant"   // the front office side when the check was saved
  bookingId: string | null   // the stay in house on the unit, if any
  bookingCode: string | null
  frontPersons: number | null
  discrepancy: DiscrepancyKind | null
  resolution: { action: DiscrepancyAction, note: string, by: string, at: string } | null
}
```

Labels. Found: Occupied, Vacant, Out of order. Kind: Sleep, Skip, Person count. Action: "Checked out the guest", "Checked in the walk-in", "Housekeeping error", "Guest out for the night".

### Front office status (`frontOffice`)
The unit is occupied on the date when a stay with `unitAssigned`, `unitId` the unit and status `checked_in` has `checkIn <= date` (a guest due out who has not checked out is still occupied). Otherwise vacant. `frontPersons`: the stay's check-in record (adults plus children), else its booked party, else null. The housekeeping copy of a stay gains a `persons` column for it (migration `00008_room_checks.sql`); a row at the same version with `persons` NULL is filled by a replay from the snapshot catch-up.

### Discrepancy (`discrepancyOf`)
- front office occupied, found vacant or out of order: `sleep` (the guest may have left without checking out);
- front office vacant, found occupied: `skip` (someone sleeps there without a check-in: revenue at risk);
- both occupied, `persons` and `frontPersons` both known and different: `persons`;
- otherwise none.

The comparison runs when the check is saved and is stored on it, so the list stays as it was found after the desk acts (a checked-out sleeper does not vanish from the report).

### Record a check
`PUT /housekeeping/room-checks` `{ unitId, date, found, persons, note }` -> RoomCheck. maintenance/edit, villa scope of the unit.
- Unknown unit: `NOT_FOUND`.
- Field `date`: not an ISO date "Pick the day."; after today "<date> has not come yet.".
- Field `found`: not one of the three "Pick what housekeeping found.".
- Field `persons`: given with occupied and not a whole number from 1 to 20, "Enter the guests seen as a whole number from 1, or leave it empty.". With vacant or out of order it is stored as null.
- Field `note`: over 300 characters "Keep the note under 300 characters.".
- The same room and day again replaces the check (same id) unless it is resolved: `ROOM_CHECK_RESOLVED`, "<unit code> on <date> is resolved; its check stays as recorded.".
- Audit (entity `room-check`, id the check id): "Recorded <unit code> on <date>: <found label>" plus ", <n> guests" (", 1 guest") when counted, plus ", <kind label> discrepancy" when there is one.

### Resolve
`POST /housekeeping/room-checks/{id}/resolve` `{ action, note }` -> RoomCheck. booking/edit, villa scope.
- Unknown check: `NOT_FOUND`.
- No discrepancy: `DISCREPANCY_NONE`, "<unit code> on <date> matches the front office; nothing to resolve.".
- Resolved already: `DISCREPANCY_RESOLVED`, "<unit code> on <date> was resolved by <name>.".
- Field `action`: not one of the four "Pick how the desk settled it."; not allowed for the kind "<action label> does not settle a <kind label lower case> discrepancy.". Allowed: sleep: checked_out, guest_out, housekeeping_error; skip: checked_in, housekeeping_error; persons: guest_out, housekeeping_error.
- Field `note`: under 3 characters trimmed "Say what the desk found."; over 300 "Keep the note under 300 characters.".
- The action is a record of what the desk did; the check-out or walk-in check-in goes through the booking as usual.
- Audit: "Resolved <kind label lower case> on <unit code> <date>: <action label>".

### Read
`GET /housekeeping/room-checks` -> RoomCheck[], newest date first then unit code, filtered by villa scope; maintenance/view or booking/view.

### Night audit block
- Open discrepancy: a check with a discrepancy and no resolution. The audit counts those with `date <= ` the business date it closes.
- Internal: `GET /internal/v1/housekeeping/open-discrepancies?date=<date>` -> `{ count }` (every villa). Go interface `housekeeping.Discrepancies { OpenDiscrepancies(ctx, date) (int, error) }`; billing's stand-in answers 0 when no housekeeping is reachable.
- Console check `discrepancies`, label "Room discrepancies open", hint "Resolve each one, or a manager closes the day with a reason.", items "<unit code> · <kind label> · <date>" linked to `/front-office/discrepancies?date=<date>`.
- `POST /night-audits` body gains `override?: { reason } | null`; `NightAudit` gains `override: { by, reason } | null` (absent on older audits, read as null). Rule (`discrepancyBlock`), checked after `AuditProblem` and before anything posts, and in the console before the no-shows are marked:
  - no open discrepancy: no override is kept (null);
  - no override: `AUDIT_DISCREPANCIES`, "1 room discrepancy is still open; resolve it before closing the day." / "<n> room discrepancies are still open; resolve them before closing the day.";
  - reason under 3 characters trimmed: `AUDIT_DISCREPANCIES`, "Give the reason to close the day over open discrepancies.";
  - the person may not override: `AUDIT_DISCREPANCIES`, "Only a villa manager or someone who approves bookings may close the day over open discrepancies.";
  - else the audit runs and keeps `{ by: <name>, reason: <trimmed> }`; its audit line ends ", over <n> open discrepancies".

## 2. Card pre-authorization (billing)

```
CardBrand     = "visa" | "mastercard" | "amex" | "jcb" | "unionpay"   // Visa, Mastercard, American Express, JCB, UnionPay
PreAuthStatus = "active" | "captured" | "released"

PreAuth {
  id: string            // "pa-<n>"
  number: string        // "PA-<1000 + n>"
  bookingId: string
  amount: number        // the hold
  brand: CardBrand
  last4: string         // four digits; the card number is never sent or kept
  approvalCode: string
  expiresOn: IsoDate    // the last day the hold stands
  status: PreAuthStatus
  takenBy: string
  takenAt: string
  captured: number      // 0 until captured
  paymentId: string | null
  closedBy: string | null
  closedAt: string | null
}
```

Expired is read, never stored: an active hold with `expiresOn < today` (`preAuthExpired`). The console shows "The hold lapsed on <date>; take another card or another deposit." on it.

### Take a hold
`POST /pre-auths` `{ bookingId, amount, brand, last4, approvalCode, expiresOn }` -> PreAuth. payments/create, villa scope of the stay.
- Fields: `amount` "Enter the hold in whole rupiah." (whole, above 0); `brand` "Pick the card brand."; `last4` "Enter the last four digits of the card." (exactly four digits); `approvalCode` blank or 4 to 12 letters or digits, else "An approval code is 4 to 12 letters or digits."; `expiresOn` not an ISO date or before today "The hold must stand until today at least."; more than 30 days ahead "A card hold stands at most 30 days.".
- Stay not confirmed or checked in: `PREAUTH_STAY`, "<code> is <status label lower case>; a card hold is for a stay arriving or in house.".
- An active hold on the stay already: `PREAUTH_ACTIVE`, "<code> already holds <number>; capture or release it first.".
- The demo gateway authorizes it: last four "0000" declines with `PREAUTH_DECLINED`, "The gateway declined the hold on <brand label> ending <last4>.". A blank approval code takes the gateway's: `"A" + five digits of (n * 7919) mod 100000`, n the hold's sequence number. The API puts the gateway behind `command.CardGateway` (`Authorize`, `Capture`, `Release`) with `clients.DemoGateway` as the default, beside the demo settle of payment links.
- No money moves and nothing is booked: a hold is not cash.
- Audit (entity `pre-auth`, id the number): "Held <amount> on <brand label> ending <last4> for <code>, until <date>".

### Capture
`POST /pre-auths/{id}/capture` `{ amount }` -> `{ preAuth, payment }`. payments/create.
- Not active: `PREAUTH_CLOSED`, "<number> is <captured|released>.".
- Expired: `PREAUTH_EXPIRED`, "The hold on <number> lapsed on <date>; take the money another way.".
- Field `amount`: not a whole number above 0 "Enter the amount to capture in whole rupiah."; above the hold "Only <amount> is held." (formatted `id-ID`, e.g. "Only 2.000.000 is held."); above the stay's room balance on the folio (`due.room`, the forecast nights included) "The room balance is <amount>; capture at most that.". A credit on one part of the bill never pays another, and a card payment lands on the room part, so the capture is capped there.
- The capture makes one paid payment: kind `balance`, method `card`, the amount, gateway fee from the payment policy's card rate, reference the approval code, note "Captured from <number>", history `paid` by the person "Card hold captured". It lands like any paid card payment: a cash-in on the gateway account on `cat-room` and the fee as a cash-out (billing's `payment.recorded` fact). The rest of the hold is let go with it: status `captured`, `captured` the amount, `paymentId`, `closedBy`, `closedAt`.
- Audit: "Captured <amount> of <number> on <code>".

### Release
`POST /pre-auths/{id}/release` -> PreAuth. payments/create. Not active: `PREAUTH_CLOSED`. An expired hold may be released. Nothing is booked. Audit: "Released <number> on <code>".

### Read
`GET /pre-auths` -> PreAuth[] oldest first, villa scope of the stay; payments/view.

### On the desk
- Check-in deposit step: cash, bank transfer or card hold. Cash books as today: a submitted cash-in on the location's cashbox, category `cat-deposit`, "Security deposit, <code> <guest>". Transfer books the same cash-in on the location's bank account (cashbox when it has none), "Security deposit by transfer, <code> <guest>". A card hold takes `POST /pre-auths` before the check-in and sends `deposit: 0` on the check-in record, since no money is held; the hold amount is the deposit field.
- Booking page: a "Card hold" card lists the stay's holds, takes one on a confirmed or checked-in stay, and captures or releases an active one. At check-out the page reminds the desk of an active hold.

## 3. Front office log book (billing)

```
LogCategory = "handover" | "guest" | "maintenance" | "cash" | "security" | "other"
LogShift    = "morning" | "afternoon" | "night"

LogEntry {
  id: string             // "log-<n>"
  at: string             // stamp when written
  date: IsoDate          // the shift's day
  shift: LogShift
  author: string
  authorId: string
  category: LogCategory
  text: string
  villaId: string | null // the property it is about; null for every property
  link: { kind: "booking" | "unit" | "guest", id: string, label: string } | null
  followUp: boolean
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  doneBy: string | null
  doneAt: string | null
  doneNote: string
  shiftId: string | null // the cashier shift whose close wrote it
}
```

Shift from the stamp's local hour (`shiftOf`): 07:00 to 14:59 morning, 15:00 to 22:59 afternoon, 23:00 to 06:59 night. A night entry written before 07:00 belongs to the previous day's date. Labels: Morning, Afternoon, Night; categories Handover, Guest, Maintenance, Cash, Security, Other.

### Write
`POST /log-book` `{ category, text, villaId, link: { kind, id } | null, followUp }` -> LogEntry. booking/edit; a `villaId` must be in the person's scope.
- Field `category` "Pick a category."; field `text` under 3 characters trimmed "Write what the next shift needs to know.", over 1000 "Keep an entry under 1000 characters."; field `link` an unknown booking, unit or guest "That booking, room or guest was not found."; field `villaId` an unknown villa "Pick a property.".
- The server fills `link.label`: the booking code, the unit code, or the guest's name.
- Audit (entity `log-entry`): "Logged <category label lower case> note" plus ", follow-up" when flagged.

### Acknowledge and done
- `POST /log-book/{id}/acknowledge` -> LogEntry. booking/edit. Not flagged: `LOG_NO_FOLLOW_UP`, "That entry asks for no follow-up."; acknowledged already: `LOG_ACKNOWLEDGED`, "<name> acknowledged it at <HH:MM>."; the author: `LOG_OWN_ENTRY`, "The next shift acknowledges this note; you wrote it.". Audit "Acknowledged the note of <author>".
- `POST /log-book/{id}/done` `{ note }` -> LogEntry. booking/edit. Not flagged: `LOG_NO_FOLLOW_UP`; done already: `LOG_DONE`, "<name> marked it done at <HH:MM>.". Field `note` over 300 "Keep the note under 300 characters.". Anyone may mark it done, the author too; an entry nobody acknowledged is acknowledged with it. Audit "Marked the note of <author> done".
- Open follow-up: flagged and not done. They head the Log book page and count on the dashboard attention list until done.

### Read
`GET /log-book` -> LogEntry[] newest first; booking/view; entries with a `villaId` outside the scope are left out.

### Cashier shift close
`POST /cashier-shifts/{id}/close` body gains `handover?: string`. Trimmed and not empty, it writes a log entry in the same transaction: category `handover`, the text, `villaId` null, no link, no follow-up, `shiftId` the shift, author the person closing. Over 1000 characters: field `handover`, "Keep an entry under 1000 characters.". `CashierShift` gains `logEntryId: string | null` (absent on older shifts); the shift page links to the entry.

## 4. Seed

Base date 2026-11-11, `SEED_VERSION` 29 (after the merges with the front desk and guest relations rounds).
- Room checks: yesterday's and today's rounds on Villa Saka and two villas. Yesterday a skip on a Saka room resolved as a housekeeping error and a person count resolved as guest out; today a sleep on the room of a Saka guest in house, open, and the rest matching. The open sleep blocks today's audit until resolved or overridden.
- Card holds: PA-1001 captured at check-out on a stay that left (its balance payment becomes the card capture), PA-1002 active on a stay in house until two days after its check-out.
- Log book: a week of entries, two to four per day across the shifts, two open follow-ups (one acknowledged, one waiting), and the handover entry of the latest closed cashier shift linked from it.
- Fixtures: `make export-fixtures` writes `roomChecks` to housekeeping.json and `preAuths`, `logEntries` to billing.json; the loaders shift their dates.

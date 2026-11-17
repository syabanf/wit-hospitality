# Hotel front desk: room rack, arrivals, sections and rate packages

> Design record: the contract the frontend and the Go API were built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on operation-contract.md and hospitality-contract.md. Money in whole rupiah, dates IsoDate. Every rule keys on the unit kind (room or villa), so a mixed property applies the hotel rules to its rooms only.

## 1. Room rack (console only)

`/rooms` reads what already exists: the catalog, the bookings, the guests and the housekeeping board (`GET /housekeeping`). No endpoint and no status model were added.

- Shown in the menu when the user's scope holds a property whose operation is hotel or mixed. It lists room-kind units only.
- Occupancy of a room on a date, from its assigned stays (`src/domain/rack.ts` `roomOccupancy`):

| Occupancy | Stay |
|---|---|
| in house | checked in, `checkIn <= date < checkOut` (the date is not its check-out day) |
| due out | checked in, `checkOut == date` |
| arriving | confirmed, `checkIn == date`; on today also a confirmed stay that should have come in already and still holds the night (a late arrival) |
| departed | checked out, `checkOut == date` or `checkedOutOn == date` |
| vacant | none of the above |

  A room with a guest in house or due out shows that stay; an arrival the same day rides along as `next`. On a date after today a confirmed stay over the night reads in house and one that ends that day reads due out, so the rack doubles as a forecast.
- Housekeeping state is the board's (`dirty`, `cleaning`, `inspected`, `ready`, `out_of_order`), shown for today only. The rack labels `ready` "Clean" and `out_of_order` "Out of service"; the states are the board's own.
- Room-type stays with no room yet that arrive on the date are listed above the floors with "Assign room".

## 2. One arrival flow

### Assign room, then check in
`POST /bookings/{id}/assign-unit` is unchanged. The console ranks the rooms of the type that are free for the stay (`assignChoices`): ready and inspected first, then cleaning, then dirty, by room code inside each. A room that is not ready carries the warning "<code> is <state>; housekeeping has not released it." and stays selectable. "Assign and check in" opens the check-in form on the assigned stay.

### Walk-in
A vacant room on today's rack opens the booking form on that room, tonight to tomorrow, source direct, saved as confirmed, and lands on the check-in form (`/bookings/new?unit=<id>&walkin=1`, then `/bookings/{id}?desk=in`). A departed room offers the walk-in too. It uses `POST /bookings` and `POST /bookings/{id}/check-in` as they are.

### Room move
`POST /bookings/{id}/move-unit` body gains `rate`:

```
{ unitId, reason, price?: PriceChange, rate?: "keep" | "reprice" }
```

- Targets. A villa-kind stay moves between interchangeable units as before. A room-kind stay may also move to any other active room-kind unit of the same property, whatever its room type. Anything else: `UNIT_NOT_INTERCHANGEABLE`, "<target> is not interchangeable with <current>.". A target that is not active: `UNIT_UNAVAILABLE`, "<code> is <status>.".
- `rate` left out keeps the old behaviour: a direct stay reprices every night from the new unit's list, a channel stay keeps its price.
- `rate: "keep"`: every night keeps the price it was sold at (a free upgrade).
- `rate: "reprice"`: the nights from the move on take the new room's price list with the stay's rate package: night `i` is repriced when `i >= max(nights posted by the audit, days from check-in to today)`; before check-in that is every night. On a channel stay: `CHANNEL_PRICE_LOCKED`, "<code> keeps the price the channel sold it for.".
- Any other `rate`: field error `rate`, "Pick whether the rate follows the new room.".
- The movement is appended to `movements` as before. When the stay is checked in, the room it left goes dirty on the housekeeping board, updated by "Front desk" with the note "<booking code> moved to <target code>", when the board allows that move (the same rule as after a check-out). The API does it from `reservation.booking.saved.v1` in the housekeeping context (the stay's copy held another unit while checked in); the mock does it in `moveUnit`.

## 3. Housekeeping by floor or section

### Sections (property context)
A section is a named set of rooms of one hotel or mixed property.

```
Section { id, villaId, name, unitIds: string[] }
GET    /sections                 -> Section[] (scope filtered)
POST   /sections                 { villaId, name, unitIds } -> Section       property/edit
PATCH  /sections/{id}            { villaId, name, unitIds } -> Section       property/edit
DELETE /sections/{id}            -> 204                                        property/edit
```

Ids: `sec-<slug of the name>-<suffix>`: the mock uses `newId("sec", name)`, the API `ids.New("sec", name)`; clients treat the id as opaque.

Rules (`validateSection`), checked in this order:
- The property operates as a villa: `SECTION_HOTEL_ONLY`, "Sections group hotel rooms; <villa name> has none.".
- Field `name`: under 2 characters "Name the section."; over 40 "A section name is at most 40 characters."; taken in the property, ignoring case, "<name> is already a section of <villa name>.".
- Field `unitIds`: empty "Pick at least one room."; a unit of another property or a villa-kind unit "Pick rooms of this property."; a room already in another section "<room code> is already in <section name>.".
- `villaId` of an existing section does not change (field `villaId`, "A section stays with its property.").

Events: `property.section.saved.v1` `{ section: { id, villaId, name, unitIds }, locationId }` and `property.section.removed.v1` `{ id, villaId, locationId }`. Housekeeping keeps `housekeeping.cat_sections` from them (consumer `housekeeping.catalog`), caught up from property's snapshot on start. Audit: "Added section <name> to <villa>: <n> rooms", "Changed section <name> of <villa>: <n> rooms", "Removed section <name> from <villa>".

### Section attendants (housekeeping context)

```
SectionAssignment { sectionId, date, attendantId }
GET /housekeeping/section-assignments          -> SectionAssignment[] (scope filtered by the section's villa)
PUT /housekeeping/section-assignments          { sectionId, date, attendantId: string | null } -> RoomTask[]   maintenance/edit
```

- Field `date`: "Pick the day." when it is not an ISO date. Unknown section: `NOT_FOUND`. The attendant is not on shift that day: `NOT_ON_SHIFT`, "That attendant is not on shift on <date>.".
- With an attendant: the assignment is saved (one per section and day) and every `pending` task of that day on the section's rooms that another attendant or nobody holds goes to them, with an `assigned` history event noted "<section name>: <attendant name>".
- With `null`: the assignment is removed and the `pending` tasks of that day on the section's rooms that its attendant held go back to unassigned (`assigned` event noted "<section name>: unassigned").
- The answer is the tasks that changed hands.
- A task created later for a room of the section on that day (day plan, a task added without an attendant, a clean the guest asked for) starts with the section's attendant.
- Removing a section removes its assignments.
- Audit (entity `housekeeping-section`, id the section id): "Gave <section> to <name> on <date>: <n> tasks", "Cleared <section> on <date>: <n> tasks back to unassigned".

The console groups a hotel's rooms by floor on the assignments board and in the day view (`floorLabel`: "Floor 2", "Ground floor" for G or 0, "No floor" when empty); villas keep one group per villa. Auto-assign is unchanged: it only takes tasks nobody holds.

## 4. Rate packages (room types of kind room)

### On the rate plan (property context)

```
RatePackage { id, name, rate: "plan" | "fixed" | "percent", value, breakfast, accountId: string | null }
RatePlan    { groupId, weekdayRate, weekendRate, seasons, packages: RatePackage[] }
PUT /unit-groups/{id}/rate-plan   { weekdayRate, weekendRate, seasons, packages?: RatePackageInput[] }
```

- `rate`: `plan` sells at the plan's nightly rate, `fixed` at `value` rupiah every night, `percent` at the plan's rate less `value` percent.
- `breakfast`: rupiah per person per night, 0 without breakfast.
- `accountId`: a city ledger account of kind company the rate belongs to (a corporate rate), or null.
- "Room only" is not stored: a stay without a package is Room only (`ROOM_ONLY`).
- `packages` left out of the PUT keeps the packages the plan has; sent, it replaces them. A package sent without an id gets `pkg-<slug of the name>`, with `-2`, `-3` on a clash inside the plan.
- Events and copies: `property.rate_plan.saved.v1` carries `plan.packages`; reservation's `cat_rate_plans` stores the plan document, so the copy needs no migration.

Rules (`validateRatePackages`), field keys `packages.<i>.<field>` and `packages` for the list:
- More than 12: `packages`, "Keep at most 12 packages.".
- Any package on a villa-kind room type: `packages`, "Packages are for hotel room types; a villa sells at its own price.".
- `name`: under 2 characters "Name the package."; "Room only" (any case) "Room only is always offered; name this one differently."; twice in the list "<name> is listed twice.".
- `rate`: not one of the three "Pick how the room is priced.".
- `value`: fixed, not a whole number above 0, "Enter the nightly price in whole rupiah."; percent, not a whole number from 1 to 90, "A whole percentage from 1 to 90."; with `plan` the value is stored as 0.
- `breakfast`: not a whole number from 0 "Enter the breakfast price per person in whole rupiah, or zero."; `plan` with breakfast 0 "Add breakfast or a rate; without either this is Room only.".
- `accountId` set: it must be a city ledger account of kind company, "Pick a company account from the city ledger.". The API's property context asks billing in process; a property service that reaches no billing lets the id through.

### On a booking (reservation context)

- `POST /bookings` gains `packageId?: string | null`. `Booking` gains `ratePackage?: RatePackage | null`, a copy of the package as it was when sold; absent or null is Room only. Stays booked before packages keep their prices and have none.
- Refusals, in this order:
  - `PACKAGE_NOT_ALLOWED`, "A rate package is for a direct stay in a hotel room.": a channel stay or a villa-kind unit.
  - `PACKAGE_UNKNOWN`, "<room type name> has no such rate package.".
  - `PACKAGE_ACCOUNT`, "<package name> is a company rate; bill the stay to its city ledger account.": the package has an `accountId` and the booking's `cityLedger.accountId` differs or is missing.
- Price (`packageNight`): each night of the room's rate plan through the package. `fixed`: the rate is `value`, the source `{ kind: "plan", name: <package name> }`. `percent`: `round(rate * (100 - value) / 100)` (half up), source name "<night name>, <package name>". `plan`: the rate stays, source name "<night name>, <package name>".
- Nights a stay gains later (new dates, a room assigned, a move with `rate: "reprice"`, a move without `rate`) price through the stay's own `ratePackage`.
- Group stays and whole villa bookings take no package.

### Breakfast on the folio (billing context)

- New transaction code `BKF` "Breakfast", kind charge, department fnb, account `gl-4210`; it carries service and PB1 (`DEFAULT_SERVICE_CODES`, `DEFAULT_PB1_CODES`). No breakfast code existed (`FNB` is food and drinks), so this one is new; billing's migration adds it and puts it on the tax rates in force where `FNB` is.
- The night audit posts it. For every night it posts on a stay whose `ratePackage.breakfast > 0`, it adds one folio posting in the same transaction:
  - kind `charge`, code `BKF`, part `charges`, posted by the person who ran the audit;
  - amount `breakfast * persons`, read in the stay's price mode (`taxSplit(amount, "BKF", rates of today, stay mode)`), where `persons` is adults plus children of the check-in record, else of the booked party, else 1;
  - description "Breakfast, night <i> of <n>, <persons> guest(s)" ("1 guest", "2 guests").
- Nights that check-out posts because no audit reached them carry no breakfast posting.
- The stay's total (`stayTax`, the deposit, the amount still expected) is room only; breakfast is a folio charge settled at check-out like any other. The quote shows it as a separate estimate.
- The room night lines of the folio read "Night 1 of 3, <package name>".
- City ledger: breakfast postings sit in the charges part, so an account that pays them bills "All charges".

## 5. Seed

Villa Saka gets the sections "Ground floor" (SK-01 to SK-04) and "Floor 1" (SK-05 to SK-08), its attendant on shift today on the ground floor, and two packages on Saka standard: "With breakfast" (`pkg-with-breakfast`, plan rate, breakfast 150,000 per person) and "Nusa Retreats corporate" (`pkg-nusa-corporate`, fixed 1,650,000 a night, breakfast 120,000 per person, tied to the company account `cl-nusa`). The first direct guest in house and tonight's first assigned direct arrival sell With breakfast; BK-2005 sells on the corporate rate and bills `cl-nusa` (room only). The public site inventory leaves packages out on both sides, since a corporate rate names its company. `SEED_VERSION` 26 (after the merge with the guest stay page); fixtures from `make export-fixtures` with base date 2026-11-11.

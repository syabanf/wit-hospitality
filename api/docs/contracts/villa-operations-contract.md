# Villa operations: inventory checks, meters and upkeep plans

> Design record: the contract the frontend and the Go API were built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on operation-contract.md and hotel-desk-contract.md. Money in whole rupiah, dates IsoDate. Minibar checks stay as they are.

## Who owns what

| Record | Context | Why |
|---|---|---|
| Unit inventory lists, inventory checks | inventory | The contents of a unit are counted goods with a replacement cost, the same kind of record as stock counts. Inventory already keeps the stay copy (`ref_stays`) the minibar check reads, so a check needs no new copy. Housekeeping runs the check from its board; the record stays with inventory. |
| Meters, readings, utility settings | maintenance | Meters are villa equipment that the technicians read on their rounds, next to the assets. The readings bill out through events, so maintenance needs no money of its own. |
| Upkeep templates, upkeep plans and their tasks | maintenance | They are preventive plans and the work orders those plans open. |
| Folio charges for damage and utilities | billing | Billing owns the folio. It posts from `inventory.damage.charged.v1` and `maintenance.utility.billed.v1` once per source reference. |
| Utility lines on owner statements | owners | Owners closes statements. It keeps a copy of the owner-paid usage from `maintenance.utility.billed.v1`. |

Permissions reuse the existing matrix (`src/domain/access.ts`, `rbac.DefaultPermissions`), so no role changes: lists, checks, meters and readings need maintenance actions (staff hold view, create, edit, submit), a damage charge needs booking/edit (the desk), the long-stay setting needs property/edit.

## 1. Unit inventory (inventory context)

```
InventoryCategory = "kitchen" | "linen" | "electronics" | "furniture" | "bathroom" | "outdoor" | "pool"
UnitItem      { id, unitId, villaId, name, category, expected, condition, photo: string | null, replacementCost }
UnitItemInput { unitId, name, category, expected, condition, photo, replacementCost }

GET    /unit-items                                      -> UnitItem[]  (scope filtered)
POST   /unit-items          UnitItemInput               -> UnitItem    maintenance/edit
PATCH  /unit-items/{id}     UnitItemInput               -> UnitItem    maintenance/edit
DELETE /unit-items/{id}                                 -> 204         maintenance/edit
POST   /unit-items/copy     { fromUnitId, toUnitId }    -> UnitItem[]  maintenance/edit (the target's list after the copy)
```

Ids `uit-<n>` (counter `unitItem`). `condition` is the free condition note, `photo` a file name as the work order photos keep it.

`validateUnitItem`, field errors:
- `name`: under 2 characters "Name the item."; over 60 "An item name is at most 60 characters."; on the unit's list already, ignoring case, "<name> is already on this list.".
- `category`: "Pick the category.".
- `expected`: not a whole number from 1 to 999, "A whole number from 1 to 999.".
- `replacementCost`: not a whole number from 0, "Whole rupiah, zero or more.".
- `condition`: over 200 characters, "Keep the condition note under 200 characters.".
- `unitId` on PATCH differs from the item's: "An item stays with its unit.".

Copy (the template for a room type or villa): the source's items whose names the target lacks join the target's list with an empty condition and no photo.
- Same unit: `INVENTORY_COPY_SELF`, "Pick another unit to copy from.".
- Source has no items: `INVENTORY_COPY_EMPTY`, "<source code> has no inventory list to copy.".
- Nothing new: `INVENTORY_COPY_NOTHING`, "<target code> already lists every item of <source code>.".

Audit (entity `unit-item`): "Added <name> to the inventory of <code>", "Changed <name> on the inventory of <code>", "Removed <name> from the inventory of <code>", "Copied <n> items from <source> to <target>".

## 2. Inventory checks (inventory context)

```
CheckKind     = "pre_arrival" | "post_departure"     ("Pre-arrival check", "Post-departure check")
ItemCondition = "ok" | "damaged" | "missing"
CheckLine { itemId, name, category, expected, counted, condition, note, replacementCost,
            charge: { sourceRef, quantity, amount, reason, by, on } | null,
            workOrder: { id, number } | null,
            adjusted: boolean }
InventoryCheck { id, number, unitId, villaId, bookingId, bookingCode, kind, on, by, byId, lines: CheckLine[] }

GET  /inventory-checks                                                       -> InventoryCheck[] (scope filtered)
POST /inventory-checks  { unitId, bookingId, kind, lines: [{ itemId, counted, condition, note }] } -> InventoryCheck   maintenance/edit
POST /inventory-checks/{id}/lines/{itemId}/charge      { quantity, reason }  -> InventoryCheck   booking/edit
POST /inventory-checks/{id}/lines/{itemId}/work-order  {}                    -> InventoryCheck   maintenance/create
POST /inventory-checks/{id}/lines/{itemId}/adjust      {}                    -> InventoryCheck   maintenance/edit
```

Ids `ick-<n>`, numbers `IC-<1000+n>` (counter `inventoryCheck`). A line copies the item's name, category, expected count and replacement cost as they stood, so the check reads the same after the list changes.

Recording, in this order:
- `kind` not one of the two: field `kind`, "Pick the check.".
- The unit has no items: `CHECK_NO_LIST`, "<code> has no inventory list yet; add its items first.".
- The stay: unknown `NOT_FOUND`; on another unit, field `bookingId` "Pick a stay of this unit."; a pre-arrival check on a stay that is not confirmed or in house, `CHECK_STAY_STATE` "<code> is <status>; a pre-arrival check is for a stay arriving or in house."; a post-departure check on a stay that is not in house or checked out, `CHECK_STAY_STATE` "<code> is <status>; a post-departure check follows a stay in house or checked out.". Status words are the booking labels in lower case.
- The same kind twice on one stay: `CHECK_TWICE`, "<code> already has a <pre-arrival check|post-departure check>.".
- `lines` must hold every item on the list once: field `lines`, "Count every item on the list.". Per line `i`: `lines.<i>.counted` "Count in whole numbers." (whole number 0 to 9999); `lines.<i>.condition` "Pick ok, damaged or missing."; ok with fewer than expected, `lines.<i>.condition` "<counted> of <expected> found; mark it missing or damaged."; `lines.<i>.note` over 200 characters "Keep the note under 200 characters.".

Differences (`checkDiffs`, console): each line against the list (`counted - expected`) and, on a post-departure check, against the pre-arrival check of the same stay (`counted - pre.counted`, condition changed). A line is highlighted when its condition is not ok or either difference is not zero.

Line actions (each needs a line whose condition is not ok, else `CHECK_LINE_OK` "<name> was found in order."):
- **Charge** (post-departure only, else `CHECK_KIND` "Charges come from a post-departure check."): already charged `CHECK_CHARGED` "<name> is already charged to <booking code>."; replacement cost 0 `CHECK_NO_COST` "<name> has no replacement cost; set one on the list first."; field `quantity` "From 1 to <expected>."; field `reason` under 4 characters "Say why the guest pays for it."; the stay is no longer in house `CHECK_STAY_CLOSED` "<code> has checked out; charge damage while the guest is in house, before the deposit is returned.". The amount is `replacementCost * quantity`. The check-out form's deposit step follows, so the deposit can cover the charge. Inventory appends `inventory.damage.charged.v1` and billing posts it once.
- **Work order**: already raised `CHECK_WORK_ORDER` "<name> already has work order <number>.". Opens a maintenance work order through `maintenance.WorkOrders` (source `inspection`, priority normal, category by item category: kitchen appliance, linen other, electronics electrical, furniture structure, bathroom plumbing, outdoor garden, pool pool), title "<Damaged|Missing> <name> in <unit code>", description "<check number>, <check label>: <counted> of <expected> found<. note>".
- **Adjust the list**: already adjusted `CHECK_ADJUSTED` "<name> is already adjusted on the list.". The item's expected count becomes the counted number; a count of 0 removes the item.

Audit (entity `inventory-check`, id the number): "Recorded <label> <number> on <unit code> for <booking code>: <n> items off", "Charged <name> on <booking code>: <amount>", "Raised <work order number> for <name> from <check number>", "Adjusted <name> on the inventory of <unit code> to <counted>".

Event `inventory.damage.charged.v1`:
```
{ sourceRef: "<checkId>:<itemId>", bookingId, bookingCode, unitId, villaId, locationId,
  code: "DMG", description: "<Damaged|Missing> <name> (<quantity>): <reason>", amount, by, byId, at }
```

Console: the unit page lists the inventory and every check on the unit; the booking page lists the stay's checks; the housekeeping page shows today's villa arrivals and departures with "Pre-arrival check" and "Post-departure check". Villa-kind units get the step on the housekeeping page; a hotel room can run a check from its unit page.

## 3. Meters and readings (maintenance context)

```
MeterKind  = "electricity" | "water" | "gas"
MeterUnit  = "kWh" | "m3"
MeterPayer = "guest" | "owner" | "operator"
Meter      { id, villaId, unitId: string | null, kind, number, unit, tariff, payer, active }
MeterInput = Meter without id

ReadingPurpose = "monthly" | "check_in" | "check_out"
MeterReading { id, meterId, villaId, unitId: string | null, on, value, photo: string | null, purpose, bookingId: string | null,
               bookingCode: string | null, replacement, previous: number | null, consumption, amount,
               billedTo: "guest" | "owner" | null, by, byId }
ReadingInput { meterId, on, value, photo, purpose, bookingId, replacement }

UtilitySettings { villaId, longStayNights }

GET   /meters                                   -> Meter[]            (scope filtered)
POST  /meters            MeterInput             -> Meter              maintenance/create
PATCH /meters/{id}       MeterInput             -> Meter              maintenance/edit
GET   /meter-readings                           -> MeterReading[]     (scope filtered)
POST  /meter-readings    ReadingInput           -> MeterReading       maintenance/edit
GET   /utility-settings                         -> UtilitySettings[]  (one per villa in scope; 28 when never set)
PUT   /utility-settings/{villaId} { longStayNights } -> UtilitySettings   property/edit
```

Ids `mtr-<n>`, `mrd-<n>` (counters `meter`, `meterReading`). The long-stay length is a property setting held by maintenance, which is the only context that reads it; a villa without a row reads 28.

`validateMeter`, field errors: `number` 2 to 30 characters "Enter the meter number.", taken in the villa ignoring case "<number> is already a meter of <villa name>."; `kind` "Pick electricity, water or gas."; `unit` electricity not in kWh, or water or gas not in m3, "Electricity reads in kWh, water and gas in m3."; `tariff` "Whole rupiah per unit, zero or more."; `payer` "Pick who pays."; `unitId` of another villa "Pick a unit of this villa."; `villaId` changed on PATCH "A meter stays with its villa.". Field `longStayNights`: "A whole number of nights from 1 to 365.".

Recording a reading, in this order:
- Field `on` not a date "Pick the reading date.", after today "A reading cannot be dated after today."; field `value` not a number from 0 with at most two decimals "Enter the meter value."; field `purpose` "Pick monthly, check-in or check-out.".
- The meter is inactive: `METER_INACTIVE`, "<number> is out of use.".
- A reading dated before the meter's last one: `READING_OUT_OF_ORDER`, "<number> was last read on <date>; record readings in date order.".
- Below the last value and not marked as a replacement: `READING_BELOW_PREVIOUS`, "<value> is below the last reading of <previous> on <date>; mark it a meter replacement if the meter was changed.".
- Check-in and check-out: field `bookingId` empty "Pick the stay this reading belongs to.", on a unit the meter does not serve "Pick a stay of this meter's unit."; `READING_SHORT_STAY` "<code> is <n> nights; check-in and check-out readings are for stays of <N> nights or more."; `READING_TWICE` "<code> already has a <check-in|check-out> reading on <number>."; a check-out without the check-in `READING_NO_CHECK_IN` "Record the check-in reading of <code> on <number> first."; a check-out on a guest-paid meter when the stay is no longer in house `READING_STAY_CLOSED` "<code> has checked out; take the check-out reading while the guest is in house.".

Consumption is `value - previous` (two decimals), 0 on the first reading and on a replacement (the new meter counts from its first value).

Billing, once per reading pair:
- A guest-paid meter's check-out reading bills the usage since the stay's check-in reading (the consumption of every reading after it, up to this one) at the meter's tariff: `amount = round(usage * tariff)`, `billedTo: "guest"`.
- An owner-paid meter's monthly reading bills its consumption: `billedTo: "owner"`.
- Anything else bills nothing (`amount: 0`, `billedTo: null`). An amount of 0 publishes nothing.

Event `maintenance.utility.billed.v1`:
```
{ readingId, payer: "guest" | "owner", bookingId, bookingCode, meterId, meterNumber, kind, unit, usage, tariff, amount,
  villaId, locationId, month, on, description, by, byId }
description: "<Electricity|Water|Gas> <usage> <unit> at <tariff> per <unit>, meter <number>"
```
Billing posts a guest bill as a charge on the new code `UTIL` "Electricity, water and gas" (department other, `gl-4900`, no service or PB1) once per `readingId`. Owners keeps owner bills in `owners.utility_charges` (one row per `readingId`).

### Owner statements
`StatementBase.utilities` (optional, 0 on statements closed before) is the month's owner-paid usage; `OwnerStatement.utilities` (optional, empty before) lists it as `StatementUtility { readingId, on, meterNumber, kind, usage, unit, tariff, amount }`. `netPayable = gop - managementFee - reserve - ownerStayCharge - utilities`. The close journal credits `gl-4900` with the owner stay charge plus the utilities. `StatementClose` carries `utilities`; the API closes with its own lines from its copy and refuses a close whose lines do not add up (`STATEMENT_MISMATCH`).

### Long stays on the booking page
A stay of at least the villa's `longStayNights` on a unit with guest-paid meters shows a "Meter readings" card: per guest-paid meter (the unit's own and the villa's), its check-in and check-out readings and "Record" buttons that open the reading form with the purpose and stay filled in.

### Utilities page (`/maintenance/utilities`)
Meters (filters: villa, kind, payer, search), readings, consumption per month (last six months, column chart per kind) and per villa, the reading form and the long-stay setting.

## 4. Upkeep plan templates (maintenance context)

```
UpkeepTemplate = "pool" | "garden" | "fogging"
PlanUpkeep      { template, key, readings: boolean, outsideWindow: boolean, notifyStay: boolean }
PreventivePlan gains upkeep: PlanUpkeep | null          (null on plans made by hand and on existing rows)
WorkOrderUpkeep { key, checklist: [{ item, done }], readingsRequired: boolean,
                  readings: { ph, chlorine, flags: string[] } | null,
                  window: { from, to } | null, outsideWindow: boolean,
                  notice: { bookingId, bookingCode, text, sentOn: IsoDate | null } | null }
WorkOrder gains upkeep: WorkOrderUpkeep | null

POST /preventive-plans/templates  { villaId, unitId: string | null, template, startOn } -> PreventivePlan[]   maintenance/create
PUT  /work-orders/{id}/upkeep     { checklist: boolean[], readings: { ph, chlorine } | null, noticeSent: boolean } -> WorkOrder   maintenance/edit
```

Templates (`UPKEEP_TEMPLATES`, same keys, titles and checklists on both sides):

| Template | Key | Title | Every | Category | Extra |
|---|---|---|---|---|---|
| pool | `pool_daily` | Pool skim and chemical check | 1 day | pool | records pH and chlorine |
| pool | `pool_weekly` | Pool vacuum | 7 days | pool | |
| pool | `pool_monthly` | Pool filter backwash | 1 month | pool | |
| garden | `garden_weekly` | Garden mowing and trimming | 7 days | garden | |
| garden | `garden_monthly` | Garden fertilising | 1 month | garden | |
| fogging | `fogging_monthly` | Mosquito fogging | 1 month | pest | outside the service window, notifies the stay |

Applying: field `template` "Pick pool, garden or fogging."; field `startOn` "Pick the first day."; the villa outside scope `FORBIDDEN`; `unitId` of another villa field `unitId` "Pick a unit of this villa."; an active plan of the template already on that villa and unit `UPKEEP_APPLIED` "<villa name> already has the <Pool|Garden|Fogging> plans.". Every plan of the template is created active, due on `startOn`, unassigned, cost 0. Audit "Applied the <Template> plans to <villa>: <n> plans". Editing a plan (PATCH) keeps its `upkeep`.

Generating (`POST /preventive-plans/generate`, unchanged otherwise) for an upkeep plan looks at the stay in house on the plan's unit (any unit of the villa when the plan has none) today:
- The guest asked not to be disturbed (`serviceWindow.mode == "dnd"`): no work order; the plan stays due for the next run.
- A service window (the stay's own, else the villa default 10:00 to 12:00): `upkeep.window` holds it and the description ends "Within the guest's service window <from> to <to>." or, for an outside-window plan, "Outside the guest's service window <from> to <to>.".
- A notifying plan with a stay in house sets `upkeep.notice` with the text "<Title> at <villa name> on <date>, outside your service window (<from> to <to>). Please keep doors and windows closed for 30 minutes afterwards."; without a window the text ends at the date.
- The checklist is `upkeep.checklist` (all not done) and the description as before.

Recording (`PUT /work-orders/{id}/upkeep`): no upkeep `UPKEEP_NONE` "<number> is not an upkeep task."; verified or cancelled `WORK_ORDER_INVALID_STATE` "<number> is <status>; its checklist is closed."; field `checklist` "Tick the checklist as listed." (one boolean per item); readings on a task that records none, field `readings` "This task records no readings."; field `ph` "pH from 0 to 14."; field `chlorine` "Chlorine in ppm, from 0 to 20.". Flags (`poolFlags`): pH under 7.2 "pH low", over 7.8 "pH high"; chlorine under 1 "Chlorine low", over 3 "Chlorine high". `noticeSent: true` stamps `notice.sentOn` with today once. Closing a task that records readings without them: `READINGS_REQUIRED`, "Record the pH and chlorine on <number> before closing it.".

The console's "Notify the guest" sends the notice as a free WhatsApp message through the messaging port (booking/edit), then records `noticeSent`.

Maintenance keeps `maintenance.ref_stays` (consumer `maintenance.stays`) from `reservation.booking.saved.v1` and `.status_changed.v1`: code, status, unit, check-in, check-out and service window. It came with migration `00002_villa_ops`, so the start-up catch-up fills it from reservation's snapshot.

## 5. Seed

Villa inventory lists on two villas' units and on Saka standard's first room, copied to its room type mates; a pre-arrival and a post-departure check on a stay that left, one damaged item charged to its folio (`DMG`, before its check-out); meters on those villas with three months of monthly readings; one long stay (28 nights or more) billed for electricity on check-out (`UTIL`); pool, garden and fogging plans on two villas with a few completed tasks, one pool reading flagged. `SEED_VERSION` bumped; fixtures from `make export-fixtures` at base date 2026-11-11. Billing's seed claims the seeded charges' source references, and owners' seed carries the owner-paid utility lines, so cmd/seed posts nothing twice.

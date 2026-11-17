# Guest relations: complaints, incidents and safe deposit boxes

> Design record: the contract the frontend and the Go API were built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on guest-stay-contract.md and the lost and found section of ARCHITECTURE.md. Money in whole rupiah, dates IsoDate, times `YYYY-MM-DDTHH:MM` in the business time zone.

## 0. Who owns what

All three records live in the **guest** context, on the `guest` schema, next to lost and found.

- Guest already owns lost and found, the nearest sibling: a villa-scoped desk record with photos through the files context and a timeline of who did what. Complaints, incidents and safe boxes are the same front office desk and need the same copies guest keeps already (villas, units, locations for the scope, stays for the guest, code, unit and status).
- A new context would need its own copies of stays, villas and units, a service, a gateway route and catch-up for three small aggregates. Services was the other candidate, but it holds orders and requests that post money on its own; a complaint is about the guest, not about an order.
- Money goes to the folio through one event, `guest.folio_posting.requested.v1`, which billing posts once per `sourceId` (section 4). Guest never calls billing.
- The stay page form is a reservation route (`POST /stay/{token}/complaints`), like the other guest actions: reservation checks the token, the rate limit and the read-only state, records the guest action and asks guest through `guest.Complaints` to file it (section 5).
- A work order or a housekeeping task raised from a complaint uses the existing commands (`POST /work-orders`, `POST /housekeeping/tasks`); the console then links the new record to the complaint with a note (`POST /complaints/{id}/notes` with `ref`). No new cross-context call.

Pages: Complaints, Incidents and Safe boxes sit under Front office > Guests, after Lost and found. Incidents went there rather than Setup because the desk and the duty manager log them during a shift, as they log finds.

Counters (`guest.counters`, the mock's `seq()`): `complaint`, `incident`, `safeBox`, `boxRental`.

## 1. Complaints

```
ComplaintCategory = room | cleanliness | noise | service | food | billing | staff | facility | other
Severity          = low | medium | high
ComplaintStatus   = open | in_progress | resolved | closed
ComplaintSource   = desk | stay_page

Complaint {
  id: "cpl-<n>", number: "CP-<nnn>",
  villaId, unitId: string | null, bookingId: string | null, guestId: string,
  category, severity,
  description: string,        // what the guest said
  receivedBy: string,         // a name
  receivedAt: "YYYY-MM-DDTHH:MM",
  owner: string,              // a name; who follows it up
  source,
  status,
  resolution: { action, by, at } | null,
  compensation: Compensation | null,
  links: { kind: "work_order" | "room_task", id, label }[],
  timeline: { at, by, kind: "logged" | "note" | "status" | "resolved" | "compensation" | "link", note, ref: Link | null }[]
}

Compensation {
  kind: "folio_credit" | "free_service" | "goodwill",
  amount: number,             // folio_credit only, else 0
  description: string,
  status: "pending_approval" | "posted" | "rejected" | "given",   // given for free_service and goodwill
  decidedBy: string | null,   // who approved or rejected a credit; the resolver when it posted at once
  decidedAt: string | null
}

ComplaintInput { villaId, unitId, bookingId, guestId, category, severity, description, receivedBy, receivedAt, owner }
```

### Endpoints

| Endpoint | Needs | Answers |
| --- | --- | --- |
| `GET /complaints` | signed in, filtered to the villa scope | Complaint[] |
| `POST /complaints` | guest/create, villa in scope | Complaint (status open, source desk) |
| `PATCH /complaints/{id}` | guest/edit | Complaint; the status, resolution and timeline stay |
| `POST /complaints/{id}/notes` `{ note, ref?: Link }` | guest/edit | Complaint; a `ref` also joins `links` |
| `POST /complaints/{id}/move` `{ to: "in_progress" \| "closed", note }` | guest/edit | Complaint |
| `POST /complaints/{id}/resolve` `{ action, compensation: { kind, amount, description } \| null }` | guest/edit | Complaint |
| `POST /complaints/{id}/compensation` `{ approve: boolean, note }` | guest/edit, then guest/approve | Complaint |

### Rules (`validateComplaint`, field errors, `VALIDATION_ERROR`)
- `villaId` empty: "Pick the villa.".
- `guestId` and `bookingId` both empty: field `guestId`, "Pick the guest or the stay.".
- `category` not in the list: "Pick the category.". `severity` not in the list: "Pick the severity.".
- `description` under 5 characters trimmed: "Write what the guest said.".
- `receivedBy` under 2: "Say who received it.". `owner` under 2: "Name who follows it up.".
- `receivedAt` not `YYYY-MM-DDTHH:MM`: "Enter when it was received."; its date after today: "The time cannot be in the future.".
- With a `bookingId`, the stay wins: villa, unit and guest come from the stay; a `guestId` that differs is "<code> is booked by another guest." (`VALIDATION_ERROR`, the lost and found wording). Without one, a `unitId` outside the villa is "<unit code> is not in that villa." and the guest must exist (`NOT_FOUND`).
- Edit of a closed complaint: `COMPLAINT_INVALID_STATE`, "<number> is closed.".
- Note under 2 characters: field `note`, "Write the note.". Closed: `COMPLAINT_INVALID_STATE`, "<number> is closed.".

### Status moves (`COMPLAINT_TRANSITIONS`)
```
open:        in_progress, resolved
in_progress: resolved
resolved:    closed, in_progress     (back to in progress reopens it and clears the resolution; compensation already posted stays)
closed:      (none)
```
- `move` takes `in_progress` or `closed`; `resolve` is the only way to `resolved`. A move off the table, or `move` to any other status: `COMPLAINT_INVALID_STATE`, "<number> is <from label lower>; it cannot become <to label lower>." with labels Open, In progress, Resolved, Closed ("CP-004 is closed; it cannot become in progress."). Resolving a complaint that is resolved or closed answers the same with "resolved".
- Reopening a resolved complaint whose compensation is `pending_approval` rejects that compensation first (status `rejected`, decidedBy the mover).

### Resolve
- `action` under 3 characters: field `action`, "Say what was done.".
- `compensation.kind` not one of the three: field `compensation.kind`, "Pick the compensation.".
- `compensation.description` under 3: field `compensation.description`, "Say what the guest gets.".
- `folio_credit`:
  - `amount` not a whole number above 0: field `compensation.amount`, "Enter the credit in whole rupiah.".
  - No stay on the complaint: `COMPENSATION_NO_STAY`, "A folio credit needs the guest's stay; link the stay first.".
  - Stay not checked in: `BOOKING_INVALID_STATE`, "<code> is not in house; post to the folio during the stay.".
  - `amount <= COMPENSATION_LIMIT` (500,000), or the resolver may approve in the guest module: status `posted`, decidedBy the resolver, and the folio posting is requested (section 4).
  - Above the limit by someone who may not approve: status `pending_approval`, nothing posts yet. The complaint is still resolved.
- `free_service`: the desk places the order on the house through room service (the existing comp flow); the complaint records what was given. `goodwill`: flowers, a late check-out, a note. Both get status `given`, amount 0.
- Timeline: "resolved" with the action; "compensation" with "Credit of <amount> posted to the folio", "Credit of <amount> waits for a manager's approval", or "<kind label>: <description>".

### Approve or reject the credit
- Status not `pending_approval`: `COMPENSATION_INVALID_STATE`, "There is no compensation waiting for approval on <number>.".
- Caller may not approve in the guest module: `FORBIDDEN`, "Only someone who may approve in the guest module can approve compensation.".
- Reject without a note of 3 characters: field `note`, "Say why the credit is refused.".
- Approve with the stay no longer in house: `BOOKING_INVALID_STATE`, "<code> is not in house; post to the folio during the stay.".
- Approve: status `posted`, decidedBy/At set, the posting is requested. Reject: status `rejected`.

### Reading
- The console computes `resolutionHours` (receivedAt to resolution.at, whole hours) for the list and the report.
- `COMPENSATION_LIMIT = 500_000` is a constant on both sides (`src/domain/relations.ts`, `api/internal/guest/domain/relations.go`). The existing approval rules sign cash entries by amount and the rebate limit is a share of one folio line; neither fits a credit that corrects no line, so the credit keeps the rebate's spirit: past the limit someone who may approve in the guest module signs it.

## 2. Incidents

```
IncidentKind   = accident | theft | damage | security | medical | fire | other
  labels: Accident or injury, Theft or loss, Damage to property, Security, Medical, Fire or safety, Other
IncidentStatus = open | follow_up | closed
PersonKind     = guest | staff | outsider

Incident {
  id: "inc-<n>", number: "IN-<nnn>",
  kind, severity, villaId, unitId: string | null, area: string, occurredAt: "YYYY-MM-DDTHH:MM",
  bookingId: string | null,
  people: { kind: PersonKind, name: string, guestId: string | null, note: string }[],
  description: string, actions: string,
  policeCalled: boolean, doctorCalled: boolean, policeReport: string,
  attachments: Attachment[],
  reportedBy: string,
  status,
  timeline: { at, by, kind: "logged" | "follow_up" | "charge" | "closed", note }[],
  charge: { amount, reason, bookingId, by, at } | null,
  signOff: { by, at, note } | null
}

IncidentInput { kind, severity, villaId, unitId, area, occurredAt, bookingId, people, description, actions, policeCalled, doctorCalled, policeReport, attachments }
```

| Endpoint | Needs | Answers |
| --- | --- | --- |
| `GET /incidents` | signed in, villa scope | Incident[] |
| `POST /incidents` | guest/create, villa in scope | Incident (open) |
| `PATCH /incidents/{id}` | guest/edit | Incident |
| `POST /incidents/{id}/follow-ups` `{ note }` | guest/edit | Incident; open becomes follow_up |
| `POST /incidents/{id}/charge` `{ amount, reason }` | guest/edit | Incident |
| `POST /incidents/{id}/close` `{ note }` | guest/edit, then guest/approve | Incident (closed, signOff) |

Rules (`validateIncident`):
- `kind`: "Pick the kind of incident.". `severity`: "Pick the severity.". `villaId`: "Pick the villa.".
- `occurredAt`: "Enter when it happened."; date after today "The time cannot be in the future.".
- No `unitId` and `area` under 2: field `area`, "Say where it happened.".
- `description` under 5: "Describe what happened.".
- `people.<i>.name` under 2: "Name the person."; `people.<i>.kind` not in the list: "Pick who they are.".
- `attachments` over 10: "Attach at most 10 files.".
- With a `bookingId` the stay wins the villa and unit; a stay at another villa than `villaId` is not refused, it moves the incident there. A `unitId` outside the villa: "<unit code> is not in that villa.".
- Edit, follow-up, charge or close of a closed incident: `INCIDENT_INVALID_STATE`, "<number> is closed.".
- Follow-up note under 3: field `note`, "Write the follow-up.".
- Charge:
  - kind other than damage: `INCIDENT_CHARGE_KIND`, "Only damage to property is charged to a guest.".
  - no stay: `INCIDENT_NO_STAY`, "Link the guest's stay before charging the damage.".
  - already charged: `INCIDENT_ALREADY_CHARGED`, "<number> is already charged to <booking code>.".
  - `amount` not a whole number above 0: field `amount`, "Enter the charge in whole rupiah."; `reason` under 3: field `reason`, "Say what was damaged.".
  - stay not checked in: `BOOKING_INVALID_STATE`, "<code> is not in house; post to the folio during the stay.".
  - posts code DMG through section 4.
- Close: caller may not approve: `FORBIDDEN`, "Only someone who may approve in the guest module can sign off an incident."; note under 3: field `note`, "Write the closing note.".
- The dashboard bell lists incidents with severity high that are not closed and were logged in the last 7 days, for anyone who may approve in the guest module ("High-severity incident at <villa>: <kind label>").

## 3. Safe deposit boxes

```
SafeBoxSize   = small | medium | large
SafeBoxStatus = free | in_use | out_of_order
SafeBox { id: "box-<n>", villaId, number: string, size, status, note: string }
SafeBoxInput { villaId, number, size, note, outOfOrder: boolean }

Signature = drawn | paper | none
BoxRental {
  id: "bxr-<n>", number: "SB-<nnn>",
  boxId, villaId, bookingId, guestId,
  items: string, keyNumber: string,
  status: "open" | "closed",
  openedAt, openedBy,
  closedAt: string | null, closedBy: string | null,
  keyReturned: boolean | null,      // null while open
  keyFee: number,                   // 0 unless the key was lost and charged
  log: { kind: "open" | "add" | "take" | "close" | "key_lost", at, by, signature: Signature, signatureData: string, note }[]
}
OpenBoxInput   { boxId, bookingId, items, keyNumber, signature: "drawn" | "paper", signatureData }
BoxAccessInput { kind: "add" | "take", signature: "drawn" | "paper", signatureData, note }
CloseBoxInput  { keyReturned: boolean, keyFee: number, signature: "drawn" | "paper", signatureData, note }
```

`signatureData` is a PNG data URL of the drawn mark (at most 200,000 characters), "" when signed on paper.

| Endpoint | Needs | Answers |
| --- | --- | --- |
| `GET /safe-boxes` | signed in, villa scope | SafeBox[] |
| `POST /safe-boxes` | guest/edit, villa in scope | SafeBox (free, or out_of_order) |
| `PATCH /safe-boxes/{id}` | guest/edit | SafeBox; `villaId` stays |
| `GET /safe-box-rentals` | signed in, villa scope | BoxRental[] |
| `POST /safe-box-rentals` | guest/edit | BoxRental; the box goes in_use |
| `POST /safe-box-rentals/{id}/access` | guest/edit | BoxRental |
| `POST /safe-box-rentals/{id}/close` | guest/edit | BoxRental; the box goes free |

Rules:
- Box: `number` trimmed, 1 to 8 characters: "Number the box."; taken in the villa, ignoring case: "Box <number> is already at <villa name>."; `size` not in the list: "Pick the size."; `outOfOrder` on a box in use: `SAFE_BOX_IN_USE`, "Box <number> is in use; close it first.".
- Open: the box is not free: `SAFE_BOX_UNAVAILABLE`, "Box <number> is <in use | out of order>."; the stay not checked in: `BOOKING_INVALID_STATE`, "<code> is not in house; open a box during the stay."; the stay at another villa than the box: field `bookingId`, "<code> stays at another villa."; `keyNumber` empty: field `keyNumber`, "Enter the key handed to the guest."; `signature` drawn without data, or not drawn or paper: field `signature`, "Have the guest sign, or mark it signed on paper.". The log starts with `open`.
- Access and close on a closed rental: `SAFE_BOX_CLOSED`, "<number> is closed.". Access `kind` not add or take: field `kind`, "Pick what the guest did.". Same signature rule.
- Close: `keyFee` not a whole number from 0: field `keyFee`, "Enter the key fee in whole rupiah, or zero."; a fee with the key returned: field `keyFee`, "Charge a fee only for a lost key.". A fee above 0 needs the stay in house (`BOOKING_INVALID_STATE`, "<code> is not in house; post to the folio during the stay.") and posts code DMG through section 4. The log gains `close`, and `key_lost` before it when the key did not come back.
- Check-out is not refused by an open box. The check-out form warns: "Safe box <number> is still open for this stay; close it and take back the key.".

## 4. Money to the folio

```
guest.folio_posting.requested.v1 {
  sourceId: "complaint:<id>" | "incident:<id>" | "box-rental:<id>",
  bookingId, villaId,
  kind: "credit" | "charge",
  amount,                     // credit: what comes off the bill, service and PB1 inside; charge: as typed
  description,
  by, byId
}
```

- Descriptions: "Compensation for CP-003: <compensation description>", "Damage, IN-002: <reason>", "Lost safe box key, box <number> (SB-004)".
- Billing (consumer `billing.guest_postings`) posts once per `sourceId` (`billing.guest_postings (source_id PRIMARY KEY, posting_id)`), as the late check-out fee does:
  - `credit`: a folio posting of kind `rebate` on code ROOM, `lineId` null, part `charges`, split inclusive at today's rates (`taxSplit(amount, "ROOM", rates, "inclusive")`), so the guest's balance falls by exactly `amount`.
  - `charge`: kind `charge` on code DMG, part `charges`, split in the stay's price mode (DMG carries neither service nor PB1).
  - posted by `by`; a stay that is no longer in house when the event arrives is skipped with a log line, never retried forever.
- The mock posts the same posting at once through its `addPosting`.

## 5. The stay page form

`POST /stay/{token}/complaints { category, description }` answers the GuestStayView, like the other guest actions (rate limit, STAY_READ_ONLY, STAY_LINK_EXPIRED, NOT_FOUND as for them).
- `category` not in the list: field `category`, "Pick what it is about."; `description` under 5: field `description`, "Tell us what went wrong.".
- Guest files an open complaint: source `stay_page`, severity medium, receivedBy "Guest", owner "Front desk", receivedAt now, villa, unit, booking and guest from the stay; its timeline starts with `logged` by "Guest".
- The stay gains a guest action of kind `complaint` ("Something went wrong") with the summary "Told us something went wrong: <category label> (<number>)". The audit line is reservation's usual "Guest of <code>: " plus that summary; guest writes no audit line of its own for it.
- Reservation asks guest through `guest.Complaints.FileFromStay(ctx, StayComplaint{BookingID, Category, Description})`, in process or `POST /internal/v1/complaints/stay` with GUEST_URL; it answers the complaint number.

## 6. Events and audit

Events (payload `{ record, villaId, locationId }`, `record` the JSON the console reads; seeded events carry an empty `locationId`):
`guest.complaint.saved.v1`, `guest.incident.saved.v1`, `guest.safe_box.saved.v1`, `guest.box_rental.saved.v1`, `guest.folio_posting.requested.v1`.

Audit lines:
- "Logged complaint CP-004 from <guest> at <villa>: <category label>", "Edited CP-004", "Noted on CP-004", "CP-004 open to in progress", "Resolved CP-004: <action>", "Approved the credit of <amount> on CP-004", "Refused the credit of <amount> on CP-004".
- "Logged incident IN-003 at <villa>: <kind label>", "Edited IN-003", "Followed up IN-003", "Charged damage of <amount> on <code> for IN-003", "Signed off IN-003".
- "Added safe box <number> at <villa>", "Changed safe box <number> at <villa>", "Opened box <number> for <code> (SB-004)", "Box <number> for <code>: added items" / "took items out", "Closed box <number> for <code>: key returned" / "key lost".

## 7. Merge

`guest.merged.v1` moves complaints (`guest_id`, the document) and the guest ids in incident people and box rentals with the other guest records; the merge payload is unchanged.

## 8. Seed

`SEED_VERSION` 27. Complaints: one resolved with a folio credit posted (its posting is in billing's seed), one open high-severity noise complaint filed from the stay page, one in progress, one closed with a goodwill gesture. Incidents: one damage charged to an in-house stay (the DMG posting is in the seed), one medical incident closed with a sign-off. Safe boxes: Saka and one villa, two of them in use by in-house stays. Fixtures from `make export-fixtures` at base date 2026-11-11; the seed loader inserts the records without requesting postings again.

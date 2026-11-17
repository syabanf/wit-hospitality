# Front desk SOP: registration card, early check-in, keys and wake-up calls

> Design record: the contract the frontend and the Go API were built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on hospitality-contract.md (late check-out), hotel-desk-contract.md and guest-stay-contract.md. Money in whole rupiah, dates IsoDate, times `HH:MM`, stamps local `YYYY-MM-DDTHH:MM:SS`. Every record below lives inside the booking document (`reservation.bookings.doc`), so `booking.saved` carries it to every copy and no new reservation table is needed. The rules sit in `src/domain/frontDesk.ts` and `api/internal/reservation/domain/front_desk.go` with the same codes and words; the mock enforces them like the API.

## 1. Property settings (property context)

`Villa` gains two fields, on `GET/POST /villas`, `PATCH /villas/{id}`, the wizard and `property.villa.*` events:

| Field | Type | Default for a new property | Existing rows |
|---|---|---|---|
| `requireRegistrationCard` | boolean | hotel true, mixed true, villa false | the same by operation |
| `earlyCheckinFee` | integer >= 0 | hotel 500000, mixed 500000 (rooms only), villa 0 | the same by operation |

- `earlyCheckinFee` not a whole number from 0: field `earlyCheckinFee`, "Enter the early check-in fee in whole rupiah, or 0.".
- Changing the operation without sending them resets both to the new operation's defaults, as `lateCheckoutFee` does.
- An event from before the fields carries them absent (null); readers take the operation's default. Reservation copies both onto `reservation.cat_villas` (`early_checkin_fee`, `require_registration_card`, NULL until filled) and fills them on start from property's `villa.updated` snapshot with a same-version fill.

## 2. Registration card

```
RegistrationCard {
  method: "screen" | "paper"
  signature: Attachment | null      // screen: the PNG from POST /files
  cardNumber: string                // paper: the printed card's number; "" on screen
  signedAt: string                  // stamp
  by: string                        // staff name, or "Guest"
  where: "desk" | "precheckin" | "stay"
}
Booking.registrationCard?: RegistrationCard | null
```

The card shows the property and its address, unit, dates and house times, rate and package, party, the guest's name, nationality, document type and number, address, phone and email, the house rules, the cancellation policy and the deposit terms, and the signature. The console renders it at `/bookings/:id/registration-card` (outside the shell, print stylesheet, Print button). The signature image goes through the files context: the page uploads the canvas as `signature.png` with `POST /files` (no session needed, uploader "Guest") and sends the Attachment it gets back.

```
POST /bookings/{id}/registration-card   { method, signature?, cardNumber? } -> Booking      booking/edit
POST /checkin/{token}/registration-card  { signature }                       -> PublicPreCheckIn (public)
POST /stay/{token}/registration-card     { signature }                       -> GuestStayView   (public)
```

Rules (`validateRegistrationCard`, then the state checks), in this order:
- The stay is over (checked out, cancelled, no-show): `BOOKING_INVALID_STATE`, "This stay is over; its registration card no longer changes.".
- Field `method`: not screen or paper, "Pick signed on screen or on paper.".
- Field `signature` (screen): no attachment id, "Ask the guest to sign on the screen."; a type that is not `image/*`, "The signature must be an image.".
- Field `cardNumber` (paper): empty after trimming, "Enter the number printed on the paper card."; over 30 characters, "A card number is at most 30 characters.".
- Already signed: `CARD_ALREADY_SIGNED`, "<booking code> already has a signed registration card.".
- The online check-in link takes it while the stay is confirmed or in house; the stay page while in house (STAY_READ_ONLY after).

Check-in (`POST /bookings/{id}/check-in` and the plain `transition` to checked_in) refuses `REGISTRATION_CARD_UNSIGNED`, "Have the guest sign the registration card before check-in.", when the property has `requireRegistrationCard` and the stay has no card. Audit: "Signed the registration card of <code> on screen", "... on paper card <n>", and by "Guest" from the two public pages. Guest views carry `cardSigned: boolean` only; the public pages show the guest's name, the stay and the rules, never the document number.

## 3. Early check-in

```
EarlyCheckin { from: string, charge: number, by?: string, at?: string }
Booking.earlyCheckin?: EarlyCheckin | null
POST /bookings/{id}/early-checkin { from: "HH:MM" } -> { booking, charge }          booking/edit
```

The mirror of late check-out (`earlyCheckinCharge`):
- The stay is not confirmed: `BOOKING_INVALID_STATE`, "<code> is <status label lower case>; early check-in is set before arrival.". Already set: `BOOKING_INVALID_STATE`, "<code> already arrives early, from <from>.". No room assigned: `UNIT_UNASSIGNED`, "Assign a room to <code> before setting early check-in.".
- Field `from`: not a clock time, "Enter the time the guest arrives as HH:MM."; at or after the house check-in time, "Check-in is from <time> anyway; early check-in comes before it.".
- The departure: the stay in the same unit whose check-out is this stay's check-in date (not cancelled, not a no-show). It leaves by its late check-out time, else the house check-out time.
- `EARLY_CHECKIN_TAKEN`, "<departure code> still holds <unit code> until <time>.": the departure has not checked out and leaves after `from`.
- Charge: a room pays `earlyCheckinFee`; a villa arrives early for free when the unit had no departure that morning, and pays the fee otherwise, except in a mixed property, which never charges its villas.
- The stay keeps `earlyCheckin` and `reservation.early_checkin.granted.v1` goes out in the same transaction (payload `StayCharged`: `bookingId, bookingCode, unitId, villaId, locationId, code: "EARLY", description: "Early check-in from <from>", charge, by, byId, at`). Billing posts it once per stay (consumer `billing.stay-charges`, table `billing.stay_charges` keyed `early:<bookingId>`); 0 posts nothing. The command waits for billing as late check-out does. New transaction code `EARLY` "Early check-in", department room, `gl-4100`, with service and PB1 like `LATE`.
- The stay page opens at check-in, after the early check-in matters, so early check-in stays at the desk. The online check-in shows the house check-in time and tells the guest to ask the desk.

## 4. Keys

```
StayKey {
  id: string                 // key-1, key-2, ... within the stay
  number: string             // key number, card id or access code
  kind: "card" | "key" | "code"
  reason: "check_in" | "extra" | "replacement"
  replaces: string | null    // the lost key's id
  issuedAt: string, issuedBy: string
  status: "out" | "returned" | "lost" | "not_returned"
  closedAt: string | null, closedBy: string | null
  charge: number             // fee charged when the key closed lost or not returned
}
Booking.keys?: StayKey[]
CheckInDetails.keys?: { number, kind }[]      // replaces the "keys handed" checkbox
POST /bookings/{id}/keys               { number, kind, reason: "extra" | "replacement", replacesKeyId?, fee? } -> Booking   booking/edit
POST /bookings/{id}/keys/{keyId}/return { returned: boolean, fee? } -> Booking                                            booking/edit
```

- Check-in takes `keys` (at least one) or, from an older client, `keysHanded: true`. Neither: field `keys`, "Record the room key card handed over." on a room, "Record the keys or access code handed over." on a villa. Each key goes on the stay with reason `check_in`; `arrival.keysHanded` is set true when any key went out, so old screens still read it. Stays from before keep `keysHanded` and no `keys`.
- Issuing later needs the stay in house: `BOOKING_INVALID_STATE`, "<code> is not in house; keys go out at check-in and during the stay.".
- Fields: `number` empty "Enter the key number, card id or code.", over 30 characters "A key number is at most 30 characters.", already out on the stay "<number> is already out on this stay."; `kind` "Pick a key card, a physical key or an access code."; `reason` "Pick why the key goes out."; `replacesKeyId` on a replacement that names no key out "Pick the key this one replaces."; `fee` "Enter the fee in whole rupiah, or zero.".
- A replacement marks the key it replaces `lost`, with the fee as its charge. Return: `returned: true` closes the key `returned`; `false` closes it `not_returned` with the fee as its charge. A key that is not out: `KEY_NOT_OUT`, "<number> is not out.". Returning needs the stay in house.
- A fee above 0 sends `reservation.key_charged.v1` (`StayCharged` with `keyId`, code `DMG`, description "Lost key <number>" or "Key not returned: <number>"); billing posts it once per key (`key:<bookingId>:<keyId>`), and the command waits for it.
- Check-out closes every key still out as `not_returned` without a charge, so the log never shows a key out for a departed stay; `departure.keysReturned` reads true when no key of the stay closed `not_returned` (a stay without key records keeps the tick it was sent). The console's check-out form lists the keys out first, asks Returned or Not returned with an optional fee for each, records them, then checks out.
- The key log (`/keys`) is console-only, read from the bookings like the room rack: keys out now per property and the history, newest first.

## 5. Wake-up calls

```
WakeUpCall {
  id: string                  // wk-1, wk-2, ... within the stay
  date: IsoDate               // the next morning it rings
  time: string
  note: string
  repeatDaily: boolean
  status: "pending" | "done" | "cancelled"
  by: string, at: string      // who booked it and when ("Guest" from the stay page)
  log: { date, outcome: "done" | "no_answer" | "cancelled", by, at }[]
}
Booking.wakeUpCalls?: WakeUpCall[]
POST /bookings/{id}/wake-up-calls             { date, time, note, repeatDaily } -> Booking   booking/edit
POST /bookings/{id}/wake-up-calls/{callId}    { outcome: "done" | "no_answer" | "cancelled" } -> Booking   booking/edit
POST /stay/{token}/wake-up-calls              { date, time, note, repeatDaily } -> GuestStayView (public)
```

- The stay is over: `BOOKING_INVALID_STATE`, "This stay is over; its wake-up calls no longer change.".
- Fields: `date` outside check-in to check-out (both mornings count) "Pick a day of the stay, from <checkIn> to <checkOut>.", before today "Pick today or a later day."; `time` "Enter the time as HH:MM."; `note` over 200 characters "Keep the note to 200 characters."; `outcome` "Pick done, no answer or cancel.".
- An outcome on a call that is not pending: `WAKE_UP_CLOSED`, "This wake-up call is <done|cancelled> already.".
- Done on a daily call moves `date` to the next day and keeps it pending until that day passes check-out, then it is done. No answer keeps it pending for a retry. Cancel ends the call (and its series).
- When the stay checks out, is cancelled or is a no-show, its pending calls close `cancelled` with a log line by "System".
- The console lists today's pending calls of stays in house, by time, on `/wake-up-calls`; a call whose date is before today or whose time has passed reads overdue. The night audit page lists tomorrow's.
- The stay page shows the stay's calls and books one by "Guest" (guest action `wake_up`); the registration card signed there is guest action `card`.

## 6. Seed

Every stay in house at Villa Saka (the hotel) carries a signed card, on screen or on paper; every stay in house has its keys out (a card per room, a key and a gate code per villa), the first room lost its card and holds a replacement, the second holds an extra card, and stays that left in the last three days returned theirs. Tomorrow's first villa arrival with nobody leaving that morning comes in early at 11:00, free, and the first two rooms in house have wake-up calls tomorrow at 05:30 and 06:45 (the second daily). Seeded fees stay at 0 so the seeded folios need no extra lines. `SEED_VERSION` goes up by one; fixtures from `make export-fixtures` with base date 2026-11-11.

# Guest stay page: the guest's own page during the stay

> Design record: the contract the frontend and API sides built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on hospitality-contract.md. Like the online check-in, the payment link and the room QR menu, the page needs no sign-in: the link's token is the credential.

## 1. The link
- Booking gains `stayToken: string | null` (`st` + 32 hex, 16 random bytes) and `guestActions: { kind, at, summary }[]`. Reservation makes the token at check-in, through either check-in path, and keeps it. A stay checked in before the page existed gets one from `POST /bookings/{id}/stay-link` (booking/edit, BOOKING_INVALID_STATE unless in house).
- The token is random rather than derived from the booking id like the check-in token: the page shows the folio and takes orders on it, so the link must not be guessable from a booking code.
- The page lives at `/stay/:token` on the guest site. It is open while the stay is checked in, read only once checked out (writes answer STAY_READ_ONLY) and closed a day after the check-out date or for a stay that never happened (STAY_LINK_EXPIRED). An unknown or malformed token answers NOT_FOUND.
- `reservation.bookings.stay_token` is a stored column generated from the document, with a unique index, so the page finds its stay without a scan.

## 2. What the page shows (`GET /stay/{token}`, GuestStayView)
- Property, location, unit, kind, dates, house times, nights, the house rules and today's date.
- `hostName`: the villa host's first name on a villa stay, null on a room. No other staff name appears.
- `serviceWindow`, `preferences`, `cleanAskedAt` (today's clean, or null) and `lateCheckout` ({ until, charge }).
- `menu`: services' active menu for the villa without `costPrice` or `partnerId`; null when services does not run. `orders` and `requests`: this stay's only, newest first, with number, status, lines at menu price and charge.
- `folio` (GuestFolioView): billing's posted lines in the guest's words (a room night without its rate notes, a payment without its reference, a tax by name), subtotal, service, PB1, balance, nights still to post and the deposit held. Forecast lines, references, notes, who posted a line and costs stay behind.

## 3. The six guest actions
Each runs the desk's own rule in the guest's name, lands on the stay's `guestActions`, writes one audit line by "Guest" ("Guest of BK-1294: Asked for cleaning today") and answers the page again.
1. `POST /stay/{token}/clean { note }`: housekeeping adds today's stayover, or keeps the open one, and tells services, which logs one cleaning request per task. A second ask the same day answers CLEAN_ALREADY_ASKED.
2. `PUT /stay/{token}/service-window`: a villa takes a window or dnd, a room the schedule or dnd; another mode back from dnd lifts it.
3. `POST /stay/{token}/orders` (GuestOrderInput): services places the order at menu prices with its hours, notice and villaOnRequest rules, on the stay's folio.
4. `POST /stay/{token}/requests { kind, note }`: towels, laundry, minibar, maintenance, transfer or other (with a note). The villa host takes it on a villa stay, the desk on a room. Cleaning has its own button.
5. `GET /stay/{token}/late-checkout?until=HH:MM` quotes the price by the desk's rule; `POST` with `{ until }` gives it, recorded as by "Guest". Billing posts the fee from `late_checkout.granted`, as for the desk.
6. `PUT /stay/{token}/preferences`: the fields the online check-in takes for the unit kind; the arrival time stays as it was.

## 4. Limits and security
- Each token may send 60 reads and 10 writes a minute; past that, 429 RATE_LIMITED ("Too many requests from this page. Wait a minute and try again."). The counter lives in the reservation process, so each replica counts on its own.
- The invoice link drops `stayToken` and `guestActions` from the booking it prints.
- Public routes: `/api/v1/stay/*` goes to reservation in the split gateway and in `scripts/ownership.mjs`.

## 5. Cross-context calls
- Reservation asks housekeeping through `housekeeping.GuestCleaner` (in process, or `POST /internal/v1/housekeeping/guest-clean` with HOUSEKEEPING_URL), services through `services.StayGuests` (in process, or `/internal/v1/services/stay`, `/orders`, `/requests` with SERVICES_URL) and billing through `billing.Client.GuestFolio` (`/internal/v1/billing/guest-folio`).
- Messaging copies the token from booking events onto `messaging.stays.stay_token`, so templates may carry `{stayLink}`; the welcome message does.

## 6. Staff side
- The booking page shows the link with Copy, a QR code and "Open as the guest", and the guest's actions ("Asked by the guest at 14:02").
- The room QR cards page can print each room with a guest in house pointing at that guest's stay page.

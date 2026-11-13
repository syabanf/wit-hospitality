# Villa or hotel operation: shared contract (frontend and Go API)

> Design record: the contract the frontend and API agents built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

The `Villa` record is the property. Each property chooses how it operates. Money in whole rupiah, dates IsoDate.

## Property (villa record): GET/POST /api/v1/villas, PATCH /api/v1/villas/{id}, wizard POST /api/v1/properties
- operation: "villa" | "hotel" | "mixed"   (labels: Villa, Hotel, Hotel and villas; default for existing rows "villa")
- stayoverEvery: integer 0..7, days between stayover cleans for a guest in house; 0 = none.
  Default when not sent: hotel 1, villa 0, mixed 1 (applies to room-kind units only in mixed, see below). Existing rows: 0.
- wholeRental: boolean, the villa may be rented whole (default false; must be false when operation is "hotel": field error "A hotel is not rented whole.")
- wholeNightlyRate: integer >= 0, the nightly price for the whole villa; 0 means the sum of its villa-kind units' prices for the night.

## Room type (unit group): GET/POST /api/v1/unit-groups, PATCH /api/v1/unit-groups/{id}
- kind: "room" | "villa". Must be "room" in a hotel and "villa" in a villa property; either in mixed (field error GROUP_KIND, message "A <Hotel|Villa> only has <rooms|villas>."). Existing rows: "villa".
- A hotel room type defaults to interchangeable true and operatorAssigns true when created through the wizard.

## Unit: GET/POST /api/v1/units, PATCH /api/v1/units/{id}
- floor: string (max 10 chars, e.g. "2", "G"); used for hotel rooms, may be empty.
- A unit's kind is its group's kind; a unit with no group counts as "villa" in villa/mixed properties and "room" in a hotel.

## Terms (frontend only, computed)
- hotel: property noun "Hotel", unit noun "Room"/"Rooms", the unit code shows as "Room <code>".
- villa: "Villa", "Unit"/"Units".
- mixed: "Property", "Room or villa"/"Rooms and villas".

## Stayover cleaning (housekeeping)
When a business day opens (the same trigger that creates departure tasks today; find it), create one "stayover" task per occupied unit whose property has stayoverEvery > 0, whose unit kind is "room" (in mixed) or any (in hotel/villa with stayoverEvery > 0), when the guest is in house that day, not departing that day, and (day - checkIn) % stayoverEvery == 0 with day > checkIn. Idempotent: one stayover per unit per business day.

## Whole villa rental
POST /api/v1/whole-villa-bookings
body: { villaId, guestId? | newGuest?, checkIn, checkOut, adults, children, source: "direct" | "airbnb", note?: string, price?: { nightly: integer, reason: string } }
- Refused WHOLE_VILLA_NOT_ALLOWED when the property's wholeRental is false or operation is "hotel".
- Refused WHOLE_VILLA_UNAVAILABLE ("<Villa> has <unit codes> taken on those nights.") when any villa-kind unit that is not inactive has a booking, block or out-of-service status over the stay.
- Refused UNIT_CAPACITY when the party exceeds the sum of the villa-kind units' capacity (same formula per unit, summed).
- Creates a booking group (the existing group booking feature) with `wholeVilla: true`, name "Whole <villa name>", one stay per villa-kind unit that is not inactive, same dates, lead guest, one folio/billing as group billing does today. Nightly price: price.nightly when given (manager override rule as for direct price changes), else wholeNightlyRate when > 0 (split evenly across the stays, remainder on the first), else each unit's own price.
- Response: the created group (as GET /api/v1/booking-groups/{id} returns it) with `wholeVilla: true`.
- BookingGroup JSON gains `wholeVilla: boolean` (false for existing groups).

## Amendment 1: two business foundations, room and villa
The business rules split on the unit's kind (its group's kind): a hotel "room" or a "villa". The property's operation only decides which kinds it may hold. Every rule below keys on the unit kind, so a mixed property applies hotel rules to its rooms and villa rules to its villas.

| Rule | Room (hotel) | Villa |
|---|---|---|
| What is sold | a room of a room type; guest books the type, front desk assigns the room number | the whole private villa, by name |
| Rate basis | per room type (rate plan of the group) | per villa (the unit's own nightly rate or Airbnb listing) |
| Minimum stay default | 1 night | 2 nights |
| Security deposit at check-in | not asked by default | asked by default |
| Cleaning | stayover every stayoverEvery days plus departure | departure only unless stayoverEvery > 0 |
| Check-in | front desk, room key card | key or access code handover, house rules explained |
| Capacity | per room | per villa (all bedrooms) |
| Reports | occupancy, ADR, RevPAR per room night | occupancy, ADR, RevPAR per villa night |

Contract additions:
- Unit group (room type) gains `minStay` default only when created: room 1, villa 2. Use the existing restriction (minimum stay) mechanism if one fits instead of a new field; report which.
- Property gains `depositOnCheckIn: boolean` default true for villa, false for hotel, mixed true; the check-in form pre-fills the deposit step from it (villa kind units only in mixed). Existing rows: true.
- Revenue figures (dashboard, revenue report, owner performance): when a scope holds both kinds, show the KPIs split into "Rooms" and "Villas" plus the total. GET endpoints that return occupancy/ADR/RevPAR accept `kind=room|villa` where they already accept a villa or unit filter.
- Terms: unit noun follows the unit kind (Room / Villa), the property noun follows the operation (Hotel / Villa / Property).

## Amendment 2: the wizard carries the two foundations
The property wizard (POST /api/v1/properties) applies Amendment 1 from its first step:
- Step 1 "How does this property operate?": Hotel, Villa, Hotel and villas. Each choice shows a short summary of the rules it brings (what is sold, rate basis, minimum stay, deposit, cleaning, reports) taken from the Amendment 1 table.
- Hotel rooms step: room types (name, count, capacity, beds, rate plan), a room number generator (floor + starting number, e.g. floor 2 from 201 gives 201, 202, ...), sold by type on by default. Defaults shown and editable: minimum stay 1, stayover every 1 day, no deposit.
- Villas step: each villa by name with bedrooms, capacity, beds, nightly rate, private pool and other amenities. Defaults shown and editable: minimum stay 2, deposit on check-in, departure-only cleaning, whole rental toggle with whole nightly rate when the property has more than one villa unit.
- Mixed: both steps, each with its own defaults; stayoverEvery applies to rooms, depositOnCheckIn to villas.
- Review step: a table per kind listing the rules that will apply.
- POST /properties body: villa { ...profile, operation, stayoverEvery, depositOnCheckIn, wholeRental, wholeNightlyRate }, groups[] { name, kind, interchangeable, operatorAssigns, minStay, plan }, rooms[] { code, name, floor, bedrooms, nightlyRate, groupIndex, amenities, maxAdults, maxChildren, beds, extraBeds, extraBedRate }. The API stores minStay through the mechanism it chose for room type minimum stays.

# Hospitality layer: room vs villa service (next round, after the operation round merges)

> Design record: the contract the frontend and API agents built against. The code is the source of truth; this file explains why the fields and codes look the way they do.

Builds on operation-contract.md. Every rule keys on the unit kind (room or villa).

## 1. Villa host (staff ratio, service delivery)
- Unit (villa kind) gains `hostId: string | null`, the default host or butler (an employee id from people). Must be an employee allocated to that villa; error HOST_NOT_ALLOCATED.
- Booking gains `hostId: string | null`: set from the unit's hostId when a villa-kind stay is created or assigned; a manager may change it per booking (PATCH /api/v1/bookings/{id}/host { hostId }). Room-kind stays keep null.
- The host's /me area lists their upcoming and in-house stays with guest preferences and the service window.

## 2. Guest preferences before arrival (personalisation)
- Booking gains `preferences`: { breakfastTime: "HH:MM" | "", dietary: string, setups: ("bbq" | "floating_breakfast" | "private_chef" | "romantic_dinner" | "airport_pickup" | "baby_cot")[], arrivalTime: "HH:MM" | "", notes: string }.
- Guests fill them on the existing online pre-check-in page for villa-kind stays (room-kind stays see only arrival time and notes). Staff edit them on the booking (PATCH /api/v1/bookings/{id}/preferences).
- Setups that cost money become service requests to the host, not automatic charges.

## 3. Service window (privacy)
- Booking gains `serviceWindow`: { mode: "scheduled" | "window" | "dnd", from: "HH:MM" | "", to: "HH:MM" | "" }. Default: room kind "scheduled", villa kind "window" with 10:00 to 12:00.
- Housekeeping tasks for a stay carry the window; the board shows it and refuses to start a task for a "dnd" stay (TASK_DND, "The guest asked not to be disturbed.") unless a supervisor overrides with a reason. Villa-kind stays get stayover tasks only when stayoverEvery > 0 or the guest asks (POST /api/v1/bookings/{id}/service-requests { kind: "clean" }).

## 4. Flexibility
- Room service menu items gain `villaOnRequest: boolean`: a villa-kind stay may order it outside the item's from/to hours; room-kind stays keep the hours.
- Late check-out: property gains `lateCheckoutFee: integer` (default hotel 500000, villa 0; a mixed property charges it on rooms only). A villa-kind stay gets late check-out free when its unit has no arrival that day; a room-kind stay is charged lateCheckoutFee to the folio. Endpoint: POST /api/v1/bookings/{id}/late-checkout { until: "HH:MM" } answers with the charge applied (0 or fee) or LATE_CHECKOUT_TAKEN when the unit has an arrival before `until`.

## 5. Reports
- Housekeeping and host workload: stays per host per week; requests answered by host.

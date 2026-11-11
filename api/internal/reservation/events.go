// Package reservation is the published language of the reservation context: the events it
// publishes. Each payload carries the record in the console's JSON shape (the TypeScript types
// named on each field) plus the villas and locations it sits in, so a consumer builds its read
// model from one event without calling back. Other contexts may import this package and nothing
// below it.
package reservation

import "encoding/json"

// Event types; the suffix is the payload version.
const (
	// EventBookingSaved follows every change to a booking: created, repriced, moved, new dates.
	EventBookingSaved = "reservation.booking.saved.v1"
	// EventBookingStatusChanged follows a lifecycle step and carries the step and, for a
	// cancellation or no-show, the cancellation terms billing applies to the money paid.
	EventBookingStatusChanged = "reservation.booking.status_changed.v1"
	EventGroupSaved           = "reservation.booking_group.saved.v1"
	EventRestrictionSaved     = "reservation.restriction.saved.v1"
	EventRestrictionRemoved   = "reservation.restriction.removed.v1"
	EventOverbookingSet       = "reservation.overbooking.set.v1"
	// EventWalkRecorded carries the relocation cost finance books as a Guest relocation cash-out.
	EventWalkRecorded    = "reservation.walk.recorded.v1"
	EventPreCheckInSaved = "reservation.pre_checkin.saved.v1"
)

// Record is the common payload: Data is the record (Booking, BookingGroup, Restriction,
// OverbookPolicy, Walk or PreCheckIn from src/domain).
type Record struct {
	ID          string          `json:"id"`
	VillaIDs    []string        `json:"villaIds"`
	LocationIDs []string        `json:"locationIds"`
	Data        json.RawMessage `json:"data"`
}

// StatusChanged is the payload of booking.status_changed.
type StatusChanged struct {
	Record
	From string `json:"from"`
	To   string `json:"to"`
	// Terms is set for a direct stay cancelled or marked no-show: refund and retained, from the
	// payment policy, worked out on what billing reports as paid.
	Terms *Terms `json:"terms,omitempty"`
}

// Terms is CancellationTerms.
type Terms struct {
	Refund   int64 `json:"refund"`
	Retained int64 `json:"retained"`
}

// Removed is the payload of restriction.removed.
type Removed struct {
	ID string `json:"id"`
}

package reservation

import "context"

// GroupSource is a booking group's source at its current version, the part of
// booking_group.saved owners copies: a stay in a corporate group counts in the corporate segment.
type GroupSource struct {
	ID      string `json:"id"`
	Source  string `json:"source"`
	Version int64  `json:"version"`
}

// Groups lists every booking group's source, so a context whose copy of booking_group.saved
// started late can fill it. The composition root hands a consumer the in-process answer
// (reservation/module) in the monolith and GroupsHTTP in split mode.
type Groups interface {
	GroupSources(ctx context.Context) ([]GroupSource, error)
}

// GroupsHTTP calls the reservation service's /internal/v1 routes with INTERNAL_TOKEN.
type GroupsHTTP StaysHTTP

// GroupSources calls GET /internal/v1/booking-groups/sources.
func (h GroupsHTTP) GroupSources(ctx context.Context) ([]GroupSource, error) {
	var out []GroupSource
	err := StaysHTTP(h).get(ctx, "/internal/v1/booking-groups/sources", &out)
	return out, err
}

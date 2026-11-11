package bootstrap

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/sources"
	channeldomain "github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
)

// siteSources gives channel the bookings, held nights and stay restrictions reservation owns, in
// process. Tax, menu and team still come from sources.None until finance, services and people run.
type siteSources struct {
	sources.None
	site reservationpg.Site
}

// BookingCode finds the booking an enquiry became.
func (s siteSources) BookingCode(ctx context.Context, id string) (string, bool, error) {
	return s.site.BookingCode(ctx, id)
}

// Restrictions lists the stay restrictions.
func (s siteSources) Restrictions(ctx context.Context) ([]json.RawMessage, error) {
	return s.site.Restrictions(ctx)
}

// Stays lists the stays holding a night in [from, to), without guest, code or price.
func (s siteSources) Stays(ctx context.Context, from, to string) ([]channeldomain.Hold, error) {
	held, err := s.site.Holds(ctx, from, to)
	if err != nil {
		return nil, err
	}
	out := make([]channeldomain.Hold, len(held))
	for i, h := range held {
		out[i] = channeldomain.Hold{UnitID: h.UnitID, UnitAssigned: h.UnitAssigned, From: h.CheckIn, To: h.CheckOut}
	}
	return out, nil
}

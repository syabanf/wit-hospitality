package bootstrap

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/sources"
	channelquery "github.com/syabanf/wit-hospitality/api/internal/channel/app/query"
	channeldomain "github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
)

// siteSources gives channel the bookings, held nights and stay restrictions reservation owns, in
// process. Tax and team still come from sources.None until finance and people run; siteMenu adds
// the menu when services runs here.
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

// siteMenu gives channel's site the room service menu services owns, in process; the other site
// sources answer as before.
type siteMenu struct {
	channelquery.SiteSources
	menu func(context.Context) ([]json.RawMessage, error)
}

// Menu lists the active menu items as the site prints them.
func (s siteMenu) Menu(ctx context.Context) ([]json.RawMessage, error) { return s.menu(ctx) }

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

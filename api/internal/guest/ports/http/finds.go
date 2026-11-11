package http

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// finds logs finds other contexts report, as guest.LostFound.
type finds struct{ log command.LogLostItem }

// Finds is the in-process guest.LostFound.
func (h Handler) Finds() guest.LostFound { return finds{log: h.Commands.LogLostItem} }

// LogFind logs the find as the finder.
func (f finds) LogFind(ctx context.Context, finder guest.Finder, find guest.LostFind) (guest.LostItemEvent, error) {
	p := auth.Principal{UserID: finder.UserID, Name: finder.Name, Role: rbac.Role(finder.Role), VillaIDs: finder.VillaIDs, LocationIDs: finder.LocationIDs}
	item, err := f.log.Find(ctx, p, domain.LostItemInput{FoundOn: find.FoundOn, VillaID: find.VillaID, UnitID: find.UnitID, Where: find.Where,
		Description: find.Description, Photos: []json.RawMessage{}, BookingID: find.BookingID})
	if err != nil {
		return guest.LostItemEvent{}, err
	}
	return item.State(), nil
}

type findBody struct {
	Finder guest.Finder   `json:"finder"`
	Find   guest.LostFind `json:"find"`
}

// findRoute serves POST /internal/v1/lost-found/finds for guest.HTTPClient.LogFind.
func (h Handler) findRoute(r chi.Router) {
	f := h.Finds()
	r.Post("/lost-found/finds", read(h.Log, func(r *http.Request) (guest.LostItemEvent, error) {
		var in findBody
		if err := httpx.Decode(r, &in); err != nil {
			return guest.LostItemEvent{}, err
		}
		return f.LogFind(r.Context(), in.Finder, in.Find)
	}))
}

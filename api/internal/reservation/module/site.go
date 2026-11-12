package module

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// siteHold is a held night range as GET /internal/v1/site/holds answers it.
type siteHold struct {
	UnitID       string `json:"unitId"`
	UnitAssigned bool   `json:"unitAssigned"`
	CheckIn      string `json:"checkIn"`
	CheckOut     string `json:"checkOut"`
}

// siteRoutes answers a channel service in split mode what Site answers in process: the booking an
// enquiry became, the held nights and the stay restrictions of the public site.
func (m *Module) siteRoutes(r chi.Router) {
	site := m.Site()
	r.Get("/site/bookings/{id}", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		code, found, err := site.BookingCode(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"code": code, "found": found})
		return nil
	}))
	r.Get("/site/holds", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		held, err := site.Holds(r.Context(), q.Get("from"), q.Get("to"))
		if err != nil {
			return err
		}
		out := make([]siteHold, len(held))
		for i, h := range held {
			out[i] = siteHold{UnitID: h.UnitID, UnitAssigned: h.UnitAssigned, CheckIn: h.CheckIn, CheckOut: h.CheckOut}
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Get("/site/restrictions", httpx.Handle(m.log, func(w http.ResponseWriter, r *http.Request) error {
		list, err := site.Restrictions(r.Context())
		if err != nil {
			return err
		}
		if list == nil {
			list = []json.RawMessage{}
		}
		httpx.OK(w, list)
		return nil
	}))
}

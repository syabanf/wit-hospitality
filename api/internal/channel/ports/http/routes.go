// Package http maps the channel context onto the contract paths the TypeScript HTTP adapter calls
// for the airbnb, site and enquiries ports, and serves the price lookups other services call on
// /internal/v1.
package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the channel write handlers.
type Commands struct {
	CreateAccount    command.CreateAccount
	UpdateAccount    command.UpdateAccount
	CreateListing    command.CreateListing
	UpdateListing    command.UpdateListing
	SetListingStatus command.SetListingStatus
	SetListingPrices command.SetListingPrices
	SubmitEnquiry    command.SubmitEnquiry
	SetEnquiryStatus command.SetEnquiryStatus
	ConvertEnquiry   command.ConvertEnquiry
}

// Handler serves the channel routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

// list answers a read.
func list[T any](log *slog.Logger, read func(r *http.Request) ([]T, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := read(r)
		if err != nil {
			return err
		}
		if out == nil {
			out = []T{}
		}
		httpx.OK(w, out)
		return nil
	})
}

// write decodes the body, runs the command as the signed-in user and answers with status.
func write[In, Out any](log *slog.Logger, status int, run func(r *http.Request, p auth.Principal, in In) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in In
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := run(r, p, in)
		if err != nil {
			return err
		}
		httpx.JSON(w, status, out)
		return nil
	})
}

// listingPatch is PATCH /airbnb-listings/{id}: the whole form (updateListing) or the status alone
// (setListingStatus).
type listingPatch struct {
	AccountID *string `json:"accountId"`
	UnitID    *string `json:"unitId"`
	Title     *string `json:"title"`
	AirbnbID  *string `json:"airbnbId"`
	Status    string  `json:"status"`
}

func (p listingPatch) statusOnly() bool {
	return p.AccountID == nil && p.UnitID == nil && p.Title == nil && p.AirbnbID == nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/airbnb-accounts", list(log, func(r *http.Request) ([]domain.Account, error) { return q.Accounts(r.Context()) }))
	r.Post("/airbnb-accounts", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.AccountInput) (domain.Account, error) {
		return c.CreateAccount.Handle(r.Context(), p, in)
	}))
	r.Patch("/airbnb-accounts/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AccountInput) (domain.Account, error) {
		return c.UpdateAccount.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/airbnb-listings", list(log, func(r *http.Request) ([]domain.Listing, error) { return q.Listings(r.Context()) }))
	r.Post("/airbnb-listings", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ListingInput) (domain.Listing, error) {
		return c.CreateListing.Handle(r.Context(), p, in)
	}))
	r.Patch("/airbnb-listings/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in listingPatch) (domain.Listing, error) {
		if in.statusOnly() {
			return c.SetListingStatus.Handle(r.Context(), p, id(r), in.Status)
		}
		form := domain.ListingInput{AccountID: deref(in.AccountID), UnitID: deref(in.UnitID), Title: deref(in.Title), AirbnbID: deref(in.AirbnbID), Status: in.Status}
		return c.UpdateListing.Handle(r.Context(), p, id(r), form)
	}))
	r.Put("/airbnb-listings/{id}/prices", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.PriceInput) (domain.Listing, error) {
		return c.SetListingPrices.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/enquiries", list(log, func(r *http.Request) ([]domain.Enquiry, error) { return q.Enquiries(r.Context()) }))
	r.Post("/enquiries/{id}/status", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}) (domain.Enquiry, error) {
		return c.SetEnquiryStatus.Handle(r.Context(), p, id(r), in.Status, in.Note)
	}))
	r.Post("/enquiries/{id}/convert", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in struct {
		BookingID string `json:"bookingId"`
	}) (domain.Enquiry, error) {
		return c.ConvertEnquiry.Handle(r.Context(), p, id(r), in.BookingID)
	}))

	// The public website: no session.
	r.Get("/public/site/inventory", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := q.Inventory(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Get("/public/site/holds", list(log, func(r *http.Request) ([]domain.Hold, error) {
		return q.Holds(r.Context(), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	}))
	r.Post("/public/enquiries", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		var in domain.EnquiryInput
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := c.SubmitEnquiry.Handle(r.Context(), in)
		if err != nil {
			return err
		}
		httpx.Created(w, out)
		return nil
	}))
}

// InternalRoutes registers the service-to-service routes under /internal/v1: the listing price
// lookups behind channel.Prices.
func (h Handler) InternalRoutes(r chi.Router) {
	q, log := h.Queries, h.Log
	r.Get("/channel/listings/active", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		unitID := r.URL.Query().Get("unitId")
		if unitID == "" {
			return errs.Invalid("unitId", "Pick the unit.")
		}
		l, err := q.ActiveListing(r.Context(), unitID)
		if err != nil {
			return err
		}
		httpx.OK(w, l)
		return nil
	}))
	r.Get("/channel/prices", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		v := r.URL.Query()
		if v.Get("unitId") == "" {
			return errs.Invalid("unitId", "Pick the unit.")
		}
		if stay := domain.ValidateStay(v.Get("from"), v.Get("to")); stay == "Pick both dates." {
			return errs.Invalid("from", stay)
		}
		nights, listed, err := q.NightlyPrices(r.Context(), v.Get("unitId"), v.Get("from"), v.Get("to"))
		if err != nil {
			return err
		}
		if nights == nil {
			nights = []channel.NightPrice{}
		}
		httpx.OK(w, map[string]any{"listed": listed, "nights": nights})
		return nil
	}))
}

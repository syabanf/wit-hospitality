package http

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// client is the in-process guest.Client: the query handlers answer the reads, the create command
// adds profiles.
type client struct {
	query.Queries
	create command.CreateGuest
	apply  command.ApplyPreCheckIn
}

// Client is the in-process guest.Client.
func (h Handler) Client() guest.Client {
	return client{Queries: h.Queries, create: h.Commands.CreateGuest, apply: h.Commands.ApplyPreCheckIn}
}

// ApplyPreCheckIn copies the verified online check-in onto the profile and the companions.
func (c client) ApplyPreCheckIn(ctx context.Context, p auth.Principal, pre guest.PreCheckIn) ([]string, error) {
	return c.apply.Handle(ctx, p, pre)
}

// CreateGuest adds the profile once per key.
func (c client) CreateGuest(ctx context.Context, p auth.Principal, input json.RawMessage, key string) (guest.Guest, error) {
	var in domain.GuestInput
	if err := json.Unmarshal(input, &in); err != nil {
		return guest.Guest{}, errs.New(errs.CodeValidation, "The new guest is not valid.")
	}
	g, err := c.create.Once(ctx, p, key, in)
	if err != nil {
		return guest.Guest{}, err
	}
	return g.Summary(), nil
}

// createRoute serves POST /internal/v1/guests for guest.HTTPClient.CreateGuest.
func (h Handler) createRoute(r chi.Router) {
	c := h.Client()
	r.Post("/guests", httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		var in guest.NewProfile
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		g, err := c.CreateGuest(r.Context(), in.Principal, in.Input, in.Key)
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, g)
		return nil
	}))
}

// preCheckInRoute serves POST /internal/v1/pre-checkins for guest.HTTPClient.ApplyPreCheckIn.
func (h Handler) preCheckInRoute(r chi.Router) {
	c := h.Client()
	r.Post("/pre-checkins", read(h.Log, func(r *http.Request) ([]string, error) {
		var in guest.AppliedPreCheckIn
		if err := httpx.Decode(r, &in); err != nil {
			return nil, err
		}
		return c.ApplyPreCheckIn(r.Context(), in.Principal, in.PreCheckIn)
	}))
}

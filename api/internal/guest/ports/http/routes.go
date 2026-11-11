// Package http maps the guest context onto the contract paths the TypeScript HTTP adapter calls
// for the guest and lost and found ports, plus the service-to-service routes of the guest client.
package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the guest write handlers.
type Commands struct {
	CreateGuest     command.CreateGuest
	UpdateGuest     command.UpdateGuest
	SetBlacklist    command.SetBlacklist
	MergeGuests     command.MergeGuests
	AddCompanion    command.AddCompanion
	UpdateCompanion command.UpdateCompanion
	RemoveCompanion command.RemoveCompanion
	MarkReported    command.MarkReported
	LogLostItem     command.LogLostItem
	UpdateLostItem  command.UpdateLostItem
	MoveLostItem    command.MoveLostItem
	SaveSettings    command.SaveLostFoundSettings
}

// Handler serves the guest routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

// read answers a GET.
func read[T any](log *slog.Logger, get func(r *http.Request) (T, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := get(r)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

// list answers a GET of a list, never null.
func list[T any](log *slog.Logger, get func(r *http.Request) ([]T, error)) http.HandlerFunc {
	return read(log, func(r *http.Request) ([]T, error) {
		out, err := get(r)
		if out == nil && err == nil {
			out = []T{}
		}
		return out, err
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

// act runs a command without a body.
func act[Out any](log *slog.Logger, run func(r *http.Request, p auth.Principal) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		out, err := run(r, p)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

type blacklistBody struct {
	Reason *string `json:"reason"`
}

type mergeBody struct {
	DropID string `json:"dropId"`
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/guests", list(log, func(r *http.Request) ([]domain.Guest, error) { return q.Guests(r.Context()) }))
	r.Get("/guests/duplicates", list(log, func(r *http.Request) ([]domain.Duplicate, error) { return q.Duplicates(r.Context()) }))
	r.Post("/guests", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.GuestInput) (domain.Guest, error) {
		return c.CreateGuest.Handle(r.Context(), p, in)
	}))
	r.Patch("/guests/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.GuestInput) (domain.Guest, error) {
		return c.UpdateGuest.Handle(r.Context(), p, id(r), in)
	}))
	r.Put("/guests/{id}/blacklist", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in blacklistBody) (domain.Guest, error) {
		reason := ""
		if in.Reason != nil {
			reason = *in.Reason
		}
		return c.SetBlacklist.Handle(r.Context(), p, id(r), &reason)
	}))
	r.Delete("/guests/{id}/blacklist", act(log, func(r *http.Request, p auth.Principal) (domain.Guest, error) {
		return c.SetBlacklist.Handle(r.Context(), p, id(r), nil)
	}))
	r.Post("/guests/{id}/merge", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in mergeBody) (domain.Guest, error) {
		return c.MergeGuests.Handle(r.Context(), p, id(r), in.DropID)
	}))

	r.Get("/stay-companions", list(log, func(r *http.Request) ([]domain.Companion, error) { return q.Companions(r.Context()) }))
	r.Post("/bookings/{id}/companions", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.CompanionInput) (domain.Companion, error) {
		return c.AddCompanion.Handle(r.Context(), p, id(r), in)
	}))
	r.Patch("/stay-companions/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.CompanionInput) (domain.Companion, error) {
		return c.UpdateCompanion.Handle(r.Context(), p, id(r), in)
	}))
	r.Delete("/stay-companions/{id}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		if err := c.RemoveCompanion.Handle(r.Context(), p, id(r)); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))

	r.Get("/foreign-reports", list(log, func(r *http.Request) ([]domain.ForeignReport, error) { return q.Reports(r.Context()) }))
	r.Post("/foreign-reports", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ReportInput) ([]domain.ForeignReport, error) {
		return c.MarkReported.Handle(r.Context(), p, in)
	}))
	r.Get("/foreign-guests", read(log, func(r *http.Request) (query.ForeignList, error) {
		return q.Foreign(r.Context(), r.URL.Query().Get("date"), r.URL.Query().Get("villaId"))
	}))

	r.Get("/lost-found", list(log, func(r *http.Request) ([]domain.LostItem, error) { return q.LostItems(r.Context()) }))
	r.Post("/lost-found", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.LostItemInput) (domain.LostItem, error) {
		return c.LogLostItem.Handle(r.Context(), p, in)
	}))
	r.Get("/lost-found/settings", read(log, func(r *http.Request) (domain.LostFoundSettings, error) { return q.Settings(r.Context()) }))
	r.Put("/lost-found/settings", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.LostFoundSettings) (domain.LostFoundSettings, error) {
		return c.SaveSettings.Handle(r.Context(), p, in)
	}))
	r.Patch("/lost-found/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.LostItemInput) (domain.LostItem, error) {
		return c.UpdateLostItem.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/lost-found/{id}/move", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.LostMove) (domain.LostItem, error) {
		return c.MoveLostItem.Handle(r.Context(), p, id(r), in)
	}))
}

// InternalRoutes registers the guest client's routes under /internal/v1 (guest.HTTPClient). The
// gateway does not expose them.
func (h Handler) InternalRoutes(r chi.Router) {
	q, log := h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	stay := func(r *http.Request) (guest.StayPeople, error) {
		var in guest.StayPeople
		err := httpx.Decode(r, &in)
		return in, err
	}
	h.findRoute(r)
	r.Get("/guests/{id}", read(log, func(r *http.Request) (guest.Guest, error) { return q.Guest(r.Context(), id(r)) }))
	r.Get("/guests/{id}/blacklist", read(log, func(r *http.Request) (guest.BlacklistStatus, error) { return q.BlacklistStatus(r.Context(), id(r)) }))
	r.Post("/registrations", read(log, func(r *http.Request) (guest.Registration, error) {
		in, err := stay(r)
		if err != nil {
			return guest.Registration{}, err
		}
		return q.Registration(r.Context(), in)
	}))
	r.Post("/registrations/check", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		in, err := stay(r)
		if err != nil {
			return err
		}
		if err := q.CheckRegistration(r.Context(), in); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))
}

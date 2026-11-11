// Package http maps the reservation context onto the contract paths the TypeScript HTTP adapter
// calls for the booking, group, stay rules and pre-check-in ports.
package http

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// Commands are the reservation write handlers.
type Commands struct {
	CreateBooking     command.CreateBooking
	Transition        command.Transition
	CheckIn           command.CheckIn
	CheckOut          command.CheckOut
	SettleCheckOut    command.SettleCheckOut
	MoveUnit          command.MoveUnit
	SetPrice          command.SetPrice
	AssignUnit        command.AssignUnit
	AdjustStay        command.AdjustStay
	SetPayment        command.SetPayment
	SaveRestriction   command.SaveRestriction
	RemoveRestriction command.RemoveRestriction
	BulkRestrictions  command.BulkRestrictions
	SetOverbooking    command.SetOverbooking
	Walk              command.WalkGuest
	CreateGroup       command.CreateGroup
	AddGroupStay      command.AddGroupStay
	RemoveGroupStay   command.RemoveGroupStay
	PayGroup          command.PayGroup
	VerifyPreCheckIn  command.VerifyPreCheckIn
	CheckinLink       command.CheckinLink
}

// Handler serves the reservation routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

func (h Handler) list(table string) http.HandlerFunc {
	return httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := h.Queries.List(r.Context(), table)
		if err != nil {
			return err
		}
		if out == nil {
			out = []json.RawMessage{}
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

// body reads a JSON body that may be absent; an empty body reads as nil.
func body(r *http.Request) (json.RawMessage, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, httpx.MaxBody+1))
	if err != nil {
		return nil, err
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	if !json.Valid(raw) {
		return nil, errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	return raw, nil
}

func decodeInto(raw json.RawMessage, v any) error {
	if err := json.Unmarshal(raw, v); err != nil {
		return errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	return nil
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, log := h.Commands, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/bookings", h.list(query.Bookings))
	r.Post("/bookings", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.NewBooking) (domain.Booking, error) {
		return c.CreateBooking.Handle(r.Context(), p, in)
	}))
	r.Patch("/bookings/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.StayPatch) (domain.Booking, error) {
		return c.AdjustStay.Handle(r.Context(), p, id(r), in)
	}))
	for action, to := range map[string]string{"confirm": domain.Confirmed, "cancel": domain.Cancelled, "no-show": domain.NoShow} {
		r.Post("/bookings/{id}/"+action, h.step(to))
	}
	r.Post("/bookings/{id}/check-in", h.desk(domain.CheckedIn))
	r.Post("/bookings/{id}/check-out", h.desk(domain.CheckedOut))
	r.Post("/bookings/{id}/settle-check-out", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		raw, err := body(r)
		if err != nil {
			return err
		}
		if raw == nil {
			return errs.New(errs.CodeValidation, "The request body is empty.")
		}
		out, err := c.SettleCheckOut.Handle(r.Context(), p, id(r), raw)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Post("/bookings/{id}/move-unit", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.MoveInput) (domain.Booking, error) {
		return c.MoveUnit.Handle(r.Context(), p, id(r), in)
	}))
	r.Put("/bookings/{id}/price", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.PriceChange) (domain.Booking, error) {
		return c.SetPrice.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/assign-unit", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.AssignInput) (domain.Booking, error) {
		return c.AssignUnit.Handle(r.Context(), p, id(r), in)
	}))
	r.Patch("/bookings/{id}/payment", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.PaymentInput) (domain.Booking, error) {
		return c.SetPayment.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/walk", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.WalkInput) (command.Walked, error) {
		return c.Walk.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/pre-checkin/verify", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		out, err := c.VerifyPreCheckIn.Handle(r.Context(), p, id(r))
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))

	r.Get("/booking-groups", h.list(query.Groups))
	r.Post("/booking-groups", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.NewGroup) (command.GroupCreated, error) {
		return c.CreateGroup.Handle(r.Context(), p, in)
	}))
	r.Post("/booking-groups/{id}/stays", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.StayInput) (domain.Booking, error) {
		return c.AddGroupStay.Handle(r.Context(), p, id(r), in)
	}))
	r.Delete("/booking-groups/{id}/stays/{bookingId}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		out, err := c.RemoveGroupStay.Handle(r.Context(), p, id(r), chi.URLParam(r, "bookingId"))
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Post("/booking-groups/{id}/payments", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in json.RawMessage) (json.RawMessage, error) {
		return c.PayGroup.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/stay-restrictions", h.list(query.Restrictions))
	r.Post("/stay-restrictions", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.RestrictionInput) (domain.Restriction, error) {
		return c.SaveRestriction.Handle(r.Context(), p, "", in)
	}))
	r.Post("/stay-restrictions/bulk", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.BulkRestrictionInput) ([]domain.Restriction, error) {
		return c.BulkRestrictions.Handle(r.Context(), p, in)
	}))
	r.Put("/stay-restrictions/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.RestrictionInput) (domain.Restriction, error) {
		return c.SaveRestriction.Handle(r.Context(), p, id(r), in)
	}))
	r.Delete("/stay-restrictions/{id}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		if err := c.RemoveRestriction.Handle(r.Context(), p, id(r)); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))

	r.Get("/overbooking-policies", h.list(query.Overbooking))
	r.Put("/unit-groups/{id}/overbooking", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in struct {
		Limit float64 `json:"limit"`
	}) (domain.OverbookPolicy, error) {
		return c.SetOverbooking.Handle(r.Context(), p, id(r), in.Limit)
	}))
	r.Get("/walks", h.list(query.Walks))

	r.Get("/pre-checkins", h.list(query.PreCheckIns))
	// The online check-in link is public: the token is the credential.
	r.Get("/checkin/{token}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := c.CheckinLink.View(r.Context(), chi.URLParam(r, "token"))
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Put("/checkin/{token}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		var in domain.PreCheckInInput
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := c.CheckinLink.Submit(r.Context(), chi.URLParam(r, "token"), in)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Post("/checkin/{token}/pay", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		var in struct {
			Method string `json:"method"`
		}
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := c.CheckinLink.PayBalance(r.Context(), chi.URLParam(r, "token"), in.Method)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
}

// step serves a lifecycle step without a body.
func (h Handler) step(to string) http.HandlerFunc {
	return httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		out, err := h.Commands.Transition.Handle(r.Context(), p, chi.URLParam(r, "id"), to)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

// desk serves check-in and check-out: with the front desk record in the body, or as the plain
// lifecycle step when the console's transition() posts no body.
func (h Handler) desk(to string) http.HandlerFunc {
	return httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		raw, err := body(r)
		if err != nil {
			return err
		}
		ctx, bookingID := r.Context(), chi.URLParam(r, "id")
		var out domain.Booking
		switch {
		case raw == nil:
			out, err = h.Commands.Transition.Handle(ctx, p, bookingID, to)
		case to == domain.CheckedIn:
			var d domain.CheckInDetails
			if err = decodeInto(raw, &d); err == nil {
				out, err = h.Commands.CheckIn.Handle(ctx, p, bookingID, d)
			}
		default:
			var d domain.CheckOutDetails
			if err = decodeInto(raw, &d); err == nil {
				out, err = h.Commands.CheckOut.Handle(ctx, p, bookingID, d)
			}
		}
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

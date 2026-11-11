// Package http maps the messaging context onto the contract paths the TypeScript HTTP adapter
// calls for the messaging port, the public e-invoice link included.
package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the messaging write handlers.
type Commands struct {
	Send         command.Send
	Resend       command.Resend
	SaveSettings command.SaveSettings
	Sweep        command.Sweep
	Invoice      command.Invoice
}

// Handler serves the messaging routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	// Reading the outbox moves it on first, as the mock's messages() does.
	r.Get("/messages", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := auth.Require(r.Context()); err != nil {
			return err
		}
		if err := c.Sweep.Handle(r.Context()); err != nil {
			return err
		}
		out, err := q.Messages(r.Context())
		if err != nil {
			return err
		}
		if out == nil {
			out = []json.RawMessage{}
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Post("/messages", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in domain.SendInput
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		m, err := c.Send.Handle(r.Context(), p, in)
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, m)
		return nil
	}))
	r.Post("/messages/{id}/resend", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		m, err := c.Resend.Handle(r.Context(), p, chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		httpx.OK(w, m)
		return nil
	}))
	r.Get("/messages/settings", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		s, err := q.Settings(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, s)
		return nil
	}))
	r.Put("/messages/settings", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in domain.Settings
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		s, err := c.SaveSettings.Handle(r.Context(), p, in)
		if err != nil {
			return err
		}
		httpx.OK(w, s)
		return nil
	}))
	// Public: the e-invoice link the thank-you message carries; no session.
	r.Get("/invoice/{token}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		inv, err := c.Invoice.Handle(r.Context(), chi.URLParam(r, "token"))
		if err != nil {
			return err
		}
		httpx.OK(w, inv)
		return nil
	}))
}

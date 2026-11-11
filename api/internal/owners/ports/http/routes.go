// Package http maps the owners context onto the contract paths the TypeScript HTTP adapter calls
// for the owners port, plus the owner portal's calendar.
package http

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/owners/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/owners/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the owners write handlers.
type Commands struct {
	SaveOwner    command.SaveOwner
	SaveContract command.SaveContract
	Close        command.CloseStatement
	Approve      command.ApproveStatement
	Pay          command.PayStatement
	Reopen       command.ReopenStatement
	RequestStay  command.RequestStay
	DecideStay   command.DecideStay
}

// Handler serves the owners routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

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

type noteBody struct {
	Note string `json:"note"`
}

type payBody struct {
	AccountID string `json:"accountId"`
}

type reasonBody struct {
	Reason string `json:"reason"`
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/villa-owners", list(log, func(r *http.Request) ([]domain.VillaOwner, error) { return q.Owners(r.Context()) }))
	r.Post("/villa-owners", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.OwnerInput) (domain.VillaOwner, error) {
		return c.SaveOwner.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/villa-owners/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.OwnerInput) (domain.VillaOwner, error) {
		return c.SaveOwner.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/management-contracts", list(log, func(r *http.Request) ([]domain.Contract, error) { return q.Contracts(r.Context()) }))
	r.Post("/management-contracts", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ContractInput) (domain.Contract, error) {
		return c.SaveContract.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/management-contracts/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ContractInput) (domain.Contract, error) {
		return c.SaveContract.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/owner-statements", list(log, func(r *http.Request) ([]domain.Statement, error) { return q.Statements(r.Context()) }))
	r.Post("/owner-statements", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.CloseInput) (domain.Statement, error) {
		return c.Close.Handle(r.Context(), p, in)
	}))
	r.Post("/owner-statements/{id}/approve", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in noteBody) (domain.Statement, error) {
		return c.Approve.Handle(r.Context(), p, id(r), in.Note)
	}))
	r.Post("/owner-statements/{id}/pay", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in payBody) (domain.Statement, error) {
		return c.Pay.Handle(r.Context(), p, id(r), in.AccountID)
	}))
	r.Post("/owner-statements/{id}/reopen", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in reasonBody) (domain.Statement, error) {
		return c.Reopen.Handle(r.Context(), p, id(r), in.Reason)
	}))

	r.Get("/owner-stays", list(log, func(r *http.Request) ([]domain.StayRequest, error) { return q.StayRequests(r.Context()) }))
	r.Post("/owner-stays", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.StayInput) (domain.StayRequest, error) {
		return c.RequestStay.Handle(r.Context(), p, in)
	}))
	r.Post("/owner-stays/{id}/decide", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.Decision) (domain.StayRequest, error) {
		return c.DecideStay.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/owner-portal/calendar", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		out, err := q.Calendar(r.Context(), r.URL.Query().Get("from"), days)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
}

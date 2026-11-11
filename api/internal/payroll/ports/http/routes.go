// Package http maps the payroll context onto the contract paths the TypeScript HTTP adapter
// calls for the payroll port.
package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the payroll write handlers.
type Commands struct {
	SaveSettings     command.SaveSettings
	CreatePeriod     command.CreatePeriod
	Calculate        command.Calculate
	AddAdjustment    command.AddAdjustment
	RemoveAdjustment command.RemoveAdjustment
	Transition       command.Transition
	Publish          command.Publish
}

// Handler serves the payroll routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

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

type empty struct{}

type monthInput struct {
	Month string `json:"month"`
}

type transitionInput struct {
	Note      string `json:"note"`
	AccountID string `json:"accountId"`
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	r.Get("/payroll/settings", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		s, err := q.Settings(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, s)
		return nil
	}))
	r.Put("/payroll/settings", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.Settings) (domain.Settings, error) {
		return c.SaveSettings.Handle(r.Context(), p, in)
	}))
	r.Get("/payroll/periods", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := q.Periods(r.Context())
		if err != nil {
			return err
		}
		if out == nil {
			out = []domain.Period{}
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Post("/payroll/periods", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in monthInput) (domain.Period, error) {
		return c.CreatePeriod.Handle(r.Context(), p, in.Month)
	}))
	r.Post("/payroll/periods/{id}/calculate", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ empty) (domain.Period, error) {
		return c.Calculate.Handle(r.Context(), p, id(r))
	}))
	r.Post("/payroll/periods/{id}/lines/{employeeId}/adjustments", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AdjustmentInput) (domain.Period, error) {
		return c.AddAdjustment.Handle(r.Context(), p, id(r), chi.URLParam(r, "employeeId"), in)
	}))
	r.Post("/payroll/periods/{id}/lines/{employeeId}/adjustments/{adjustmentId}/remove", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ empty) (domain.Period, error) {
		return c.RemoveAdjustment.Handle(r.Context(), p, id(r), chi.URLParam(r, "employeeId"), chi.URLParam(r, "adjustmentId"))
	}))
	for action, to := range map[string]string{"reopen": domain.Draft, "approve": domain.Approved, "close": domain.Closed} {
		r.Post("/payroll/periods/{id}/"+action, write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in transitionInput) (domain.Period, error) {
			return c.Transition.Handle(r.Context(), p, id(r), to, in.Note, in.AccountID)
		}))
	}
	r.Post("/payroll/periods/{id}/publish", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ empty) (domain.Period, error) {
		return c.Publish.Handle(r.Context(), p, id(r))
	}))
}

// Package http maps the housekeeping context onto the contract paths the TypeScript HTTP adapter
// calls for the board (maintenance port), the housekeeping port, linen and laundry.
package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the housekeeping write handlers.
type Commands struct {
	SaveSettings  command.SaveSettings
	PlanDay       command.PlanDay
	AddTask       command.AddTask
	Assign        command.Assign
	AutoAssign    command.AutoAssign
	WorkTask      command.WorkTask
	ReportIssue   command.ReportIssue
	NoteLostFound command.NoteLostFound
	SetState      command.SetState
	Inspect       command.Inspect
	SaveLinenPar  command.SaveLinenPar
	DiscardLinen  command.DiscardLinen
	SendLaundry   command.SendLaundry
	ReturnLaundry command.ReturnLaundry
}

// Handler serves the housekeeping routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

func (h Handler) list(name string) http.HandlerFunc {
	return httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := h.Queries.List(r.Context(), name)
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

type stateBody struct {
	State string `json:"state"`
	Note  string `json:"note"`
}

type dateBody struct {
	Date string `json:"date"`
}

type assignBody struct {
	TaskIDs     []string `json:"taskIds"`
	AttendantID *string  `json:"attendantId"`
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, log := h.Commands, h.Log
	param := chi.URLParam
	r.Get("/housekeeping", h.list(query.Board))
	r.Get("/housekeeping/settings", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		s, err := h.Queries.Settings(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, s)
		return nil
	}))
	r.Put("/housekeeping/settings", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.Settings) (domain.Settings, error) {
		return c.SaveSettings.Handle(r.Context(), p, in)
	}))
	r.Put("/housekeeping/{unitId}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in stateBody) (domain.Record, error) {
		return c.SetState.Handle(r.Context(), p, param(r, "unitId"), in.State, in.Note)
	}))
	r.Post("/housekeeping/{unitId}/inspections", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.InspectInput) (command.InspectResult, error) {
		return c.Inspect.Handle(r.Context(), p, param(r, "unitId"), in)
	}))

	r.Get("/housekeeping/tasks", h.list(query.Tasks))
	r.Post("/housekeeping/tasks", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.TaskInput) (domain.RoomTask, error) {
		return c.AddTask.Handle(r.Context(), p, in)
	}))
	r.Post("/housekeeping/tasks/plan", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in dateBody) ([]domain.RoomTask, error) {
		return c.PlanDay.Handle(r.Context(), p, in.Date)
	}))
	r.Post("/housekeeping/tasks/assign", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in assignBody) ([]domain.RoomTask, error) {
		return c.Assign.Handle(r.Context(), p, in.TaskIDs, in.AttendantID)
	}))
	r.Post("/housekeeping/tasks/auto-assign", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in dateBody) ([]domain.RoomTask, error) {
		return c.AutoAssign.Handle(r.Context(), p, in.Date)
	}))
	r.Post("/housekeeping/tasks/{id}/issues", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.IssueInput) (command.IssueResult, error) {
		return c.ReportIssue.Handle(r.Context(), p, param(r, "id"), in)
	}))
	r.Post("/housekeeping/tasks/{id}/lost-found", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.LostFoundInput) (domain.RoomTask, error) {
		return c.NoteLostFound.Handle(r.Context(), p, param(r, "id"), in)
	}))
	r.Post("/housekeeping/tasks/{id}/{action}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.WorkInput) (domain.RoomTask, error) {
		return c.WorkTask.Handle(r.Context(), p, param(r, "id"), param(r, "action"), in)
	}))

	r.Get("/linen/pars", h.list(query.Pars))
	r.Put("/linen/pars/{groupId}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ParInput) (domain.LinenPar, error) {
		return c.SaveLinenPar.Handle(r.Context(), p, param(r, "groupId"), in)
	}))
	r.Get("/linen/soiled", h.list(query.Soiled))
	r.Post("/linen/discards", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.Discard) ([]command.WriteOff, error) {
		return c.DiscardLinen.Handle(r.Context(), p, in)
	}))
	r.Get("/laundry/batches", h.list(query.Batches))
	r.Post("/laundry/batches", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.SendInput) (domain.LaundryBatch, error) {
		return c.SendLaundry.Handle(r.Context(), p, in)
	}))
	r.Post("/laundry/batches/{id}/return", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ReturnInput) (domain.LaundryBatch, error) {
		return c.ReturnLaundry.Handle(r.Context(), p, param(r, "id"), in)
	}))
}

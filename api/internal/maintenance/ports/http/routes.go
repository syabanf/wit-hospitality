// Package http maps the maintenance context onto the contract paths the TypeScript HTTP adapter
// calls for the maintenance port.
package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the maintenance write handlers.
type Commands struct {
	CreateWorkOrder     command.CreateWorkOrder
	UpdateWorkOrder     command.UpdateWorkOrder
	TransitionWorkOrder command.TransitionWorkOrder
	AddNote             command.AddNote
	SetBlock            command.SetBlock
	AddExpense          command.AddExpense
	CorrectExpense      command.CorrectExpense
	CreateAsset         command.CreateAsset
	UpdateAsset         command.UpdateAsset
	CreateVendor        command.CreateVendor
	UpdateVendor        command.UpdateVendor
	CreatePlan          command.CreatePlan
	UpdatePlan          command.UpdatePlan
	GenerateDue         command.GenerateDue
}

// Handler serves the maintenance routes.
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

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/work-orders", list(log, func(r *http.Request) ([]domain.WorkOrder, error) { return q.WorkOrders(r.Context()) }))
	r.Post("/work-orders", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.NewInput) (domain.WorkOrder, error) {
		return c.CreateWorkOrder.Handle(r.Context(), p, in)
	}))
	r.Patch("/work-orders/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.Input) (domain.WorkOrder, error) {
		return c.UpdateWorkOrder.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/work-orders/{id}/status", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.TransitionInput) (domain.WorkOrder, error) {
		return c.TransitionWorkOrder.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/work-orders/{id}/notes", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.NoteInput) (domain.WorkOrder, error) {
		return c.AddNote.Handle(r.Context(), p, id(r), in)
	}))
	r.Put("/work-orders/{id}/block", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.BlockInput) (domain.WorkOrder, error) {
		return c.SetBlock.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/work-orders/{id}/expenses", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ExpenseInput) (domain.WorkOrder, error) {
		return c.AddExpense.Handle(r.Context(), p, id(r), in)
	}))
	r.Put("/work-orders/{id}/expenses/{expenseId}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ExpenseInput) (domain.WorkOrder, error) {
		return c.CorrectExpense.Handle(r.Context(), p, id(r), chi.URLParam(r, "expenseId"), in)
	}))

	r.Get("/assets", list(log, func(r *http.Request) ([]domain.Asset, error) { return q.Assets(r.Context()) }))
	r.Post("/assets", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.AssetInput) (domain.Asset, error) {
		return c.CreateAsset.Handle(r.Context(), p, in)
	}))
	r.Patch("/assets/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AssetInput) (domain.Asset, error) {
		return c.UpdateAsset.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/vendors", list(log, func(r *http.Request) ([]domain.Vendor, error) { return q.Vendors(r.Context()) }))
	r.Post("/vendors", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.VendorInput) (domain.Vendor, error) {
		return c.CreateVendor.Handle(r.Context(), p, in)
	}))
	r.Patch("/vendors/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.VendorInput) (domain.Vendor, error) {
		return c.UpdateVendor.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/preventive-plans", list(log, func(r *http.Request) ([]domain.Plan, error) { return q.Plans(r.Context()) }))
	r.Post("/preventive-plans", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.PlanInput) (domain.Plan, error) {
		return c.CreatePlan.Handle(r.Context(), p, in)
	}))
	r.Patch("/preventive-plans/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.PlanInput) (domain.Plan, error) {
		return c.UpdatePlan.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/preventive-plans/generate", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.GenerateInput) ([]domain.WorkOrder, error) {
		return c.GenerateDue.Handle(r.Context(), p, in)
	}))
}

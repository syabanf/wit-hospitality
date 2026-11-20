package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// UnitCommands are the unit inventory list and check handlers.
type UnitCommands struct {
	SaveItem       command.SaveUnitItem
	RemoveItem     command.RemoveUnitItem
	CopyItems      command.CopyUnitItems
	RecordCheck    command.RecordCheck
	ChargeLine     command.ChargeLine
	RaiseWorkOrder command.RaiseWorkOrder
	AdjustLine     command.AdjustLine
}

type empty struct{}

// unitRoutes serves /unit-items and /inventory-checks (villa-operations-contract.md).
func (h Handler) unitRoutes(r chi.Router) {
	c, q, log := h.Units, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	item := func(r *http.Request) string { return chi.URLParam(r, "itemId") }

	r.Get("/unit-items", list(log, func(r *http.Request) ([]domain.UnitItem, error) { return q.UnitItems(r.Context()) }))
	r.Post("/unit-items", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.UnitItemInput) (domain.UnitItem, error) {
		return c.SaveItem.Handle(r.Context(), p, "", in)
	}))
	r.Post("/unit-items/copy", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.CopyInput) ([]domain.UnitItem, error) {
		return c.CopyItems.Handle(r.Context(), p, in)
	}))
	r.Patch("/unit-items/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.UnitItemInput) (domain.UnitItem, error) {
		return c.SaveItem.Handle(r.Context(), p, id(r), in)
	}))
	r.Delete("/unit-items/{id}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		if err := c.RemoveItem.Handle(r.Context(), p, id(r)); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))

	r.Get("/inventory-checks", list(log, func(r *http.Request) ([]domain.InventoryCheck, error) { return q.UnitChecks(r.Context()) }))
	r.Post("/inventory-checks", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.CheckInput) (domain.InventoryCheck, error) {
		return c.RecordCheck.Handle(r.Context(), p, in)
	}))
	r.Post("/inventory-checks/{id}/lines/{itemId}/charge", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ChargeInput) (domain.InventoryCheck, error) {
		return c.ChargeLine.Handle(r.Context(), p, id(r), item(r), in)
	}))
	r.Post("/inventory-checks/{id}/lines/{itemId}/work-order", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ empty) (domain.InventoryCheck, error) {
		return c.RaiseWorkOrder.Handle(r.Context(), p, id(r), item(r))
	}))
	r.Post("/inventory-checks/{id}/lines/{itemId}/adjust", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ empty) (domain.InventoryCheck, error) {
		return c.AdjustLine.Handle(r.Context(), p, id(r), item(r))
	}))
}

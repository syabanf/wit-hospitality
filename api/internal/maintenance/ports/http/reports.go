package http

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// reports opens the work orders other contexts report, as maintenance.WorkOrders.
type reports struct{ report command.ReportWorkOrder }

// WorkOrders is the in-process maintenance.WorkOrders.
func (h Handler) WorkOrders() maintenance.WorkOrders {
	return reports{report: h.Commands.ReportWorkOrder}
}

// Open opens the work order as the reporter.
func (r reports) Open(ctx context.Context, by maintenance.Reporter, in maintenance.Report) (maintenance.WorkOrderRef, error) {
	p := auth.Principal{UserID: by.UserID, Name: by.Name, Role: rbac.Role(by.Role), VillaIDs: by.VillaIDs, LocationIDs: by.LocationIDs}
	unit := in.UnitID
	w, err := r.report.Handle(ctx, p, domain.NewInput{Source: in.Source, Input: domain.Input{VillaID: in.VillaID, UnitID: &unit, Category: in.Category,
		Priority: in.Priority, Title: in.Title, Description: in.Description}})
	if err != nil {
		return maintenance.WorkOrderRef{}, err
	}
	return maintenance.WorkOrderRef{ID: w.ID, Number: w.Number}, nil
}

// InternalRoutes registers POST /internal/v1/work-orders/reports for maintenance.HTTPClient. The
// gateway does not expose it.
func (h Handler) InternalRoutes(r chi.Router) {
	wo := h.WorkOrders()
	r.Post("/work-orders/reports", httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		var in struct {
			Reporter maintenance.Reporter `json:"reporter"`
			Report   maintenance.Report   `json:"report"`
		}
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := wo.Open(r.Context(), in.Reporter, in.Report)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
}

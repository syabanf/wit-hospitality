package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// OpsCommands are the meter, reading, setting and upkeep handlers.
type OpsCommands struct {
	SaveMeter           command.SaveMeter
	RecordReading       command.RecordReading
	SaveUtilitySettings command.SaveUtilitySettings
	ApplyTemplate       command.ApplyTemplate
	RecordUpkeep        command.RecordUpkeep
}

// opsRoutes serves /meters, /meter-readings, /utility-settings, the upkeep templates and the
// upkeep checklist (villa-operations-contract.md sections 3 and 4).
func (h Handler) opsRoutes(r chi.Router) {
	c, q, log := h.Ops, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/meters", list(log, func(r *http.Request) ([]domain.Meter, error) { return q.Meters(r.Context()) }))
	r.Post("/meters", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.MeterInput) (domain.Meter, error) {
		return c.SaveMeter.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/meters/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.MeterInput) (domain.Meter, error) {
		return c.SaveMeter.Handle(r.Context(), p, id(r), in)
	}))
	r.Get("/meter-readings", list(log, func(r *http.Request) ([]domain.MeterReading, error) { return q.Readings(r.Context()) }))
	r.Post("/meter-readings", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ReadingInput) (domain.MeterReading, error) {
		return c.RecordReading.Handle(r.Context(), p, in)
	}))
	r.Get("/utility-settings", list(log, func(r *http.Request) ([]domain.UtilitySettings, error) { return q.UtilitySettings(r.Context()) }))
	r.Put("/utility-settings/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.LongStayInput) (domain.UtilitySettings, error) {
		return c.SaveUtilitySettings.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/preventive-plans/templates", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ApplyTemplateInput) ([]domain.Plan, error) {
		return c.ApplyTemplate.Handle(r.Context(), p, in)
	}))
	r.Put("/work-orders/{id}/upkeep", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.UpkeepInput) (domain.WorkOrder, error) {
		return c.RecordUpkeep.Handle(r.Context(), p, id(r), in)
	}))
}

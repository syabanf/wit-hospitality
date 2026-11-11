package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
)

// Holds are the unit blocks other contexts place for their jobs.
type Holds struct {
	Hold    command.HoldBlock
	Release command.ReleaseBlock
	Log     *slog.Logger
}

// HoldInput is the body of POST /internal/v1/unit-blocks/holds.
type HoldInput struct {
	UnitID string `json:"unitId"`
	From   string `json:"from"`
	To     string `json:"to"`
	Note   string `json:"note"`
}

// ReleaseInput is the body of POST /internal/v1/unit-blocks/{id}/release.
type ReleaseInput struct {
	Today string `json:"today"`
}

// InternalRoutes registers the service-to-service routes under /internal/v1.
func (h Holds) InternalRoutes(r chi.Router) {
	r.Post("/unit-blocks/holds", httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		var in HoldInput
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		id, err := h.Hold.Handle(r.Context(), in.UnitID, in.From, in.To, in.Note)
		if err != nil {
			return err
		}
		httpx.Created(w, map[string]string{"id": id})
		return nil
	}))
	r.Post("/unit-blocks/{id}/release", httpx.Handle(h.Log, func(w http.ResponseWriter, r *http.Request) error {
		var in ReleaseInput
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		if err := h.Release.Handle(r.Context(), chi.URLParam(r, "id"), in.Today); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))
}

// Package http maps the property context onto the contract paths the TypeScript HTTP adapter
// calls for the property port and the unit block calls of the booking port.
package http

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// Commands are the property write handlers.
type Commands struct {
	CreateLocation command.CreateLocation
	UpdateLocation command.UpdateLocation
	CreateVilla    command.CreateVilla
	UpdateVilla    command.UpdateVilla
	CreateProperty command.CreateProperty
	CreateGroup    command.CreateGroup
	UpdateGroup    command.UpdateGroup
	CreateUnit     command.CreateUnit
	UpdateUnit     command.UpdateUnit
	SaveRatePlan   command.SaveRatePlan
	AddBlock       command.AddBlock
	RemoveBlock    command.RemoveBlock
}

// Handler serves the property routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

// list answers a read.
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

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/locations", list(log, func(r *http.Request) ([]domain.Location, error) { return q.Locations(r.Context()) }))
	r.Post("/locations", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.LocationInput) (domain.Location, error) {
		return c.CreateLocation.Handle(r.Context(), p, in)
	}))
	r.Patch("/locations/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.LocationInput) (domain.Location, error) {
		return c.UpdateLocation.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/villas", list(log, func(r *http.Request) ([]domain.Villa, error) { return q.Villas(r.Context()) }))
	r.Post("/villas", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.VillaInput) (domain.Villa, error) {
		return c.CreateVilla.Handle(r.Context(), p, in)
	}))
	r.Patch("/villas/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.VillaInput) (domain.Villa, error) {
		return c.UpdateVilla.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/properties", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.PropertyInput) (domain.Villa, error) {
		return c.CreateProperty.Handle(r.Context(), p, in)
	}))

	r.Get("/unit-groups", list(log, func(r *http.Request) ([]domain.UnitGroup, error) { return q.Groups(r.Context()) }))
	r.Post("/unit-groups", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.GroupInput) (domain.UnitGroup, error) {
		return c.CreateGroup.Handle(r.Context(), p, in)
	}))
	r.Patch("/unit-groups/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.GroupInput) (domain.UnitGroup, error) {
		return c.UpdateGroup.Handle(r.Context(), p, id(r), in)
	}))
	r.Put("/unit-groups/{id}/rate-plan", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.RatePlanInput) (domain.RatePlan, error) {
		return c.SaveRatePlan.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/units", list(log, func(r *http.Request) ([]domain.Unit, error) { return q.Units(r.Context()) }))
	r.Post("/units", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.UnitInput) (domain.Unit, error) {
		return c.CreateUnit.Handle(r.Context(), p, in)
	}))
	r.Patch("/units/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.UnitInput) (domain.Unit, error) {
		return c.UpdateUnit.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/unit-status-history", list(log, func(r *http.Request) ([]domain.StatusChange, error) {
		v := r.URL.Query()
		return q.StatusHistory(r.Context(), domain.HistoryFilter{UnitID: v.Get("unitId"), VillaID: v.Get("villaId"), From: v.Get("from"), To: v.Get("to")})
	}))

	// The public site shows the photos of active villas and units without a session.
	r.Get("/site/photos/{fileId}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		body, kind, err := q.Photo(r.Context(), chi.URLParam(r, "fileId"))
		if err != nil {
			return err
		}
		defer body.Close()
		w.Header().Set("Content-Type", kind)
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, err = io.Copy(w, body)
		return err
	}))

	r.Get("/rate-plans", list(log, func(r *http.Request) ([]domain.RatePlan, error) { return q.RatePlans(r.Context()) }))

	r.Get("/unit-blocks", list(log, func(r *http.Request) ([]domain.UnitBlock, error) { return q.Blocks(r.Context()) }))
	r.Post("/unit-blocks", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.BlockInput) (domain.UnitBlock, error) {
		return c.AddBlock.Handle(r.Context(), p, in)
	}))
	r.Delete("/unit-blocks/{id}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		if err := c.RemoveBlock.Handle(r.Context(), p, id(r)); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))

	r.Get("/facilities", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := auth.Require(r.Context()); err != nil {
			return err
		}
		httpx.OK(w, q.Facilities())
		return nil
	}))
}

// Package query holds the property context's read side. Handlers read the projected rm_* tables
// of the property schema, filtered to the signed-in user's villa and location scope as the front
// end's catalog() does. They hold no domain logic.
package query

import (
	"context"
	"io"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// ReadStore reads the read models, narrowed to a scope.
type ReadStore interface {
	Locations(ctx context.Context, s rbac.Scope) ([]domain.Location, error)
	Villas(ctx context.Context, s rbac.Scope) ([]domain.Villa, error)
	Groups(ctx context.Context, s rbac.Scope) ([]domain.UnitGroup, error)
	Units(ctx context.Context, s rbac.Scope) ([]domain.Unit, error)
	RatePlans(ctx context.Context, s rbac.Scope) ([]domain.RatePlan, error)
	Blocks(ctx context.Context, s rbac.Scope) ([]domain.UnitBlock, error)
	StatusHistory(ctx context.Context, s rbac.Scope, f domain.HistoryFilter) ([]domain.StatusChange, error)
	// PhotoOnActive reports whether the file is a photo on an active villa or unit.
	PhotoOnActive(ctx context.Context, fileID string) (bool, error)
}

// Files opens uploaded files in the files context (adapters/clients.Files).
type Files interface {
	// Open returns the file's bytes and content type; found is false when no upload has the id.
	Open(ctx context.Context, id string) (body io.ReadCloser, contentType string, found bool, err error)
}

// Queries bundles the read handlers. Every signed-in user reads the catalog of their own scope; a
// villa owner reads their villas for the owner portal. Anyone reads the photos of active villas
// and units for the public site.
type Queries struct {
	Store ReadStore
	Files Files
}

func scope(ctx context.Context) (rbac.Scope, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return rbac.Scope{}, err
	}
	return p.Scope(), nil
}

// Locations is GET /locations.
func (q Queries) Locations(ctx context.Context) ([]domain.Location, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Locations(ctx, s)
}

// Villas is GET /villas.
func (q Queries) Villas(ctx context.Context) ([]domain.Villa, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Villas(ctx, s)
}

// Groups is GET /unit-groups.
func (q Queries) Groups(ctx context.Context) ([]domain.UnitGroup, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Groups(ctx, s)
}

// Units is GET /units.
func (q Queries) Units(ctx context.Context) ([]domain.Unit, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Units(ctx, s)
}

// RatePlans is GET /rate-plans.
func (q Queries) RatePlans(ctx context.Context) ([]domain.RatePlan, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.RatePlans(ctx, s)
}

// Blocks is GET /unit-blocks.
func (q Queries) Blocks(ctx context.Context) ([]domain.UnitBlock, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Blocks(ctx, s)
}

// StatusHistory is GET /unit-status-history.
func (q Queries) StatusHistory(ctx context.Context, f domain.HistoryFilter) ([]domain.StatusChange, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.StatusHistory(ctx, s, f)
}

// Photo is GET /site/photos/{fileId}: the image of a photo on an active villa or unit, without a
// session. Any other file is NOT_FOUND, so the route cannot read uploads that are not photos.
func (q Queries) Photo(ctx context.Context, fileID string) (io.ReadCloser, string, error) {
	ok, err := q.Store.PhotoOnActive(ctx, fileID)
	if err != nil {
		return nil, "", err
	}
	if !ok || q.Files == nil {
		return nil, "", errs.NotFound("photo", fileID)
	}
	body, kind, found, err := q.Files.Open(ctx, fileID)
	if err != nil {
		return nil, "", err
	}
	if !found {
		return nil, "", errs.NotFound("photo", fileID)
	}
	return body, kind, nil
}

// Facilities lists the villa facilities and unit amenities the forms offer.

func (q Queries) Facilities() map[string][]domain.Facility {
	return map[string][]domain.Facility{"villa": domain.VillaFacilities, "unit": domain.UnitAmenities}
}

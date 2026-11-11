// Package query holds the property context's read side. Handlers read the projected rm_* tables
// of the property schema, filtered to the signed-in user's villa and location scope as the front
// end's catalog() does. They hold no domain logic.
package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
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
}

// Queries bundles the read handlers. Every signed-in user reads the catalog of their own scope; a
// villa owner reads their villas for the owner portal.
type Queries struct{ Store ReadStore }

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

// Facilities lists the villa facilities and unit amenities the forms offer.
func (q Queries) Facilities() map[string][]domain.Facility {
	return map[string][]domain.Facility{"villa": domain.VillaFacilities, "unit": domain.UnitAmenities}
}

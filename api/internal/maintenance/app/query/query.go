// Package query holds the maintenance context's read side. Handlers read views over the
// maintenance schema, filtered to the signed-in user's villa and location scope. They hold no
// domain logic.
package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the views, narrowed to a scope.
type ReadStore interface {
	WorkOrders(ctx context.Context, s rbac.Scope) ([]domain.WorkOrder, error)
	Assets(ctx context.Context, s rbac.Scope) ([]domain.Asset, error)
	Vendors(ctx context.Context) ([]domain.Vendor, error)
	Plans(ctx context.Context, s rbac.Scope) ([]domain.Plan, error)
}

// Queries bundles the read handlers. Every signed-in user reads the jobs, assets and plans of
// their own villas; vendors are shared by every villa.
type Queries struct{ Store ReadStore }

func scope(ctx context.Context) (rbac.Scope, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return rbac.Scope{}, err
	}
	return p.Scope(), nil
}

// WorkOrders is GET /work-orders.
func (q Queries) WorkOrders(ctx context.Context) ([]domain.WorkOrder, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.WorkOrders(ctx, s)
}

// Assets is GET /assets.
func (q Queries) Assets(ctx context.Context) ([]domain.Asset, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Assets(ctx, s)
}

// Vendors is GET /vendors.
func (q Queries) Vendors(ctx context.Context) ([]domain.Vendor, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	return q.Store.Vendors(ctx)
}

// Plans is GET /preventive-plans.
func (q Queries) Plans(ctx context.Context) ([]domain.Plan, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Plans(ctx, s)
}

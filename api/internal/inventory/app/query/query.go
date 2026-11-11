// Package query holds the inventory context's read side. Handlers read views over the inventory
// schema, filtered to the signed-in user's villa and location scope. Items carry the average cost
// the commands store from the replay. They hold no domain logic.
package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the views, narrowed to a scope.
type ReadStore interface {
	Items(ctx context.Context) ([]domain.Item, error)
	Movements(ctx context.Context, s rbac.Scope) ([]domain.Movement, error)
	Receipts(ctx context.Context, s rbac.Scope) ([]domain.StockReceipt, error)
	Counts(ctx context.Context, s rbac.Scope) ([]domain.Count, error)
	Kits(ctx context.Context, s rbac.Scope) ([]domain.Kit, error)
	Links(ctx context.Context, s rbac.Scope) ([]domain.MinibarLink, error)
}

// Queries bundles the read handlers. Items are shared by every villa; everything else is per
// villa store and follows the user's scope.
type Queries struct{ Store ReadStore }

func scoped[T any](ctx context.Context, read func(context.Context, rbac.Scope) ([]T, error)) ([]T, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	return read(ctx, p.Scope())
}

// Items is GET /stock/items.
func (q Queries) Items(ctx context.Context) ([]domain.Item, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	return q.Store.Items(ctx)
}

// Movements is GET /stock/movements.
func (q Queries) Movements(ctx context.Context) ([]domain.Movement, error) {
	return scoped(ctx, q.Store.Movements)
}

// Receipts is GET /stock/receipts.
func (q Queries) Receipts(ctx context.Context) ([]domain.StockReceipt, error) {
	return scoped(ctx, q.Store.Receipts)
}

// Counts is GET /stock/counts.
func (q Queries) Counts(ctx context.Context) ([]domain.Count, error) {
	return scoped(ctx, q.Store.Counts)
}

// Kits is GET /stock/kits.
func (q Queries) Kits(ctx context.Context) ([]domain.Kit, error) { return scoped(ctx, q.Store.Kits) }

// Links is GET /stock/minibar-links.
func (q Queries) Links(ctx context.Context) ([]domain.MinibarLink, error) {
	return scoped(ctx, q.Store.Links)
}

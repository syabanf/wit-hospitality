package query

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// UnitStore reads the unit inventory lists and checks, narrowed to a scope.
type UnitStore interface {
	UnitItems(ctx context.Context, s rbac.Scope) ([]domain.UnitItem, error)
	UnitChecks(ctx context.Context, s rbac.Scope) ([]domain.InventoryCheck, error)
}

// UnitItems is GET /unit-items.
func (q Queries) UnitItems(ctx context.Context) ([]domain.UnitItem, error) {
	return scoped(ctx, q.Units.UnitItems)
}

// UnitChecks is GET /inventory-checks.
func (q Queries) UnitChecks(ctx context.Context) ([]domain.InventoryCheck, error) {
	return scoped(ctx, q.Units.UnitChecks)
}

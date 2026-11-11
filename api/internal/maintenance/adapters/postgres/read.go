package postgres

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the v_* views.
type ReadStore struct{ DB *db.DB }

// inScope is the allowedVilla rule in SQL: $1 villa ids, $2 location ids; empty lists allow all.
const inScope = `((cardinality($1::text[]) > 0 AND villa_id = ANY($1)) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_id = ANY($2))))`

func args(s rbac.Scope) []any {
	vil, loc := s.VillaIDs, s.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	return []any{vil, loc}
}

// WorkOrders returns the jobs of villas in scope.
func (s ReadStore) WorkOrders(ctx context.Context, sc rbac.Scope) ([]domain.WorkOrder, error) {
	return docs[domain.WorkOrder](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.v_work_orders WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// Assets returns the assets of villas in scope.
func (s ReadStore) Assets(ctx context.Context, sc rbac.Scope) ([]domain.Asset, error) {
	return docs[domain.Asset](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.v_assets WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// Vendors returns every vendor.
func (s ReadStore) Vendors(ctx context.Context) ([]domain.Vendor, error) {
	return docs[domain.Vendor](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.vendors ORDER BY seq`))
}

// Plans returns the plans of villas in scope.
func (s ReadStore) Plans(ctx context.Context, sc rbac.Scope) ([]domain.Plan, error) {
	return docs[domain.Plan](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM maintenance.v_plans WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ReadStore reads the items table and the v_* views.
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

func docs[T any](rows pgx.Rows, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) {
		var v T
		var raw []byte
		if err := r.Scan(&raw); err != nil {
			return v, err
		}
		return v, json.Unmarshal(raw, &v)
	})
}

// Items returns every item with its stored average cost.
func (s ReadStore) Items(ctx context.Context) ([]domain.Item, error) { return Repo(s).Items(ctx) }

// Movements returns the movements of stores in scope.
func (s ReadStore) Movements(ctx context.Context, sc rbac.Scope) ([]domain.Movement, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT `+movementColumns+` FROM inventory.v_movements WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanMovement)
}

// Receipts returns the receipts of stores in scope.
func (s ReadStore) Receipts(ctx context.Context, sc rbac.Scope) ([]domain.StockReceipt, error) {
	return docs[domain.StockReceipt](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM inventory.v_receipts WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// Counts returns the counts of stores in scope.
func (s ReadStore) Counts(ctx context.Context, sc rbac.Scope) ([]domain.Count, error) {
	return docs[domain.Count](s.DB.Q(ctx).Query(ctx, `SELECT doc FROM inventory.v_counts WHERE `+inScope+` ORDER BY seq`, args(sc)...))
}

// Kits returns the kits of room types in scope.
func (s ReadStore) Kits(ctx context.Context, sc rbac.Scope) ([]domain.Kit, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT group_id, lines FROM inventory.v_kits WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Kit, error) {
		var k domain.Kit
		var raw []byte
		if err := r.Scan(&k.GroupID, &raw); err != nil {
			return k, err
		}
		return k, json.Unmarshal(raw, &k.Lines)
	})
}

// Links returns the minibar links of menu items in scope.
func (s ReadStore) Links(ctx context.Context, sc rbac.Scope) ([]domain.MinibarLink, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT menu_item_id, stock_item_id FROM inventory.v_links WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[domain.MinibarLink])
}
